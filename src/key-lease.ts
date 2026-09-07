import type { RequestPerformance } from "./metrics.ts"
import type { AssistantMessageEvent, ModelLike, StreamOptions } from "./types.ts"

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
}

interface LeaseManagerOptions {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  fallbackSessionId?: string
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`
}

async function isRotationFailure(response: Response): Promise<boolean> {
  if ([401, 402, 429].includes(response.status)) return true
  if (response.status !== 403) return false
  return response
    .clone()
    .text()
    .then(
      (body) => /\b(?:quota|credit|rate limit|usage limit|exhausted|invalid api key)\b/i.test(body),
      () => false,
    )
}

function replaceAuthorization(init: RequestInit | undefined, apiKey: string): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set("authorization", `Bearer ${apiKey}`)
  return { ...init, headers }
}

function terminalMessage(event: AssistantMessageEvent) {
  if (event.type === "done") return event.message
  if (event.type === "error") return event.error
  return undefined
}

export class CommandCodeKeyLeaseManager {
  private readonly baseUrl?: string
  private readonly configuredToken?: string
  private readonly controlPlaneFetch: typeof fetch
  private readonly leases = new Map<string, KeyLease>()
  private readonly leasesByApiKey = new Map<string, KeyLease>()
  private readonly leaseTokens = new Map<string, string>()
  private readonly inFlight = new Map<string, Promise<KeyLease>>()
  private readonly fallbackSession: string

  constructor(options: LeaseManagerOptions = {}) {
    const env = options.env ?? process.env
    this.baseUrl = env.OPENSEC_ROUTER_URL?.trim()
    this.configuredToken = env.OPENSEC_ROUTER_TOKEN?.trim()
    this.controlPlaneFetch = options.fetchImpl ?? fetch
    this.fallbackSession = options.fallbackSessionId ?? `pi-${process.pid}-${crypto.randomUUID()}`
  }

  get enabled(): boolean {
    return Boolean(this.baseUrl)
  }

  async resolve(model: ModelLike, options?: StreamOptions): Promise<StreamOptions | undefined> {
    if (!this.baseUrl) return options
    const token = this.configuredToken || options?.apiKey
    if (!token) {
      throw new Error("OpenSec routing requires OPENSEC_ROUTER_TOKEN or a configured provider key")
    }
    const sessionId = options?.sessionId || this.fallbackSession
    let lease = await this.acquire({ sessionId, model: model.id }, token)
    const directFetch = options?.fetch ?? fetch
    const routed: StreamOptions = {
      ...options,
      apiKey: lease.apiKey,
      fetch: async (input, init) => {
        const response = await directFetch(input, init)
        if (!(await isRotationFailure(response))) return response

        const previous = lease
        const replacement = await this.acquire(
          {
            sessionId,
            model: model.id,
            forceRotate: true,
            excludeAccountId: previous.accountId,
          },
          token,
        )
        lease = replacement
        routed.apiKey = replacement.apiKey
        // The transport observer still holds the key that began this request.
        // Point that key at the replacement lease so final usage is attributed
        // to the account that actually completed the retried request.
        this.leasesByApiKey.set(previous.apiKey, replacement)
        return directFetch(input, replaceAuthorization(init, replacement.apiKey))
      },
    }
    return routed
  }

  observe(
    event: AssistantMessageEvent,
    model: ModelLike,
    apiKey?: string,
    performance?: RequestPerformance,
  ): void {
    const message = terminalMessage(event)
    if (!message || !apiKey || !this.baseUrl) return
    const lease = this.leasesByApiKey.get(apiKey)
    if (!lease) return
    const token = this.configuredToken || this.leaseTokens.get(lease.leaseId)
    if (!token) return
    const usage = message.usage
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite
    void this.controlPlaneFetch(
      joinUrl(this.baseUrl, `/api/router/leases/${lease.leaseId}/usage`),
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: model.id,
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
          cacheHitRate: promptTokens > 0 ? usage.cacheRead / promptTokens : 0,
          cost: usage.cost.total,
          costSource: "commandcode-price-estimate",
          totalDurationMs: performance?.totalDurationMs,
          generationDurationMs: performance?.generationDurationMs,
          ttftMs: performance?.ttftMs,
          tps: performance?.tps,
          status: event.type === "done" ? "completed" : "failed",
        }),
        signal: AbortSignal.timeout(5_000),
      },
    ).catch(() => undefined)
  }

  private async acquire(request: LeaseRequest, token: string): Promise<KeyLease> {
    const cached = this.leases.get(request.sessionId)
    // A Pi process keeps its assignment until CommandCode itself rejects the
    // key. No timer, polling request, or lease renewal runs between prompts.
    if (!request.forceRotate && cached) return cached
    if (!this.baseUrl) throw new Error("OpenSec router URL is not configured")
    const requestKey = `${request.sessionId}:${request.forceRotate ? "rotate" : "lease"}`
    const pending = this.inFlight.get(requestKey)
    if (pending) return pending
    const task = (async () => {
      const response = await this.controlPlaneFetch(joinUrl(this.baseUrl!, "/api/router/lease"), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `OpenSec router request failed (${response.status})`)
      }
      const lease = (await response.json()) as KeyLease
      if (!lease.apiKey || !lease.leaseId || !lease.accountId) {
        throw new Error("OpenSec router returned an invalid lease")
      }
      this.leases.set(request.sessionId, lease)
      this.leasesByApiKey.set(lease.apiKey, lease)
      this.leaseTokens.set(lease.leaseId, token)
      return lease
    })().finally(() => this.inFlight.delete(requestKey))
    this.inFlight.set(requestKey, task)
    return task
  }
}
