import { installHeadroomTransport } from "../dist/transport.js"

const proxyUrl = process.env.HEADROOM_OPENCODE_TRANSPORT_PROXY_URL
if (!proxyUrl) {
  throw new Error(
    "headroom-opencode-standalone transport shim loaded without HEADROOM_OPENCODE_TRANSPORT_PROXY_URL",
  )
}

installHeadroomTransport({ proxyUrl })
