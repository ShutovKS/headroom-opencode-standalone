import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { accessSync, constants } from "node:fs"
import { installHeadroomTransport } from "./transport.js"
import { ensureProxy, getProxyUrl, killProxy, spawnedByMe } from "./proxy.js"
import { createHeadroomRetrieveTool } from "./retrieve.js"
import { HEADROOM_BIN } from "./config.js"

export const HeadroomPlugin: Plugin = async (input) => {
  // Check the exact binary we'll spawn, not PATH — HEADROOM_BIN may point
  // off-PATH and `which headroom` would wrongly disable compression.
  let binOk = true
  try {
    accessSync(HEADROOM_BIN, constants.X_OK)
  } catch {
    binOk = false
  }

  const proxyUrl = await ensureProxy(binOk)
  if (!proxyUrl) {
    console.warn("[headroom] no proxy available — compression disabled")
    return {}
  }

  process.env.HEADROOM_PROXY_URL = proxyUrl
  const uninstall = installHeadroomTransport({ proxyUrl })
  const retrieve = createHeadroomRetrieveTool({ proxyBaseUrl: proxyUrl })

  return {
    dispose: async () => {
      uninstall()
      // ponytail: only kill a proxy we spawned — never a shared/external one.
      if (spawnedByMe()) killProxy()
    },
    tool: {
      headroom_retrieve: tool({
        description: retrieve.description,
        args: {
          hash: tool.schema
            .string()
            .regex(/^[a-f0-9]{24}$/i, "Expected 24-character hex hash"),
          query: tool.schema.string().optional(),
        },
        async execute(args) {
          return retrieve.execute(args)
        },
      }),
    },
    "shell.env": async (_input, output) => {
      output.env.HEADROOM_PROXY_URL = getProxyUrl()
      output.env.HEADROOM_ACTIVE = "1"
      output.env.HEADROOM_PROJECT =
        (input.project as { id?: string }).id ?? input.directory
    },
  }
}

export default HeadroomPlugin
