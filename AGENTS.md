# AGENTS.md

Guidance for AI coding agents working on this repo. Read this before editing.

## Commands

```bash
npm run typecheck   # tsc --noEmit — run after every source edit
npm run build       # tsup → dist/ (index.js + transport.js + shared chunk)
npm test            # vitest run — routing-helper unit tests
npm run test:e2e    # bun test — opencode session smoke test (local only)
```

Always run `typecheck` + `build` + `test` after changes. Run `test:e2e` when touching the plugin entry, exports, or hook-shim. Never commit `dist/` or stray `*.js`/`*.d.ts` next to sources — they are gitignored; tsup owns `dist/`.

## Architecture

This is an OpenCode plugin (`@opencode-ai/plugin`) that wraps a local `headroom` proxy. It is the standalone counterpart to the official `headroom-opencode` — the difference is proxy lifecycle: the official assumes a running proxy (`headroom wrap`); this spawns its own.

Files:

- `src/config.ts` — env knobs + constants. `STATE_KEY` is `Symbol.for("headroom.opencode.transport.standalone")`, deliberately distinct from the official so both plugins never share transport state if loaded together.
- `src/proxy.ts` — `headroom proxy` spawn/health/kill. `ensureProxy()` reuses `HEADROOM_PROXY_URL` if set (externally-managed proxy), else spawns. Captures module-level state (`proxyProcess`, `spawnedByUs`, `proxyUrl`).
- `src/transport.ts` — the core. Patches `fetch`, `node:http`/`https` (`request`/`get`), `http2.connect`, and `child_process` (`spawn`/`exec`/`execFile`/`fork`). The child wrappers inject `NODE_OPTIONS --import=<hook-shim/handler.js>` so subprocesses re-run `installHeadroomTransport` in themselves. Uses `createRequire` + `syncBuiltinESMExports` because ESM `node:http` is a frozen snapshot. Fetch has a graceful fallback: proxy unreachable → route direct (no compression), throttled warning. Pure routing helpers (`shouldRoute`, `normalizedOpenAiProxyPath`, `routedUrlForOpenCode`) take an explicit `proxy: URL` so they're unit-testable.
- `src/retrieve.ts` — `headroom_retrieve` tool. POST `/v1/retrieve` with `{hash, query?}` (matches OpenCode's advertised tool contract). Returns `{title, output}` for the opencode tool format.
- `src/plugin.ts` — entry. `ensureProxy` → `installHeadroomTransport` → returns `{dispose, tool, shell.env}`. Only kills a proxy it spawned.
- `src/index.ts` — public entry. Exports ONLY `HeadroomPlugin` (named + default). opencode's plugin loader calls every named export of the loaded module as a plugin factory with `PluginInput`; any helper exported here would be invoked with the wrong arg shape and either throw (`createHeadroomRetrieveTool` on `.proxyBaseUrl.replace`) or corrupt shared state (`installHeadroomTransport` overwriting `proxyUrl`). Helpers stay reachable for tests via direct `src/*.ts` imports.
- `hook-shim/handler.js` — plain ESM, not built by tsup. Imports `installHeadroomTransport` from `../dist/transport.js` (the helpers entry). Path in `transport.ts` is `new URL("../hook-shim/handler.js", import.meta.url)` — resolves from `dist/`, so works under `node_modules`.

## Conventions

- ESM only (`"type": "module"`). Imports between `src/` files use `.js` extensions (NodeNext).
- `@opencode-ai/plugin` is a peer dependency — consumers provide it. It's a devDependency only for building.
- `ponytail:` comments mark deliberate simplifications with their ceiling and upgrade path. When changing such code, either preserve the shortcut or remove the comment and implement the upgrade — don't leave a stale `ponytail:` note.
- No comments unless they convey non-obvious intent (the codebase already follows this; match it).
- tsup builds TWO entries: `src/index.ts` → `dist/index.js` (exports only the plugin) and `src/transport.ts` → `dist/transport.js` (re-exports `installHeadroomTransport` etc. for the hook-shim). A shared chunk holds the implementation. This split is load-bearing: opencode's loader calls every named export of `dist/index.js` as a plugin factory, so helpers must NOT live in that module — they'd get called with `PluginInput` and break. Don't collapse to one entry without an alternative way to keep helpers away from opencode's scanner. Don't enable `splitting: true` explicitly; tsup's default chunking already produces what the shim needs (`../dist/transport.js`).
- `@types/bun` is a devDependency only for type-checking `tests/e2e/*.ts` (the e2e suite uses `bun:test` and Bun globals). It does not affect the published package or the runtime.

## Release

`git tag v*` → `.github/workflows/release.yml` builds, tests, publishes to npm via `NPM_TOKEN` secret (with `--provenance` OIDC attestation — needs `id-token: write`), and cuts a GitHub Release via `gh release create`. The publish is idempotent: it checks `npm view <name>@<version>` first and skips if already published, so re-running a tag won't fail. A manual `workflow_dispatch` run is a no-op for publishing (the `if: github.ref_type == 'tag'` guard ensures only real tags publish). Bump `version` in `package.json` to match the tag.

CI/release patterns are adopted from `ShutovKS/opencode-model-fallback` (idempotent publish, provenance, tag guard, `gh release create`). That repo uses Bun for everything; this one splits: vitest for unit tests (CI gate), bun for the e2e smoke test (local only — needs the `opencode` binary on PATH). The e2e does not need the `headroom` binary or provider keys (a loopback fake provider + a dummy `HEADROOM_PROXY_URL` stand in). Don't merge the runners unless you also drop vitest for `bun test` across the board.

## Testing

Unit tests cover the pure routing helpers in `tests/transport.test.ts` (vitest). The transport patching itself (fetch/http/child_process monkeypatching) is not unit-tested — it's a faithful port of `headroom-opencode`'s `transport.ts`; verify behavior changes against the official implementation. If you add a routing helper, add a test for it.

The e2e suite (`tests/e2e/`, run via `npm run test:e2e` → `bun test`) is a **smoke test**, not a transport-routing test. It spawns a real `opencode run` session against a loopback fake OpenAI-compatible provider and asserts: (a) the plugin loads without error, (b) the session completes (exit 0), (c) the fake provider received a `/chat/completions` call. It does NOT assert that provider traffic routes through the proxy — opencode's AI-SDK HTTP path in the isolated test config does not go through `globalThis.fetch`/`http.request`, so JS-layer patching is not reachable there. Transport routing is verified by the unit tests and by manual production sessions (where the host's `~/.config/opencode/plugins/headroom.ts` is loaded and the AI-SDK path does route through the patched fetch). To test real compression + retrieve round-trip, run a real `headroom` binary against a provider that returns large context — that's a manual check, not automated.

The e2e isolates opencode from the host's `~/.config/opencode` (temp `HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME`) so only the inline-config plugin loads. `HEADROOM_PROXY_URL` is set to a dummy loopback URL so `ensureProxy` reuses it and never spawns a real `headroom` binary. Requires `opencode` on `PATH` (not `headroom` — the stub stands in for it). Not run in CI by design (needs the `opencode` binary; the unit suite is the CI gate).

`tests/e2e/headroom-live.test.ts` is a **gated** integration test against the real `headroom` binary. Skipped unless `HEADROOM_LIVE=1` is set AND `headroom` is on `PATH`. It verifies: the plugin's `ensureProxy` spawn/health contract holds against a real binary (starts, `/health` returns 200, responds to a `chat.completions` request, kills cleanly on SIGTERM). It does NOT verify real compression — headroom's compression pipeline requires a real client context (a live Claude Code / Codex / opencode session) and a working upstream that returns a valid response; a raw `fetch` with a large body hangs in the compression pipeline without a registered client. Compression is verified manually in a production opencode session. Run with `HEADROOM_LIVE=1 npm run test:e2e`.
