import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  findAdjacentSessionId,
  matchTokens,
  orderSessionsForTriage,
  rankPaletteItems,
  type PaletteActionSpec,
  type PaletteProjectItem,
  type PaletteSessionItem,
} from "../src/app/palette-logic"

const ACTIONS: PaletteActionSpec[] = [
  { id: "orchestrate", label: "Open Orchestrate", detail: "Control multiple sessions from one chat", shortcut: "O", keywords: ["fleet", "multi"] },
  { id: "tiles", label: "Open Tiles", detail: "Side-by-side live grid", shortcut: "T" },
  { id: "approve-all", label: "Approve all waiting permissions", detail: "Unblock waiting Hermes agents", boost: 25 },
  { id: "fit", label: "Fit all projects", detail: "Reset zoom to show every cluster", shortcut: "0" },
]

const SESSIONS: PaletteSessionItem[] = [
  { id: "s1", title: "Refund webhooks", projectLabel: "payments-api", directory: "/work/payments-api", status: "needs-you", updated: 500, needsPermission: true, subagents: 3 },
  { id: "s2", title: "Checkout redesign", projectLabel: "storefront-web", directory: "/work/storefront-web", status: "working", activity: "Running bun test…", updated: 400, subagents: 4 },
  { id: "s3", title: "Dark mode tokens", projectLabel: "design-system", directory: "/work/design-system", status: "review", updated: 600, subagents: 1 },
  { id: "s4", title: "Storybook build speedup", projectLabel: "design-system", directory: "/work/design-system", status: "done", updated: 300, subagents: 0 },
]

const PROJECTS: PaletteProjectItem[] = [
  { key: "p1", label: "payments-api", directory: "/work/payments-api", total: 3, needsYou: 1, working: 0, review: 1 },
  { key: "p2", label: "storefront-web", directory: "/work/storefront-web", total: 3, needsYou: 0, working: 2, review: 0 },
]

describe("palette-logic", () => {
  it("matches exact, prefix, multi-token, and subsequence queries accurately", () => {
    assert.ok(matchTokens("refund", "Refund webhooks") > matchTokens("web", "Refund webhooks"))
    assert.ok(matchTokens("pay ref", "Refund webhooks", "payments-api") > 0)
    assert.ok(matchTokens("rfnd", "Refund webhooks") > 0)
    assert.equal(matchTokens("zzzz", "Refund webhooks", "payments-api"), -1)
  })

  it("prioritizes needs-you and working sessions in empty-query overview", () => {
    const items = rankPaletteItems("", ACTIONS, SESSIONS, PROJECTS, 16)
    const attention = items.filter((i) => i.section === "Needs Attention")
    assert.equal(attention.length, 2)
    assert.equal(attention[0]!.id, "s1")
    assert.equal(attention[1]!.id, "s2")
    const acts = items.filter((i) => i.section === "Actions")
    assert.equal(acts[0]!.id, "approve-all")
  })

  it("ranks matching sessions, projects, and actions on search queries", () => {
    const refund = rankPaletteItems("refund", ACTIONS, SESSIONS, PROJECTS)
    assert.equal(refund[0]!.kind, "session")
    assert.equal(refund[0]!.id, "s1")

    const orch = rankPaletteItems("orchestrate", ACTIONS, SESSIONS, PROJECTS)
    assert.equal(orch[0]!.kind, "action")
    assert.equal(orch[0]!.id, "orchestrate")

    const store = rankPaletteItems("storefront", ACTIONS, SESSIONS, PROJECTS)
    assert.ok(store.some((r) => r.kind === "project" && r.id === "p2"))
    assert.ok(store.some((r) => r.kind === "session" && r.id === "s2"))
  })

  it("orders sessions for rapid triage and steps forward/backward cleanly with wrap", () => {
    const ordered = orderSessionsForTriage(SESSIONS)
    assert.deepEqual(ordered, ["s1", "s3", "s2", "s4"])
    assert.equal(findAdjacentSessionId(ordered, "s1", 1), "s3")
    assert.equal(findAdjacentSessionId(ordered, "s1", -1), "s4")
    assert.equal(findAdjacentSessionId(ordered, "s4", 1), "s1")
    assert.equal(findAdjacentSessionId(ordered, "missing", 1), "s1")
    assert.equal(findAdjacentSessionId([], "s1", 1), undefined)
  })
})
