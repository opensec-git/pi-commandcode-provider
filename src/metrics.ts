import type { AssistantMessageEvent, ModelLike, Usage } from "./types.ts"

export interface RequestPerformance {
  startedAt: number
  firstTokenAt?: number
  completedAt?: number
  totalDurationMs?: number
  generationDurationMs?: number
  ttftMs?: number
  tps?: number
}

export interface CommandCodeMetricRecord {
  timestamp: number
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  cacheHitRate: number
  totalDurationMs?: number
  generationDurationMs?: number
  ttftMs?: number
  tps?: number
  status: "completed" | "failed"
}

export interface CommandCodeMetricsSummary {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  promptTokens: number
  cacheHitRate: number
  averageRequestCacheHitRate: number
  costUsd: number
  outputTokensForTps: number
  generationSeconds: number
  weightedTps?: number
  averageRequestTps?: number
  averageTtftMs?: number
  failedRequests: number
}

interface MetricsUi {
  notify(message: string, type?: "info" | "warning" | "error"): void
  setStatus?(key: string, text: string | undefined): void
}

interface MetricsCommandContext {
  ui: MetricsUi
}

interface MetricsExtensionApi {
  registerCommand(
    name: string,
    command: {
      description: string
      handler: (args: string, ctx: MetricsCommandContext) => void | Promise<void>
    },
  ): void
}

const MAX_RECORDS = 10_000

export function promptTokenTotal(usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">): number {
  return usage.input + usage.cacheRead + usage.cacheWrite
}

export function calculateCacheHitRate(
  usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">,
): number {
  const total = promptTokenTotal(usage)
  return total > 0 ? usage.cacheRead / total : 0
}

export function calculateTps(tokens: number, durationMs: number | undefined): number | undefined {
  return durationMs && durationMs > 0 && tokens >= 0 ? tokens / (durationMs / 1_000) : undefined
}

export function aggregateCommandCodeMetrics(
  records: Iterable<CommandCodeMetricRecord>,
): CommandCodeMetricsSummary {
  const summary: CommandCodeMetricsSummary = {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    promptTokens: 0,
    cacheHitRate: 0,
    averageRequestCacheHitRate: 0,
    costUsd: 0,
    outputTokensForTps: 0,
    generationSeconds: 0,
    failedRequests: 0,
  }
  let cacheRateSum = 0
  let tpsSum = 0
  let tpsCount = 0
  let ttftSum = 0
  let ttftCount = 0

  for (const record of records) {
    summary.requests += 1
    summary.input += record.input
    summary.output += record.output
    summary.cacheRead += record.cacheRead
    summary.cacheWrite += record.cacheWrite
    summary.costUsd += record.costUsd
    summary.failedRequests += record.status === "failed" ? 1 : 0
    const promptTokens = record.input + record.cacheRead + record.cacheWrite
    summary.promptTokens += promptTokens
    cacheRateSum += record.cacheHitRate
    if (record.tps !== undefined) {
      tpsSum += record.tps
      tpsCount += 1
    }
    if (record.generationDurationMs && record.generationDurationMs > 0) {
      summary.outputTokensForTps += record.output
      summary.generationSeconds += record.generationDurationMs / 1_000
    }
    if (record.ttftMs !== undefined) {
      ttftSum += record.ttftMs
      ttftCount += 1
    }
  }

  summary.cacheHitRate = summary.promptTokens > 0 ? summary.cacheRead / summary.promptTokens : 0
  summary.averageRequestCacheHitRate = summary.requests > 0 ? cacheRateSum / summary.requests : 0
  if (summary.generationSeconds > 0) {
    summary.weightedTps = summary.outputTokensForTps / summary.generationSeconds
  }
  if (tpsCount > 0) summary.averageRequestTps = tpsSum / tpsCount
  if (ttftCount > 0) summary.averageTtftMs = ttftSum / ttftCount
  return summary
}

export function formatCommandCodeMetrics(
  summary: CommandCodeMetricsSummary,
  title = "CommandCode usage",
): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`
  const usd = (value: number) => `$${value.toFixed(value < 0.01 ? 6 : 4)}`
  const weightedTps =
    summary.weightedTps === undefined ? "n/a" : `${summary.weightedTps.toFixed(1)} tok/s`
  const ttft =
    summary.averageTtftMs === undefined ? "n/a" : `${Math.round(summary.averageTtftMs)} ms average`
  return [
    title,
    `${summary.requests} requests · ${summary.input.toLocaleString()} new input · ${summary.cacheRead.toLocaleString()} cache read · ${summary.output.toLocaleString()} output`,
    `Cache hit ${percent(summary.cacheHitRate)} weighted · ${percent(summary.averageRequestCacheHitRate)} average/request`,
    `Estimated cost ${usd(summary.costUsd)} · CommandCode pricing overlay`,
    `TPS ${weightedTps}${summary.averageRequestTps === undefined ? "" : ` · ${summary.averageRequestTps.toFixed(1)} average/request`}`,
    `TTFT ${ttft} · ${summary.failedRequests} failed`,
  ].join("\n")
}

function terminalMessage(event: AssistantMessageEvent) {
  if (event.type === "done") return event.message
  if (event.type === "error") return event.error
  return undefined
}

export class CommandCodeMetricsTracker {
  private readonly records: CommandCodeMetricRecord[] = []
  private ui?: MetricsUi

  attachUi(ui: MetricsUi): void {
    this.ui = ui
    this.updateStatus()
  }

  detachUi(): void {
    this.ui?.setStatus?.("pi-commandcode-metrics", undefined)
    this.ui = undefined
  }

  observe(event: AssistantMessageEvent, model: ModelLike, performance?: RequestPerformance): void {
    const message = terminalMessage(event)
    if (!message) return
    const usage = message.usage
    this.records.push({
      timestamp: message.timestamp,
      model: model.id,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      costUsd: usage.cost.total,
      cacheHitRate: calculateCacheHitRate(usage),
      totalDurationMs: performance?.totalDurationMs,
      generationDurationMs: performance?.generationDurationMs,
      ttftMs: performance?.ttftMs,
      tps: performance?.tps,
      status: event.type === "done" ? "completed" : "failed",
    })
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS)
    this.updateStatus()
  }

  summary(): CommandCodeMetricsSummary {
    return aggregateCommandCodeMetrics(this.records)
  }

  format(): string {
    return formatCommandCodeMetrics(this.summary())
  }

  private updateStatus(): void {
    if (!this.ui?.setStatus) return
    const summary = this.summary()
    if (!summary.requests) {
      this.ui.setStatus("pi-commandcode-metrics", undefined)
      return
    }
    const cache = `${(summary.cacheHitRate * 100).toFixed(0)}% cache`
    const tps =
      summary.weightedTps === undefined ? "TPS n/a" : `${summary.weightedTps.toFixed(1)} TPS`
    this.ui.setStatus(
      "pi-commandcode-metrics",
      `CC $${summary.costUsd.toFixed(4)} est · ${cache} · ${tps}`,
    )
  }
}

export function registerCommandCodeMetrics(
  pi: MetricsExtensionApi,
  tracker: CommandCodeMetricsTracker,
): void {
  pi.registerCommand("commandcode-metrics", {
    description: "Show CommandCode cost, cache-hit rate, TTFT, and TPS for this Pi process",
    handler: (_args, ctx) => {
      ctx.ui.notify(tracker.format(), "info")
    },
  })
}
