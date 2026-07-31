export interface RetrieveToolConfig {
  proxyBaseUrl: string
}

const HASH_RE = /^[a-f0-9]{24}$/i

export interface RetrieveResult {
  title: string
  output: string
}

export function createHeadroomRetrieveTool(config: RetrieveToolConfig) {
  const origin = config.proxyBaseUrl.replace(/\/+$/, "")

  return {
    description:
      "Retrieve the full, original version of a compressed context chunk by its hash. " +
        "Retrieval is by hash and always returns the full original content.",
    async execute(args: {
      hash: string
    }): Promise<RetrieveResult> {
      if (!HASH_RE.test(args.hash)) {
        return {
          title: "Headroom CCR",
          output: `Invalid hash (expected 24 hex chars): ${args.hash}`,
        }
      }

      try {
        const res = await fetch(`${origin}/v1/retrieve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hash: args.hash }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          return {
            title: "Headroom CCR",
            output: `CCR retrieve failed (${res.status}): ${text}`,
          }
        }
        const data = await res.json()
        return {
          title: "Headroom CCR",
          output:
            typeof data === "string"
              ? data
              : (data.original_content ?? JSON.stringify(data, null, 2)),
        }
      } catch (error) {
        return {
          title: "Headroom CCR",
          output: `CCR retrieve failed: ${error}`,
        }
      }
    },
  }
}
