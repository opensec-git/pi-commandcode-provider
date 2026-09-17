import { createHash } from "node:crypto"
import { configuredRouterToken, isOpenSecMemberToken, routerBaseUrl } from "./opensec-config.ts"
import { UsageQueue } from "./usage-queue.ts"
import type { ModelLike, StreamOptions } from "./types.ts"

interface KeyLease {
  leaseId: string
  sessionId: string
  accountId: string
  model: string
  apiKey: string
  keyFingerprint: string
  issuedAt: string
  expiresAt: string
}

interface LeaseRequest {
  sessionId: string
  model: string
  forceRotate?: boolean
  excludeAccountId?: string
  excludeAccountIds?: string[]
  expectedLeaseId?: string
  failedQuotaResetAt?: string
  failedQuotaWindow?: "fiveHour" | "weekly" | "monthly"
}

interface LeaseFailure {
  quota: boolean
  body: string
  resetAt?: string
  window?: "fiveHour" | "weekly" | "monthly"
}

function parseLease(value: unknown): KeyLease {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("OpenSec router returned an invalid lease")
  const data = value as Record<string, unknown>
  const fields = [
    "leaseId",
    "sessionId",
    "accountId",
    "model",
    "apiKey",
    "keyFingerprint",
    "issuedAt",
    "expiresAt",
  ] as const
  if (fields.some((field) => typeof data[field] !== "string" || !data[field]))
    throw new Error("OpenSec router returned an invalid lease")
  if (
    !Number.isFinite(Date.parse(String(data.issuedAt))) ||
    !Number.isFinite(Date.parse(String(data.expiresAt)))
  )
    throw new Error("OpenSec router returned an invalid lease")
  return data as unknown as KeyLease
}

const RENEWAL_WINDOW_MS = 60_000
const MAX_DISTINCT_ACCOUNT_ATTEMPTS = 64

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`
}

async function awaitLease<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task
  let aborted!: () => void
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        aborted = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
        signal.addEventListener("abort", aborted, { once: true })
        if (signal.aborted) aborted()
      }),
    ])
  } finally {
    signal.removeEventListener("abort", aborted)
  }
}

function resetAtFrom(body: string): string | undefined {
  const value = body.match(
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/i,
  )?.[0]
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
}

function quotaWindowFrom(body: string): LeaseFailure["window"] {
  if (/(?:5|five)[_ -]?hour(?:ly)?/i.test(body)) return "fiveHour"
  if (/weekly/i.test(body)) return "weekly"
  if (/monthly/i.test(body)) return "monthly"
  return undefined
}

async function leaseFailure(response: Response): Promise<LeaseFailure | undefined> {
  if ([401, 402].includes(response.status)) return { quota: response.status === 402, body: "" }
  if (![403, 429].includes(response.status)) return Promise.resolve(undefined)
  return await response
    .clone()
    .text()
    .then(
      // Command Code wraps exhausted rolling windows in rate_limit_error, so
      // classify the message's explicit capacity signal before its envelope.
      // Generic per-minute throttling still uses core backoff on the same key.
      (body) => {
        const quota =
          /quota|credits?|usage[_ -]?limit|exhausted|insufficient[_ -]?balance/i.test(body) ||
          /(?:5|five)[_ -]?hour(?:ly)?[_ -]?(?:usage[_ -]?)?limit|weekly[_ -]?(?:usage[_ -]?)?limit|monthly[_ -]?(?:usage[_ -]?)?limit/i.test(
            body,
          )
        return quota
          ? { quota: true, body, resetAt: resetAtFrom(body), window: quotaWindowFrom(body) }
          : undefined
      },
      () => undefined,
    )
}

function replaceAuthorization(
  init: RequestInit | undefined,
  apiKey: string,
  input: RequestInfo | URL,
): RequestInit {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  )
  if (headers.has("x-api-key")) headers.set("x-api-key", apiKey)
  headers.set("authorization", `Bearer ${apiKey}`)
  return { ...init, headers }
}

export class CommandCodeKeyLeaseManager {
  private readonly explicitRouter = Boolean(process.env.OPENSEC_ROUTER_URL?.trim())
  private readonly baseUrl = routerBaseUrl(process.env.OPENSEC_ROUTER_URL?.trim() || undefined)
  private readonly configuredToken = configuredRouterToken()
  private readonly leases = new Map<string, KeyLease>()
  private readonly queue = this.baseUrl
    ? new UsageQueue(joinUrl(this.baseUrl, "/api/router/usage"))
    : undefined
  private readonly renewalAfter = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<KeyLease>>()
  private readonly fallbackSession = `pi-${process.pid}-${crypto.randomUUID()}`

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  get enabled(): boolean {
    return this.explicitRouter || isOpenSecMemberToken(this.configuredToken)
  }

  private cacheKey(token: string, sessionId: string): string {
    // Fast in-memory identity for high-entropy API tokens, not password storage.
    // Keep token/session isolation without introducing a password KDF here.
    return createHash("sha256").update(token).digest("hex") + ":" + sessionId
  }

  async resolve(model: ModelLike, options?: StreamOptions): Promise<StreamOptions | undefined> {
    const token = this.configuredToken || options?.apiKey
    if (!this.explicitRouter && !isOpenSecMemberToken(token)) return options
    if (!token)
      throw new Error("OpenSec routing requires OPENSEC_ROUTER_TOKEN or a configured provider key")
    const sessionId = options?.sessionId || this.fallbackSession
    const cacheKey = this.cacheKey(token, sessionId)
    let lease = await this.acquire({ sessionId, model: model.id }, token, options?.signal)
    const fetchImpl = options?.fetch ?? fetch
    const eventId = crypto.randomUUID()
    let reported = false
    const routed: StreamOptions = {
      ...options,
      apiKey: lease.apiKey,
      onUsageEvent: (event) => {
        options?.onUsageEvent?.(event)
        if (reported || (event.type !== "done" && event.type !== "error")) return
        reported = true
        const message = event.type === "done" ? event.message : event.error
        this.queue?.enqueue(token, {
          eventId,
          leaseId: lease.leaseId,
          occurredAt: new Date().toISOString(),
          model: model.id,
          inputTokens: message.usage.input,
          outputTokens: message.usage.output,
          cacheReadTokens: message.usage.cacheRead,
          cacheWriteTokens: message.usage.cacheWrite,
          cost: message.usage.cost.total,
          status: event.type === "done" ? "completed" : "failed",
        })
      },
      fetch: async (input, init) => {
        const signals = [
          init?.signal,
          input instanceof Request ? input.signal : undefined,
          options?.signal,
        ].filter((signal): signal is AbortSignal => Boolean(signal))
        const signal = signals.length ? AbortSignal.any(signals) : undefined
        signal?.throwIfAborted()
        const requestInit = { ...init, signal }
        // Core retries may retain the original headers, while another request
        // has already replaced this session's failed key.
        lease = this.leases.get(cacheKey) ?? lease
        routed.apiKey = lease.apiKey
        const attemptedAccountIds = new Set<string>()
        for (;;) {
          const attempted = lease
          const response = await fetchImpl(
            input instanceof Request ? input.clone() : input,
            replaceAuthorization(requestInit, attempted.apiKey, input),
          )
          const failure = await leaseFailure(response)
          if (!failure) return response
          attemptedAccountIds.add(attempted.accountId)
          if (attemptedAccountIds.size >= MAX_DISTINCT_ACCOUNT_ATTEMPTS) return response

          const providerFailure = new Response(failure.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
          void response.body?.cancel().catch(() => undefined)

          let replacement: KeyLease
          try {
            replacement = await this.acquire(
              {
                sessionId,
                model: model.id,
                forceRotate: true,
                excludeAccountId: attempted.accountId,
                excludeAccountIds: [...attemptedAccountIds],
                expectedLeaseId: attempted.leaseId,
                failedQuotaResetAt: failure.quota ? failure.resetAt : undefined,
                failedQuotaWindow: failure.quota ? failure.window : undefined,
              },
              token,
              signal,
            )
          } catch (error) {
            if (signal?.aborted) throw error
            return providerFailure
          }
          // An older router may alternate between already-tried accounts. Keep
          // the useful provider error instead of looping or surfacing a router error.
          if (attemptedAccountIds.has(replacement.accountId)) return providerFailure
          lease = replacement
          routed.apiKey = replacement.apiKey
          signal?.throwIfAborted()
        }
      },
    }
    return routed
  }

  async flushUsage(): Promise<void> {
    await this.queue?.flush()
  }
  async shutdown(): Promise<void> {
    await this.queue?.shutdown(1500)
  }
  get telemetryStats() {
    return this.queue?.stats
  }

  private async acquire(
    request: LeaseRequest,
    token: string,
    signal?: AbortSignal,
  ): Promise<KeyLease> {
    signal?.throwIfAborted()
    // Stop this caller promptly without cancelling another caller's shared lease request.
    return awaitLease(this.acquireInternal(request, token, false), signal)
  }

  private async acquireInternal(
    request: LeaseRequest,
    token: string,
    bypassCache: boolean,
  ): Promise<KeyLease> {
    const cacheKey = this.cacheKey(token, request.sessionId)
    const cached = this.leases.get(cacheKey)
    if (
      request.forceRotate &&
      cached &&
      ((request.expectedLeaseId && cached.leaseId !== request.expectedLeaseId) ||
        (request.excludeAccountId && cached.accountId !== request.excludeAccountId))
    )
      return cached
    if (!request.forceRotate && cached && !bypassCache) {
      if (
        Date.parse(cached.expiresAt) <= Date.now() + RENEWAL_WINDOW_MS &&
        Date.now() >= (this.renewalAfter.get(cacheKey) ?? 0)
      ) {
        this.renewalAfter.set(cacheKey, Date.now() + 60_000)
        void this.acquireInternal(request, token, true).catch(() => undefined)
      }
      return cached
    }
    if (!this.baseUrl) throw new Error("OpenSec router URL is not configured")
    const requestKey = `${cacheKey}:${request.forceRotate ? `rotate:${request.expectedLeaseId ?? request.excludeAccountId ?? ""}:${request.failedQuotaResetAt ?? ""}` : bypassCache ? "renew" : "lease"}`
    const pending = this.inFlight.get(requestKey)
    if (pending) return pending
    const task = (async () => {
      const response = await this.fetchImpl(joinUrl(this.baseUrl!, "/api/router/lease"), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined)
        // The remote error body may echo credentials; never surface it in Pi.
        throw new Error(`OpenSec router request failed (${response.status})`)
      }
      const lease = parseLease(await response.json())
      // A slower renewal must not overwrite a rotation that finished meanwhile.
      const latest = this.leases.get(cacheKey)
      if (latest && latest.leaseId !== cached?.leaseId) return latest
      if (!this.leases.has(cacheKey) && this.leases.size >= 512) {
        const oldest = this.leases.keys().next().value!
        this.leases.delete(oldest)
        this.renewalAfter.delete(oldest)
      }
      this.leases.set(cacheKey, lease)
      return lease
    })().finally(() => this.inFlight.delete(requestKey))
    this.inFlight.set(requestKey, task)
    return task
  }
}
