# headroom-opencode-standalone

> Self-contained [Headroom](https://github.com/headroomlabs-ai/headroom) transport for [OpenCode](https://opencode.ai) — spawns the proxy, intercepts all provider traffic, exposes reversible compression. No `headroom wrap` needed.

[![CI](https://github.com/shutovks/headroom-opencode-standalone/actions/workflows/ci.yml/badge.svg)](https://github.com/shutovks/headroom-opencode-standalone/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@shutovks/headroom-opencode-standalone)](https://www.npmjs.com/package/@shutovks/headroom-opencode-standalone)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)

This is the standalone counterpart to the official [`headroom-opencode`](https://github.com/headroomlabs-ai/headroom/tree/main/plugins/opencode) plugin. The official plugin assumes a proxy is already running (started by `headroom wrap`); **this one spawns and manages its own**, so it works from a bare OpenCode config with nothing but the `headroom` CLI on `PATH`.

## Why

`headroom wrap opencode` works, but it owns your shell session — it starts the proxy, injects env, and launches OpenCode for you. If you already run OpenCode your own way (custom config, multiple profiles, an IDE integration), `wrap` gets in the way.

This plugin does the wrapping **inside** the OpenCode plugin lifecycle:

- It starts `headroom proxy` on a free loopback port when OpenCode loads the plugin and stops it on `dispose`.
- It patches `fetch`, `node:http`/`https`/`http2`, **and** spawned subprocesses — so every provider call, in-process or in a child, routes through Headroom.
- If the proxy dies mid-session, traffic falls back to direct upstream instead of hard-failing.

## Install

```bash
# 1. Headroom CLI (one-time)
uv tool install "headroom-ai[all]"
# or: pip install "headroom-ai[all]"

# 2. The plugin
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

If no `headroom` binary is on `PATH`, the plugin loads as a no-op — the session runs normally, just without compression.

## How it works

```
 OpenCode provider call (fetch / node:http / node:https / http2)
   or a spawned subprocess (rtk, MCP server, hook)
        │
        ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  This plugin (loaded in-process by OpenCode)                 │
 │  ──────────────────────────────────────────────────────────  │
 │  transport.ts patches:                                       │
 │    • globalThis.fetch          ──┐                           │
 │    • http.request / http.get     ├── route to local proxy    │
 │    • https.request / https.get   │   (x-headroom-base-url +  │
 │    • http2.connect (blocked)   ──┘    x-headroom-original-path│
 │    • child_process.spawn/exec/                              │
 │       execFile/fork ── inject NODE_OPTIONS --import=shim     │
 │                          │                                   │
 │  proxy.ts: spawns headroom proxy on free port, /health-poll  │
 │  retrieve.ts: headroom_retrieve tool (CCR by hash)           │
 └──────────────────────────────────────────────────────────────┘
        │  compressed prompt + retrieval tool
        ▼
   headroom proxy  ──►  LLM provider (Anthropic · OpenAI · …)
```

### Recursive subprocess shim

`transport.ts` wraps `child_process.spawn/exec/execFile/fork` and injects `NODE_OPTIONS --import=<handler.js>` into every child's env. `hook-shim/handler.js` re-runs `installHeadroomTransport` in the child, so subprocesses that make their own provider HTTP calls route through Headroom too. The shim path resolves relative to `dist/`, so it works from `node_modules`.

## Comparison with the official plugin

| | `headroom-opencode` (official) | `headroom-opencode-standalone` (this) |
|---|---|---|
| Proxy lifecycle | assumes one is running (`headroom wrap`) | spawns & manages its own |
| Transport surface | fetch + http/https + http2 + child_process | same — full parity |
| `x-headroom-original-path` | yes | yes |
| Proxy unreachable | hard-fails | **graceful fallback to direct** (no compression) |
| `headroom wrap` required | yes | **no** |
| Scoped `@opencode-ai/plugin` peer dep | yes | yes |

## Environment

| Variable | Default | Description |
|---|---|---|
| `HEADROOM_PROXY_PORT` | `0` | `0` = free port per instance; set to force a shared proxy |
| `HEADROOM_BIN` | `~/.local/bin/headroom` | Path to the `headroom` CLI |
| `HEADROOM_NO_HTTP2` | unset | `1` disables http/2 (fixes TLS corruption under heavy concurrent streams) |
| `HEADROOM_ANTHROPIC_URL` | unset | Anthropic upstream — routed via `ANTHROPIC_TARGET_API_URL` (Anthropic handler ignores `x-headroom-base-url` until [PR #1502](https://github.com/headroomlabs-ai/headroom)) |
| `HEADROOM_PROXY_URL` | unset | Reuse an externally-managed proxy instead of spawning one |

## Development

```bash
git clone https://github.com/shutovks/headroom-opencode-standalone.git
cd headroom-opencode-standalone
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/
npm test            # vitest run
```

### Project layout

```
src/
  config.ts      env knobs + shared constants (STATE_KEY is distinct from the
                 official plugin so both never collide if loaded together)
  proxy.ts       spawn/health/kill lifecycle; reuses HEADROOM_PROXY_URL if set
  transport.ts   fetch + node:http/https/http2 + child_process patching
  retrieve.ts    headroom_retrieve tool (POST /v1/retrieve, hash + query)
  plugin.ts      entry: ensureProxy → installTransport → {dispose, tool, shell.env}
  index.ts       public exports
hook-shim/
  handler.js     loaded via NODE_OPTIONS --import in subprocesses
tests/
  transport.test.ts   routing-helper unit tests
```

### Releasing

Tags drive releases. With `NPM_TOKEN` set as a repo secret:

```bash
git tag v0.1.0
git push origin v0.1.0   # → release.yml builds, tests, publishes to npm, cuts a GitHub Release
```

## Limitations

- The `headroom` CLI must be installed separately (`headroom-ai[all]`); this package is the OpenCode glue, not Headroom itself.
- `headroom_retrieve` uses the POST-with-query variant of the retrieve API (matches OpenCode's advertised tool contract). If your Headroom build only supports `GET /v1/retrieve/<hash>`, adjust `src/retrieve.ts`.
- Provenance/trusted publishing isn't wired — releases use a long-lived `NPM_TOKEN`. Switch to OIDC trusted publishing if you want to drop the token.

## Contributing

PRs welcome. Keep the diff minimal, run `npm run typecheck && npm run build && npm test` before submitting. Deliberate simplifications are marked with `ponytail:` comments — respect their intent or remove the comment when upgrading.

## License

[MIT](LICENSE)
