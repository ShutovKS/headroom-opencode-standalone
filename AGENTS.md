# AGENTS.md

Guidance for AI coding agents working on this repo. Read this before editing.

## Commands

```bash
npm run typecheck   # tsc --noEmit — run after every source edit
npm run build       # tsup → dist/ (single ESM chunk; hook-shim imports from it)
npm test            # vitest run — routing-helper unit tests
```

Always run `typecheck` + `build` + `test` after changes. Never commit `dist/` or stray `*.js`/`*.d.ts` next to sources — they are gitignored; tsup owns `dist/`.

## Architecture

This is an OpenCode plugin (`@opencode-ai/plugin`) that wraps a local `headroom` proxy. It is the standalone counterpart to the official `headroom-opencode` — the difference is proxy lifecycle: the official assumes a running proxy (`headroom wrap`); this spawns its own.

Files:

- `src/config.ts` — env knobs + constants. `STATE_KEY` is `Symbol.for("headroom.opencode.transport.standalone")`, deliberately distinct from the official so both plugins never share transport state if loaded together.
- `src/proxy.ts` — `headroom proxy` spawn/health/kill. `ensureProxy()` reuses `HEADROOM_PROXY_URL` if set (externally-managed proxy), else spawns. Captures module-level state (`proxyProcess`, `spawnedByUs`, `proxyUrl`).
- `src/transport.ts` — the core. Patches `fetch`, `node:http`/`https` (`request`/`get`), `http2.connect`, and `child_process` (`spawn`/`exec`/`execFile`/`fork`). The child wrappers inject `NODE_OPTIONS --import=<hook-shim/handler.js>` so subprocesses re-run `installHeadroomTransport` in themselves. Uses `createRequire` + `syncBuiltinESMExports` because ESM `node:http` is a frozen snapshot. Fetch has a graceful fallback: proxy unreachable → route direct (no compression), throttled warning. Pure routing helpers (`shouldRoute`, `normalizedOpenAiProxyPath`, `routedUrlForOpenCode`) take an explicit `proxy: URL` so they're unit-testable.
- `src/retrieve.ts` — `headroom_retrieve` tool. POST `/v1/retrieve` with `{hash, query?}` (matches OpenCode's advertised tool contract). Returns `{title, output}` for the opencode tool format.
- `src/plugin.ts` — entry. `ensureProxy` → `installHeadroomTransport` → returns `{dispose, tool, shell.env}`. Only kills a proxy it spawned.
- `hook-shim/handler.js` — plain ESM, not built by tsup. Imports `installHeadroomTransport` from `../dist/index.js`. Path in `transport.ts` is `new URL("../hook-shim/handler.js", import.meta.url)` — resolves from `dist/`, so works under `node_modules`.

## Conventions

- ESM only (`"type": "module"`). Imports between `src/` files use `.js` extensions (NodeNext).
- `@opencode-ai/plugin` is a peer dependency — consumers provide it. It's a devDependency only for building.
- `ponytail:` comments mark deliberate simplifications with their ceiling and upgrade path. When changing such code, either preserve the shortcut or remove the comment and implement the upgrade — don't leave a stale `ponytail:` note.
- No comments unless they convey non-obvious intent (the codebase already follows this; match it).
- tsup bundles `src/index.ts` into a single `dist/index.js` (no code-splitting) so the shim can import `installHeadroomTransport` from one chunk. Don't enable `splitting: true` without reworking the shim's import path.

## Release

`git tag v*` → `.github/workflows/release.yml` builds, tests, publishes to npm via `NPM_TOKEN` secret (with `--provenance` OIDC attestation — needs `id-token: write`), and cuts a GitHub Release via `gh release create`. The publish is idempotent: it checks `npm view <name>@<version>` first and skips if already published, so re-running a tag won't fail. A manual `workflow_dispatch` run is a no-op for publishing (the `if: github.ref_type == 'tag'` guard ensures only real tags publish). Bump `version` in `package.json` to match the tag.

CI/release patterns are adopted from `ShutovKS/opencode-model-fallback` (idempotent publish, provenance, tag guard, `gh release create`). That repo uses Bun + real-opencode e2e; this one stays on npm/tsup/vitest because a headroom e2e needs the `headroom` binary + provider keys in CI (non-deterministic, not free). Switch to Bun for cross-repo uniformity only if you also drop vitest for `bun test`.

## Testing

Unit tests cover the pure routing helpers in `tests/transport.test.ts`. The transport patching itself (fetch/http/child_process monkeypatching) is not unit-tested — it's a faithful port of `headroom-opencode`'s `transport.ts`; verify behavior changes against the official implementation. If you add a routing helper, add a test for it.
