import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  ContextLike,
  ModelLike,
  StreamOptions,
} from "./types.ts"
import { calculateTps, type RequestPerformance } from "./metrics.ts"

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
  observeEvent?: (
    event: AssistantMessageEvent,
    model: ModelLike,
    apiKey?: string,
    performance?: RequestPerformance,
  ) => void
  resolveOptions?: (model: ModelLike, options?: StreamOptions) => Promise<StreamOptions | undefined>
  now?: () => number
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
  const now = deps.now ?? Date.now

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

      const run = async () => {
        const resolvedOptions = (await deps.resolveOptions?.(model, options)) ?? options
        const resolvedApiKey = resolvedOptions?.apiKey
        const performance: RequestPerformance = { startedAt: now() }
        const observe = (event: AssistantMessageEvent): void => {
          if (
            performance.firstTokenAt === undefined &&
            (event.type === "text_delta" || event.type === "thinking_delta") &&
            event.delta
          ) {
            performance.firstTokenAt = now()
          }
          if (event.type === "done" || event.type === "error") {
            performance.completedAt = now()
            performance.totalDurationMs = Math.max(
              0,
              performance.completedAt - performance.startedAt,
            )
            if (performance.firstTokenAt !== undefined) {
              performance.ttftMs = Math.max(0, performance.firstTokenAt - performance.startedAt)
              performance.generationDurationMs = Math.max(
                1,
                performance.completedAt - performance.firstTokenAt,
              )
              const message = event.type === "done" ? event.message : event.error
              performance.tps = calculateTps(message.usage.output, performance.generationDurationMs)
            }
          }
          deps.observeEvent?.(event, model, resolvedApiKey, performance)
        }
        const pipe = async (source: AssistantMessageEventStreamLike): Promise<void> => {
          for await (const event of source) {
            output.push(event)
            observe(event)
          }
        }
        let upgradeRequired = false
        const fetchImpl = resolvedOptions?.fetch ?? fetch
        const providerOptions: StreamOptions = {
          ...resolvedOptions,
          fetch: async (input, init) => {
            const response = await fetchImpl(input, init)
            if (deps.allowLegacyGenerate && (await isUpgradeRequired(response))) {
              upgradeRequired = true
            }
            return response
          },
          onResponse: async (response, responseModel) => {
            if (upgradeRequired) return
            await resolvedOptions?.onResponse?.(response, responseModel)
          },
        }
        if (transport === "generate") {
          await pipe(deps.streamGenerate(model, context, resolvedOptions))
          output.end()
          return
        }
        const providerStream = deps.streamProvider(model, context, providerOptions)

        for await (const event of providerStream) {
          if (!upgradeRequired) {
            if (apiKey === requestApiKey) transport = "provider"
            output.push(event)
            observe(event)
          }
        }

        if (upgradeRequired) {
          if (apiKey === requestApiKey) transport = "generate"
          await pipe(deps.streamGenerate(model, context, resolvedOptions))
        }
        output.end()
      }

      run().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
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
        output.push(event)
        deps.observeEvent?.(event, model, requestApiKey)
        output.end()
      })

      return output
    },
  }
}
