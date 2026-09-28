import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  ContextLike,
  ModelLike,
  StreamOptions,
} from "./types.ts"
import type { ReapCaptureRecorder, ReapRequestCapture } from "./reap-capture.ts"

export type CommandCodeTransport = "unknown" | "provider" | "generate"

interface TransportDependencies {
  /** Enable the undocumented legacy Go-plan transport. Disabled by default. */
  allowLegacyGenerate?: boolean
  createStream: () => AssistantMessageEventStreamLike
  streamProvider: (
    model: ModelLike,
    context: ContextLike,
    options?: StreamOptions,
  ) => AssistantMessageEventStreamLike
  streamGenerate: (
    model: ModelLike,
    context: ContextLike,
    options?: StreamOptions,
  ) => AssistantMessageEventStreamLike
  observeEvent?: (event: AssistantMessageEvent, model: ModelLike, apiKey?: string) => void
  resolveOptions?: (model: ModelLike, options?: StreamOptions) => Promise<StreamOptions | undefined>
  reapCapture?: ReapCaptureRecorder
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function isUpgradeRequired(response: Response): Promise<boolean> {
  if (response.status !== 403) return false

  try {
    const body: unknown = await response.clone().json()
    if (!isRecord(body)) return false
    const error = isRecord(body.error) ? body.error : body
    if (error.code === "upgrade_required") return true

    // Anthropic-compatible errors use `type` and `message` instead of the
    // OpenAI-style `code` field documented by the chat-completions route.
    const type = typeof error.type === "string" ? error.type : ""
    const message = typeof error.message === "string" ? error.message : ""
    return (
      type === "permission_error" &&
      /\bprovider api (?:access )?upgrade (?:is )?required\b/i.test(message)
    )
  } catch {
    return false
  }
}

export function createCommandCodeTransportRouter(deps: TransportDependencies) {
  let transport: CommandCodeTransport = "unknown"
  let apiKey: string | undefined

  function pipe(
    source: AssistantMessageEventStreamLike,
    target: AssistantMessageEventStreamLike,
    model: ModelLike,
    apiKey?: string,
    onUsageEvent?: StreamOptions["onUsageEvent"],
    capture?: ReapRequestCapture,
  ): Promise<AssistantMessageEvent | undefined> {
    return (async () => {
      let terminal: AssistantMessageEvent | undefined
      for await (const event of source) {
        capture?.observeEvent(event)
        if (event.type === "done" || event.type === "error") {
          terminal = event
          continue
        }
        emit(event, target, model, apiKey, onUsageEvent)
      }
      return terminal
    })()
  }

  function emit(
    event: AssistantMessageEvent,
    target: AssistantMessageEventStreamLike,
    model: ModelLike,
    apiKey: string | undefined,
    onUsageEvent: StreamOptions["onUsageEvent"],
  ): void {
    target.push(event)
    if (!onUsageEvent) deps.observeEvent?.(event, model, apiKey)
    onUsageEvent?.(event)
  }

  async function finalizeCapture(
    capture: ReapRequestCapture | undefined,
    terminal: AssistantMessageEvent | undefined,
  ): Promise<void> {
    if (!capture) return
    if (terminal?.type === "done") await capture.finalize("completed")
    else if (terminal?.type === "error" && terminal.reason === "aborted")
      await capture.finalize("aborted", terminal.error.errorMessage)
    else
      await capture.finalize(
        "failed",
        terminal?.type === "error"
          ? terminal.error.errorMessage
          : "Stream ended without a terminal event",
      )
  }

  return {
    getTransport(): CommandCodeTransport {
      return transport
    },

    reset(): void {
      transport = "unknown"
      apiKey = undefined
    },

    stream(
      model: ModelLike,
      context: ContextLike,
      options?: StreamOptions,
    ): AssistantMessageEventStreamLike {
      if (options?.apiKey !== apiKey) {
        apiKey = options?.apiKey
        transport = "unknown"
      }
      const requestApiKey = options?.apiKey
      const output = deps.createStream()
      let resolvedOptions = options
      let capture: ReapRequestCapture | undefined
      let captureFinalized = false

      const run = async () => {
        resolvedOptions = (await deps.resolveOptions?.(model, options)) ?? options
        if (deps.reapCapture) {
          try {
            capture = await deps.reapCapture.begin({ model, context, options: resolvedOptions })
          } catch (error) {
            if (deps.reapCapture.required) throw error
          }
        }
        const capturedOptions = capture?.wrapOptions(resolvedOptions) ?? resolvedOptions
        const resolvedApiKey = resolvedOptions?.apiKey
        let upgradeRequired = false
        const fetchImpl = capturedOptions?.fetch ?? fetch
        const providerOptions: StreamOptions = {
          ...capturedOptions,
          fetch: async (input, init) => {
            const response = await fetchImpl(input, init)
            if (deps.allowLegacyGenerate && (await isUpgradeRequired(response)))
              upgradeRequired = true
            return response
          },
          onResponse: async (response, responseModel) => {
            if (upgradeRequired) return
            await capturedOptions?.onResponse?.(response, responseModel)
          },
        }
        if (transport === "generate") {
          capture?.recordTransport("generate")
          const terminal = await pipe(
            deps.streamGenerate(model, context, capturedOptions),
            output,
            model,
            resolvedApiKey,
            resolvedOptions?.onUsageEvent,
            capture,
          )
          captureFinalized = true
          await finalizeCapture(capture, terminal)
          if (terminal) emit(terminal, output, model, resolvedApiKey, resolvedOptions?.onUsageEvent)
          output.end()
          return
        }
        capture?.recordTransport("provider")
        const providerStream = deps.streamProvider(model, context, providerOptions)
        let terminal: AssistantMessageEvent | undefined

        for await (const event of providerStream) {
          if (!upgradeRequired) {
            if (apiKey === requestApiKey) transport = "provider"
            capture?.observeEvent(event)
            if (event.type === "done" || event.type === "error") terminal = event
            else emit(event, output, model, resolvedOptions?.apiKey, resolvedOptions?.onUsageEvent)
          }
        }

        if (upgradeRequired) {
          if (apiKey === requestApiKey) transport = "generate"
          capture?.recordTransport("generate")
          terminal = await pipe(
            deps.streamGenerate(model, context, capturedOptions),
            output,
            model,
            resolvedOptions?.apiKey,
            resolvedOptions?.onUsageEvent,
            capture,
          )
        }
        captureFinalized = true
        await finalizeCapture(capture, terminal)
        if (terminal)
          emit(terminal, output, model, resolvedOptions?.apiKey, resolvedOptions?.onUsageEvent)
        output.end()
      }

      run().catch(async (error: unknown) => {
        let message = error instanceof Error ? error.message : String(error)
        const event: AssistantMessageEvent = {
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: message,
            timestamp: Date.now(),
          },
        }
        if (capture && !captureFinalized) {
          capture.observeEvent(event)
          captureFinalized = true
          try {
            await capture.finalize(
              error instanceof DOMException && error.name === "AbortError" ? "aborted" : "failed",
              error,
            )
          } catch (captureError) {
            message = captureError instanceof Error ? captureError.message : String(captureError)
            event.error.errorMessage = message
          }
        }
        output.push(event)
        try {
          if (!resolvedOptions?.onUsageEvent)
            deps.observeEvent?.(event, model, resolvedOptions?.apiKey)
          resolvedOptions?.onUsageEvent?.(event)
        } catch {
          // Telemetry is best effort; the caller still receives the error event.
        }
        output.end()
      })

      return output
    },
  }
}
