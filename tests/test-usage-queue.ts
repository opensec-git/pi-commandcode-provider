import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { UsageQueue, type UsageReport } from "../src/usage-queue.ts"

const originalNow = Date.now
afterEach(() => {
  Date.now = originalNow
})
const report = (id = crypto.randomUUID()): UsageReport => ({
  eventId: id,
  leaseId: crypto.randomUUID(),
  occurredAt: new Date().toISOString(),
  model: "test",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  status: "completed",
})

describe("bounded OpenSec usage reporting", () => {
  it("batches without mixing member credentials and keeps stable IDs across retry", async () => {
    let now = originalNow()
    Date.now = () => now
    const received: { token: string; body: { events: UsageReport[] } }[] = []
    const queue = new UsageQueue("https://router.test/api/router/usage", async (_url, init) => {
      assert.equal(init?.redirect, "error")
      received.push({
        token: new Headers(init?.headers).get("authorization")!,
        body: JSON.parse(String(init?.body)),
      })
      return new Response(null, { status: received.length === 1 ? 503 : 202 })
    })
    const first = report()
    queue.enqueue("alice", first)
    queue.enqueue("bob", report())
    queue.enqueue("alice", report())
    await queue.flush()
    assert.equal(received[0].body.events.length, 2)
    now += 5000
    await queue.flush()
    await queue.flush()
    assert.equal(received[0].token, "Bearer alice")
    assert.equal(received[1].body.events[0].eventId, first.eventId)
    assert.equal(received[2].token, "Bearer bob")
    assert.equal(queue.stats.sent, 3)
  })
  it("reports safe HTTP rejection reasons without logging bodies or arbitrary headers", async () => {
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (value) => warnings.push(String(value))
    try {
      for (const code of ["invalid_report", "fixture-secret"]) {
        const queue = new UsageQueue(
          "https://router.test",
          async () =>
            new Response("fixture-secret", {
              status: 400,
              headers: { "x-opensec-error-code": code },
            }),
        )
        queue.enqueue("fixture-secret", report())
        await queue.flush()
        assert.equal(queue.stats.dropped, 1)
        assert.equal(
          queue.stats.lastDropReason,
          code === "invalid_report" ? "HTTP 400 (invalid_report)" : "HTTP 400",
        )
        await queue.shutdown()
      }
      assert.match(warnings.join("\n"), /HTTP 400 \(invalid_report\)/)
      assert.doesNotMatch(warnings.join("\n"), /fixture-secret/)
    } finally {
      console.warn = warn
    }
  })
  it("identifies exhausted timeout retries without exposing exception text", async () => {
    let now = originalNow()
    Date.now = () => now
    const queue = new UsageQueue("https://router.test", async () => {
      throw new DOMException("fixture-secret", "TimeoutError")
    })
    queue.enqueue("member", report())
    for (let i = 0; i < 5; i++) {
      await queue.flush()
      now += 40_000
    }
    assert.equal(queue.stats.dropped, 1)
    assert.equal(
      queue.stats.lastDropReason,
      "retry budget exhausted: upload timed out after five seconds",
    )
    await queue.shutdown()
  })
  it("keeps valid reports when a batch contains an invalid report", async () => {
    let calls = 0
    const queue = new UsageQueue("https://router.test", async () => {
      calls++
      return new Response(null, {
        status: 202,
        headers: { "x-opensec-usage-rejected": "1:lease_not_found" },
      })
    })
    for (let i = 0; i < 3; i++) queue.enqueue("member", report())
    await queue.flush()
    await queue.shutdown()
    assert.equal(calls, 1)
    assert.equal(queue.stats.sent, 2)
    assert.equal(queue.stats.dropped, 1)
    assert.equal(queue.stats.lastDropReason, "report rejected: lease_not_found")
  })
  it("retries an invalid acknowledgement with stable event IDs", async () => {
    let now = originalNow()
    Date.now = () => now
    const bodies: string[] = []
    const queue = new UsageQueue("https://router.test", async (_url, init) => {
      bodies.push(String(init?.body))
      return new Response(null, {
        status: 202,
        headers: bodies.length === 1 ? { "x-opensec-usage-rejected": "99:invalid_report" } : {},
      })
    })
    queue.enqueue("member", report())
    await queue.flush()
    assert.equal(queue.stats.sent, 0)
    now += 5000
    await queue.flush()
    assert.equal(queue.stats.sent, 1)
    assert.equal(queue.stats.dropped, 0)
    assert.equal(bodies[0], bodies[1])
    await queue.shutdown()
  })
  it("waits for the jittered interval but flushes a full batch immediately", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    let calls = 0
    const queue = new UsageQueue("https://router.test", async () => {
      calls++
      return new Response(null, { status: 202 })
    })
    queue.enqueue("member", report())
    t.mock.timers.tick(9999)
    assert.equal(calls, 0)
    t.mock.timers.tick(5001)
    assert.equal(calls, 1)
    // Let the already-started upload clear its single-flight marker.
    await Promise.resolve()
    await Promise.resolve()
    for (let i = 0; i < 25; i++) queue.enqueue("member", report())
    t.mock.timers.tick(0)
    assert.equal(calls, 2)
    await queue.shutdown()
  })
  it("sends large queues in batches of at most 25", async () => {
    const sizes: number[] = []
    const queue = new UsageQueue("https://router.test", async (_url, init) => {
      sizes.push(JSON.parse(String(init?.body)).events.length)
      return new Response(null, { status: 202 })
    })
    for (let i = 0; i < 60; i++) queue.enqueue("member", report())
    await queue.shutdown()
    assert.deepEqual(sizes, [25, 25, 10])
    assert.equal(queue.stats.sent, 60)
  })
  it("counts in-flight bytes toward the cap and permits only one upload", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const queue = new UsageQueue(
      "https://router.test",
      async () => {
        calls++
        await blocked
        return new Response(null, { status: 202 })
      },
      1024,
    )
    queue.enqueue("alice", report())
    const pending = queue.flush()
    for (let i = 0; i < 100; i++) queue.enqueue("alice", report())
    await queue.flush()
    assert.equal(calls, 1)
    assert.ok(queue.stats.dropped > 90)
    assert.equal(queue.stats.lastDropReason, "queue capacity exceeded")
    release()
    await pending
    await queue.flush()
  })
  it("does not retry permanent rejection and honors Retry-After", async () => {
    let now = originalNow()
    Date.now = () => now
    let calls = 0
    const queue = new UsageQueue("https://router.test", async () => {
      calls++
      return new Response(null, {
        status: calls === 1 ? 429 : 401,
        headers: { "Retry-After": "60" },
      })
    })
    queue.enqueue("alice", report())
    await queue.flush()
    now += 30_000
    await queue.flush()
    assert.equal(calls, 1)
    now += 31_000
    await queue.flush()
    await queue.flush()
    assert.equal(calls, 2)
    assert.equal(queue.stats.dropped, 1)
  })
})

describe("bounded shutdown drain", () => {
  it("drains multiple batches and member tokens", async () => {
    const batches: number[] = []
    const queue = new UsageQueue("https://router.test", async (_url, init) => {
      batches.push(JSON.parse(String(init?.body)).events.length)
      return new Response(null, { status: 202 })
    })
    for (let i = 0; i < 25; i++) queue.enqueue(i < 18 ? "alice" : "bob", report())
    await queue.shutdown()
    assert.deepEqual(batches, [18, 7])
    assert.equal(queue.stats.sent, 25)
    assert.equal(queue.stats.dropped, 0)
  })
  it("waits for an active upload then drains the remaining batch", async () => {
    let release!: () => void,
      calls = 0
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const queue = new UsageQueue("https://router.test", async () => {
      if (++calls === 1) await ready
      return new Response(null, { status: 202 })
    })
    for (let i = 0; i < 30; i++) queue.enqueue("member", report())
    const upload = queue.flush()
    const drain = queue.shutdown()
    release()
    await Promise.all([upload, drain])
    assert.equal(calls, 2)
    assert.equal(queue.stats.sent, 30)
  })
  it("honors backoff instead of uploading again during a short shutdown deadline", async () => {
    let calls = 0
    const queue = new UsageQueue("https://router.test", async () => {
      calls++
      return new Response(null, { status: 429, headers: { "retry-after": "60" } })
    })
    queue.enqueue("member", report())
    await queue.flush()
    const start = performance.now()
    await queue.shutdown(30)
    assert.equal(calls, 1)
    assert.ok(performance.now() - start < 500)
    assert.equal(queue.stats.dropped, 1)
  })
  it("aborts an active upload when its shutdown deadline expires", async () => {
    let aborted = false
    const queue = new UsageQueue("https://router.test", async (_url, init) => {
      await new Promise<void>((resolve) =>
        init!.signal!.addEventListener(
          "abort",
          () => {
            aborted = true
            resolve()
          },
          { once: true },
        ),
      )
      throw new Error("aborted")
    })
    queue.enqueue("member", report())
    const upload = queue.flush()
    await queue.shutdown(30)
    await upload
    assert.equal(aborted, true)
    assert.equal(queue.stats.dropped, 1)
  })
})
