import { describe, test, expect } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PLUGIN_PATH = new URL("../../dist/index.js", import.meta.url).pathname
const FAKE_SCRIPT = new URL("./fake-provider.ts", import.meta.url).pathname

type Call = { path: string; model: string; body: unknown }

function readCalls(logFile: string): Call[] {
  try {
    return JSON.parse(readFileSync(logFile, "utf-8")) as Call[]
  } catch {
    return []
  }
}

async function startFake(opts: { cwd?: string; scripted?: boolean } = {}): Promise<{
  port: number
  proc: ReturnType<typeof Bun.spawn>
  log: string
}> {
  const log = join(tmpdir(), `headroom-e2e-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(log, "[]")
  const proc = Bun.spawn({
    cmd: ["bun", "run", FAKE_SCRIPT],
    env: {
      ...process.env,
      FAKE_PORT: "0",
      FAKE_LOG: log,
      ...(opts.cwd ? { FAKE_CWD: opts.cwd } : {}),
      ...(opts.scripted ? { FAKE_MODE: "scripted" } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const stderr = proc.stderr
  if (!stderr || typeof stderr === "number") throw new Error("no stderr on fake provider")
  const reader = (stderr as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buf = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) throw new Error("fake provider exited before ready: " + buf)
    buf += decoder.decode(value, { stream: true })
    const match = buf.match(/READY (\d+)/)
    if (match) {
      reader.releaseLock()
      return { port: Number(match[1]), proc, log }
    }
  }
}

// Isolate opencode from the host's ~/.config/opencode (which may hold a
// headroom.ts plugin that spawns a real proxy and clobbers the session).
// Empty temp dirs for config + data + HOME prevent global plugins loading.
function freshDirs(): { config: string; data: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "hr-e2e-"))
  return {
    config: join(root, "config"),
    data: join(root, "data"),
    home: root,
  }
}

function makeConfig(fakePort: number): string {
  // baseURL is loopback so the AI SDK reaches the fake provider directly —
  // no transport routing needed. shouldRoute (transport.ts:214) skips
  // loopback. Transport routing is unit-tested in tests/transport.test.ts.
  return JSON.stringify({
    provider: {
      fake: {
        api: "openai",
        name: "Fake",
        options: { baseURL: `http://127.0.0.1:${fakePort}/v1`, apiKey: "test-key" },
        models: { "ok-model": { name: "OK" } },
      },
    },
    model: "fake/ok-model",
    permission: "allow",
    plugin: [[PLUGIN_PATH, {}]],
  })
}

async function runOpenCode(
  fakePort: number,
  prompt: string,
  dirs: { config: string; data: string; home: string },
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const config = makeConfig(fakePort)
  const proc = Bun.spawn({
    cmd: ["opencode", "run", "--format", "json", "--model", "fake/ok-model", prompt],
    cwd: opts.cwd,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: config,
      OPENCODE_CONFIG_DIR: dirs.config,
      XDG_CONFIG_HOME: dirs.config,
      XDG_DATA_HOME: dirs.data,
      HOME: dirs.home,
      // Plugin reuses this URL instead of spawning headroom — no real binary
      // needed for the e2e. The shell.env hook exposes this value to bash
      // subprocesses, which the simulated-session test asserts on.
      HEADROOM_PROXY_URL: "http://127.0.0.1:1",
      PATH: process.env.PATH || "",
      ...(opts.cwd ? { FAKE_CWD: opts.cwd } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  // Drain stdout/stderr BEFORE awaiting exit — Bun may close the pipes once
  // the process exits, so reading afterwards can yield empty.
  const stdoutP = new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  const stderrP = new Response(proc.stderr as ReadableStream<Uint8Array>).text()

  const timeout = new Promise<null>((r) => setTimeout(() => r(null), opts.timeoutMs ?? 30_000))
  const exit = proc.exited as Promise<number | null>
  const result = await Promise.race([exit, timeout])

  if (result === null) {
    proc.kill()
    return { code: null, stdout: await stdoutP, stderr: "timed out" }
  }

  return { code: result, stdout: await stdoutP, stderr: await stderrP }
}

function kill(proc: ReturnType<typeof Bun.spawn> | null): void {
  if (proc) proc.kill()
}

// Search the full request bodies logged by the fake provider for a substring.
// The bodies include the messages array, so tool results from previous turns
// appear in later requests.
function bodiesContain(logFile: string, needle: string): boolean {
  return readCalls(logFile).some((c) => JSON.stringify(c.body).includes(needle))
}

describe("e2e: headroom-opencode-standalone plugin load", () => {
  test("plugin loads and a session completes", async () => {
    const fake = await startFake()
    const dirs = freshDirs()
    try {
      const { code, stderr } = await runOpenCode(fake.port, "reply ok", dirs)

      if (code !== 0) console.error("[opencode stderr]\n" + stderr)

      expect(code).toBe(0)
      expect(stderr).not.toContain(`failed to load plugin`)
      expect(stderr).not.toContain(`dist/index.js`)

      const chatCalls = readCalls(fake.log).filter((c) => c.path.endsWith("/chat/completions"))
      expect(chatCalls.length).toBeGreaterThan(0)
    } finally {
      kill(fake.proc)
      rmSync(dirs.home, { recursive: true, force: true })
    }
  }, 45_000)
})

describe("e2e: simulated development session (multi-turn, tools, shell.env hook)", () => {
  test("plugin survives a 13-step scripted session and shell.env hook fires", async () => {
    // Temp project dir — write tool creates files here, not in the repo.
    const projectDir = mkdtempSync(join(tmpdir(), "hr-e2e-proj-"))
    const fake = await startFake({ cwd: projectDir, scripted: true })
    const dirs = freshDirs()

    try {
      const { code, stderr } = await runOpenCode(
        fake.port,
        "build a small math module step by step",
        dirs,
        { cwd: projectDir, timeoutMs: 90_000 },
      )

      if (code !== 0) console.error("[opencode stderr]\n" + stderr)

      // Session completed all scripted turns.
      expect(code).toBe(0)
      expect(stderr).not.toContain(`failed to load plugin`)
      expect(stderr).not.toContain(`dist/index.js`)

      const chatCalls = readCalls(fake.log).filter((c) => c.path.endsWith("/chat/completions"))
      // At least the 13 scripted turns (plus title-model call(s)).
      expect(chatCalls.length).toBeGreaterThanOrEqual(13)

      // The env-check step's bash output must appear in a later request's
      // messages — proving the plugin's shell.env hook set HEADROOM_PROXY_URL
      // and HEADROOM_ACTIVE in the bash subprocess's env.
      expect(bodiesContain(fake.log, "PROXY=http://127.0.0.1:1")).toBe(true)
      expect(bodiesContain(fake.log, "ACTIVE=1")).toBe(true)
    } finally {
      kill(fake.proc)
      rmSync(dirs.home, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
    }
  }, 120_000)
})
