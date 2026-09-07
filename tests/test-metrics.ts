import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  aggregateCommandCodeMetrics,
  calculateCacheHitRate,
  calculateTps,
  formatCommandCodeMetrics,
} from "../src/metrics.ts"

describe("CommandCode request metrics", () => {
  it("uses all prompt-side tokens for cache hit rate", () => {
    assert.equal(calculateCacheHitRate({ input: 600, cacheRead: 300, cacheWrite: 100 }), 0.3)
  })

  it("calculates output TPS from first-token-to-completion duration", () => {
    assert.equal(calculateTps(250, 2_000), 125)
    assert.equal(calculateTps(10, undefined), undefined)
  })

  it("aggregates weighted cache, TPS, TTFT, and estimated cost", () => {
    const summary = aggregateCommandCodeMetrics([
      {
        timestamp: 1,
        model: "model-a",
        input: 600,
        output: 100,
        cacheRead: 300,
        cacheWrite: 100,
        costUsd: 0.01,
        cacheHitRate: 0.3,
        generationDurationMs: 2_000,
        ttftMs: 200,
        tps: 50,
        status: "completed",
      },
      {
        timestamp: 2,
        model: "model-b",
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0.002,
        cacheHitRate: 0,
        generationDurationMs: 500,
        ttftMs: 400,
        tps: 100,
        status: "failed",
      },
    ])

    assert.equal(summary.requests, 2)
    assert.equal(summary.cacheHitRate, 300 / 1_100)
    assert.equal(summary.averageRequestCacheHitRate, 0.15)
    assert.equal(summary.weightedTps, 150 / 2.5)
    assert.equal(summary.averageRequestTps, 75)
    assert.equal(summary.averageTtftMs, 300)
    assert.equal(summary.costUsd, 0.012)
    assert.equal(summary.failedRequests, 1)
    assert.match(formatCommandCodeMetrics(summary), /Estimated cost \$0\.0120/)
  })
})

console.log("CommandCode metrics tests passed")
