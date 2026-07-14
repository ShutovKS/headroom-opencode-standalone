export { HeadroomPlugin } from "./plugin.js"
export { default } from "./plugin.js"
export {
  installHeadroomTransport,
  uninstallHeadroomTransport,
  shouldRoute,
  normalizedOpenAiProxyPath,
  routedUrlForOpenCode,
} from "./transport.js"
export type { InstallOptions } from "./transport.js"
export { createHeadroomRetrieveTool } from "./retrieve.js"
export type { RetrieveToolConfig, RetrieveResult } from "./retrieve.js"
export { ensureProxy, killProxy, getProxyUrl, spawnedByMe, logThrottled } from "./proxy.js"
