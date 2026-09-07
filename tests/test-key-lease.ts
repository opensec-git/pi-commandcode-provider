import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { CommandCodeKeyLeaseManager } from "../src/key-lease.ts"
import type { RequestPerformance } from "../src/metrics.ts"
import type { AssistantMessageEvent } from "../src/types.ts"
import { makeModel } from "./helpers.ts"

function lease(index: number, expiresAt = new Date(Date.now() + 300_000).toISOString()) {
  return {
    leaseId: `00000000-0000-4000-8000-00000000000${index}`,
    sessionId: "session-1",
    accountId: `00000000-0000-4000-8000-00000000001${index}`,
    model: "model",
    apiKey: `upstream-key-${index}`,
    keyFingerprint: `key_••••_0000000${index}`,
    issuedAt: new Date().toISOString(),
    expiresAt,
  }
}

describe("OpenSec CommandCode key leasing", () => {
  it("keeps one session key without timer-based lease renewal", async () => {
    let leaseCalls = 0
    const manager = new CommandCodeKeyLeaseManager({
      env: {
        OPENSEC_ROUTER_URL: "https://router.test/cc",
        OPENSEC_ROUTER_TOKEN: "master-token",
      },
      fallbackSessionId: "session-1",
      fetchImpl: async () => {
        leaseCalls += 1
        return Response.json(lease(1, new Date(Date.now() - 1).toISOString()))
      },
    })

    const first = await manager.resolve(makeModel(), { sessionId: "session-1" })
    const second = await manager.resolve(makeModel(), { sessionId: "session-1" })

    assert.equal(first?.apiKey, "upstream-key-1")
    assert.equal(second?.apiKey, "upstream-key-1")
    assert.equal(leaseCalls, 1)
  })

  it("rotates once on a CommandCode quota response and keeps requests direct", async () => {
    let leaseCalls = 0
    const leaseBodies: Array<Record<string, unknown>> = []
    const manager = new CommandCodeKeyLeaseManager({
      env: {
        OPENSEC_ROUTER_URL: "https://router.test/cc",
        OPENSEC_ROUTER_TOKEN: "master-token",
      },
      fetchImpl: async (_input, init) => {
        leaseCalls += 1
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        leaseBodies.push(body)
        return Response.json(lease(body.forceRotate ? 2 : 1))
      },
    })
    const providerKeys: string[] = []
    const directFetch: typeof fetch = async (_input, init) => {
      providerKeys.push(new Headers(init?.headers).get("authorization") ?? "")
      return new Response("ok", { status: providerKeys.length === 1 ? 429 : 200 })
    }

    const options = await manager.resolve(makeModel(), {
      apiKey: "master-token",
      sessionId: "session-1",
      fetch: directFetch,
    })
    const response = await options?.fetch?.("https://api.commandcode.ai/provider/v1/chat", {
      headers: { authorization: "Bearer upstream-key-1" },
    })

    assert.equal(response?.status, 200)
    assert.equal(leaseCalls, 2)
    assert.equal(leaseBodies[1].forceRotate, true)
    assert.equal(leaseBodies[1].excludeAccountId, lease(1).accountId)
    assert.deepEqual(providerKeys, ["Bearer upstream-key-1", "Bearer upstream-key-2"])
  })

  it("reports rich direct-stream telemetry asynchronously against the lease", async () => {
    let resolveUsage!: (body: Record<string, unknown>) => void
    const usage = new Promise<Record<string, unknown>>((resolve) => {
      resolveUsage = resolve
    })
    const manager = new CommandCodeKeyLeaseManager({
      env: {
        OPENSEC_ROUTER_URL: "https://router.test/cc",
        OPENSEC_ROUTER_TOKEN: "master-token",
      },
      fetchImpl: async (input, init) => {
        if (String(input).includes("/usage")) {
          resolveUsage(JSON.parse(String(init?.body)) as Record<string, unknown>)
          return new Response(null, { status: 202 })
        }
        return Response.json(lease(1))
      },
    })
    await manager.resolve(makeModel(), { sessionId: "session-1" })
    const model = makeModel()
    const event: AssistantMessageEvent = {
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 600,
          output: 200,
          cacheRead: 300,
          cacheWrite: 100,
          totalTokens: 1_200,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    }
    const performance: RequestPerformance = {
      startedAt: 1_000,
      firstTokenAt: 1_200,
      completedAt: 3_200,
      totalDurationMs: 2_200,
      generationDurationMs: 2_000,
      ttftMs: 200,
      tps: 100,
    }
    manager.observe(event, model, "upstream-key-1", performance)

    const body = await usage
    assert.equal(body.cacheHitRate, 0.3)
    assert.equal(body.tps, 100)
    assert.equal(body.ttftMs, 200)
    assert.equal(body.costSource, "commandcode-price-estimate")
  })
})

console.log("CommandCode key lease tests passed")
