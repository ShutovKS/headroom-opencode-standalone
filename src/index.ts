// ponytail: ONLY export the plugin. opencode's plugin loader calls every
// named export of this module as a plugin factory with PluginInput — any
// helper exported here would be invoked with the wrong arg shape and either
// throw (createHeadroomRetrieveTool on .proxyBaseUrl.replace) or corrupt
// shared state (installHeadroomTransport overwriting proxyUrl). Helpers
// live in dist/transport.js (separate tsup entry) for the hook-shim to
// import; tests import directly from src/*.ts.
export { HeadroomPlugin } from "./plugin.js"
export { default } from "./plugin.js"
