import { describe, expect, it } from "vitest"
import { accountHeadroom, activeLeaseFor, rankAccounts } from "../server/router"
import type { DatabaseShape, StoredAccount } from "../server/types"
import type { UsageSnapshot } from "../src/types"

function snapshot(monthly: number, fiveHour: number, weekly: number): UsageSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    monthlyRemaining: monthly,
    purchasedCredits: 0,
    freeCredits: 0,
    monthlyCap: 100,
    windows: [
      { name: "fiveHour", label: "5-hour", used: 100 - fiveHour, cap: 100, resetAt: null },
      { name: "weekly", label: "Weekly", used: 100 - weekly, cap: 100, resetAt: null },
    ],
    totalCost: 0,
    totalRequests: 0,
    completedRequests: 0,
    failedRequests: 0,
    successRate: null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    models: [],
    telemetryCoverage: 0,
  }
}

function account(id: string, status: StoredAccount["status"] = "healthy"): StoredAccount {
  return {
    id,
    label: id,
    group: null,
    encryptedKey: "x",
    keyFingerprint: `key_••••_${id.padEnd(8, "0")}`,
    createdAt: "",
    updatedAt: "",
    email: null,
    emailMasked: "",
    login: id,
    planId: null,
    subscriptionStatus: null,
    periodEnd: null,
    status,
    lastSyncAt: null,
    error: null,
  }
}

function database(
  accounts: StoredAccount[],
  snapshots: Record<string, UsageSnapshot[]>,
): DatabaseShape {
  return { version: 1, accounts, snapshots, telemetry: [], routerLeases: [] }
}

describe("router account selection", () => {
  it("uses the weakest quota window as safety headroom", () => {
    expect(accountHeadroom(snapshot(80, 60, 20))).toBeCloseTo(0.2)
  })

  it("selects maximum safe remaining quota and excludes a failed account", () => {
    const ranked = rankAccounts(
      database([account("a"), account("b"), account("c", "error")], {
        a: [snapshot(90, 80, 70)],
        b: [snapshot(70, 60, 50)],
        c: [snapshot(100, 100, 100)],
      }),
    )
    expect(ranked[0].account.id).toBe("a")
    expect(
      rankAccounts(
        database([account("a"), account("b")], {
          a: [snapshot(90, 80, 70)],
          b: [snapshot(70, 60, 50)],
        }),
        "a",
      )[0].account.id,
    ).toBe("b")
  })

  it("never selects an account with any exhausted quota", () => {
    const ranked = rankAccounts(
      database([account("exhausted"), account("usable")], {
        exhausted: [snapshot(100, 100, 0)],
        usable: [snapshot(40, 40, 40)],
      }),
    )
    expect(ranked[0].account.id).toBe("usable")
  })

  it("keeps one active lease for the session until explicit rotation", () => {
    const lease = {
      id: "lease",
      sessionId: "session",
      accountId: "a",
      model: "model",
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-01-01T00:05:00Z",
      lastUsedAt: "2026-01-01T00:00:00Z",
      status: "active" as const,
    }
    expect(activeLeaseFor([lease], "session")).toBe(lease)
  })
})
