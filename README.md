# headroom-opencode-standalone

Self-contained [Headroom](https://github.com/headroomlabs-ai/headroom) transport for [OpenCode](https://opencode.ai).

Spawns the local `headroom proxy` itself, intercepts all provider traffic (fetch, `node:http`, `node:https`, `node:http2`, and spawned subprocesses), and exposes the `headroom_retrieve` tool — **no `headroom wrap opencode` needed**.

This is the standalone counterpart to the official [`headroom-opencode`](https://github.com/headroomlabs-ai/headroom/tree/main/plugins/opencode) plugin. The official plugin assumes a proxy is already running (started by `headroom wrap`); this one spawns and manages its own, so it works from a bare OpenCode config with nothing but the `headroom` CLI on `PATH`.

## Install

```bash
npm install @shutovks/headroom-opencode-standalone
```

OpenCode config (`opencode.jsonc`):

```jsonc
{
  "plugins": {
    "@shutovks/headroom-opencode-standalone": {}
  }
}
```

Requires the `headroom` CLI on `PATH` (`pip install "headroom-ai[all]"` or `uv tool install "headroom-ai[all]"`). If no `headroom` binary is found, the plugin loads as a no-op (compression disabled, session unaffected).

## What it does

- **Spawns `headroom proxy`** on a free loopback port (or `HEADROOM_PROXY_PORT`), waits for `/health`, and kills it on `dispose`.
- **Patches transport** in-process: `globalThis.fetch`, `http.request`/`get`, `https.request`/`get`, `http2.connect` — so SDKs that bypass `fetch` still route through Headroom.
- **Recursive subprocess shim**: injects `NODE_OPTIONS --import=<handler>` into every spawned child (`spawn`/`exec`/`execFile`/`fork`) so rtk, MCP servers, and hooks that make their own provider calls route through Headroom too.
- **Reversible compression (CCR)**: exposes the `headroom_retrieve` tool so the model can pull back the full original of any compressed chunk by its 24-char hash.
- **Graceful degradation**: if the proxy becomes unreachable (crashed, killed), traffic falls back to direct upstream — the session keeps working, just without compression, instead of hard-failing.
- **Anthropic fallback**: until [PR #1502](https://github.com/headroomlabs-ai/headroom) lands, the Anthropic handler ignores `x-headroom-base-url`; set `HEADROOM_ANTHROPIC_URL` to route Anthropic-protocol gateways via `ANTHROPIC_TARGET_API_URL`.

## Environment

| Variable | Default | Description |
|---|---|---|
| `HEADROOM_PROXY_PORT` | `0` (auto free port) | Force a shared proxy port; `0` picks a free port per instance |
| `HEADROOM_BIN` | `~/.local/bin/headroom` | Path to the `headroom` CLI |
| `HEADROOM_NO_HTTP2` | unset | Set `1` to disable http/2 (fixes TLS corruption under heavy concurrent streams) |
| `HEADROOM_ANTHROPIC_URL` | unset | Anthropic-protocol upstream (routed via `ANTHROPIC_TARGET_API_URL`) |
| `HEADROOM_PROXY_URL` | unset | Reuse an externally-managed proxy instead of spawning one |

## Development

```bash
git clone https://github.com/shutovks/headroom-opencode-standalone.git
cd headroom-opencode-standalone
npm install
npm run typecheck
npm run build
npm test
```

## License

Apache-2.0
