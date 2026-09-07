import type { UsageSnapshot } from "../src/types"
import type { DatabaseShape, RouterLease, StoredAccount } from "./types"

const DEFAULT_RESERVE = 0

export interface RankedAccount {
  account: StoredAccount
  snapshot: UsageSnapshot
  score: number
  aggregateRemaining: number
}

function remainingRatio(snapshot: UsageSnapshot, window: "fiveHour" | "weekly"): number | null {
  const quota = snapshot.windows.find((item) => item.name === window)
  return quota && quota.cap > 0 ? Math.max(0, 1 - quota.used / quota.cap) : null
}

export function accountRemainingRatios(snapshot: UsageSnapshot): number[] {
  const values = [remainingRatio(snapshot, "fiveHour"), remainingRatio(snapshot, "weekly")]
  if (snapshot.monthlyCap && snapshot.monthlyCap > 0) {
    values.push(Math.max(0, snapshot.monthlyRemaining / snapshot.monthlyCap))
  } else {
    values.push(snapshot.monthlyRemaining > 0 ? 1 : 0)
  }
  return values.filter((value): value is number => value !== null)
}

export function accountHeadroom(snapshot: UsageSnapshot): number {
  return Math.min(...accountRemainingRatios(snapshot))
}

export function rankAccounts(
  database: DatabaseShape,
  excludedAccountId?: string,
  reserve = DEFAULT_RESERVE,
): RankedAccount[] {
  return database.accounts
    .filter((account) => account.id !== excludedAccountId && account.status === "healthy")
    .flatMap((account) => {
      const snapshot = database.snapshots[account.id]?.at(-1)
      if (!snapshot) return []
      const score = accountHeadroom(snapshot)
      const ratios = accountRemainingRatios(snapshot)
      const aggregateRemaining = ratios.reduce((sum, value) => sum + value, 0) / ratios.length
      return score > reserve ? [{ account, snapshot, score, aggregateRemaining }] : []
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.aggregateRemaining - left.aggregateRemaining ||
        right.snapshot.monthlyRemaining - left.snapshot.monthlyRemaining,
    )
}

export function activeLeaseFor(leases: RouterLease[], sessionId: string): RouterLease | undefined {
  return leases.find((lease) => lease.sessionId === sessionId && lease.status === "active")
}
