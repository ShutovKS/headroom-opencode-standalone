import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { FIXED_PORT, HEADROOM_BIN, NO_HTTP2 } from "./config.js"

let proxyProcess: ChildProcess | null = null
let spawnedByUs = false
let port = 0
let proxyUrl = ""

let lastWarn = 0
export function logThrottled(msg: string): void {
  // ponytail: surface proxy-death once per minute so a flapping proxy
  // doesn't flood the session log.
  const now = Date.now()
  if (now - lastWarn > 60_000) {
    lastWarn = now
    console.warn("[headroom]", msg)
  }
}

export function getProxyUrl(): string {
  return proxyUrl
}
export function spawnedByMe(): boolean {
  return spawnedByUs
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address()
      const n = typeof a === "object" && a ? a.port : 0
      srv.close(() => resolve(n))
    })
  })
}

async function isRunning(p: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${p}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function waitUntilReady(p: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isRunning(p)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

export function killProxy(): void {
  if (!proxyProcess) return
  proxyProcess.kill()
  proxyProcess = null
}

// ponytail: reuse an externally-managed proxy (e.g. from `headroom wrap`)
// when HEADROOM_PROXY_URL is already set — don't spawn a second one.
// `headroomInPath` gates spawning: if the binary isn't on PATH and no
// external proxy is configured, returns "" (compression disabled).
export async function ensureProxy(headroomInPath: boolean): Promise<string> {
  if (process.env.HEADROOM_PROXY_URL) {
    proxyUrl = process.env.HEADROOM_PROXY_URL
    return proxyUrl
  }

  port = FIXED_PORT || (await pickFreePort())
  proxyUrl = `http://127.0.0.1:${port}`

  if (await isRunning(port)) return proxyUrl

  if (!headroomInPath) {
    logThrottled("headroom binary not found — compression disabled")
    return ""
  }

  const proxyEnv = { ...process.env }
  if (process.env.HEADROOM_ANTHROPIC_URL) {
    // Anthropic handler ignores x-headroom-base-url (PR #1502 not landed),
    // so Anthropic-protocol gateways need a single ANTHROPIC_TARGET_API_URL.
    proxyEnv.ANTHROPIC_TARGET_API_URL = process.env.HEADROOM_ANTHROPIC_URL
  }

  const args = ["proxy", "--port", String(port), "--intercept-tool-results"]
  if (NO_HTTP2) args.push("--no-http2")

  proxyProcess = spawn(HEADROOM_BIN, args, { stdio: "pipe", env: proxyEnv })
  spawnedByUs = true

  proxyProcess.stderr?.on("data", (d: Buffer) => {
    console.warn("[headroom]", String(d).trim())
  })
  proxyProcess.on("exit", (code: number | null) => {
    proxyProcess = null
    if (code !== 0 && code !== null) {
      console.warn(`[headroom] proxy exited with code ${code}`)
    }
  })

  if (!(await waitUntilReady(port))) {
    logThrottled("proxy didn't start in time — compression disabled")
    killProxy()
    return ""
  }

  return proxyUrl
}
