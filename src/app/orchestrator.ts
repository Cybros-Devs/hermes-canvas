// Centralized Orchestrator Page: control multiple Hermes agent sessions from
// one unified chat. Supports parallel steer/queue fan-out, @target routing
// (@live, @ask, @review, @all, @project, @session), Hermes slash commands
// (/status, /collect, /team, /spawn, /stop, /approve, /model, /help), live
// per-session execution tracking, and an inline live transcript inspector.

import { autoApproveToggle } from "./approve"
import type { Backend } from "./backend"
import { lastAssistantText, timeAgo } from "./format"
import { launchPrompt } from "./launch"
import { defaultModel, modelLabel, models } from "./models"
import {
  filterAndGroupFleet,
  orchestratorSuggestions,
  parseOrchestratorInput,
  resolveOrchestratorTargets,
  resolveSpawnProject,
  rollupDispatchStates,
  toFleetSession,
  type AutocompleteItem,
  type DispatchTargetState,
  type FleetSession,
} from "./orchestrator-logic"
import { spinner } from "./spinners"
import { ALLOW_ALL, STATUS_LABEL, type Store } from "./store"
import { toast } from "./toast"
import { Transcript } from "./transcript"
import type { OcEvent } from "./types"
import pipMark from "../../assets/pip.svg"

const TARGETS_KEY = "hermes-canvas.orch.targets"
const DELIVERY_KEY = "hermes-canvas.orch.delivery"

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const svg = (d: string, size = 14) =>
  `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`

const ICONS = {
  canvas: svg('<rect x="2" y="2" width="5" height="5"/><rect x="9" y="2" width="5" height="5"/><rect x="2" y="9" width="5" height="5"/><rect x="9" y="9" width="5" height="5"/>'),
  inspect: svg('<path d="M2 8s2.5-4.5 6-4.5S14 8 14 8s-2.5 4.5-6 4.5S2 8 2 8z"/><circle cx="8" cy="8" r="1.8"/>'),
  open: svg('<path d="M6.5 3.5h-3v9h9v-3M9.5 2.5h4v4M13.5 2.5 7.5 8.5"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  menu: svg('<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>'),
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function saveJson(key: string, val: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(val))
  } catch {
    /* private mode */
  }
}

function formatClock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  } catch {
    return ""
  }
}

interface DispatchTargetRecord {
  sessionID: string
  title: string
  projectLabel: string
  state: DispatchTargetState
  activity: string
  output: string
  error?: string
  rowEl?: HTMLElement
  stateEl?: HTMLElement
  activityEl?: HTMLElement
  outputEl?: HTMLElement
  stopBtn?: HTMLButtonElement
}

interface DispatchEntry {
  id: string
  at: number
  kind: "prompt" | "status" | "collect" | "spawn" | "stop" | "approve" | "model" | "help"
  modeLabel: string
  scopeLabel: string
  promptText: string
  note?: string
  targets: DispatchTargetRecord[]
  el?: HTMLElement
  rollupEl?: HTMLElement
}

export interface OrchestratorHandlers {
  openCanvas(): void
  openTiles(): void
  openSessionOnCanvas(id: string): void
  openNewPicker(): void
  closed(): void
}

export class OrchestratorView {
  private root: HTMLElement
  private barSummary: HTMLElement
  private mobileFleetBtn: HTMLButtonElement
  private shell: HTMLElement
  private rosterBackdrop: HTMLElement
  private rosterEl: HTMLElement
  private rosterCountEl: HTMLElement
  private rosterSearch: HTMLInputElement
  private rosterList: HTMLElement
  private filterBtns = new Map<"all" | "live" | "ask" | "review", HTMLButtonElement>()
  private scopeSummaryEl: HTMLElement
  private scopeChipsEl: HTMLElement
  private bulkApproveBtn: HTMLButtonElement
  private bulkStopBtn: HTMLButtonElement
  private permBanner: HTMLElement
  private feedEl: HTMLElement
  private welcomeEl: HTMLElement
  private acEl: HTMLElement
  private input: HTMLTextAreaElement
  private sendBtn: HTMLButtonElement
  private deliveryBtns = new Map<"steer" | "queue", HTMLButtonElement>()
  private inspectorEl: HTMLElement
  private inspProjectEl: HTMLElement
  private inspTitleEl: HTMLElement
  private inspStatusEl: HTMLElement
  private inspModelEl: HTMLElement
  private inspStopBtn: HTMLButtonElement
  private inspCanvasBtn: HTMLButtonElement
  private inspTranscript: Transcript
  private inspInput: HTMLTextAreaElement
  private inspSendBtn: HTMLButtonElement

  private openState = false
  private rosterOpenMobile = false
  private rosterFilter: "all" | "live" | "ask" | "review" = "all"
  private rosterQuery = ""
  private selected = new Set<string>()
  private initializedSelection = false
  private delivery: "steer" | "queue" = loadJson<"steer" | "queue">(DELIVERY_KEY, "steer") === "queue" ? "queue" : "steer"
  private entries: DispatchEntry[] = []
  private activeDispatchBySession = new Map<string, DispatchTargetRecord>()
  private inspectedId?: string
  private acItems: AutocompleteItem[] = []
  private acIdx = 0
  private unsub: () => void
  private tickTimer: ReturnType<typeof setInterval>
  private ac = new AbortController()
  private seq = 0
  private rosterSig = ""
  private rosterGroups = new Map<string, { checkEl: HTMLElement; countEl: HTMLElement; toggleBtn: HTMLButtonElement; sessionIds: string[] }>()
  private rosterRows = new Map<
    string,
    {
      row: HTMLElement
      cb: HTMLInputElement
      titleEl: HTMLElement
      subEl: HTMLElement
      stopBtn: HTMLButtonElement
    }
  >()
  private scopeSig = ""
  private permSig = ""

  constructor(
    host: HTMLElement,
    private store: Store,
    private backend: Backend,
    private handlers: OrchestratorHandlers,
  ) {
    const savedTargets = loadJson<unknown>(TARGETS_KEY, null)
    if (Array.isArray(savedTargets)) {
      for (const id of savedTargets) if (typeof id === "string") this.selected.add(id)
      this.initializedSelection = true
    }

    this.root = h("section", "orch-view")
    this.root.setAttribute("aria-label", "Hermes Centralized Orchestrator")
    this.root.hidden = true

    // ---- Top navigation bar ----
    const bar = h("header", "orch-bar")
    const barLeft = h("div", "orch-bar-left")
    this.mobileFleetBtn = h("button", "orch-btn orch-mobile-fleet") as HTMLButtonElement
    this.mobileFleetBtn.type = "button"
    this.mobileFleetBtn.innerHTML = `${ICONS.menu}<span>Fleet</span>`
    this.mobileFleetBtn.setAttribute("aria-label", "Toggle session fleet roster")
    this.mobileFleetBtn.addEventListener("click", () => this.setMobileRoster(!this.rosterOpenMobile))

    const brand = h("div", "orch-brand")
    const pip = document.createElement("img")
    pip.src = pipMark
    pip.alt = "Pip, the courier owl"
    pip.className = "orch-brand-mark"
    pip.draggable = false
    brand.append(pip, h("span", "orch-brand-name", "Hermes"))

    const nav = h("nav", "orch-nav")
    nav.setAttribute("aria-label", "Workspace views")
    const navCanvas = h("button", "orch-nav-btn", "Canvas") as HTMLButtonElement
    navCanvas.type = "button"
    navCanvas.title = "Spatial sessions canvas (Esc)"
    navCanvas.addEventListener("click", () => {
      this.close()
      this.handlers.openCanvas()
    })
    const navTiles = h("button", "orch-nav-btn", "Tiles") as HTMLButtonElement
    navTiles.type = "button"
    navTiles.title = "Side-by-side live tiles (T)"
    navTiles.addEventListener("click", () => {
      this.close()
      this.handlers.openTiles()
    })
    const navOrch = h("button", "orch-nav-btn on", "Orchestrate") as HTMLButtonElement
    navOrch.type = "button"
    navOrch.setAttribute("aria-current", "page")
    nav.append(navCanvas, navTiles, navOrch)

    this.barSummary = h("div", "orch-bar-summary")
    barLeft.append(this.mobileFleetBtn, brand, nav, this.barSummary)

    const barRight = h("div", "orch-bar-right")
    const spawnBtn = h("button", "orch-btn primary", "+ New session") as HTMLButtonElement
    spawnBtn.type = "button"
    spawnBtn.title = "Create a new Hermes session"
    spawnBtn.addEventListener("click", () => this.handlers.openNewPicker())
    barRight.append(autoApproveToggle(store, { signal: this.ac.signal }), spawnBtn)
    bar.append(barLeft, barRight)

    // ---- Main 3-pane shell ----
    this.shell = h("div", "orch-shell")
    this.rosterBackdrop = h("div", "orch-backdrop")
    this.rosterBackdrop.hidden = true
    this.rosterBackdrop.addEventListener("click", () => this.setMobileRoster(false))

    // ---- Left Sidebar: Fleet Roster ----
    this.rosterEl = h("aside", "orch-roster")
    this.rosterEl.setAttribute("aria-label", "Session fleet roster")

    const rHead = h("div", "orch-roster-head")
    const rTitleRow = h("div", "orch-roster-title-row")
    rTitleRow.append(h("h2", "orch-roster-title", "Session fleet"))
    this.rosterCountEl = h("span", "orch-roster-count", "0 selected")
    const rClose = h("button", "orch-icon-btn orch-roster-close") as HTMLButtonElement
    rClose.type = "button"
    rClose.innerHTML = ICONS.close
    rClose.setAttribute("aria-label", "Close fleet roster")
    rClose.addEventListener("click", () => this.setMobileRoster(false))
    rTitleRow.append(this.rosterCountEl, rClose)

    const rPresets = h("div", "orch-roster-presets")
    const presetLive = h("button", "orch-mini-btn", "Select live") as HTMLButtonElement
    presetLive.type = "button"
    presetLive.addEventListener("click", () => this.selectByFilter("live"))
    const presetAll = h("button", "orch-mini-btn", "All") as HTMLButtonElement
    presetAll.type = "button"
    presetAll.addEventListener("click", () => this.selectByFilter("all"))
    const presetNone = h("button", "orch-mini-btn", "Clear") as HTMLButtonElement
    presetNone.type = "button"
    presetNone.addEventListener("click", () => this.clearSelection())
    rPresets.append(presetLive, presetAll, presetNone)

    this.rosterSearch = h("input", "orch-roster-search") as HTMLInputElement
    this.rosterSearch.type = "search"
    this.rosterSearch.placeholder = "Filter projects or sessions…"
    this.rosterSearch.setAttribute("aria-label", "Filter fleet sessions")
    this.rosterSearch.addEventListener("input", () => {
      this.rosterQuery = this.rosterSearch.value
      this.renderRoster()
    })

    const rFilters = h("div", "orch-filter-tabs")
    rFilters.setAttribute("role", "tablist")
    rFilters.setAttribute("aria-label", "Filter fleet by status")
    for (const [key, label] of [
      ["all", "All"],
      ["live", "Live"],
      ["ask", "Ask"],
      ["review", "Review"],
    ] as const) {
      const b = h("button", `orch-ftab${key === "all" ? " on" : ""}`, label) as HTMLButtonElement
      b.type = "button"
      b.setAttribute("role", "tab")
      b.setAttribute("aria-selected", String(key === "all"))
      b.addEventListener("click", () => {
        this.rosterFilter = key
        for (const [k, btn] of this.filterBtns) {
          btn.classList.toggle("on", k === key)
          btn.setAttribute("aria-selected", String(k === key))
        }
        this.renderRoster()
      })
      this.filterBtns.set(key, b)
      rFilters.append(b)
    }
    rHead.append(rTitleRow, rPresets, this.rosterSearch, rFilters)

    this.rosterList = h("div", "orch-roster-list")
    this.rosterEl.append(rHead, this.rosterList)

    // ---- Center Workspace: Unified Orchestrator Chat ----
    const chat = h("div", "orch-chat")

    const scopeBar = h("div", "orch-scope")
    const scopeLeft = h("div", "orch-scope-left")
    this.scopeSummaryEl = h("div", "orch-scope-summary", "No sessions selected")
    this.scopeChipsEl = h("div", "orch-scope-chips")
    scopeLeft.append(this.scopeSummaryEl, this.scopeChipsEl)

    const scopeRight = h("div", "orch-scope-actions")
    this.bulkApproveBtn = h("button", "orch-action-btn warn", "Approve all") as HTMLButtonElement
    this.bulkApproveBtn.type = "button"
    this.bulkApproveBtn.hidden = true
    this.bulkApproveBtn.addEventListener("click", () => void this.runCommand("/approve"))

    const collectBtn = h("button", "orch-action-btn", "Collect") as HTMLButtonElement
    collectBtn.type = "button"
    collectBtn.title = "Collect latest summaries from targeted sessions (/collect)"
    collectBtn.addEventListener("click", () => void this.runCommand("/collect"))

    this.bulkStopBtn = h("button", "orch-action-btn danger", "Stop selected") as HTMLButtonElement
    this.bulkStopBtn.type = "button"
    this.bulkStopBtn.hidden = true
    this.bulkStopBtn.addEventListener("click", () => void this.runCommand("/stop"))

    const clearChatBtn = h("button", "orch-action-btn ghost", "Clear log") as HTMLButtonElement
    clearChatBtn.type = "button"
    clearChatBtn.title = "Clear orchestrator dispatch log"
    clearChatBtn.addEventListener("click", () => this.clearLog())

    scopeRight.append(this.bulkApproveBtn, collectBtn, this.bulkStopBtn, clearChatBtn)
    scopeBar.append(scopeLeft, scopeRight)

    this.permBanner = h("div", "orch-perm-banner")
    this.permBanner.hidden = true

    this.feedEl = h("div", "orch-feed")
    this.feedEl.setAttribute("role", "log")
    this.feedEl.setAttribute("aria-live", "polite")
    this.feedEl.setAttribute("aria-label", "Orchestration timeline")

    this.welcomeEl = this.buildWelcome()
    this.feedEl.append(this.welcomeEl)

    // ---- Single Chat Composer ----
    const composerWrap = h("div", "orch-composer-wrap")
    this.acEl = h("div", "orch-ac")
    this.acEl.setAttribute("role", "listbox")
    this.acEl.hidden = true

    const composer = h("div", "orch-composer")
    const compTop = h("div", "orch-comp-top")

    const delGroup = h("div", "orch-del-group")
    delGroup.setAttribute("role", "radiogroup")
    delGroup.setAttribute("aria-label", "Prompt delivery mode")
    for (const [mode, label, title] of [
      ["steer", "Steer", "Interrupt active turns and redirect immediately (Enter)"],
      ["queue", "Queue", "Queue follow-up prompts for after each session's current turn (Tab)"],
    ] as const) {
      const b = h("button", `orch-del-btn${this.delivery === mode ? " on" : ""}`, label) as HTMLButtonElement
      b.type = "button"
      b.title = title
      b.setAttribute("role", "radio")
      b.setAttribute("aria-checked", String(this.delivery === mode))
      b.addEventListener("click", () => this.setDelivery(mode))
      this.deliveryBtns.set(mode, b)
      delGroup.append(b)
    }

    const quickCmds = h("div", "orch-quick-cmds")
    for (const [label, cmd, immediate] of [
      ["/status", "/status", true],
      ["/collect", "/collect", true],
      ["/team", "/team @", false],
      ["/spawn", "/spawn @", false],
      ["/help", "/help", true],
    ] as const) {
      const b = h("button", "orch-cmd-btn", label) as HTMLButtonElement
      b.type = "button"
      b.addEventListener("click", () => {
        if (immediate) {
          void this.runCommand(cmd)
        } else {
          this.input.value = cmd
          this.autosize()
          this.updateAutocomplete()
          this.input.focus()
        }
      })
      quickCmds.append(b)
    }
    compTop.append(delGroup, quickCmds)

    const compRow = h("div", "orch-comp-row")
    this.input = h("textarea", "orch-input") as HTMLTextAreaElement
    this.input.rows = 1
    this.input.spellcheck = true
    this.input.setAttribute("aria-label", "Orchestrate multiple sessions")
    this.input.addEventListener("input", () => {
      this.autosize()
      this.updateAutocomplete()
      this.syncSendReady()
    })
    this.input.addEventListener("keydown", (e) => this.onComposerKey(e))

    this.sendBtn = h("button", "orch-send", "Dispatch ↑") as HTMLButtonElement
    this.sendBtn.type = "button"
    this.sendBtn.title = "Send to targeted sessions (Enter)"
    this.sendBtn.addEventListener("click", () => void this.submitComposer())
    compRow.append(this.input, this.sendBtn)

    composer.append(compTop, compRow)
    composerWrap.append(this.acEl, composer)

    chat.append(scopeBar, this.permBanner, this.feedEl, composerWrap)

    // ---- Right Collapsible Live Inspector ----
    this.inspectorEl = h("aside", "orch-inspector")
    this.inspectorEl.setAttribute("aria-label", "Live session inspector")
    this.inspectorEl.hidden = true

    const inspHead = h("header", "orch-insp-head")
    const inspMeta = h("div", "orch-insp-meta")
    this.inspProjectEl = h("span", "orch-insp-proj")
    this.inspStatusEl = h("span", "orch-insp-status")
    this.inspModelEl = h("span", "orch-insp-model")
    inspMeta.append(this.inspProjectEl, this.inspStatusEl, this.inspModelEl)

    const inspActions = h("div", "orch-insp-actions")
    this.inspStopBtn = h("button", "orch-action-btn danger", "Stop") as HTMLButtonElement
    this.inspStopBtn.type = "button"
    this.inspStopBtn.hidden = true
    this.inspStopBtn.addEventListener("click", () => {
      if (!this.inspectedId) return
      void this.backend.interrupt(this.inspectedId).catch((e) => toast((e as Error).message))
    })
    this.inspCanvasBtn = h("button", "orch-icon-btn") as HTMLButtonElement
    this.inspCanvasBtn.type = "button"
    this.inspCanvasBtn.innerHTML = ICONS.open
    this.inspCanvasBtn.title = "Open full session on Canvas"
    this.inspCanvasBtn.setAttribute("aria-label", "Open session on Canvas")
    this.inspCanvasBtn.addEventListener("click", () => {
      if (!this.inspectedId) return
      const id = this.inspectedId
      this.close()
      this.handlers.openSessionOnCanvas(id)
    })
    const inspClose = h("button", "orch-icon-btn") as HTMLButtonElement
    inspClose.type = "button"
    inspClose.innerHTML = ICONS.close
    inspClose.title = "Close inspector"
    inspClose.setAttribute("aria-label", "Close inspector")
    inspClose.addEventListener("click", () => this.closeInspector())
    inspActions.append(this.inspStopBtn, this.inspCanvasBtn, inspClose)

    const inspTopRow = h("div", "orch-insp-row")
    inspTopRow.append(inspMeta, inspActions)
    this.inspTitleEl = h("h3", "orch-insp-title")
    inspHead.append(inspTopRow, this.inspTitleEl)

    this.inspTranscript = new Transcript(store, backend, {
      pageSize: 40,
      compact: true,
      onRender: () => this.renderInspectorHeader(),
      onFinished: () => this.renderInspectorHeader(),
    })
    this.inspTranscript.scroller.classList.add("orch-insp-scroll")

    const inspComp = h("div", "orch-insp-comp")
    this.inspInput = h("textarea", "orch-insp-input") as HTMLTextAreaElement
    this.inspInput.rows = 1
    this.inspInput.placeholder = "Direct message this session…"
    this.inspInput.setAttribute("aria-label", "Direct message inspected session")
    this.inspInput.addEventListener("keydown", (e) => {
      e.stopPropagation()
      if (e.isComposing) return
      if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        void this.sendDirectToInspected()
      }
    })
    this.inspSendBtn = h("button", "orch-insp-send", "↑") as HTMLButtonElement
    this.inspSendBtn.type = "button"
    this.inspSendBtn.title = "Send directly to this session"
    this.inspSendBtn.setAttribute("aria-label", "Send to inspected session")
    this.inspSendBtn.addEventListener("click", () => void this.sendDirectToInspected())
    inspComp.append(this.inspInput, this.inspSendBtn)

    this.inspectorEl.append(inspHead, this.inspTranscript.scroller, inspComp)

    this.shell.append(this.rosterBackdrop, this.rosterEl, chat, this.inspectorEl)
    this.root.append(bar, this.shell)
    host.append(this.root)

    this.unsub = store.on({
      structure: () => {
        if (!this.openState) return
        this.reconcileSelection()
        this.renderAll()
      },
      cards: (ids) => {
        if (!this.openState) return
        this.renderSummary()
        this.renderRoster()
        this.renderScope()
        this.renderPermBanner()
        if (this.inspectedId && ids.has(this.inspectedId)) this.renderInspectorHeader()
        for (const id of ids) this.syncDispatchRowFromStore(id)
      },
      event: (ev) => {
        if (!this.openState) return
        this.onStoreEvent(ev)
      },
    })
    this.tickTimer = setInterval(() => {
      if (this.openState) this.renderRoster()
    }, 30_000)
  }

  get isOpen() {
    return this.openState
  }

  open() {
    if (this.openState) return
    this.openState = true
    this.root.hidden = false
    document.documentElement.classList.add("orch-open")
    this.reconcileSelection()
    this.renderAll()
    requestAnimationFrame(() => this.input.focus())
  }

  /** Ensure a session is attached to the fleet and open its live inspector. */
  focusSession(id: string) {
    if (!this.store.sessions.has(id)) return
    this.selected.add(id)
    this.initializedSelection = true
    saveJson(TARGETS_KEY, [...this.selected])
    if (!this.openState) this.open()
    this.inspectSession(id)
    this.renderRoster()
    this.renderScope()
  }

  close() {
    if (!this.openState) return
    this.openState = false
    this.setMobileRoster(false)
    this.closeAutocomplete()
    this.root.hidden = true
    document.documentElement.classList.remove("orch-open")
    this.handlers.closed()
  }

  handleEscape(): boolean {
    if (!this.openState) return false
    if (!this.acEl.hidden) {
      this.closeAutocomplete()
      return true
    }
    if (this.rosterOpenMobile) {
      this.setMobileRoster(false)
      return true
    }
    if (this.inspectedId) {
      this.closeInspector()
      return true
    }
    this.close()
    this.handlers.openCanvas()
    return true
  }

  destroy() {
    this.ac.abort()
    clearInterval(this.tickTimer)
    this.unsub()
    this.inspTranscript.destroy()
    document.documentElement.classList.remove("orch-open")
    this.root.remove()
  }

  // ---- Fleet data helpers ----

  private buildFleet(): FleetSession[] {
    const now = Date.now()
    return this.store.roots().map((s) =>
      toFleetSession(s, {
        title: this.store.title(s),
        projectKey: this.store.groupKey(s),
        projectLabel: this.store.projectLabel(s),
        status: this.store.status(s.id, now),
        running: this.store.isWorking(s.id),
        needsInput: this.store.needsInput(s.id),
        activity: this.store.isWorking(s.id) ? this.store.activityLabel(s.id) : "",
        modelLabel: modelLabel(s.model),
        subagents: this.store.subagentCount(s.id),
        preview: this.store.liveText.get(s.id) || this.store.previews.get(s.id)?.text || "",
      }),
    )
  }

  private knownProjects(): Array<{ label: string; directory: string }> {
    const out: Array<{ label: string; directory: string }> = []
    const seen = new Set<string>()
    for (const g of this.store.groups()) {
      if (!g.directory || seen.has(g.directory)) continue
      seen.add(g.directory)
      out.push({ label: g.label, directory: g.directory })
    }
    for (const p of this.store.projects.values()) {
      if (!p.canonical || seen.has(p.canonical)) continue
      seen.add(p.canonical)
      out.push({ label: p.name || p.canonical.split(/[/\\]/).pop() || p.canonical, directory: p.canonical })
    }
    return out
  }

  private reconcileSelection() {
    const valid = new Set(this.store.roots().map((s) => s.id))
    let changed = false
    for (const id of [...this.selected]) {
      if (!valid.has(id)) {
        this.selected.delete(id)
        changed = true
      }
    }
    if (!this.initializedSelection && valid.size > 0) {
      this.initializedSelection = true
      const fleet = this.buildFleet()
      const live = fleet.filter((s) => s.status === "needs-you" || s.status === "working")
      const seed = live.length ? live : fleet.slice(0, 3)
      for (const s of seed) this.selected.add(s.id)
      changed = true
    }
    if (changed) saveJson(TARGETS_KEY, [...this.selected])
  }

  private toggleSelected(id: string) {
    if (this.selected.has(id)) this.selected.delete(id)
    else this.selected.add(id)
    this.initializedSelection = true
    saveJson(TARGETS_KEY, [...this.selected])
    this.renderRoster()
    this.renderScope()
  }

  private selectByFilter(mode: "live" | "all") {
    const fleet = this.buildFleet()
    this.selected.clear()
    for (const s of fleet) {
      if (mode === "all" || s.status === "working" || s.status === "needs-you") {
        this.selected.add(s.id)
      }
    }
    this.initializedSelection = true
    saveJson(TARGETS_KEY, [...this.selected])
    this.renderRoster()
    this.renderScope()
  }

  private clearSelection() {
    this.selected.clear()
    this.initializedSelection = true
    saveJson(TARGETS_KEY, [])
    this.renderRoster()
    this.renderScope()
  }

  private setDelivery(mode: "steer" | "queue") {
    this.delivery = mode
    saveJson(DELIVERY_KEY, mode)
    for (const [k, b] of this.deliveryBtns) {
      b.classList.toggle("on", k === mode)
      b.setAttribute("aria-checked", String(k === mode))
    }
    this.renderScope()
  }

  private setMobileRoster(open: boolean) {
    this.rosterOpenMobile = open
    this.rosterEl.classList.toggle("mobile-open", open)
    this.rosterBackdrop.hidden = !open
  }

  // ---- Rendering ----

  private buildWelcome(): HTMLElement {
    const box = h("div", "orch-welcome")
    box.append(
      h("h1", "orch-welcome-title", "Centralized Hermes Orchestration"),
      h(
        "p",
        "orch-welcome-sub",
        "Steer, queue, spawn, and collect summaries across multiple Hermes sessions from one chat. Select sessions in the fleet roster or route inline with @live, @project, or slash commands.",
      ),
    )

    const starters = h("div", "orch-starters")
    const items: Array<{ title: string; desc: string; cmd: string; runNow: boolean }> = [
      {
        title: "Fleet status digest",
        desc: "Inspect live activity, pending approvals, and recent outputs across your selected sessions.",
        cmd: "/status",
        runNow: true,
      },
      {
        title: "Collect summaries",
        desc: "Pull the latest return summary from every targeted Hermes session into one unified readout.",
        cmd: "/collect",
        runNow: true,
      },
      {
        title: "Ask all live agents for blockers",
        desc: "Broadcast one status & blocker check to every running session without leaving this chat.",
        cmd: "@live Give a 2-bullet progress update and flag any blockers.",
        runNow: true,
      },
    ]
    for (const it of items) {
      const btn = h("button", "orch-starter") as HTMLButtonElement
      btn.type = "button"
      btn.append(
        h("span", "orch-starter-title", it.title),
        h("span", "orch-starter-desc", it.desc),
        h("span", "orch-starter-cmd", it.cmd),
      )
      btn.addEventListener("click", () => {
        if (it.runNow) void this.runCommand(it.cmd)
        else {
          this.input.value = it.cmd
          this.autosize()
          this.input.focus()
        }
      })
      starters.append(btn)
    }

    const hint = h(
      "div",
      "orch-welcome-hints",
      "Commands: /status · /collect · /team @project <task> · /spawn @project <task> · /stop · /approve · /model <name> · /help",
    )
    box.append(starters, hint)
    return box
  }

  private renderAll() {
    this.renderSummary()
    this.renderRoster()
    this.renderScope()
    this.renderPermBanner()
    this.renderInspectorHeader()
    this.syncSendReady()
  }

  private renderSummary() {
    const counts = this.store.statusCounts()
    const total = this.store.roots().length
    const parts: string[] = []
    if (counts["needs-you"]) parts.push(`${counts["needs-you"]} needs you`)
    if (counts.working) parts.push(`${counts.working} working`)
    const rev = counts.review + counts.failed
    if (rev) parts.push(`${rev} to review`)
    parts.push(`${total} total`)
    this.barSummary.textContent = parts.join(" · ")
  }

  private renderRoster() {
    const fleet = this.buildFleet()
    const groups = filterAndGroupFleet(fleet, this.rosterFilter, this.rosterQuery)
    this.rosterCountEl.textContent = `${this.selected.size} selected`

    if (!groups.length) {
      const emptySig = `empty:${this.rosterFilter}:${this.rosterQuery}`
      if (this.rosterSig === emptySig) return
      this.rosterSig = emptySig
      this.rosterGroups.clear()
      this.rosterRows.clear()
      const empty = h("div", "orch-roster-empty")
      empty.append(
        h("p", "", this.rosterQuery || this.rosterFilter !== "all" ? "No sessions match this filter." : "No Hermes sessions yet."),
      )
      const btn = h("button", "orch-mini-btn", this.rosterQuery || this.rosterFilter !== "all" ? "Reset filter" : "+ New session") as HTMLButtonElement
      btn.type = "button"
      btn.addEventListener("click", () => {
        if (this.rosterQuery || this.rosterFilter !== "all") {
          this.rosterQuery = ""
          this.rosterSearch.value = ""
          this.rosterFilter = "all"
          for (const [k, fb] of this.filterBtns) {
            fb.classList.toggle("on", k === "all")
            fb.setAttribute("aria-selected", String(k === "all"))
          }
          this.renderRoster()
        } else {
          this.handlers.openNewPicker()
        }
      })
      empty.append(btn)
      this.rosterList.replaceChildren(empty)
      return
    }

    const sig = groups.map((g) => `${g.key}:${g.sessions.map((s) => s.id).join(",")}`).join("|")
    const formatSub = (s: FleetSession) => {
      const subBits: string[] = []
      if (s.status === "needs-you") subBits.push(s.needsInput === "permission" ? "Needs permission" : "Waiting")
      else if (s.status === "working") subBits.push(s.activity || "Working")
      else subBits.push(`${STATUS_LABEL[s.status]} · ${timeAgo(s.updated)}`)
      if (s.subagents > 0) subBits.push(`${s.subagents} sub`)
      return subBits.join(" · ")
    }

    if (sig === this.rosterSig) {
      for (const g of groups) {
        const gRef = this.rosterGroups.get(g.key)
        if (gRef) {
          const selCount = g.sessions.filter((s) => this.selected.has(s.id)).length
          const allSel = selCount === g.sessions.length
          const someSel = selCount > 0 && !allSel
          gRef.sessionIds = g.sessions.map((s) => s.id)
          gRef.checkEl.className = `orch-group-check${allSel ? " on" : someSel ? " partial" : ""}`
          gRef.checkEl.textContent = allSel ? "✓" : someSel ? "–" : ""
          gRef.countEl.textContent = String(g.sessions.length)
          gRef.toggleBtn.title = allSel ? `Deselect all in ${g.label}` : `Select all in ${g.label}`
        }
        for (const s of g.sessions) {
          const rRef = this.rosterRows.get(s.id)
          if (!rRef) continue
          const isSel = this.selected.has(s.id)
          const isInsp = this.inspectedId === s.id
          rRef.row.className = `orch-srow st-${s.status}${isSel ? " sel" : ""}${isInsp ? " insp" : ""}`
          if (rRef.cb.checked !== isSel) rRef.cb.checked = isSel
          if (rRef.titleEl.textContent !== s.title) rRef.titleEl.textContent = s.title
          const subText = formatSub(s)
          rRef.subEl.className = `orch-srow-sub st-${s.status}`
          if (rRef.subEl.textContent !== subText) rRef.subEl.textContent = subText
          rRef.stopBtn.hidden = !s.running
        }
      }
      return
    }

    this.rosterSig = sig
    this.rosterGroups.clear()
    this.rosterRows.clear()

    const frag = document.createDocumentFragment()
    for (const g of groups) {
      const sec = h("div", "orch-group")
      const selCount = g.sessions.filter((s) => this.selected.has(s.id)).length
      const allInGroupSelected = selCount === g.sessions.length
      const someInGroupSelected = selCount > 0 && !allInGroupSelected
      const gHead = h("div", "orch-group-head")

      const gCheck = h(
        "span",
        `orch-group-check${allInGroupSelected ? " on" : someInGroupSelected ? " partial" : ""}`,
        allInGroupSelected ? "✓" : someInGroupSelected ? "–" : "",
      )
      const gCount = h("span", "orch-group-count", String(g.sessions.length))
      const gToggle = h("button", "orch-group-toggle") as HTMLButtonElement
      gToggle.type = "button"
      gToggle.title = allInGroupSelected ? `Deselect all in ${g.label}` : `Select all in ${g.label}`
      gToggle.append(gCheck, h("span", "orch-group-name", g.label), gCount)

      const gRef = { checkEl: gCheck, countEl: gCount, toggleBtn: gToggle, sessionIds: g.sessions.map((s) => s.id) }
      this.rosterGroups.set(g.key, gRef)

      gToggle.addEventListener("click", () => {
        const currentlyAll = gRef.sessionIds.every((id) => this.selected.has(id))
        for (const id of gRef.sessionIds) {
          if (currentlyAll) this.selected.delete(id)
          else this.selected.add(id)
        }
        this.initializedSelection = true
        saveJson(TARGETS_KEY, [...this.selected])
        this.renderRoster()
        this.renderScope()
      })

      const gAdd = h("button", "orch-group-add", "+") as HTMLButtonElement
      gAdd.type = "button"
      gAdd.title = `Spawn new session in ${g.label}`
      gAdd.setAttribute("aria-label", `Spawn session in ${g.label}`)
      gAdd.addEventListener("click", () => {
        this.input.value = `/team @${g.label.toLowerCase().replace(/\s+/g, "-")} `
        this.autosize()
        this.input.focus()
        this.setMobileRoster(false)
      })
      gHead.append(gToggle, gAdd)
      sec.append(gHead)

      for (const s of g.sessions) {
        const isSel = this.selected.has(s.id)
        const isInsp = this.inspectedId === s.id
        const row = h("div", `orch-srow st-${s.status}${isSel ? " sel" : ""}${isInsp ? " insp" : ""}`)
        row.dataset.id = s.id

        const cb = h("input", "orch-srow-cb") as HTMLInputElement
        cb.type = "checkbox"
        cb.checked = isSel
        cb.setAttribute("aria-label", `Select ${s.title}`)
        cb.addEventListener("change", () => this.toggleSelected(s.id))

        const main = h("button", "orch-srow-main") as HTMLButtonElement
        main.type = "button"
        main.title = `Inspect "${s.title}" transcript`
        const topLine = h("span", "orch-srow-title", s.title)
        const subLine = h("span", `orch-srow-sub st-${s.status}`, formatSub(s))
        main.append(topLine, subLine)
        main.addEventListener("click", () => {
          this.inspectSession(s.id)
          if (typeof innerWidth === "number" && innerWidth <= 960) this.setMobileRoster(false)
        })

        const acts = h("div", "orch-srow-acts")
        const stop = h("button", "orch-srow-btn stop", "Stop") as HTMLButtonElement
        stop.type = "button"
        stop.title = `Stop ${s.title}`
        stop.setAttribute("aria-label", `Stop ${s.title}`)
        stop.hidden = !s.running
        stop.addEventListener("click", (e) => {
          e.stopPropagation()
          const curTitle = this.store.sessions.get(s.id) ? this.store.title(this.store.sessions.get(s.id)!) : s.title
          void this.backend.interrupt(s.id).then(
            () => toast(`Stopping ${curTitle}…`),
            (err) => toast((err as Error).message),
          )
        })
        acts.append(stop)

        row.append(cb, main, acts)
        sec.append(row)
        this.rosterRows.set(s.id, { row, cb, titleEl: topLine, subEl: subLine, stopBtn: stop })
      }
      frag.append(sec)
    }
    this.rosterList.replaceChildren(frag)
  }

  private renderScope() {
    const fleet = this.buildFleet()
    const picked = fleet.filter((s) => this.selected.has(s.id))
    const runningPicked = picked.filter((s) => s.running).length
    const pendingAll = this.store.pendingPermissionCount()

    if (!picked.length) {
      this.scopeSummaryEl.textContent = "No sessions selected · pick from fleet or use @live / @project"
    } else {
      const bits = [`${picked.length} attached`]
      if (runningPicked) bits.push(`${runningPicked} running`)
      this.scopeSummaryEl.textContent = bits.join(" · ")
    }

    const shown = picked.slice(0, 4)
    const nextScopeSig = `${shown.map((s) => `${s.id}:${s.status}:${s.title}`).join("|")}|${picked.length}`
    if (nextScopeSig !== this.scopeSig) {
      this.scopeSig = nextScopeSig
      const nodes: HTMLElement[] = shown.map((s) => {
        const item = h("button", `orch-target-tag st-${s.status}`) as HTMLButtonElement
        item.type = "button"
        item.title = `${s.projectLabel} / ${s.title} — click to remove from scope`
        item.append(h("span", "ot-name", s.title), h("span", "ot-x", "×"))
        item.addEventListener("click", () => this.toggleSelected(s.id))
        return item
      })
      if (picked.length > shown.length) {
        nodes.push(h("span", "orch-target-more", `+${picked.length - shown.length} more`))
      }
      this.scopeChipsEl.replaceChildren(...nodes)
    }

    this.bulkApproveBtn.hidden = pendingAll === 0
    this.bulkApproveBtn.textContent = pendingAll > 1 ? `Approve all (${pendingAll})` : "Approve (1)"
    this.bulkStopBtn.hidden = runningPicked === 0
    this.bulkStopBtn.textContent = runningPicked > 1 ? `Stop ${runningPicked} active` : "Stop active"

    const verb = this.delivery === "queue" ? "Queue for" : "Steer"
    this.input.placeholder = picked.length
      ? `${verb} ${picked.length} selected session${picked.length === 1 ? "" : "s"}, or prefix with @project / /command…`
      : "Select sessions on the left, or type @live / /team @project <task>…"
  }

  private renderPermBanner() {
    const pending: Array<{ sessionID: string; title: string; project: string; reqID: string; action: string; resource: string }> = []
    for (const [sid, list] of this.store.permissions) {
      const s = this.store.sessions.get(sid)
      if (!s) continue
      const rootId = s.parentID && this.store.sessions.has(s.parentID) ? s.parentID : sid
      const rootSess = this.store.sessions.get(rootId) ?? s
      for (const req of list) {
        pending.push({
          sessionID: sid,
          title: this.store.title(rootSess),
          project: this.store.projectLabel(rootSess),
          reqID: req.id,
          action: req.action,
          resource: req.resources?.[0] ?? "",
        })
      }
    }
    if (!pending.length) {
      if (this.permSig !== "") {
        this.permSig = ""
        this.permBanner.hidden = true
        this.permBanner.replaceChildren()
      }
      return
    }
    const first = pending[0]!
    const sig = `${pending.length}:${first.sessionID}:${first.reqID}:${first.action}:${first.resource}`
    if (sig === this.permSig) return
    this.permSig = sig
    this.permBanner.hidden = false
    const left = h("div", "orch-perm-info")
    left.append(
      h("span", "orch-perm-label", pending.length > 1 ? `${pending.length} permissions waiting` : "Permission waiting"),
      h("span", "orch-perm-detail", `${first.project} / ${first.title} · ${first.action}${first.resource ? `: ${first.resource}` : ""}`),
    )
    const right = h("div", "orch-perm-acts")
    const allowBtn = h("button", "orch-action-btn primary", "Allow once") as HTMLButtonElement
    allowBtn.type = "button"
    allowBtn.addEventListener("click", () => {
      const req = this.store.permissions.get(first.sessionID)?.find((p) => p.id === first.reqID)
      if (req) void this.store.approve(req).then(() => toast(`Approved ${first.title}`))
    })
    const inspBtn = h("button", "orch-action-btn", "Inspect") as HTMLButtonElement
    inspBtn.type = "button"
    inspBtn.addEventListener("click", () => this.inspectSession(first.sessionID))
    right.append(allowBtn, inspBtn)
    this.permBanner.replaceChildren(left, right)
  }

  // ---- Right Inspector ----

  inspectSession(id: string) {
    if (!this.store.sessions.has(id)) return
    this.inspectedId = id
    this.inspectorEl.hidden = false
    this.shell.classList.add("has-inspector")
    this.inspTranscript.setSession(id)
    this.store.markViewed(id)
    this.renderInspectorHeader()
    this.renderRoster()
  }

  private closeInspector() {
    this.inspectedId = undefined
    this.inspectorEl.hidden = true
    this.shell.classList.remove("has-inspector")
    this.inspTranscript.setSession(undefined)
    this.renderRoster()
  }

  private renderInspectorHeader() {
    const id = this.inspectedId
    const s = id ? this.store.sessions.get(id) : undefined
    if (!id || !s) return
    const working = this.store.running.has(id)
    const ask = this.store.needsInput(id)
    this.inspProjectEl.textContent = this.store.projectLabel(s)
    this.inspTitleEl.textContent = this.store.title(s)
    this.inspModelEl.textContent = modelLabel(s.model)
    this.inspStatusEl.textContent = ask
      ? ask === "permission"
        ? "Needs permission"
        : "Waiting"
      : working
        ? this.store.activityLabel(id)
        : STATUS_LABEL[this.store.status(id)]
    this.inspStatusEl.className = `orch-insp-status st-${this.store.status(id)}`
    this.inspStopBtn.hidden = !working
  }

  private async sendDirectToInspected() {
    const id = this.inspectedId
    const text = this.inspInput.value.trim()
    if (!id || !text) return
    this.inspInput.value = ""
    const working = this.store.running.has(id)
    try {
      await this.backend.prompt(id, { text, delivery: working ? "steer" : undefined })
      this.inspTranscript.scheduleRefetch(80)
    } catch (e) {
      this.inspInput.value = text
      toast(`Couldn't send: ${(e as Error).message}`)
    }
  }

  // ---- Composer & Autocomplete ----

  private autosize() {
    this.input.style.height = "auto"
    this.input.style.height = `${Math.min(180, Math.max(28, this.input.scrollHeight))}px`
  }

  private syncSendReady() {
    this.sendBtn.classList.toggle("ready", !!this.input.value.trim())
  }

  private updateAutocomplete() {
    const items = orchestratorSuggestions(this.input.value, this.buildFleet(), this.knownProjects())
    this.acItems = items
    this.acIdx = 0
    if (!items.length) {
      this.closeAutocomplete()
      return
    }
    this.acEl.hidden = false
    this.renderAutocomplete()
  }

  private renderAutocomplete() {
    this.acEl.replaceChildren(
      ...this.acItems.map((it, idx) => {
        const b = h("button", `orch-ac-item${idx === this.acIdx ? " on" : ""}`) as HTMLButtonElement
        b.type = "button"
        b.setAttribute("role", "option")
        b.setAttribute("aria-selected", String(idx === this.acIdx))
        b.append(
          h("span", `orch-ac-label kind-${it.kind}`, it.label),
          h("span", "orch-ac-detail", it.detail),
        )
        b.addEventListener("pointerdown", (e) => {
          e.preventDefault()
          this.applyAutocomplete(it)
        })
        return b
      }),
    )
  }

  private applyAutocomplete(item: AutocompleteItem) {
    const val = this.input.value
    if (item.kind === "command") {
      this.input.value = item.insert
    } else {
      const replaced = val.replace(/(^|\s)@[^\s]*$/, `$1${item.insert}`)
      this.input.value = replaced
    }
    this.closeAutocomplete()
    this.autosize()
    this.syncSendReady()
    this.input.focus()
  }

  private closeAutocomplete() {
    this.acItems = []
    this.acIdx = 0
    this.acEl.hidden = true
    this.acEl.replaceChildren()
  }

  private onComposerKey(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.isComposing) return

    if (!this.acEl.hidden && this.acItems.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        this.acIdx = (this.acIdx + 1) % this.acItems.length
        this.renderAutocomplete()
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        this.acIdx = (this.acIdx - 1 + this.acItems.length) % this.acItems.length
        this.renderAutocomplete()
        return
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault()
        const hit = this.acItems[this.acIdx]
        if (hit) this.applyAutocomplete(hit)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        this.closeAutocomplete()
        return
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      void this.submitComposer()
    } else if (e.key === "Tab" && !e.shiftKey && this.input.value.trim()) {
      e.preventDefault()
      void this.submitComposer("queue")
    } else if (e.key === "Escape") {
      e.preventDefault()
      if (this.input.value) {
        this.input.value = ""
        this.autosize()
        this.syncSendReady()
      } else {
        this.input.blur()
      }
    }
  }

  private async submitComposer(deliveryOverride?: "steer" | "queue") {
    const raw = this.input.value.trim()
    if (!raw) return
    this.input.value = ""
    this.autosize()
    this.closeAutocomplete()
    this.syncSendReady()
    await this.runCommand(raw, deliveryOverride)
  }

  // ---- Orchestration Execution Engine ----

  async runCommand(raw: string, deliveryOverride?: "steer" | "queue") {
    const parsed = parseOrchestratorInput(raw, deliveryOverride ?? this.delivery)
    const fleet = this.buildFleet()
    const resolved = resolveOrchestratorTargets(fleet, this.selected, parsed.mentions)

    if (parsed.kind === "help") {
      this.appendEntry({
        id: `ord_${++this.seq}`,
        at: Date.now(),
        kind: "help",
        modeLabel: "Help",
        scopeLabel: "Orchestrator",
        promptText: raw,
        note: [
          "Plain text: broadcasts in parallel to all selected sessions (or prefix with @live, @ask, @review, @all, @project, or @session).",
          "/status [@target] — live status digest across targeted sessions (Hermes check_task / list_tasks).",
          "/collect [@target] — gather latest assistant summaries from every targeted session (Hermes collect_task).",
          "/team [@project] <task> — spawn a Hermes delegate_task team lead, attach it to the fleet, and dispatch.",
          "/spawn [@project] <task> — spawn a solo Hermes session, attach it to the fleet, and dispatch.",
          "/steer <msg> | /queue <msg> — override delivery mode for one dispatch.",
          "/stop [@target] — interrupt running targeted sessions.",
          "/approve [@target] — approve waiting permission prompts.",
          "/model [@target] <query> — switch model across targeted sessions.",
        ].join("\n"),
        targets: [],
      })
      return
    }

    if (parsed.kind === "spawn") {
      await this.executeSpawn(parsed.text, parsed.mentions, !!parsed.team)
      return
    }

    if (!resolved.sessions.length) {
      const msg = resolved.unknownMentions.length
        ? `No sessions matched ${resolved.unknownMentions.map((m) => `@${m}`).join(", ")}.`
        : "Select at least one session in the fleet roster (or prefix with @live / @all / @project)."
      toast(msg)
      return
    }

    if (parsed.kind === "status") {
      this.executeStatus(resolved.sessions, resolved.scopeLabel, raw)
      return
    }

    if (parsed.kind === "collect") {
      await this.executeCollect(resolved.sessions, resolved.scopeLabel, raw)
      return
    }

    if (parsed.kind === "stop") {
      await this.executeStop(resolved.sessions, resolved.scopeLabel, raw)
      return
    }

    if (parsed.kind === "approve") {
      await this.executeApprove(resolved.sessions, resolved.scopeLabel, raw)
      return
    }

    if (parsed.kind === "model") {
      await this.executeModelSwitch(resolved.sessions, resolved.scopeLabel, parsed.text, raw)
      return
    }

    // Standard multi-session prompt dispatch (steer or queue).
    if (!parsed.text) {
      toast("Enter a message after your @target mentions.")
      return
    }

    const delivery = parsed.delivery ?? this.delivery
    const targets: DispatchTargetRecord[] = resolved.sessions.map((s) => ({
      sessionID: s.id,
      title: s.title,
      projectLabel: s.projectLabel,
      state: delivery === "queue" && s.running ? "queued" : "sending",
      activity: delivery === "queue" && s.running ? "Queued after current turn" : "Dispatching…",
      output: "",
    }))

    const entry: DispatchEntry = {
      id: `ord_${++this.seq}`,
      at: Date.now(),
      kind: "prompt",
      modeLabel: delivery === "queue" ? "Queue" : "Steer",
      scopeLabel: resolved.scopeLabel,
      promptText: parsed.text,
      note: resolved.unknownMentions.length
        ? `Skipped unmatched targets: ${resolved.unknownMentions.map((m) => `@${m}`).join(", ")}`
        : undefined,
      targets,
    }
    this.appendEntry(entry)

    await Promise.allSettled(
      targets.map(async (t) => {
        this.activeDispatchBySession.set(t.sessionID, t)
        const wasRunning = this.store.running.has(t.sessionID)
        try {
          await this.backend.prompt(t.sessionID, {
            text: parsed.text,
            delivery: delivery === "queue" ? "queue" : wasRunning ? "steer" : undefined,
          })
          if (t.state === "sending") {
            t.state = delivery === "queue" && wasRunning ? "queued" : "running"
            t.activity = t.state === "queued" ? "Queued for next turn" : this.store.activityLabel(t.sessionID)
          }
        } catch (e) {
          t.state = "error"
          t.error = (e as Error).message
          t.activity = "Dispatch failed"
          t.output = t.error
        }
        this.updateDispatchTargetRow(entry, t)
      }),
    )
  }

  private executeStatus(sessions: FleetSession[], scopeLabel: string, raw: string) {
    const targets: DispatchTargetRecord[] = sessions.map((s) => ({
      sessionID: s.id,
      title: s.title,
      projectLabel: s.projectLabel,
      state:
        s.status === "working" || s.status === "needs-you"
          ? "running"
          : s.status === "failed"
            ? "failed"
            : s.status === "stopped"
              ? "interrupted"
              : "succeeded",
      activity:
        s.status === "needs-you"
          ? s.needsInput === "permission"
            ? "Waiting on permission approval"
            : "Waiting on input"
          : s.status === "working"
            ? s.activity || "Working…"
            : `${STATUS_LABEL[s.status]} · ${s.modelLabel}${s.subagents ? ` · ${s.subagents} subagents` : ""}`,
      output: s.preview ? s.preview.slice(0, 220) : "No transcript preview loaded yet.",
    }))
    this.appendEntry({
      id: `ord_${++this.seq}`,
      at: Date.now(),
      kind: "status",
      modeLabel: "Status",
      scopeLabel,
      promptText: raw,
      targets,
    })
  }

  private async executeCollect(sessions: FleetSession[], scopeLabel: string, raw: string) {
    const targets: DispatchTargetRecord[] = sessions.map((s) => ({
      sessionID: s.id,
      title: s.title,
      projectLabel: s.projectLabel,
      state: "sending",
      activity: "Collecting summary…",
      output: "",
    }))
    const entry: DispatchEntry = {
      id: `ord_${++this.seq}`,
      at: Date.now(),
      kind: "collect",
      modeLabel: "Collect",
      scopeLabel,
      promptText: raw,
      targets,
    }
    this.appendEntry(entry)

    await Promise.allSettled(
      targets.map(async (t) => {
        try {
          const page = await this.backend.messages(t.sessionID, 12)
          let summary = ""
          for (const m of page.data) {
            if (m.type === "assistant") {
              const txt = lastAssistantText(m.content)
              if (txt) {
                summary = txt.trim()
                break
              }
            }
          }
          const st = this.store.status(t.sessionID)
          t.state = st === "failed" ? "failed" : st === "stopped" ? "interrupted" : st === "working" ? "running" : "succeeded"
          t.activity = `${STATUS_LABEL[st]} · collected`
          t.output = summary ? summary.slice(0, 420) : "No assistant summary recorded yet."
        } catch (e) {
          t.state = "error"
          t.activity = "Collect failed"
          t.output = (e as Error).message
        }
        this.updateDispatchTargetRow(entry, t)
      }),
    )
  }

  private async executeSpawn(task: string, mentions: string[], team: boolean) {
    if (!task) {
      toast(`Describe a task after /${team ? "team" : "spawn"} (e.g. /${team ? "team" : "spawn"} @project fix flaky tests).`)
      return
    }
    const projects = this.knownProjects()
    const pickedProj =
      resolveSpawnProject(projects, mentions) ??
      (() => {
        const firstSelected = [...this.selected].map((id) => this.store.sessions.get(id)).find(Boolean)
        if (firstSelected?.location?.directory) {
          return { label: this.store.projectLabel(firstSelected), directory: firstSelected.location.directory }
        }
        return projects[0]
      })()

    if (!pickedProj?.directory) {
      toast("No project directory available yet. Create one via + New session first.")
      return
    }

    try {
      const created = await this.backend.createSession(
        pickedProj.directory,
        defaultModel(this.backend.kind),
        this.store.autoApproveAll ? [ALLOW_ALL] : undefined,
      )
      this.store.sessions.set(created.id, created)
      this.store.markStructure()
      // Auto-attach the newly spawned session into the active orchestration scope!
      this.selected.add(created.id)
      this.initializedSelection = true
      saveJson(TARGETS_KEY, [...this.selected])
      this.renderRoster()
      this.renderScope()

      const target: DispatchTargetRecord = {
        sessionID: created.id,
        title: this.store.title(created),
        projectLabel: pickedProj.label,
        state: "running",
        activity: team ? "Launching Hermes team (delegate_task)…" : "Starting session…",
        output: "",
      }
      const entry: DispatchEntry = {
        id: `ord_${++this.seq}`,
        at: Date.now(),
        kind: "spawn",
        modeLabel: team ? "Team launch" : "Solo launch",
        scopeLabel: `@${pickedProj.label}`,
        promptText: task,
        note: `Created session ${created.id} and attached to active fleet.`,
        targets: [target],
      }
      this.appendEntry(entry)
      this.activeDispatchBySession.set(created.id, target)

      await this.backend.prompt(created.id, { text: launchPrompt(task, team) })
      target.title = this.store.title(this.store.sessions.get(created.id) ?? created)
      this.updateDispatchTargetRow(entry, target)
    } catch (e) {
      toast(`Couldn't spawn session: ${(e as Error).message}`)
    }
  }

  private async executeStop(sessions: FleetSession[], scopeLabel: string, raw: string) {
    const running = sessions.filter((s) => this.store.running.has(s.id) || s.running)
    if (!running.length) {
      toast("None of the targeted sessions are currently running.")
      return
    }
    const targets: DispatchTargetRecord[] = running.map((s) => ({
      sessionID: s.id,
      title: s.title,
      projectLabel: s.projectLabel,
      state: "sending",
      activity: "Interrupting…",
      output: "",
    }))
    const entry: DispatchEntry = {
      id: `ord_${++this.seq}`,
      at: Date.now(),
      kind: "stop",
      modeLabel: "Stop",
      scopeLabel,
      promptText: raw,
      targets,
    }
    this.appendEntry(entry)

    await Promise.allSettled(
      targets.map(async (t) => {
        try {
          await this.backend.interrupt(t.sessionID)
          t.state = "interrupted"
          t.activity = "Interrupted"
        } catch (e) {
          t.state = "error"
          t.activity = "Interrupt failed"
          t.output = (e as Error).message
        }
        this.updateDispatchTargetRow(entry, t)
      }),
    )
  }

  private async executeApprove(sessions: FleetSession[], scopeLabel: string, raw: string) {
    const ids = new Set(sessions.map((s) => s.id))
    let totalApproved = 0
    const targets: DispatchTargetRecord[] = []

    for (const s of sessions) {
      const count = await this.store.approveAllPending(s.id, true)
      if (count > 0) {
        totalApproved += count
        targets.push({
          sessionID: s.id,
          title: s.title,
          projectLabel: s.projectLabel,
          state: "succeeded",
          activity: `Approved ${count} permission${count === 1 ? "" : "s"}`,
          output: "",
        })
      }
    }

    if (totalApproved === 0 && this.store.pendingPermissionCount() > 0 && !ids.size) {
      totalApproved = await this.store.approveAllPending()
    }

    if (!targets.length) {
      // Fallback: if other fleet sessions have pending approvals, approve them too when user explicitly clicked Approve all / ran /approve with no mentions
      const fallbackCount = await this.store.approveAllPending()
      if (fallbackCount > 0) {
        this.appendEntry({
          id: `ord_${++this.seq}`,
          at: Date.now(),
          kind: "approve",
          modeLabel: "Approve",
          scopeLabel: "All waiting",
          promptText: raw,
          note: `Approved ${fallbackCount} waiting permission request${fallbackCount === 1 ? "" : "s"}.`,
          targets: [],
        })
        return
      }
      toast("No pending permission requests.")
      return
    }

    this.appendEntry({
      id: `ord_${++this.seq}`,
      at: Date.now(),
      kind: "approve",
      modeLabel: "Approve",
      scopeLabel,
      promptText: raw,
      note: `Approved ${totalApproved} permission request${totalApproved === 1 ? "" : "s"}.`,
      targets,
    })
  }

  private async executeModelSwitch(sessions: FleetSession[], scopeLabel: string, query: string, raw: string) {
    const q = query.trim().toLowerCase()
    if (!q) {
      toast("Specify a model name after /model (e.g. /model sonnet).")
      return
    }
    let list
    try {
      list = await models(this.backend)
    } catch (e) {
      toast(`Couldn't load models: ${(e as Error).message}`)
      return
    }
    const match = list.find(
      (m) =>
        m.id.toLowerCase() === q ||
        m.name.toLowerCase() === q ||
        `${m.providerID}/${m.id}`.toLowerCase() === q ||
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q),
    )
    if (!match) {
      toast(`No model matched "${query}".`)
      return
    }
    const ref = { id: match.id, providerID: match.providerID }
    const targets: DispatchTargetRecord[] = sessions.map((s) => ({
      sessionID: s.id,
      title: s.title,
      projectLabel: s.projectLabel,
      state: "sending",
      activity: `Switching to ${modelLabel(ref)}…`,
      output: "",
    }))
    const entry: DispatchEntry = {
      id: `ord_${++this.seq}`,
      at: Date.now(),
      kind: "model",
      modeLabel: "Model",
      scopeLabel,
      promptText: raw,
      note: `Target model: ${match.providerID}/${match.id}`,
      targets,
    }
    this.appendEntry(entry)

    await Promise.allSettled(
      targets.map(async (t) => {
        try {
          await this.backend.switchModel(t.sessionID, ref)
          const s = this.store.sessions.get(t.sessionID)
          if (s) s.model = ref
          t.state = "succeeded"
          t.activity = `Switched to ${modelLabel(ref)}`
        } catch (e) {
          t.state = "error"
          t.activity = "Switch failed"
          t.output = (e as Error).message
        }
        this.updateDispatchTargetRow(entry, t)
      }),
    )
    this.renderRoster()
  }

  // ---- Timeline DOM & Live Event Streaming ----

  private clearLog() {
    this.entries = []
    this.activeDispatchBySession.clear()
    this.feedEl.replaceChildren(this.welcomeEl)
    this.welcomeEl.hidden = false
  }

  private appendEntry(entry: DispatchEntry) {
    this.welcomeEl.hidden = true
    this.entries.push(entry)

    const article = h("article", `orch-entry kind-${entry.kind}`)
    const head = h("header", "orch-entry-head")
    const meta = h("div", "orch-entry-meta")
    meta.append(
      h("span", `orch-entry-mode mode-${entry.kind}`, entry.modeLabel),
      h("span", "orch-entry-sep", "·"),
      h("span", "orch-entry-scope", entry.scopeLabel),
      h("span", "orch-entry-sep", "·"),
      h("span", "orch-entry-time", formatClock(entry.at)),
    )
    const rollupEl = h("span", "orch-entry-rollup")
    head.append(meta, rollupEl)
    entry.rollupEl = rollupEl

    const body = h("div", "orch-entry-prompt", entry.promptText)
    article.append(head, body)

    if (entry.note) {
      article.append(h("div", "orch-entry-note", entry.note))
    }

    if (entry.targets.length) {
      const list = h("div", "orch-targets")
      for (const t of entry.targets) {
        const row = h("div", `orch-trow st-${t.state}`)
        const top = h("div", "orch-trow-top")

        const nameBtn = h("button", "orch-trow-name") as HTMLButtonElement
        nameBtn.type = "button"
        nameBtn.title = `Inspect ${t.title}`
        nameBtn.append(
          h("span", "orch-trow-proj", t.projectLabel),
          h("span", "orch-trow-slash", "/"),
          h("span", "orch-trow-title", t.title),
        )
        nameBtn.addEventListener("click", () => this.inspectSession(t.sessionID))

        const stateEl = h("span", "orch-trow-state")
        const activityEl = h("span", "orch-trow-act", t.activity)

        const acts = h("div", "orch-trow-acts")
        const stopBtn = h("button", "orch-trow-btn stop", "Stop") as HTMLButtonElement
        stopBtn.type = "button"
        stopBtn.hidden = t.state !== "running" && t.state !== "sending"
        stopBtn.addEventListener("click", () => {
          void this.backend.interrupt(t.sessionID).catch((e) => toast((e as Error).message))
        })
        const inspBtn = h("button", "orch-trow-btn", "Inspect") as HTMLButtonElement
        inspBtn.type = "button"
        inspBtn.addEventListener("click", () => this.inspectSession(t.sessionID))
        acts.append(stopBtn, inspBtn)

        top.append(nameBtn, stateEl, activityEl, acts)
        const outputEl = h("div", "orch-trow-out", t.output)
        outputEl.hidden = !t.output
        row.append(top, outputEl)

        t.rowEl = row
        t.stateEl = stateEl
        t.activityEl = activityEl
        t.outputEl = outputEl
        t.stopBtn = stopBtn
        this.paintTargetState(t)
        list.append(row)
      }
      article.append(list)
    }

    entry.el = article
    this.paintEntryRollup(entry)
    this.feedEl.append(article)
    this.feedEl.scrollTop = this.feedEl.scrollHeight
  }

  private paintTargetState(t: DispatchTargetRecord) {
    if (!t.rowEl || !t.stateEl || !t.activityEl || !t.outputEl) return
    t.rowEl.className = `orch-trow st-${t.state}`
    t.stateEl.replaceChildren()
    if (t.state === "running" || t.state === "sending") {
      t.stateEl.append(spinner(11), h("span", "", t.state === "sending" ? "Sending" : "Live"))
    } else if (t.state === "queued") {
      t.stateEl.textContent = "Queued"
    } else if (t.state === "succeeded") {
      t.stateEl.textContent = "Done"
    } else if (t.state === "interrupted") {
      t.stateEl.textContent = "Stopped"
    } else {
      t.stateEl.textContent = "Failed"
    }
    t.activityEl.textContent = t.activity
    t.outputEl.textContent = t.output
    t.outputEl.hidden = !t.output
    if (t.stopBtn) t.stopBtn.hidden = t.state !== "running" && t.state !== "sending"
  }

  private paintEntryRollup(entry: DispatchEntry) {
    if (!entry.rollupEl) return
    if (!entry.targets.length) {
      entry.rollupEl.textContent = ""
      return
    }
    const r = rollupDispatchStates(entry.targets.map((t) => t.state))
    const bits: string[] = []
    if (r.active) bits.push(`${r.active} active`)
    if (r.succeeded) bits.push(`${r.succeeded} done`)
    if (r.interrupted) bits.push(`${r.interrupted} stopped`)
    if (r.failed) bits.push(`${r.failed} failed`)
    entry.rollupEl.textContent = bits.join(" · ")
  }

  private updateDispatchTargetRow(entry: DispatchEntry, t: DispatchTargetRecord) {
    this.paintTargetState(t)
    this.paintEntryRollup(entry)
  }

  private findEntryForTarget(target: DispatchTargetRecord): DispatchEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.targets.includes(target)) return this.entries[i]
    }
    return undefined
  }

  private syncDispatchRowFromStore(sessionID: string) {
    const t = this.activeDispatchBySession.get(sessionID)
    if (!t) return
    const entry = this.findEntryForTarget(t)
    if (!entry) return
    const s = this.store.sessions.get(sessionID)
    if (s) t.title = this.store.title(s)
    if (this.store.running.has(sessionID)) {
      t.state = "running"
      t.activity = this.store.activityLabel(sessionID)
      const live = this.store.liveText.get(sessionID)
      if (live) t.output = live.trim()
    } else if (t.state === "running" || t.state === "sending") {
      const outcome = s?.outcome
      t.state = outcome === "failed" ? "failed" : outcome === "interrupted" ? "interrupted" : "succeeded"
      t.activity = t.state === "failed" ? "Turn failed" : t.state === "interrupted" ? "Interrupted" : "Completed"
      const preview = this.store.previews.get(sessionID)?.text
      if (preview && !t.output) t.output = preview
    }
    this.updateDispatchTargetRow(entry, t)
  }

  private onStoreEvent(ev: OcEvent) {
    const id: string | undefined = ev.data?.sessionID
    if (!id) return
    const t = this.activeDispatchBySession.get(id)
    if (!t) return
    const entry = this.findEntryForTarget(t)
    if (!entry) return

    if (ev.type === "session.execution.started") {
      t.state = "running"
      t.activity = "Working…"
      this.updateDispatchTargetRow(entry, t)
    } else if (ev.type === "session.text.delta") {
      const live = this.store.liveText.get(id)
      if (live) {
        t.output = live.trim()
        this.updateDispatchTargetRow(entry, t)
      }
    } else if (
      ev.type === "session.execution.succeeded" ||
      ev.type === "session.execution.failed" ||
      ev.type === "session.execution.interrupted"
    ) {
      t.state = ev.type.endsWith("succeeded") ? "succeeded" : ev.type.endsWith("failed") ? "failed" : "interrupted"
      t.activity = t.state === "succeeded" ? "Completed" : t.state === "interrupted" ? "Interrupted" : "Failed"
      this.updateDispatchTargetRow(entry, t)
      if (t.state === "succeeded") {
        void this.backend
          .messages(id, 6)
          .then((page) => {
            for (const m of page.data) {
              if (m.type === "assistant") {
                const txt = lastAssistantText(m.content)
                if (txt) {
                  t.output = txt.trim().slice(0, 420)
                  this.updateDispatchTargetRow(entry, t)
                  break
                }
              }
            }
          })
          .catch(() => {})
      }
    }
  }
}
