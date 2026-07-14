import { defineConfig } from "tsup"

// ponytail: single ESM entry, bundled (no code-split) so hook-shim/handler.js
// can `import { installHeadroomTransport } from "../dist/index.js"` — the
// export lives in the one chunk tsup emits.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
})
