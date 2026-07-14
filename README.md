# headroom-opencode-standalone

> [Headroom](https://github.com/headroomlabs-ai/headroom) context compression for [OpenCode](https://opencode.ai) — spawns the proxy, intercepts provider traffic, exposes reversible compression.

[![CI](https://github.com/shutovks/headroom-opencode-standalone/actions/workflows/ci.yml/badge.svg)](https://github.com/shutovks/headroom-opencode-standalone/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@shutovks/headroom-opencode-standalone)](https://www.npmjs.com/package/@shutovks/headroom-opencode-standalone)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)

Compresses everything your AI agent reads — tool outputs, logs, files, conversation history — before it reaches the LLM. Same answers, a fraction of the tokens. Runs locally; your data stays on your machine.

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

The plugin starts the local `headroom` proxy automatically and stops it when OpenCode exits. If no `headroom` binary is on `PATH`, it loads as a no-op — your session runs normally, just without compression.

## Environment

| Variable | Default | Description |
|---|---|---|
| `HEADROOM_PROXY_PORT` | `0` | `0` = free port per instance; set to force a shared proxy port |
| `HEADROOM_BIN` | `~/.local/bin/headroom` | Path to the `headroom` CLI |
| `HEADROOM_NO_HTTP2` | unset | `1` disables http/2 (fixes TLS corruption under heavy concurrent streams) |
| `HEADROOM_ANTHROPIC_URL` | unset | Anthropic upstream URL (Anthropic handler ignores per-request routing until headroom PR #1502 lands) |
| `HEADROOM_PROXY_URL` | unset | Reuse an externally-managed proxy instead of spawning one |

## License

[MIT](LICENSE)
