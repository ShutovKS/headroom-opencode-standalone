import { defineConfig } from "tsup"

// Two ESM entries, each bundled (no code-split) so:
//   - dist/index.js exports ONLY the plugin. opencode's loader calls every
//     named export as a plugin factory; helpers here would get PluginInput
//     and break.
//   - dist/transport.js exports installHeadroomTransport for hook-shim/
//     handler.js (which imports from "../dist/transport.js").
// Shared state across the two chunks is fine: STATE_KEY is a Symbol on
// globalThis, and each chunk runs in its own process anyway.
export default defineConfig({
  entry: ["src/index.ts", "src/transport.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
})
