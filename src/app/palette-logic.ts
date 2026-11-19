// Pure, DOM-free ranking, fuzzy matching, and session triage logic for the
// Hermes Command Palette (Cmd/Ctrl+K) and Session Panel rapid stepper.

import type { Status } from "./store"

export type PaletteItemKind = "action" | "session" | "project"

export interface PaletteActionSpec {
  id: string
  label: string
  detail: string
  shortcut?: string
  keywords?: string[]
  /** Optional priority bump (e.g., when permissions are waiting). */
  boost?: number
}

export interface PaletteSessionItem {
  id: string
  title: string
  projectLabel: string
  directory: string
  status: Status
  activity?: string
  updated: number
  needsPermission?: boolean
  subagents: number
}

export interface PaletteProjectItem {
  key: string
  label: string
  directory: string
  total: number
  needsYou: number
  working: number
  review: number
}

export interface PaletteResult {
  key: string
  kind: PaletteItemKind
  id: string
  title: string
  subtitle: string
  meta?: string
  shortcut?: string
  status?: Status
  score: number
  section: "Needs Attention" | "Actions" | "Sessions" | "Projects"
}

const STATUS_WEIGHT: Record<Status, number> = {
  "needs-you": 52,
  working: 34,
  review: 22,
  failed: 18,
  stopped: 6,
  done: 2,
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

/** Score a haystack against space-separated query tokens. Returns -1 when no match. */
export function matchTokens(query: string, primary: string, secondary = ""): number {
  const q = norm(query)
  if (!q) return 0
  const tokens = q.split(/\s+/).filter(Boolean)
  const p = norm(primary)
  const combined = secondary ? `${p} ${norm(secondary)}` : p
  let score = 0
  for (const tok of tokens) {
    const pIdx = p.indexOf(tok)
    if (pIdx === 0) {
      score += 40
    } else if (pIdx > 0) {
      // Word boundary match scores higher than mid-word match
      const boundary = p[pIdx - 1] === " " || p[pIdx - 1] === "-" || p[pIdx - 1] === "/"
      score += boundary ? 30 : 20
    } else {
      const cIdx = combined.indexOf(tok)
      if (cIdx >= 0) {
        score += 12
      } else {
        // Lightweight ordered subsequence check on primary for typo-tolerant jumping
        let pi = 0
        for (let ti = 0; ti < tok.length; ti++) {
          const found = p.indexOf(tok[ti]!, pi)
          if (found < 0) return -1
          pi = found + 1
        }
        score += 5
      }
    }
  }
  if (p === q) score += 35
  return score
}

/** Rank actions, sessions, and projects for the Hermes Command Palette. */
export function rankPaletteItems(
  query: string,
  actions: readonly PaletteActionSpec[],
  sessions: readonly PaletteSessionItem[],
  projects: readonly PaletteProjectItem[],
  limit = 16,
): PaletteResult[] {
  const q = norm(query)
  const out: PaletteResult[] = []

  // 1. Sessions
  for (const s of sessions) {
    const hay = `${s.projectLabel} ${s.directory} ${s.status} ${s.activity ?? ""}`
    const m = q ? matchTokens(q, s.title, hay) : 0
    if (m < 0) continue
    const recency = Math.min(10, Math.max(0, s.updated / 1e12))
    const statusBoost = STATUS_WEIGHT[s.status] ?? 0
    const metaParts: string[] = []
    if (s.status === "needs-you") metaParts.push(s.needsPermission ? "Needs permission" : "Needs input")
    else if (s.status === "working") metaParts.push(s.activity || "Working")
    else if (s.status === "review") metaParts.push("To review")
    else if (s.status === "failed") metaParts.push("Failed")
    else metaParts.push("Done")
    if (s.subagents > 0) metaParts.push(`${s.subagents} sub`)

    out.push({
      key: `session:${s.id}`,
      kind: "session",
      id: s.id,
      title: s.title,
      subtitle: s.projectLabel,
      meta: metaParts.join(" · "),
      status: s.status,
      section: !q && (s.status === "needs-you" || s.status === "working") ? "Needs Attention" : "Sessions",
      score: (q ? m * 2 : 0) + statusBoost + recency,
    })
  }

  // 2. Projects
  for (const p of projects) {
    const m = q ? matchTokens(q, p.label, p.directory) : 0
    if (m < 0) continue
    const bits: string[] = []
    if (p.needsYou) bits.push(`${p.needsYou} ask`)
    if (p.working) bits.push(`${p.working} live`)
    if (p.review) bits.push(`${p.review} rev`)
    if (!bits.length) bits.push(`${p.total} session${p.total === 1 ? "" : "s"}`)
    out.push({
      key: `project:${p.key}`,
      kind: "project",
      id: p.key,
      title: p.label,
      subtitle: "Jump to project on canvas",
      meta: bits.join(" · "),
      section: "Projects",
      score: (q ? m * 1.8 : 0) + p.needsYou * 15 + p.working * 8 + 10,
    })
  }

  // 3. Actions
  for (const a of actions) {
    const kw = `${a.detail} ${(a.keywords ?? []).join(" ")}`
    const m = q ? matchTokens(q, a.label, kw) : 0
    if (m < 0) continue
    out.push({
      key: `action:${a.id}`,
      kind: "action",
      id: a.id,
      title: a.label,
      subtitle: a.detail,
      shortcut: a.shortcut,
      section: "Actions",
      score: (q ? m * 2.1 : 28) + (a.boost ?? 0),
    })
  }

  if (!q) {
    // When empty, present a balanced, high-signal overview:
    // Top active/waiting sessions, key actions, and top projects.
    const attention = out
      .filter((r) => r.section === "Needs Attention")
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
    const acts = out
      .filter((r) => r.section === "Actions")
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
    const projs = out
      .filter((r) => r.section === "Projects")
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
    return [...attention, ...acts, ...projs].slice(0, limit)
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Order sessions for Panel ‹ / › rapid triage: needs-you > review > working > failed > rest. */
export function orderSessionsForTriage(sessions: readonly PaletteSessionItem[]): string[] {
  const rank = (st: Status) => {
    if (st === "needs-you") return 0
    if (st === "review") return 1
    if (st === "working") return 2
    if (st === "failed") return 3
    if (st === "stopped") return 4
    return 5
  }
  return [...sessions]
    .sort((a, b) => rank(a.status) - rank(b.status) || b.updated - a.updated)
    .map((s) => s.id)
}

/** Return the previous or next session ID in triage order, wrapping cleanly. */
export function findAdjacentSessionId(
  orderedIds: readonly string[],
  currentId: string | undefined,
  dir: 1 | -1,
): string | undefined {
  if (!orderedIds.length) return undefined
  if (orderedIds.length === 1) return orderedIds[0]
  const idx = currentId ? orderedIds.indexOf(currentId) : -1
  if (idx < 0) return dir === 1 ? orderedIds[0] : orderedIds[orderedIds.length - 1]
  return orderedIds[(idx + dir + orderedIds.length) % orderedIds.length]
}
