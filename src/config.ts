// ponytail: headroom 0.30 honors x-headroom-base-url only on the OpenAI
// handler (openai.py); the Anthropic handler still ignores it (PR #1502
// not landed). So OpenAI-compatible providers (e.g. cpa) route per-request
// to any upstream; Anthropic-protocol providers fall back to a single
// ANTHROPIC_TARGET_API_URL (set via HEADROOM_ANTHROPIC_URL).

// 0 = auto free port; set HEADROOM_PROXY_PORT to force a shared proxy.
export const FIXED_PORT = Number(process.env.HEADROOM_PROXY_PORT) || 0
export const BASE_URL_HEADER = "x-headroom-base-url"
export const ORIGINAL_PATH_HEADER = "x-headroom-original-path"
export const PROXY_ENV = "HEADROOM_OPENCODE_TRANSPORT_PROXY_URL"
// ponytail: distinct symbol so this plugin's transport state never collides
// with the official headroom-opencode transport if both happen to load.
export const STATE_KEY = Symbol.for(
  "headroom.opencode.transport.standalone",
)
export const HEADROOM_BIN =
  process.env.HEADROOM_BIN ?? `${process.env.HOME}/.local/bin/headroom`
// ponytail: http/2 can corrupt TLS under many cancelled concurrent streams
// (headroom proxy --help). Default keeps http/2; set to "1" if stability
// issues persist under heavy multi-instance load.
export const NO_HTTP2 = process.env.HEADROOM_NO_HTTP2 === "1"
