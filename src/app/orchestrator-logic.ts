// Pure, DOM-free logic for the centralized Hermes Orchestrator page.
// Handles command parsing (/status, /collect, /spawn, /team, /stop, /approve,
// /model, /queue, /steer, /help), @target resolution across live sessions and
// projects, autocomplete suggestions, and fleet dispatch summaries.

import type { Status } from "./store"
import type { Session } from "./types"

export interface FleetSession {
  id: string
  title: string
  projectKey: string
  projectLabel: string
  directory: string
  status: Status
  running: boolean
  needsInput: "permission" | "question" | undefined
  activity: string
  modelLabel: string
  subagents: number
  updated: number
  preview: string
}

export interface FleetProjectGroup {
  key: string
  label: string
  directory: string
  sessions: FleetSession[]
  working: number
  needsYou: number
  review: number
}

export type OrchestratorCommandKind =
  | "prompt"
  | "status"
  | "collect"
  | "spawn"
  | "stop"
  | "approve"
  | "model"
  | "help"

export interface ParsedOrchestratorInput {
  kind: OrchestratorCommandKind
  /** Clean directive or argument text after stripping command & leading @tokens. */
  text: string
  /** Delivery mode override for prompt dispatches. */
  delivery?: "steer" | "queue"
  /** Whether /spawn or /team should launch a Hermes delegate_task team lead. */
  team?: boolean
  /** Explicit leading @tokens (e.g. ["live"], ["payments-api", "storefront-web"]). */
  mentions: string[]
  /** Unresolved tokens that didn't match any known group, project, or session. */
  unknownMentions?: string[]
}

export interface TargetResolution {
  sessions: FleetSession[]
  /** Human-readable scope label for the dispatch header. */
  scopeLabel: string
  /** True when explicit @mentions overrode the checkbox selection. */
  usedMentions: boolean
  /** Any @tokens that matched nothing. */
  unknownMentions: string[]
}

export interface AutocompleteItem {
  insert: string
  label: string
  detail: string
  kind: "command" | "group" | "project" | "session"
}

export type DispatchTargetState = "sending" | "running" | "queued" | "succeeded" | "failed" | "interrupted" | "error"

export interface DispatchRollup {
  total: number
  active: number
  succeeded: number
  failed: number
  interrupted: number
  done: number
}

const SLASH_COMMANDS: ReadonlyArray<{ cmd: string; detail: string; insert: string }> = [
  { cmd: "/status", detail: "Post a live status digest for targeted sessions", insert: "/status" },
  { cmd: "/collect", detail: "Collect latest assistant summaries across targeted sessions", insert: "/collect" },
  { cmd: "/team", detail: "Spawn a Hermes delegate_task team lead (@project task)", insert: "/team " },
  { cmd: "/spawn", detail: "Spawn a new solo Hermes session (@project task)", insert: "/spawn " },
  { cmd: "/steer", detail: "Interrupt and steer targeted running sessions immediately", insert: "/steer " },
  { cmd: "/queue", detail: "Queue a follow-up prompt after the current turn", insert: "/queue " },
  { cmd: "/stop", detail: "Interrupt all targeted running sessions", insert: "/stop" },
  { cmd: "/approve", detail: "Approve pending permission prompts across targeted sessions", insert: "/approve" },
  { cmd: "/model", detail: "Switch model across targeted sessions (/model <name>)", insert: "/model " },
  { cmd: "/help", detail: "Show orchestrator commands and @target routing", insert: "/help" },
]

const GROUP_TOKENS: ReadonlyArray<{ token: string; detail: string }> = [
  { token: "@live", detail: "All currently working sessions" },
  { token: "@ask", detail: "Sessions waiting on permission or input" },
  { token: "@review", detail: "Finished sessions awaiting review" },
  { token: "@all", detail: "Every root session on the canvas" },
]

function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@+/, "")
}

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Extract leading `@token` mentions before the main body text. */
function extractLeadingMentions(input: string): { mentions: string[]; rest: string } {
  const mentions: string[] = []
  let rest = input.trim()
  while (rest.startsWith("@")) {
    const m = /^@([^\s]+)(?:\s+([\s\S]*))?$/.exec(rest)
    if (!m) break
    const tok = m[1]!.trim()
    if (!tok) break
    mentions.push(tok)
    rest = (m[2] ?? "").trim()
  }
  return { mentions, rest }
}

/**
 * Parse a single user input from the unified Orchestrator chat into a
 * structured command or multi-session prompt dispatch.
 */
export function parseOrchestratorInput(
  raw: string,
  defaultDelivery: "steer" | "queue" = "steer",
): ParsedOrchestratorInput {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { kind: "prompt", text: "", delivery: defaultDelivery, mentions: [] }
  }

  if (trimmed.startsWith("/")) {
    const m = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed)
    const cmd = (m?.[1] ?? "").toLowerCase()
    const tail = (m?.[2] ?? "").trim()
    const { mentions, rest } = extractLeadingMentions(tail)

    switch (cmd) {
      case "status":
      case "tasks":
      case "agents":
        return { kind: "status", text: rest, mentions }
      case "collect":
      case "summary":
      case "summarize":
        return { kind: "collect", text: rest, mentions }
      case "spawn":
      case "new":
        return { kind: "spawn", text: rest, mentions, team: false }
      case "team":
      case "delegate":
        return { kind: "spawn", text: rest, mentions, team: true }
      case "stop":
      case "cancel":
      case "interrupt":
        return { kind: "stop", text: rest, mentions }
      case "approve":
      case "allow":
        return { kind: "approve", text: rest, mentions }
      case "model":
        return { kind: "model", text: rest, mentions }
      case "queue":
        return { kind: "prompt", text: rest, delivery: "queue", mentions }
      case "steer":
        return { kind: "prompt", text: rest, delivery: "steer", mentions }
      case "help":
        return { kind: "help", text: rest, mentions }
      default:
        // Unknown slash prefix: treat as literal prompt text so user prose isn't swallowed.
        return { kind: "prompt", text: trimmed, delivery: defaultDelivery, mentions: [] }
    }
  }

  const { mentions, rest } = extractLeadingMentions(trimmed)
  // If user typed ONLY @mentions with no directive, keep them as mentions with empty text.
  return {
    kind: "prompt",
    text: rest,
    delivery: defaultDelivery,
    mentions,
  }
}

/**
 * Resolve explicit `@mentions` (or fall back to the user's selected session IDs)
 * against the current fleet of root sessions.
 */
export function resolveOrchestratorTargets(
  fleet: readonly FleetSession[],
  selectedIds: ReadonlySet<string>,
  mentions: readonly string[],
): TargetResolution {
  if (!mentions.length) {
    const picked = fleet.filter((s) => selectedIds.has(s.id))
    const label =
      picked.length === 0
        ? "No sessions selected"
        : picked.length === 1
          ? picked[0]!.title
          : `${picked.length} selected sessions`
    return { sessions: picked, scopeLabel: label, usedMentions: false, unknownMentions: [] }
  }

  const matched = new Map<string, FleetSession>()
  const labels: string[] = []
  const unknownMentions: string[] = []

  for (const rawTok of mentions) {
    const tok = normalizeToken(rawTok)
    if (!tok) continue

    if (tok === "all") {
      for (const s of fleet) matched.set(s.id, s)
      labels.push("@all")
      continue
    }
    if (tok === "live" || tok === "working" || tok === "running") {
      const hits = fleet.filter((s) => s.status === "working" || s.running)
      for (const s of hits) matched.set(s.id, s)
      labels.push("@live")
      continue
    }
    if (tok === "ask" || tok === "needs-you" || tok === "blocked") {
      const hits = fleet.filter((s) => s.status === "needs-you" || !!s.needsInput)
      for (const s of hits) matched.set(s.id, s)
      labels.push("@ask")
      continue
    }
    if (tok === "review") {
      const hits = fleet.filter((s) => s.status === "review" || s.status === "failed")
      for (const s of hits) matched.set(s.id, s)
      labels.push("@review")
      continue
    }

    // 1. Exact project label match
    let hits = fleet.filter((s) => s.projectLabel.toLowerCase() === tok || slugify(s.projectLabel) === tok)
    // 2. Exact session ID or title slug match
    if (!hits.length) {
      hits = fleet.filter((s) => s.id.toLowerCase() === tok || slugify(s.title) === tok)
    }
    // 3. Unique/prefix match on project label
    if (!hits.length) {
      hits = fleet.filter((s) => s.projectLabel.toLowerCase().startsWith(tok) || slugify(s.projectLabel).startsWith(tok))
    }
    // 4. Substring match on session title
    if (!hits.length) {
      hits = fleet.filter((s) => s.title.toLowerCase().includes(tok) || slugify(s.title).includes(tok))
    }

    if (hits.length) {
      for (const s of hits) matched.set(s.id, s)
      labels.push(`@${rawTok}`)
    } else {
      unknownMentions.push(rawTok)
    }
  }

  const sessions = [...matched.values()]
  const scopeLabel = labels.length ? labels.join(" ") : "No matching sessions"
  return { sessions, scopeLabel, usedMentions: true, unknownMentions }
}

/** Resolve a single `@project` mention to a known project directory (used by `/spawn` and `/team`). */
export function resolveSpawnProject(
  projects: readonly { label: string; directory: string }[],
  mentions: readonly string[],
): { label: string; directory: string } | undefined {
  for (const rawTok of mentions) {
    const tok = normalizeToken(rawTok)
    if (!tok) continue
    const exact = projects.find((p) => p.label.toLowerCase() === tok || slugify(p.label) === tok)
    if (exact) return exact
    const pref = projects.filter((p) => p.label.toLowerCase().startsWith(tok) || slugify(p.label).startsWith(tok))
    if (pref.length === 1) return pref[0]
  }
  return undefined
}

/** Filter and group the session fleet by project, sorted by urgency then recency. */
export function filterAndGroupFleet(
  fleet: readonly FleetSession[],
  filter: "all" | "live" | "ask" | "review",
  query: string,
): FleetProjectGroup[] {
  const q = query.trim().toLowerCase()
  const filtered = fleet.filter((s) => {
    if (filter === "live" && s.status !== "working" && !s.running) return false
    if (filter === "ask" && s.status !== "needs-you" && !s.needsInput) return false
    if (filter === "review" && s.status !== "review" && s.status !== "failed") return false
    if (q) {
      const hay = `${s.title} ${s.projectLabel} ${s.preview} ${s.activity} ${s.modelLabel}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  const map = new Map<string, FleetProjectGroup>()
  for (const s of filtered) {
    let g = map.get(s.projectKey)
    if (!g) {
      g = {
        key: s.projectKey,
        label: s.projectLabel,
        directory: s.directory,
        sessions: [],
        working: 0,
        needsYou: 0,
        review: 0,
      }
      map.set(s.projectKey, g)
    }
    g.sessions.push(s)
    if (s.status === "needs-you") g.needsYou++
    else if (s.status === "working") g.working++
    else if (s.status === "review" || s.status === "failed") g.review++
  }

  const rankSession = (s: FleetSession) => {
    if (s.status === "needs-you") return 0
    if (s.status === "working") return 1
    if (s.status === "review" || s.status === "failed") return 2
    return 3
  }

  const groups = [...map.values()]
  for (const g of groups) {
    g.sessions.sort((a, b) => rankSession(a) - rankSession(b) || b.updated - a.updated)
  }
  groups.sort(
    (a, b) =>
      (b.needsYou > 0 ? 1 : 0) - (a.needsYou > 0 ? 1 : 0) ||
      (b.working > 0 ? 1 : 0) - (a.working > 0 ? 1 : 0) ||
      (b.sessions[0]?.updated ?? 0) - (a.sessions[0]?.updated ?? 0),
  )
  return groups
}

/** Suggest inline `/` commands or `@target` mentions for the active token at the end of the composer. */
export function orchestratorSuggestions(
  input: string,
  fleet: readonly FleetSession[],
  projects: readonly { label: string; directory: string }[],
): AutocompleteItem[] {
  const trimmedStart = input.trimStart()
  if (!trimmedStart) return []

  // Slash command completion when typing the first token.
  if (trimmedStart.startsWith("/") && !/\s/.test(trimmedStart)) {
    const q = trimmedStart.toLowerCase()
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q)).map((c) => ({
      insert: c.insert,
      label: c.cmd,
      detail: c.detail,
      kind: "command",
    }))
  }

  // @mention completion for the trailing token.
  const m = /(?:^|\s)(@[^\s]*)$/.exec(input)
  if (!m) return []
  const partial = m[1]!.slice(1).toLowerCase()
  const out: AutocompleteItem[] = []

  for (const g of GROUP_TOKENS) {
    if (!partial || g.token.slice(1).startsWith(partial)) {
      out.push({ insert: `${g.token} `, label: g.token, detail: g.detail, kind: "group" })
    }
  }

  const seenProj = new Set<string>()
  for (const p of projects) {
    const slug = slugify(p.label)
    if (!slug || seenProj.has(slug)) continue
    seenProj.add(slug)
    if (!partial || slug.includes(partial) || p.label.toLowerCase().includes(partial)) {
      const count = fleet.filter((s) => s.projectLabel === p.label).length
      out.push({
        insert: `@${slug} `,
        label: `@${p.label}`,
        detail: `${count} session${count === 1 ? "" : "s"}`,
        kind: "project",
      })
    }
  }

  for (const s of fleet) {
    const slug = slugify(s.title)
    if (!partial || slug.includes(partial) || s.title.toLowerCase().includes(partial)) {
      out.push({
        insert: `@${slug} `,
        label: `@${s.title}`,
        detail: `${s.projectLabel} · ${s.status}`,
        kind: "session",
      })
    }
    if (out.length >= 10) break
  }

  return out.slice(0, 10)
}

/** Roll up execution states across all target sessions in one dispatch. */
export function rollupDispatchStates(states: readonly DispatchTargetState[]): DispatchRollup {
  let active = 0
  let succeeded = 0
  let failed = 0
  let interrupted = 0
  for (const st of states) {
    if (st === "sending" || st === "running" || st === "queued") active++
    else if (st === "succeeded") succeeded++
    else if (st === "interrupted") interrupted++
    else failed++
  }
  return {
    total: states.length,
    active,
    succeeded,
    failed,
    interrupted,
    done: succeeded + failed + interrupted,
  }
}

/** Build a clean FleetSession snapshot from a raw Session and auxiliary store fields. */
export function toFleetSession(
  s: Session,
  meta: {
    title: string
    projectKey: string
    projectLabel: string
    status: Status
    running: boolean
    needsInput: "permission" | "question" | undefined
    activity: string
    modelLabel: string
    subagents: number
    preview: string
  },
): FleetSession {
  return {
    id: s.id,
    title: meta.title,
    projectKey: meta.projectKey,
    projectLabel: meta.projectLabel,
    directory: s.location?.directory ?? "",
    status: meta.status,
    running: meta.running,
    needsInput: meta.needsInput,
    activity: meta.activity,
    modelLabel: meta.modelLabel,
    subagents: meta.subagents,
    updated: s.time.updated,
    preview: meta.preview,
  }
}
