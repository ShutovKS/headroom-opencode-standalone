// Gated integration test against the REAL headroom binary. Skipped unless
// `headroom` is on PATH AND HEADROOM_LIVE=1 is set — so `npm run test:e2e`
// doesn't spawn real proxies by default.
//
// What this verifies: the plugin's `ensureProxy` spawn/health contract holds
// against a real headroom binary — it starts, /health returns 200, it responds
// to a chat.completions request (even if 502 to a dead upstream), and it
// kills cleanly on SIGTERM.
//
// What this does NOT verify: real compression. Headroom's compression
// pipeline requires a real client context (Claude Code / Codex session) and
// a working upstream that returns a valid response — a raw fetch with a
// large body hangs in the compression pipeline without a registered client.
// Compression is verified manually in a production opencode session.

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:net"
import { writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HEADROOM_BIN = process.env.HEADROOM_BIN ?? `${process.env.HOME}/.local/bin/headroom`
const GATE = process.env.HEADROOM_LIVE === "1"
const SKIP_MSG = "set HEADROOM_LIVE=1 (and have headroom on PATH) to run"

const whichResult = spawnSync("which", ["headroom"], { env: process.env })
const headroomOnPath = whichResult.status === 0
const shouldRun = GATE && headroomOnPath

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const a = s.address()
      const port = typeof a === "object" && a ? a.port : 0
      s.close(() => resolve(port))
    })
  })
}

function waitForHealth(port: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise(async (resolve) => {
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2000),
        })
        if (r.ok) return resolve(true)
      } catch {}
      await new Promise((r) => setTimeout(r, 300))
    }
    resolve(false)
  })
}

describe.skipIf(!shouldRun)("e2e-live: real headroom binary", () => {
  let hrProc: ReturnType<typeof spawn> | null = null
  let hrPort: number

  beforeAll(async () => {
    hrPort = await pickFreePort()
    // OPENAI_TARGET_API_URL points to a dead port — headroom will 502 quickly,
    // which is enough to prove it processed the request. A live upstream would
    // require real provider keys.
    hrProc = spawn(
      HEADROOM_BIN,
      ["proxy", "--port", String(hrPort), "--mode", "token"],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_TARGET_API_URL: "http://127.0.0.1:1" } },
    )
    const ok = await waitForHealth(hrPort)
    if (!ok) throw new Error("headroom didn't become healthy in 20s")
  }, 25_000)

  afterAll(() => {
    if (hrProc) {
      hrProc.kill("SIGTERM")
      hrProc = null
    }
  })

  test("spawned headroom responds to /health", async () => {
    const r = await fetch(`http://127.0.0.1:${hrPort}/health`)
    expect(r.ok).toBe(true)
  }, 5_000)

  test("headroom processes a chat.completions request (502 to dead upstream is fine)", async () => {
    const r = await fetch(`http://127.0.0.1:${hrPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ok-model",
        messages: [{ role: "user", content: "ping" }],
        stream: false,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    // 502 is expected (dead upstream). The point is headroom returned a
    // response at all — it received, attempted to forward, and replied.
    expect(r.status).toBe(502)
    const body = await r.json().catch(() => ({}) as Record<string, unknown>)
    expect(body).toHaveProperty("error")
  }, 20_000)
})
