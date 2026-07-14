import { describe, it, expect } from "vitest"
import {
  shouldRoute,
  normalizedOpenAiProxyPath,
  routedUrlForOpenCode,
} from "../src/transport.js"

const proxy = new URL("http://127.0.0.1:8787")

describe("shouldRoute", () => {
  it("routes http/https non-loopback upstreams", () => {
    expect(shouldRoute(new URL("https://api.openai.com/v1/x"), proxy)).toBe(true)
    expect(shouldRoute(new URL("http://api.example.com/v1"), proxy)).toBe(true)
  })

  it("skips loopback", () => {
    expect(shouldRoute(new URL("http://127.0.0.1:9999/x"), proxy)).toBe(false)
    expect(shouldRoute(new URL("http://localhost:9999/x"), proxy)).toBe(false)
    expect(shouldRoute(new URL("http://[::1]:9999/x"), proxy)).toBe(false)
  })

  it("skips the proxy origin itself", () => {
    expect(shouldRoute(new URL("http://127.0.0.1:8787/v1/retrieve"), proxy)).toBe(false)
  })

  it("skips non-http(s) schemes", () => {
    expect(shouldRoute(new URL("file:///x"), proxy)).toBe(false)
  })
})

describe("normalizedOpenAiProxyPath", () => {
  it("rewrites chat/completions suffix to /v1/chat/completions", () => {
    expect(normalizedOpenAiProxyPath("/api/coding/paas/v4/chat/completions")).toBe(
      "/v1/chat/completions",
    )
  })

  it("rewrites responses suffix to /v1/responses", () => {
    expect(normalizedOpenAiProxyPath("/foo/responses")).toBe("/v1/responses")
  })

  it("leaves non-openai-standard paths undefined", () => {
    expect(normalizedOpenAiProxyPath("/v1/messages")).toBeUndefined()
    expect(normalizedOpenAiProxyPath("/anything/else")).toBeUndefined()
  })
})

describe("routedUrlForOpenCode", () => {
  it("carries originalPath for non-standard openai paths", () => {
    const upstream = new URL(
      "https://api.cpa.example/api/coding/v4/chat/completions?x=1",
    )
    const { url, originalPath } = routedUrlForOpenCode(upstream, proxy)
    expect(url.href).toBe("http://127.0.0.1:8787/v1/chat/completions?x=1")
    expect(originalPath).toBe("/api/coding/v4/chat/completions")
  })

  it("has no originalPath for standard paths", () => {
    const upstream = new URL("https://api.anthropic.com/v1/messages")
    const { url, originalPath } = routedUrlForOpenCode(upstream, proxy)
    expect(url.href).toBe("http://127.0.0.1:8787/v1/messages")
    expect(originalPath).toBeUndefined()
  })

  it("preserves query string on standard paths", () => {
    const upstream = new URL("https://api.example.com/v1/messages?stream=true")
    const { url } = routedUrlForOpenCode(upstream, proxy)
    expect(url.href).toBe("http://127.0.0.1:8787/v1/messages?stream=true")
  })
})
