// Stateful fake OpenAI-compatible provider. Drives a scripted multi-turn
// development session: returns a sequence of tool_calls (bash/write/read)
// then a final text response. Logs the full request body of every call to
// a JSON file so the test can assert on tool results echoed back.
// Prints `READY <port>` on stderr for startup sync.

export {}

const port = Number(Bun.env.FAKE_PORT || "0")
const logFile = Bun.env.FAKE_LOG || "/tmp/headroom-e2e-calls.json"
const cwd = Bun.env.FAKE_CWD || "/tmp/headroom-e2e-cwd"
const scripted = Bun.env.FAKE_MODE === "scripted"

type ScriptStep =
  | { toolCall: { name: string; arguments: Record<string, unknown> } }
  | { content: string }

// 13-step simulated development session. All file paths are absolute under
// FAKE_CWD so write/read don't pollute the repo. Bash commands are read-only
// or operate only on files created within FAKE_CWD.
const script: ScriptStep[] = [
  { toolCall: { name: "write", arguments: { filePath: `${cwd}/package.json`, content: '{"name":"hr-e2e-demo","version":"1.0.0"}\n' } } },
  { toolCall: { name: "read", arguments: { filePath: `${cwd}/package.json` } } },
  { toolCall: { name: "write", arguments: { filePath: `${cwd}/math.ts`, content: "export function add(a: number, b: number) { return a + b }\n" } } },
  { toolCall: { name: "write", arguments: { filePath: `${cwd}/math.test.ts`, content: 'import { add } from "./math"; console.log(add(2, 3))\n' } } },
  { toolCall: { name: "bash", arguments: { command: `cd ${cwd} && bun run math.test.ts` } } },
  { toolCall: { name: "write", arguments: { filePath: `${cwd}/hello.ts`, content: 'console.log("hello from headroom e2e")\n' } } },
  { toolCall: { name: "bash", arguments: { command: `cd ${cwd} && bun run hello.ts` } } },
  { toolCall: { name: "bash", arguments: { command: `cd ${cwd} && ls -la` } } },
  // The env-check step — proves the plugin's shell.env hook fired.
  { toolCall: { name: "bash", arguments: { command: "echo PROXY=$HEADROOM_PROXY_URL ACTIVE=$HEADROOM_ACTIVE" } } },
  { toolCall: { name: "bash", arguments: { command: `cd ${cwd} && rg -c "function" *.ts || true` } } },
  { toolCall: { name: "bash", arguments: { command: `cd ${cwd} && wc -l *.ts` } } },
  { toolCall: { name: "bash", arguments: { command: `cd ${cwd} && git init -q && git add -A && git commit -q -m "demo" --allow-empty-message 2>&1 || true` } } },
  { content: "Done. Built and tested a small math module." },
]

type Call = { path: string; model: string; body: unknown }
const calls: Call[] = []

async function flush(): Promise<void> {
  await Bun.write(logFile, JSON.stringify(calls))
}

let counter = 0

function nextStep(): ScriptStep {
  if (!scripted) return { content: "ok" }
  const step = script[counter] ?? { content: "done" }
  counter += 1
  return step
}

function streamChunks(step: ScriptStep, model: string): string {
  const id = "chatcmpl-x"
  const base = `data: {"id":"${id}","object":"chat.completion.chunk","model":"${model}"`
  if ("toolCall" in step) {
    const args = JSON.stringify(step.toolCall.arguments)
    return (
      `${base},"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_${counter}","type":"function","function":{"name":"${step.toolCall.name}","arguments":""}}]},"finish_reason":null}]}\n\n` +
      `${base},"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":${JSON.stringify(args)}}}]},"finish_reason":null}]}\n\n` +
      `${base},"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n` +
      `data: [DONE]\n\n`
    )
  }
  return (
    `${base},"choices":[{"index":0,"delta":{"role":"assistant","content":${JSON.stringify(step.content)}},"finish_reason":"stop"}]}\n\n` +
    `data: [DONE]\n\n`
  )
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)
    const body = (await req.json().catch(() => ({}))) as { model?: string; stream?: boolean; messages?: unknown[] }
    const model = typeof body.model === "string" ? body.model : "unknown"

    // Title/summary calls (short messages) get plain "ok" so they don't
    // consume the script or confuse the title generator with tool_calls.
    // In scripted mode, the main session has a longer messages array (system
    // + user + assistant + tool + ...) after the first turn.
    const isTitleish = !scripted && Array.isArray(body.messages) && body.messages.length <= 2 && JSON.stringify(body).length < 800
    const step = isTitleish ? { content: "ok" } : nextStep()

    calls.push({ path: url.pathname, model, body })
    await flush()

    if (url.pathname.endsWith("/models")) {
      return Response.json({
        object: "list",
        data: [{ id: "ok-model", object: "model" }],
      })
    }

    if (body.stream) {
      return new Response(streamChunks(step, model), {
        headers: { "content-type": "text/event-stream" },
      })
    }

    if ("toolCall" in step) {
      const args = JSON.stringify(step.toolCall.arguments)
      return Response.json({
        id: "x",
        object: "chat.completion",
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: `call_${counter}`, type: "function", function: { name: step.toolCall.name, arguments: args } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
    }

    return Response.json({
      id: "x",
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: step.content }, finish_reason: "stop" }],
    })
  },
})

await flush()
console.error(`READY ${server.port}`)
await new Promise(() => {})
