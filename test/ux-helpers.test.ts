import { describe, expect, test } from "bun:test"
import type { Backend } from "../src/app/backend"
import { Store } from "../src/app/store"
import type { Session } from "../src/app/types"
import {
  activeFilterSummary,
  buildAttentionQueue,
  formatZoomPercent,
  nextAttentionId,
  summarizeProjectGroups,
} from "../src/app/ux-helpers"

const NOW = 1_700_000_000_000
const mk = (id: string, dir = "/repo/a", over: Record<string, any> = {}): Session =>
  ({
    id,
    projectID: dir,
    title: `Session ${id}`,
    cost: 0,
    tokens: {} as any,
    outcome: "succeeded",
    time: { created: NOW - 10_000, updated: NOW - 1_000, ...over.time },
    location: { directory: dir },
    ...over,
  }) as unknown as Session

async function mkStore(sessions: Session[]) {
  const backend = {
    listProjects: async () => [],
    listSessions: async () => sessions,
    active: async () => new Set<string>(),
    messages: async () => ({ data: [] }),
    inbox: async () => [],
    markViewed: async () => {},
    searchSessions: async () => [],
  } as unknown as Backend
  const store = new Store(backend)
  await store.reload()
  return store
}

describe("ux-helpers", () => {
  test("formatZoomPercent handles valid, edge, and invalid values", () => {
    expect(formatZoomPercent(1)).toBe("100%")
    expect(formatZoomPercent(0.854)).toBe("85%")
    expect(formatZoomPercent(0.001)).toBe("1%")
    expect(formatZoomPercent(2.4)).toBe("240%")
    expect(formatZoomPercent(0)).toBe("100%")
    expect(formatZoomPercent(Number.NaN)).toBe("100%")
  })

  test("summarizeProjectGroups counts statuses and assigns priority per project", async () => {
    const s1 = mk("s1", "/work/api", { time: { created: NOW - 20_000, updated: NOW - 2_000 } })
    const s2 = mk("s2", "/work/api", { time: { created: NOW - 15_000, updated: NOW - 1_000, idle: NOW - 1_000 } })
    const s3 = mk("s3", "/work/web", { time: { created: NOW - 10_000, updated: NOW - 500 } })
    const s4 = mk("s4", "/work/docs", { time: { created: NOW - 9_000, updated: NOW - 500, idle: NOW - 999_999_999 } })
    const store = await mkStore([s1, s2, s3, s4])
    store.running.add("s1")
    store.permissions.set("s1", [{ id: "p1", sessionID: "s1", action: "bash" } as any])
    store.running.add("s3")

    const summary = summarizeProjectGroups(store, NOW)
    const api = summary.find((g) => g.label === "api")!
    const web = summary.find((g) => g.label === "web")!
    const docs = summary.find((g) => g.label === "docs")!

    expect(api.total).toBe(2)
    expect(api.needsYou).toBe(1)
    expect(api.review).toBe(1)
    expect(api.priority).toBe("needs-you")

    expect(web.working).toBe(1)
    expect(web.priority).toBe("working")

    expect(docs.needsYou).toBe(0)
    expect(docs.working).toBe(0)
    expect(docs.review).toBe(0)
    expect(docs.priority).toBe("idle")
  })

  test("buildAttentionQueue orders needs-you before review before working and steps cyclically", async () => {
    const sWork = mk("work", "/work/a", { time: { created: NOW - 5_000, updated: NOW - 100 } })
    const sAsk = mk("ask", "/work/b", { time: { created: NOW - 6_000, updated: NOW - 500 } })
    const sRev = mk("rev", "/work/c", { time: { created: NOW - 7_000, updated: NOW - 300, idle: NOW - 300 } })
    const store = await mkStore([sWork, sAsk, sRev])
    store.running.add("work")
    store.running.add("ask")
    store.permissions.set("ask", [{ id: "p1", sessionID: "ask", action: "bash" } as any])

    const q = buildAttentionQueue(store, () => true, NOW)
    expect(q.ids).toEqual(["ask", "rev", "work"])
    expect(q.needsYou).toBe(1)
    expect(q.review).toBe(1)
    expect(q.working).toBe(1)

    expect(nextAttentionId(q.ids, undefined, 1)).toBe("ask")
    expect(nextAttentionId(q.ids, undefined, -1)).toBe("work")
    expect(nextAttentionId(q.ids, "ask", 1)).toBe("rev")
    expect(nextAttentionId(q.ids, "work", 1)).toBe("ask")
    expect(nextAttentionId(q.ids, "ask", -1)).toBe("work")
    expect(nextAttentionId([], undefined, 1)).toBeUndefined()
  })

  test("activeFilterSummary formats filter and query states cleanly", () => {
    expect(activeFilterSummary(undefined, "", 10)).toBeUndefined()
    expect(activeFilterSummary("needs-you", "", 1)).toBe("1 session · needs you")
    expect(activeFilterSummary("working", "auth", 3)).toBe("3 sessions · working matching “auth”")
    expect(activeFilterSummary(undefined, "billing", 2)).toBe("2 sessions · “billing”")
  })
})
