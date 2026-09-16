/** Opt-in background diagnostics. Never write into the TUI by default. */
export function backgroundWarning(message: string): void {
  if (process.env.COMMANDCODE_DEBUG !== "1") return
  try {
    console.warn(message)
  } catch {
    // Logging must never interrupt generation, refreshes, or usage reporting.
  }
}
