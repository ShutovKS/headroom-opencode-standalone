import { createRequire, syncBuiltinESMExports } from "node:module"
import {
  BASE_URL_HEADER,
  ORIGINAL_PATH_HEADER,
  PROXY_ENV,
  STATE_KEY,
} from "./config.js"
import { logThrottled } from "./proxy.js"

// ponytail: ESM import of node:http gives a frozen namespace snapshot;
// createRequire + syncBuiltinESMExports lets us mutate http.request etc.
// so the patched methods are visible to all callers.
const nodeRequire = createRequire(import.meta.url)
const http = nodeRequire("node:http") as typeof import("node:http")
const https = nodeRequire("node:https") as typeof import("node:https")
const http2 = nodeRequire("node:http2") as typeof import("node:http2")
const childProcess = nodeRequire("node:child_process") as typeof import("node:child_process")

type FetchArgs = Parameters<typeof fetch>
type HttpRequest = typeof http.request
type HttpGet = typeof http.get
type HttpsRequest = typeof https.request
type HttpsGet = typeof https.get
type Http2Connect = typeof http2.connect
type ChildSpawn = typeof childProcess.spawn
type ChildExec = typeof childProcess.exec
type ChildExecFile = typeof childProcess.execFile
type ChildFork = typeof childProcess.fork

export interface InstallOptions {
  proxyUrl: string
  debug?: boolean
}

interface TransportState {
  refs: number
  proxyUrl: string
  debug: boolean
  originalFetch: typeof fetch
  originalHttpRequest: HttpRequest
  originalHttpGet: HttpGet
  originalHttpsRequest: HttpsRequest
  originalHttpsGet: HttpsGet
  originalHttp2Connect: Http2Connect
  originalChildSpawn: ChildSpawn
  originalChildExec: ChildExec
  originalChildExecFile: ChildExecFile
  originalChildFork: ChildFork
}

interface GlobalWithHeadroomTransport {
  [STATE_KEY]?: TransportState
}

interface NodeRequestParts {
  url?: URL
  options: Record<string, unknown>
  callback?: (...args: unknown[]) => unknown
}

function getState(): TransportState | undefined {
  return (globalThis as GlobalWithHeadroomTransport)[STATE_KEY]
}

function setState(state: TransportState | undefined): void {
  ;(globalThis as GlobalWithHeadroomTransport)[STATE_KEY] = state
}

// ── recursive child_process shim ────────────────────────────────────
// The shim (hook-shim/handler.js) is loaded via `--import` in every
// spawned subprocess and re-runs installHeadroomTransport there, so
// rtk / MCP servers / hooks that make their own HTTP calls to providers
// route through headroom too. Path resolves from dist/ → ../hook-shim.
function shimImportSpecifier(): string {
  return new URL("../hook-shim/handler.js", import.meta.url).href
}

function withNodeImportOption(
  existing: string | undefined,
  shim: string,
): string {
  const parts = existing?.trim() ? existing.trim().split(/\s+/) : []
  const alreadyPresent = parts.some((part, index) => {
    return (
      part === `--import=${shim}` ||
      (part === "--import" && parts[index + 1] === shim)
    )
  })
  if (!alreadyPresent) parts.push(`--import=${shim}`)
  return parts.join(" ")
}

function withShimEnv(
  env: NodeJS.ProcessEnv | Record<string, unknown> | undefined,
  proxyUrl: string,
): NodeJS.ProcessEnv {
  const nextEnv = { ...(env ?? process.env) } as NodeJS.ProcessEnv
  nextEnv[PROXY_ENV] = proxyUrl
  nextEnv.NODE_OPTIONS = withNodeImportOption(
    nextEnv.NODE_OPTIONS,
    shimImportSpecifier(),
  )
  return nextEnv
}

function installProcessEnv(proxyUrl: string): void {
  process.env[PROXY_ENV] = proxyUrl
  process.env.NODE_OPTIONS = withNodeImportOption(
    process.env.NODE_OPTIONS,
    shimImportSpecifier(),
  )
}

function isOptions(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof URL)
  )
}

function injectOptionsEnv(
  args: unknown[],
  optionIndex: number,
  proxyUrl: string,
): unknown[] {
  const nextArgs = [...args]
  const callback =
    typeof nextArgs.at(-1) === "function" ? nextArgs.pop() : undefined
  const existing = isOptions(nextArgs[optionIndex])
    ? { ...(nextArgs[optionIndex] as Record<string, unknown>) }
    : {}
  existing.env = withShimEnv(
    existing.env as NodeJS.ProcessEnv | undefined,
    proxyUrl,
  )

  if (isOptions(nextArgs[optionIndex])) {
    nextArgs[optionIndex] = existing
  } else {
    nextArgs.splice(optionIndex, 0, existing)
  }

  if (callback) nextArgs.push(callback)
  return nextArgs
}

function wrapSpawn(originalSpawn: ChildSpawn): ChildSpawn {
  return function headroomSpawn(this: unknown, ...args: unknown[]) {
    const state = getState()
    if (!state) return Reflect.apply(originalSpawn, this, args)
    const optionIndex = Array.isArray(args[1]) ? 2 : 1
    return Reflect.apply(
      originalSpawn,
      this,
      injectOptionsEnv(args, optionIndex, state.proxyUrl),
    )
  } as ChildSpawn
}

function wrapExec(originalExec: ChildExec): ChildExec {
  return function headroomExec(this: unknown, ...args: unknown[]) {
    const state = getState()
    if (!state) return Reflect.apply(originalExec, this, args)
    return Reflect.apply(
      originalExec,
      this,
      injectOptionsEnv(args, 1, state.proxyUrl),
    )
  } as ChildExec
}

function wrapExecFile(originalExecFile: ChildExecFile): ChildExecFile {
  return function headroomExecFile(this: unknown, ...args: unknown[]) {
    const state = getState()
    if (!state) return Reflect.apply(originalExecFile, this, args)
    const optionIndex = Array.isArray(args[1]) ? 2 : 1
    return Reflect.apply(
      originalExecFile,
      this,
      injectOptionsEnv(args, optionIndex, state.proxyUrl),
    )
  } as ChildExecFile
}

function wrapFork(originalFork: ChildFork): ChildFork {
  return function headroomFork(this: unknown, ...args: unknown[]) {
    const state = getState()
    if (!state) return Reflect.apply(originalFork, this, args)
    const optionIndex = Array.isArray(args[1]) ? 2 : 1
    return Reflect.apply(
      originalFork,
      this,
      injectOptionsEnv(args, optionIndex, state.proxyUrl),
    )
  } as ChildFork
}

// ── routing helpers (pure — take explicit proxy) ───────────────────
function normalizeProxyUrl(proxyUrl: string): URL {
  return new URL(proxyUrl)
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  )
}

export function shouldRoute(url: URL, proxy: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  if (isLoopback(url.hostname)) return false
  if (url.origin === proxy.origin) return false
  return true
}

function routedUrl(upstream: URL, proxy: URL): URL {
  return new URL(`${upstream.pathname}${upstream.search}`, proxy.origin)
}

export function normalizedOpenAiProxyPath(pathname: string): string | undefined {
  if (pathname.endsWith("/chat/completions")) return "/v1/chat/completions"
  if (pathname.endsWith("/responses")) return "/v1/responses"
  return undefined
}

export function routedUrlForOpenCode(
  upstream: URL,
  proxy: URL,
): { url: URL; originalPath: string | undefined } {
  const normalizedPath = normalizedOpenAiProxyPath(upstream.pathname)
  if (!normalizedPath) {
    return { url: routedUrl(upstream, proxy), originalPath: undefined }
  }
  return {
    url: new URL(`${normalizedPath}${upstream.search}`, proxy.origin),
    originalPath: upstream.pathname,
  }
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url)
  if (input instanceof URL) return input
  return new URL(String(input))
}

function mergeFetchHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  upstream: URL | undefined,
  originalPath: string | undefined = undefined,
): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  if (init?.headers) {
    new Headers(init.headers).forEach((v, k) => headers.set(k, v))
  }
  if (upstream) {
    headers.set(BASE_URL_HEADER, upstream.origin)
    headers.delete("host")
  }
  if (originalPath) headers.set(ORIGINAL_PATH_HEADER, originalPath)
  return headers
}

function withRoutedFetchInput(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  proxy: URL,
): FetchArgs {
  const upstream = requestUrl(input)
  if (!shouldRoute(upstream, proxy)) return [input, init]

  const { url: nextUrl, originalPath } = routedUrlForOpenCode(upstream, proxy)
  const nextInit = {
    ...init,
    headers: mergeFetchHeaders(input, init, upstream, originalPath),
  }

  if (input instanceof Request) {
    // Reconstruct the Request so method/body/signal survive the URL rewrite.
    return [new Request(nextUrl, input), nextInit]
  }
  return [nextUrl, nextInit]
}

// ── node:http arg parsing ──────────────────────────────────────────
function urlFromRequestOptions(
  options: Record<string, unknown>,
): URL | undefined {
  const protocol = String(options.protocol ?? "http:")
  if (protocol !== "http:" && protocol !== "https:") return undefined
  const hostValue = options.hostname ?? options.host
  if (!hostValue) return undefined
  const hostname = String(hostValue).replace(/:\d+$/, "")
  const port = options.port ? `:${String(options.port)}` : ""
  const path = String(options.path ?? "/")
  try {
    return new URL(`${protocol}//${hostname}${port}${path}`)
  } catch {
    return undefined
  }
}

function splitNodeArgs(args: unknown[]): NodeRequestParts {
  const callback =
    typeof args.at(-1) === "function"
      ? (args.at(-1) as (...args: unknown[]) => unknown)
      : undefined
  const withoutCallback = callback ? args.slice(0, -1) : args
  const [first, second] = withoutCallback
  const options = isOptions(second) ? { ...(second as Record<string, unknown>) } : {}

  if (first instanceof URL) return { url: first, options, callback }
  if (typeof first === "string") {
    try {
      return { url: new URL(first), options, callback }
    } catch {
      return { options, callback }
    }
  }
  if (isOptions(first)) {
    const requestOptions = {
      ...(first as Record<string, unknown>),
      ...options,
    }
    return {
      url: urlFromRequestOptions(requestOptions),
      options: requestOptions,
      callback,
    }
  }
  return { options, callback }
}

function headersForNodeRequest(
  options: Record<string, unknown>,
  upstream: URL,
  originalPath: string | undefined,
): Record<string, string> {
  const headers = new Headers(options.headers as HeadersInit | undefined)
  headers.set(BASE_URL_HEADER, upstream.origin)
  if (originalPath) headers.set(ORIGINAL_PATH_HEADER, originalPath)
  headers.delete("host")
  const result: Record<string, string> = {}
  headers.forEach((v, k) => {
    result[k] = v
  })
  return result
}

function routedNodeOptions(
  parts: NodeRequestParts,
  proxy: URL,
): Record<string, unknown> | undefined {
  if (!parts.url || !shouldRoute(parts.url, proxy)) return undefined

  const { url: nextUrl, originalPath } = routedUrlForOpenCode(parts.url, proxy)
  const {
    agent: _agent,
    auth: _auth,
    createConnection: _createConnection,
    defaultPort: _defaultPort,
    family: _family,
    headers: _headers,
    host: _host,
    hostname: _hostname,
    href: _href,
    lookup: _lookup,
    path: _path,
    pathname: _pathname,
    port: _port,
    protocol: _protocol,
    search: _search,
    servername: _servername,
    setHost: _setHost,
    ...rest
  } = parts.options

  return {
    ...rest,
    protocol: nextUrl.protocol,
    hostname: nextUrl.hostname,
    port: nextUrl.port || undefined,
    path: `${nextUrl.pathname}${nextUrl.search}`,
    headers: headersForNodeRequest(parts.options, parts.url, originalPath),
  }
}

function wrapRequest(
  httpOrig: HttpRequest,
  httpsOrig: HttpsRequest,
  passThrough: HttpRequest | HttpsRequest,
): HttpRequest | HttpsRequest {
  return function headroomRequest(this: unknown, ...args: unknown[]) {
    const state = getState()
    if (!state) return Reflect.apply(passThrough, this, args)

    const proxy = normalizeProxyUrl(state.proxyUrl)
    const parts = splitNodeArgs(args)
    const nextOptions = routedNodeOptions(parts, proxy)
    if (!nextOptions) return Reflect.apply(passThrough, this, args)

    // ponytail: route to the module matching the PROXY's scheme, not the
    // upstream's — headroom terminates TLS and re-issues upstream itself.
    const target = proxy.protocol === "https:" ? httpsOrig : httpOrig
    const nextArgs = parts.callback ? [nextOptions, parts.callback] : [nextOptions]
    return Reflect.apply(target, this, nextArgs)
  } as HttpRequest | HttpsRequest
}

function wrapGet(request: HttpRequest | HttpsRequest): HttpGet | HttpsGet {
  return function headroomGet(this: unknown, ...args: unknown[]) {
    const req = Reflect.apply(request, this, args)
    req.end()
    return req
  } as HttpGet | HttpsGet
}

function wrapHttp2Connect(originalConnect: Http2Connect): Http2Connect {
  return function headroomHttp2Connect(
    this: unknown,
    authority: string | URL,
    ...args: unknown[]
  ) {
    const state = getState()
    if (state) {
      const proxy = normalizeProxyUrl(state.proxyUrl)
      const upstream =
        authority instanceof URL ? authority : new URL(String(authority))
      if (shouldRoute(upstream, proxy)) {
        // ponytail: block direct h2 to upstreams — it bypasses fetch/http
        // patching entirely, so headroom would never see the request.
        throw new Error(
          `Headroom blocked direct HTTP/2 connection to ${upstream.origin}. ` +
            "Use fetch, http, or https so traffic routes through Headroom.",
        )
      }
    }
    return Reflect.apply(originalConnect, this, [authority, ...args])
  } as Http2Connect
}

// ── install / uninstall ────────────────────────────────────────────
export function installHeadroomTransport(options: InstallOptions): () => void {
  const existing = getState()
  if (existing) {
    existing.refs += 1
    existing.proxyUrl = options.proxyUrl
    existing.debug = Boolean(options.debug)
    installProcessEnv(options.proxyUrl)
    return () => uninstallHeadroomTransport()
  }

  const state: TransportState = {
    refs: 1,
    proxyUrl: options.proxyUrl,
    debug: Boolean(options.debug),
    originalFetch: globalThis.fetch,
    originalHttpRequest: http.request,
    originalHttpGet: http.get,
    originalHttpsRequest: https.request,
    originalHttpsGet: https.get,
    originalHttp2Connect: http2.connect,
    originalChildSpawn: childProcess.spawn,
    originalChildExec: childProcess.exec,
    originalChildExecFile: childProcess.execFile,
    originalChildFork: childProcess.fork,
  }

  setState(state)
  installProcessEnv(options.proxyUrl)

  globalThis.fetch = async function routedFetch(...args: FetchArgs) {
    const current = getState()
    if (!current) return state.originalFetch(...args)
    const proxy = normalizeProxyUrl(current.proxyUrl)
    try {
      const [nextInput, nextInit] = withRoutedFetchInput(args[0], args[1], proxy)
      return await state.originalFetch(nextInput, nextInit)
    } catch {
      // ponytail: proxy unreachable (crashed / killed by a sibling instance
      // in shared-port mode) — fall back to direct upstream so the session
      // keeps working, degraded (no compression), instead of hard-failing.
      logThrottled("proxy unreachable — routing direct (no compression)")
      return state.originalFetch(...args)
    }
  }

  http.request = wrapRequest(
    state.originalHttpRequest,
    state.originalHttpsRequest,
    state.originalHttpRequest,
  ) as HttpRequest
  https.request = wrapRequest(
    state.originalHttpRequest,
    state.originalHttpsRequest,
    state.originalHttpsRequest,
  ) as HttpsRequest
  http.get = wrapGet(http.request) as HttpGet
  https.get = wrapGet(https.request) as HttpsGet
  http2.connect = wrapHttp2Connect(state.originalHttp2Connect)
  childProcess.spawn = wrapSpawn(state.originalChildSpawn)
  childProcess.exec = wrapExec(state.originalChildExec)
  childProcess.execFile = wrapExecFile(state.originalChildExecFile)
  childProcess.fork = wrapFork(state.originalChildFork)
  syncBuiltinESMExports()

  return () => uninstallHeadroomTransport()
}

export function uninstallHeadroomTransport(): void {
  const state = getState()
  if (!state) return

  state.refs -= 1
  if (state.refs > 0) return

  globalThis.fetch = state.originalFetch
  http.request = state.originalHttpRequest
  http.get = state.originalHttpGet
  https.request = state.originalHttpsRequest
  https.get = state.originalHttpsGet
  http2.connect = state.originalHttp2Connect
  childProcess.spawn = state.originalChildSpawn
  childProcess.exec = state.originalChildExec
  childProcess.execFile = state.originalChildExecFile
  childProcess.fork = state.originalChildFork
  syncBuiltinESMExports()
  setState(undefined)
}
