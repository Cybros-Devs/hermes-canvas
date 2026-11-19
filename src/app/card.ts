// Session card DOM. Built once per card, then patched in place.

import { previewBlocks } from "./markdown"
import { spinner } from "./spinners"
import { REVIEW_WINDOW, type Status, type Store } from "./store"
import { timeAgo } from "./format"

export interface CardEls {
  root: HTMLElement
  project: HTMLElement
  title: HTMLElement
  body: HTMLElement
  text: HTMLElement
  bullets: HTMLElement
  permBar: HTMLElement
  permCmd: HTMLElement
  permAllow: HTMLButtonElement
  status: HTMLElement
  sub: HTMLElement
  stopBtn: HTMLButtonElement
  orchBtn: HTMLButtonElement
  pinBtn: HTMLButtonElement
  state: string
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const PIN_SVG = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5l4 4-2.2.8-2.6 2.6.3 2.6-1.2 1.2-2.4-2.4L3 13.6M2.9 7.9l1.2-1.2 2.6.3 2.6-2.6z"/></svg>`
const STOP_SVG = `<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg>`
const ORCH_SVG = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="4" r="1.7"/><circle cx="12" cy="4" r="1.7"/><circle cx="8" cy="12" r="1.7"/><path d="M5.3 5.2 7.1 10.4M10.7 5.2 8.9 10.4"/></svg>`

export function createSessionCard(id: string): CardEls {
  const root = el("div", "card")
  root.dataset.id = id
  root.tabIndex = -1
  root.setAttribute("role", "button")
  // Coloured top edge: the status reads even when zoomed far out.
  const accent = el("div", "card-accent")
  // The Hermes arc: an amber stroke that travels the card while it's selected.
  const arc = el("div", "card-arc")
  const quick = el("div", "card-quick")
  const stopBtn = el("button", "card-qbtn stop") as HTMLButtonElement
  stopBtn.type = "button"
  stopBtn.dataset.quick = "stop"
  stopBtn.dataset.id = id
  stopBtn.innerHTML = STOP_SVG
  stopBtn.title = "Stop session"
  stopBtn.setAttribute("aria-label", "Stop session")
  stopBtn.hidden = true
  const orchBtn = el("button", "card-qbtn orch") as HTMLButtonElement
  orchBtn.type = "button"
  orchBtn.dataset.quick = "orchestrate"
  orchBtn.dataset.id = id
  orchBtn.innerHTML = ORCH_SVG
  orchBtn.title = "Inspect & steer in Orchestrate"
  orchBtn.setAttribute("aria-label", "Open in Orchestrate")
  const pinBtn = el("button", "card-qbtn pin") as HTMLButtonElement
  pinBtn.type = "button"
  pinBtn.dataset.quick = "pin"
  pinBtn.dataset.id = id
  pinBtn.innerHTML = PIN_SVG
  pinBtn.title = "Pin to Tiles"
  pinBtn.setAttribute("aria-label", "Pin to Tiles")
  quick.append(stopBtn, orchBtn, pinBtn)
  root.append(accent, arc, quick)
  const project = el("div", "card-project")
  const title = el("div", "card-title")
  const body = el("div", "card-body")
  const text = el("p", "card-text")
  const bullets = el("ul", "card-bullets")
  body.append(text, bullets)
  const permBar = el("div", "card-perm")
  permBar.hidden = true
  const permCmd = el("span", "card-perm-cmd")
  const permAllow = el("button", "card-qbtn card-perm-allow", "Allow once") as HTMLButtonElement
  permAllow.type = "button"
  permAllow.dataset.quick = "approve"
  permAllow.dataset.id = id
  permAllow.title = "Approve waiting permission once without opening the panel"
  permAllow.setAttribute("aria-label", "Allow waiting permission once")
  permBar.append(permCmd, permAllow)
  const foot = el("div", "card-foot")
  const status = el("span", "card-status")
  const sub = el("span", "card-sub")
  foot.append(status, sub)
  root.append(project, title, body, permBar, foot)
  return { root, project, title, body, text, bullets, permBar, permCmd, permAllow, status, sub, stopBtn, orchBtn, pinBtn, state: "" }
}

export function createNewCard(groupKey: string): HTMLElement {
  const root = el("div", "card card-new")
  root.dataset.id = `new:${groupKey}`
  root.dataset.group = groupKey
  root.setAttribute("role", "button")
  root.innerHTML = `<span class="plus">+</span> New session`
  return root
}

const STATUSES: Status[] = ["needs-you", "working", "review", "failed", "stopped", "done"]
const STATUS_TEXT: Record<Status, string> = {
  "needs-you": "needs your input",
  working: "working",
  review: "finished, not reviewed yet",
  failed: "failed",
  stopped: "stopped",
  done: "done",
}

function setText(e: HTMLElement, v: string): boolean {
  if (e.textContent === v) return false
  e.textContent = v
  return true
}

function firstPermission(store: Store, id: string) {
  const own = store.permissions.get(id)?.[0]
  if (own) return own
  for (const c of store.children.get(id) ?? []) {
    const p = store.permissions.get(c)?.[0]
    if (p) return p
  }
  return undefined
}

/** Patch a card's DOM in place. Returns true when layout-affecting content changed. */
export function updateSessionCard(c: CardEls, store: Store, id: string, now = Date.now()): boolean {
  const s = store.sessions.get(id)
  if (!s) return false
  const working = store.isWorking(id)
  const ask = store.needsInput(id) ?? undefined
  const preview = store.previews.get(id)
  const live = working ? store.liveText.get(id) : undefined

  let heightChanged = c.state === ""
  setText(c.project, store.projectLabel(s))
  if (setText(c.title, store.title(s))) heightChanged = true
  c.root.title = s.location.directory

  let body = preview?.text ?? ""
  let bullets = preview?.bullets ?? []
  let pending = false
  if (live && live.trim()) {
    const p = previewBlocks(live)
    body = p.text
    bullets = p.bullets
  } else if (preview?.pendingUser && working) {
    body = preview.pendingUser
    bullets = []
    pending = true
  }
  if (setText(c.text, body)) heightChanged = true
  if (c.text.classList.contains("pending") !== pending) {
    c.text.classList.toggle("pending", pending)
    heightChanged = true
  }
  // Fixed-height body: streaming text never changes the card's size. Before
  // the preview loads, reserve the space so the layout doesn't jump.
  const empty = !!preview && !body && !bullets.length
  if (c.body.classList.contains("empty") !== empty) {
    c.body.classList.toggle("empty", empty)
    heightChanged = true
  }
  const bulletKey = bullets.join("\u0001")
  if (c.bullets.dataset.key !== bulletKey) {
    c.bullets.dataset.key = bulletKey
    c.bullets.replaceChildren(...bullets.map((b) => el("li", "", b)))
    heightChanged = true
  }
  // Only fade the top edge when the body actually clips its first line; the
  // mask used to wash out the first line of every short preview too.
  const bodyKey = `${body}\u0000${bulletKey}\u0000${pending}\u0000${empty}`
  if (c.body.dataset.key !== bodyKey) {
    c.body.dataset.key = bodyKey
    c.body.classList.toggle(
      "clipped",
      !empty && c.body.scrollHeight > c.body.clientHeight + 1,
    )
  }

  // Inline permission approval bar directly on waiting cards.
  const perm = firstPermission(store, id)
  const showPerm = !!perm
  if (c.permBar.hidden !== !showPerm) {
    c.permBar.hidden = !showPerm
    heightChanged = true
  }
  if (perm) {
    const detail = perm.resources?.[0] ? `${perm.action}: ${perm.resources[0]}` : perm.action
    setText(c.permCmd, detail)
    c.permCmd.title = detail
  }

  const status = store.status(id, now)
  if ((c.root.dataset.status === "working") !== (status === "working")) heightChanged = true
  const fresh = status === "failed" && store.unseen(id) && now - (s.time.idle ?? 0) < REVIEW_WINDOW
  const state = `${status}:${ask ?? ""}:${fresh}`
  if (state !== c.state) {
    c.state = state
    c.status.replaceChildren()
    for (const st of STATUSES) c.root.classList.toggle(`st-${st}`, st === status)
    c.root.classList.toggle("fresh", fresh)
    c.root.dataset.status = status
    c.stopBtn.hidden = status !== "working"
    if (status === "working") c.status.append(spinner(13), el("span", "label"))
    else c.status.append(el("span", `mark ${status}`), el("span", "label"))
  }
  const label = c.status.querySelector<HTMLElement>(".label")!
  const ago = timeAgo(s.time.idle ?? s.time.updated, now)
  switch (status) {
    case "needs-you":
      setText(label, ask === "question" ? "Waiting for your answer" : "Needs permission")
      break
    case "working":
      setText(label, store.activityLabel(id))
      break
    case "review":
      setText(label, `Finished · ${ago}`)
      break
    case "failed":
      setText(label, `Failed · ${ago}`)
      break
    case "stopped":
      setText(label, `Stopped · ${ago}`)
      break
    default:
      setText(label, ago)
  }
  c.root.setAttribute("aria-label", `${store.title(s)}, ${STATUS_TEXT[status]}`)

  const n = store.subagentCount(id)
  setText(c.sub, n ? `${n} subagent${n === 1 ? "" : "s"}` : "")
  c.root.classList.toggle("has-sub", n > 0)
  return heightChanged
}
