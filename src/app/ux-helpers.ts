// Pure UI/UX helper functions for spatial navigation, zoom display, attention
// queue ordering, and active filter summaries. Kept DOM-free for fast testing.

import { STATUS_LABEL, type Status, type Store } from "./store"

export interface ProjectSummary {
  key: string
  label: string
  directory: string
  total: number
  needsYou: number
  working: number
  review: number
  /** Highest urgency status for indicator styling. */
  priority: "needs-you" | "working" | "review" | "idle"
}

export function formatZoomPercent(z: number): string {
  if (!Number.isFinite(z) || z <= 0) return "100%"
  return `${Math.max(1, Math.round(z * 100))}%`
}

export function summarizeProjectGroups(store: Store, now = Date.now()): ProjectSummary[] {
  return store.groups().map((g) => {
    let needsYou = 0
    let working = 0
    let review = 0
    for (const s of g.sessions) {
      if (store.inFilter(s.id, "needs-you", now)) needsYou++
      else if (store.inFilter(s.id, "working", now)) working++
      else if (store.inFilter(s.id, "review", now)) review++
    }
    const priority: ProjectSummary["priority"] =
      needsYou > 0 ? "needs-you" : working > 0 ? "working" : review > 0 ? "review" : "idle"
    return {
      key: g.key,
      label: g.label,
      directory: g.directory,
      total: g.sessions.length,
      needsYou,
      working,
      review,
      priority,
    }
  })
}

export interface AttentionSummary {
  ids: string[]
  needsYou: number
  review: number
  working: number
}

export function buildAttentionQueue(
  store: Store,
  hasSession: (id: string) => boolean,
  now = Date.now(),
): AttentionSummary {
  const order: Status[] = ["needs-you", "review", "working"]
  const buckets: Record<"needs-you" | "review" | "working", string[]> = {
    "needs-you": [],
    review: [],
    working: [],
  }
  const seen = new Set<string>()
  const roots = store.roots().sort((a, b) => b.time.updated - a.time.updated)
  for (const st of order) {
    for (const s of roots) {
      if (seen.has(s.id) || !hasSession(s.id)) continue
      if (store.inFilter(s.id, st, now)) {
        seen.add(s.id)
        buckets[st as keyof typeof buckets].push(s.id)
      }
    }
  }
  return {
    ids: [...buckets["needs-you"], ...buckets.review, ...buckets.working],
    needsYou: buckets["needs-you"].length,
    review: buckets.review.length,
    working: buckets.working.length,
  }
}

export function nextAttentionId(ids: readonly string[], current: string | undefined, dir: 1 | -1): string | undefined {
  if (!ids.length) return undefined
  const idx = current ? ids.indexOf(current) : -1
  if (idx < 0) return dir === 1 ? ids[0] : ids[ids.length - 1]
  return ids[(idx + dir + ids.length) % ids.length]
}

export function activeFilterSummary(
  filter: Status | undefined,
  query: string,
  shownCount: number,
): string | undefined {
  const q = query.trim()
  if (!filter && !q) return undefined
  const parts: string[] = []
  if (filter) parts.push(STATUS_LABEL[filter].toLowerCase())
  if (q) parts.push(`“${q}”`)
  const noun = shownCount === 1 ? "session" : "sessions"
  return `${shownCount} ${noun} · ${parts.join(" matching ")}`
}
