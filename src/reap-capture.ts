import { createHash, randomUUID } from "node:crypto"
import { appendFile, chmod, mkdir, open, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type {
  AssistantMessageEvent,
  AssistantMessageLike,
  ContextLike,
  ModelLike,
  StreamOptions,
} from "./types.ts"

export const REAP_CAPTURE_SCHEMA_VERSION = "opensec.commandcode-reap-capture.v1"

const SAFE_REQUEST_HEADERS = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "content-type",
  "user-agent",
  "x-client-request-id",
  "x-cmd-zdr",
  "x-session-affinity",
  "x-session-id",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
])

const SAFE_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-type",
  "date",
  "request-id",
  "retry-after",
  "x-request-id",
])

type CaptureStatus = "completed" | "aborted" | "failed"

interface ReapCaptureManifest {
  schema_version: typeof REAP_CAPTURE_SCHEMA_VERSION
  request_id: string
  created_at: string
  completed_at?: string
  status: "inflight" | CaptureStatus
  provider: string
  model: string
  api: unknown
  session_id?: string
  pid: number
  cwd: string
  run_id?: string
  repository?: string
  origin?: string
  parent_session_id?: string
  delegate_task_id?: string
  delegate_artifact_dir?: string
  transport?: "provider" | "generate"
  attempts: number
  terminal_error?: string
}

export interface ReapCaptureStoreOptions {
  rootDir: string
  env?: NodeJS.ProcessEnv
  now?: () => Date
  uuid?: () => string
  cwd?: () => string
}

export interface BeginReapCaptureOptions {
  model: ModelLike
  context: ContextLike
  options?: StreamOptions
}

export interface ReapCaptureRecorder {
  begin(args: BeginReapCaptureOptions): Promise<ReapRequestCapture>
}

interface SanitizedHeaders {
  values: Record<string, string>
  omitted_header_names: string[]
}

interface AttemptState {
  index: number
  directory: string
  responseDone?: Promise<void>
}

function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ""
    url.password = ""
    for (const name of [...url.searchParams.keys()]) {
      if (/(?:api[-_]?key|auth|credential|secret|signature|token)/i.test(name))
        url.searchParams.set(name, "[REDACTED]")
    }
    return url.toString()
  } catch {
    return "[unparseable-url]"
  }
}

function sanitizeHeaders(headers: Headers, allowlist: Set<string>): SanitizedHeaders {
  const values: Record<string, string> = {}
  const omitted: string[] = []
  headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase()
    if (allowlist.has(name)) values[name] = value
    else omitted.push(name)
  })
  return { values, omitted_header_names: [...new Set(omitted)].sort() }
}

function sanitizeOptions(options: StreamOptions | undefined): Record<string, unknown> {
  if (!options) return {}
  const result: Record<string, unknown> = {}
  for (const key of [
    "maxTokens",
    "temperature",
    "sessionId",
    "cacheRetention",
    "reasoning",
    "timeoutMs",
    "maxRetries",
    "maxRetryDelayMs",
  ] as const) {
    if (options[key] !== undefined) result[key] = options[key]
  }
  if (options.headers)
    result.headers = sanitizeHeaders(new Headers(options.headers), SAFE_REQUEST_HEADERS)
  return result
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function writePrivateFile(path: string, data: string | Uint8Array): Promise<void> {
  await ensurePrivateDirectory(dirname(path))
  await writeFile(path, data, { mode: 0o600 })
  await chmod(path, 0o600)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeJson(temporary, value)
  await rename(temporary, path)
}

function compactEvent(event: AssistantMessageEvent): Record<string, unknown> {
  if (event.type === "done") return event
  if (event.type === "error") return event
  const { partial: _partial, ...compact } = event
  return compact
}

function responseWithBody(response: Response, body: ReadableStream<Uint8Array>): Response {
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  for (const key of ["url", "redirected", "type"] as const) {
    try {
      Object.defineProperty(wrapped, key, { value: response[key], configurable: true })
    } catch {
      // These metadata fields are advisory; body/status/headers remain exact.
    }
  }
  return wrapped
}

export class ReapRequestCapture {
  readonly requestId: string

  private readonly inflightDir: string
  private readonly finalDir: string
  private readonly manifest: ReapCaptureManifest
  private queue: Promise<void> = Promise.resolve()
  private captureError: unknown
  private finalized = false
  private lastMessage?: AssistantMessageLike
  private readonly attempts: AttemptState[] = []

  constructor(args: {
    requestId: string
    inflightDir: string
    finalDir: string
    manifest: ReapCaptureManifest
  }) {
    this.requestId = args.requestId
    this.inflightDir = args.inflightDir
    this.finalDir = args.finalDir
    this.manifest = args.manifest
  }

  private enqueue(operation: () => Promise<void>): void {
    this.queue = this.queue.then(operation).catch((error: unknown) => {
      this.captureError ??= error
    })
  }

  recordPayload(payload: unknown): void {
    this.enqueue(() => writeJson(join(this.inflightDir, "payload.json"), payload))
  }

  recordTransport(transport: "provider" | "generate"): void {
    this.manifest.transport = transport
  }

  observeEvent(event: AssistantMessageEvent): void {
    if ("partial" in event) this.lastMessage = event.partial
    else if (event.type === "done") this.lastMessage = event.message
    else this.lastMessage = event.error

    this.enqueue(async () => {
      const path = join(this.inflightDir, "events.jsonl")
      await appendFile(path, `${JSON.stringify(compactEvent(event))}\n`, { mode: 0o600 })
      await chmod(path, 0o600)
    })
  }

  wrapOptions(options: StreamOptions | undefined): StreamOptions {
    const originalPayload = options?.onPayload
    const originalFetch = options?.fetch ?? fetch
    return {
      ...options,
      onPayload: async (payload, model) => {
        const transformed = originalPayload ? await originalPayload(payload, model) : payload
        this.recordPayload(transformed)
        return transformed
      },
      fetch: (input, init) => this.captureFetch(originalFetch, input, init),
    }
  }

  private async captureFetch(
    fetchImpl: typeof fetch,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const index = this.attempts.length + 1
    const directory = join(this.inflightDir, "attempts", String(index).padStart(4, "0"))
    const attempt: AttemptState = { index, directory }
    this.attempts.push(attempt)
    this.manifest.attempts = this.attempts.length

    let request: Request
    try {
      request = new Request(input, init)
      const body = new Uint8Array(await request.clone().arrayBuffer())
      await ensurePrivateDirectory(directory)
      await Promise.all([
        writeJson(join(directory, "request.json"), {
          attempt_index: index,
          method: request.method,
          url: sanitizeUrl(request.url),
          headers: sanitizeHeaders(request.headers, SAFE_REQUEST_HEADERS),
          body_bytes: body.byteLength,
          body_sha256: createHash("sha256").update(body).digest("hex"),
        }),
        writePrivateFile(join(directory, "request.body.bin"), body),
      ])
    } catch (captureError) {
      this.captureError ??= captureError
      throw captureError
    }

    const startedAt = new Date().toISOString()
    let response: Response
    try {
      response = await fetchImpl(input, init)
    } catch (upstreamError) {
      await writeJson(join(directory, "attempt.error.json"), {
        attempt_index: index,
        error: errorMessage(upstreamError),
        timestamp: new Date().toISOString(),
      }).catch((captureError: unknown) => {
        this.captureError ??= captureError
      })
      throw upstreamError
    }

    try {
      await writeJson(join(directory, "response.json"), {
        attempt_index: index,
        started_at: startedAt,
        received_at: new Date().toISOString(),
        status: response.status,
        status_text: response.statusText,
        url: sanitizeUrl(response.url || request.url),
        redirected: response.redirected,
        headers: sanitizeHeaders(response.headers, SAFE_RESPONSE_HEADERS),
      })

      if (response.body) return await this.createTappedResponse(response, attempt)
      attempt.responseDone = this.recordEmptyResponseBody(attempt)
      await attempt.responseDone
      return response
    } catch (captureError) {
      await writeJson(join(directory, "attempt.error.json"), {
        attempt_index: index,
        error: errorMessage(captureError),
        timestamp: new Date().toISOString(),
      }).catch(() => undefined)
      this.captureError ??= captureError
      throw captureError
    }
  }

  private async createTappedResponse(response: Response, attempt: AttemptState): Promise<Response> {
    const source = response.body
    if (!source) return response
    const file = await open(join(attempt.directory, "response.body.bin"), "w", 0o600)
    const reader = source.getReader()
    const hash = createHash("sha256")
    let bytes = 0
    let settled = false
    let resolveDone!: () => void
    let rejectDone!: (error: unknown) => void
    attempt.responseDone = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })

    const finish = async (state: "complete" | "cancelled" | "error", error?: unknown) => {
      if (settled) return
      settled = true
      try {
        await file.sync()
        await file.close()
        await writeJson(join(attempt.directory, "response.complete.json"), {
          attempt_index: attempt.index,
          state,
          body_bytes: bytes,
          body_sha256: hash.digest("hex"),
          completed_at: new Date().toISOString(),
          ...(error === undefined ? {} : { error: errorMessage(error) }),
        })
        resolveDone()
      } catch (finishError) {
        rejectDone(finishError)
      }
    }

    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const chunk = await reader.read()
          if (chunk.done) {
            await finish("complete")
            controller.close()
            return
          }
          try {
            await file.write(chunk.value)
            bytes += chunk.value.byteLength
            hash.update(chunk.value)
          } catch (captureError) {
            this.captureError ??= captureError
            throw captureError
          }
          controller.enqueue(chunk.value)
        } catch (error) {
          await finish("error", error)
          controller.error(error)
        }
      },
      cancel: async (reason) => {
        try {
          await reader.cancel(reason)
        } finally {
          await finish("cancelled", reason)
        }
      },
    })
    return responseWithBody(response, body)
  }

  private async recordEmptyResponseBody(attempt: AttemptState): Promise<void> {
    await writePrivateFile(join(attempt.directory, "response.body.bin"), new Uint8Array())
    await writeJson(join(attempt.directory, "response.complete.json"), {
      attempt_index: attempt.index,
      state: "complete",
      body_bytes: 0,
      body_sha256: createHash("sha256").digest("hex"),
      completed_at: new Date().toISOString(),
    })
  }

  async finalize(status: CaptureStatus, error?: unknown): Promise<void> {
    if (this.finalized) return
    this.finalized = true
    await this.queue
    try {
      await Promise.all(this.attempts.map((attempt) => attempt.responseDone).filter(Boolean))
    } catch (responseCaptureError) {
      this.captureError ??= responseCaptureError
    }

    if (this.captureError) throw this.captureError

    try {
      if (this.lastMessage)
        await writeJson(join(this.inflightDir, "normalized-response.json"), this.lastMessage)
      this.manifest.status = status
      this.manifest.completed_at = new Date().toISOString()
      if (error !== undefined) this.manifest.terminal_error = errorMessage(error)
      await writeJsonAtomic(join(this.inflightDir, "manifest.json"), this.manifest)
      const marker =
        status === "completed" ? "COMMITTED" : status === "aborted" ? "ABORTED" : "FAILED"
      await writePrivateFile(join(this.inflightDir, marker), `${this.manifest.completed_at}\n`)
      await ensurePrivateDirectory(dirname(this.finalDir))
      await rename(this.inflightDir, this.finalDir)
    } catch (finalizeError) {
      this.captureError ??= finalizeError
      throw finalizeError
    }
  }
}

export class ReapCaptureStore {
  readonly rootDir: string

  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => Date
  private readonly uuid: () => string
  private readonly cwd: () => string

  constructor(options: ReapCaptureStoreOptions) {
    this.rootDir = options.rootDir
    this.env = options.env ?? process.env
    this.now = options.now ?? (() => new Date())
    this.uuid = options.uuid ?? randomUUID
    this.cwd = options.cwd ?? process.cwd
  }

  async begin(args: BeginReapCaptureOptions): Promise<ReapRequestCapture> {
    const timestamp = this.now().toISOString()
    const requestId = `${timestamp.replace(/[:.]/g, "-")}_${this.uuid()}`
    const inflightDir = join(this.rootDir, ".inflight", requestId)
    const finalDir = join(this.rootDir, "requests", requestId)
    await ensurePrivateDirectory(this.rootDir)
    await ensurePrivateDirectory(join(this.rootDir, ".inflight"))
    await ensurePrivateDirectory(join(this.rootDir, "requests"))
    await ensurePrivateDirectory(inflightDir)

    const manifest: ReapCaptureManifest = {
      schema_version: REAP_CAPTURE_SCHEMA_VERSION,
      request_id: requestId,
      created_at: timestamp,
      status: "inflight",
      provider: args.model.provider,
      model: args.model.id,
      api: args.model.api,
      session_id: args.options?.sessionId,
      pid: process.pid,
      cwd: this.cwd(),
      run_id: this.env.COMMANDCODE_REAP_RUN_ID,
      repository: this.env.COMMANDCODE_REAP_REPOSITORY,
      origin: this.env.COMMANDCODE_REAP_CAPTURE_ORIGIN,
      parent_session_id: this.env.COMMANDCODE_REAP_PARENT_SESSION_ID,
      delegate_task_id: this.env.PI_BG_DELEGATE_TASK_ID,
      delegate_artifact_dir: this.env.PI_BG_DELEGATE_ARTIFACT_DIR,
      attempts: 0,
    }
    await Promise.all([
      writeJson(join(inflightDir, "manifest.json"), manifest),
      writeJson(join(inflightDir, "context.json"), args.context),
      writeJson(join(inflightDir, "options.json"), sanitizeOptions(args.options)),
    ])
    return new ReapRequestCapture({
      requestId,
      inflightDir,
      finalDir,
      manifest,
    })
  }
}

export function createReapCaptureFromEnv(env: NodeJS.ProcessEnv = process.env): ReapCaptureStore {
  const configuredDir = env.COMMANDCODE_REAP_CAPTURE_DIR?.trim()
  const rootDir = configuredDir || join(homedir(), ".pi", "reap-capture")
  return new ReapCaptureStore({ rootDir, env })
}
