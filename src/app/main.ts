import type { ModelRef } from "./types"
import { type Backend, type ConnectionState } from "./backend"
import { HermesBackend } from "./hermes-backend"
import { CanvasView } from "./canvas"
import { DemoBackend } from "./demo"
import { LAYOUTS, type LayoutName } from "./layouts"
import { defaultModel } from "./models"
import { SessionPanel } from "./panel"
import { NewSessionPicker } from "./picker"
import { Launchpad } from "./launchpad"
import { OrchestratorView } from "./orchestrator"
import { CommandPalette, type PaletteActionEntry } from "./palette"
import { findAdjacentSessionId, orderSessionsForTriage } from "./palette-logic"
import { TilesView } from "./tiles"
import { autoApproveToggle, autoApprovedNotices } from "./approve"
import pipMark from "../../assets/pip.svg"
import { WALLPAPER_IDS, WALLPAPER_LABELS, applyWallpaper, loadWallpaper, saveWallpaper, type WallpaperId } from "./wallpaper"
import { SPINNERS, setSpinnerStyle, spinner, type SpinnerStyle } from "./spinners"
import { ALLOW_ALL, STATUS_LABEL, Store, type Status } from "./store"
import { toast } from "./toast"
import {
  activeFilterSummary,
  buildAttentionQueue,
  formatZoomPercent,
  nextAttentionId,
  summarizeProjectGroups,
} from "./ux-helpers"

export interface CanvasConfig {
  mode: "live" | "demo"
  connected: boolean
  version?: string
  upstream?: string
  home?: string
  /** The OS user's home, for expanding and shortening `~` in paths. */
  userHome?: string
  error?: string
}

export const pref = {
  get<T extends string>(k: string, fallback: T, allowed: readonly T[]): T {
    try {
      const v = localStorage.getItem(`hermes-canvas.${k}`) as T | null
      return v && allowed.includes(v) ? v : fallback
    } catch {
      return fallback
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(`hermes-canvas.${k}`, v)
    } catch {
      /* private mode */
    }
  },
}

const LAYOUT_LABEL: Record<LayoutName, string> = { satellites: "Satellites", fold: "Fold", tabs: "Tabs", tree: "Tree" }
const SPINNER_LABEL: Record<SpinnerStyle, string> = { wave: "Wave", matrix: "Matrix", braid: "Braid", mist: "Mist", comet: "Comet" }

async function getConfig(): Promise<CanvasConfig> {
  try {
    const r = await fetch("/canvas/config")
    if (r.ok) return await r.json()
    return { mode: "live", connected: false, error: `Canvas server responded ${r.status}` }
  } catch (e) {
    return { mode: "live", connected: false, error: (e as Error).message }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export function segmented<T extends string>(items: readonly T[], labels: Record<T, string>, current: T, onPick: (v: T) => void, name: string) {
  const group = el("div", "seg")
  group.setAttribute("role", "radiogroup")
  group.setAttribute("aria-label", name)
  // The dock groups layouts, spinners and wallpapers side by side; a tiny
  // caption above each group makes that split legible without a legend.
  group.dataset.label = name
  const buttons = new Map<T, HTMLButtonElement>()
  for (const it of items) {
    const b = el("button", "seg-btn", labels[it]) as HTMLButtonElement
    b.type = "button"
    b.setAttribute("role", "radio")
    b.addEventListener("click", () => {
      set(it)
      onPick(it)
    })
    buttons.set(it, b)
    group.append(b)
  }
  const set = (v: T) => {
    for (const [k, b] of buttons) {
      b.classList.toggle("on", k === v)
      b.setAttribute("aria-checked", String(k === v))
    }
  }
  set(current)
  return { group, set }
}

export function showUnavailable(root: HTMLElement, cfg: CanvasConfig) {
  root.replaceChildren()
  const box = el("div", "empty-state")
  const mark = el("div", "empty-mark")
  const pip = document.createElement("img")
  pip.src = pipMark
  pip.alt = "Pip, the courier owl"
  pip.className = "empty-pip"
  pip.width = 132
  pip.height = 132
  pip.draggable = false
  mark.append(pip)
  box.append(
    el("div", "empty-brand", "Hermes Canvas"),
    mark,
    el("h1", "", "Can't reach Hermes"),
    el(
      "p",
      "",
      cfg.error ??
        "The Hermes session store didn't answer. Check that your Hermes home (state.db) exists and is readable.",
    ),
  )
  const actions = el("div", "empty-actions")
  const retry = el("button", "btn primary", "Try again") as HTMLButtonElement
  retry.type = "button"
  retry.addEventListener("click", () => location.reload())
  const demo = el("button", "btn", "Explore simulated sessions") as HTMLButtonElement
  demo.type = "button"
  demo.addEventListener("click", () => {
    const u = new URL(location.href)
    u.searchParams.set("demo", "1")
    location.href = u.toString()
  })
  actions.append(retry, demo)
  box.append(actions)
  root.append(box)
}

export interface BootHandle {
  store: Store
  canvas: CanvasView
  panel: SessionPanel
  tiles: TilesView
  orchestrator: OrchestratorView
  picker: NewSessionPicker
  launchpad: Launchpad
  destroy(): void
}

export async function boot(rootEl?: HTMLElement): Promise<BootHandle | undefined> {
  const root = rootEl ?? document.getElementById("app")!
  // The splash markup ships in index.html so it paints before this module runs;
  // re-point its owl at the bundled asset so the path is always right.
  const bootPip = root.querySelector<HTMLImageElement>(".boot-pip")
  if (bootPip) bootPip.src = pipMark
  const params = new URLSearchParams(location.search)
  const cfg = await getConfig()
  const demo = params.has("demo") || cfg.mode === "demo"
  if (!demo && !cfg.connected) {
    showUnavailable(root, cfg)
    return undefined
  }

  const backend: Backend = demo ? new DemoBackend() : new HermesBackend()
  const store = new Store(backend)

  root.replaceChildren()
  root.classList.add("ready")

  let layoutName = pref.get<LayoutName>("layout", "tree", LAYOUTS)
  let spinnerStyle = pref.get<SpinnerStyle>("spinner", "comet", SPINNERS)
  setSpinnerStyle(spinnerStyle)
  root.dataset.layout = layoutName

  let destroyed = false
  let panel: SessionPanel
  let tiles: TilesView
  let orchestrator: OrchestratorView
  let launchpad: Launchpad | undefined
  let visibleSessionCount = 0
  let zoomReadout: HTMLButtonElement | undefined
  let updateFilterBanner = () => {}
  const canvas = new CanvasView(root, store, {
    open: (id) => openSession(id),
    newSession: (group) => void newSession(group),
    selectionChanged: () => launchpad?.refreshDestination(),
    quickStop: (id) => {
      void backend.interrupt(id).then(
        () => toast("Stopping session…"),
        (err) => toast((err as Error).message),
      )
    },
    quickPin: (id) => {
      tiles.togglePin(id)
      toast(tiles.isPinned(id) ? "Pinned to Tiles" : "Unpinned from Tiles")
    },
    quickApprove: (id) => {
      const own = store.permissions.get(id)?.[0]
      let childPerm = undefined
      if (!own) {
        for (const c of store.children.get(id) ?? []) {
          const p = store.permissions.get(c)?.[0]
          if (p) {
            childPerm = p
            break
          }
        }
      }
      const req = own ?? childPerm
      if (!req) return
      const s = store.sessions.get(id)
      void store.approve(req).then(
        () => toast(`Approved ${s ? store.title(s) : "request"}`),
        (err) => toast((err as Error).message),
      )
    },
    quickOrchestrate: (id) => {
      openOrchestrator(id)
    },
    isPinned: (id) => tiles?.isPinned(id) ?? false,
    onCameraChange: (z) => {
      if (zoomReadout) zoomReadout.textContent = formatZoomPercent(z)
    },
    onVisibleCount: (n) => {
      visibleSessionCount = n
      updateFilterBanner()
    },
  })
  canvas.setLayout(layoutName)
  root.dataset.layout = layoutName
  // Handy from the devtools console.
  ;(window as any).hermesCanvas = { canvas, store }

  panel = new SessionPanel(root, store, backend, canvas, () => {
    if (destroyed) return
    root.classList.remove("panel-open")
    launchpad?.refreshModel()
    if (!tiles.isOpen && !orchestrator.isOpen && location.hash && location.hash !== "#tiles" && location.hash !== "#orchestrate") {
      history.replaceState(null, "", location.pathname + location.search)
    }
  })

  function openSession(id: string) {
    if (destroyed) return
    if (helpEl) toggleHelp()
    if (picker.isOpen) picker.close(false)
    if (tiles.isOpen) tiles.close()
    if (orchestrator.isOpen) orchestrator.close()
    closeStylePop()
    const from = canvas.cardRect(id)
    canvas.select(id, false)
    canvas.centerOn(id, Math.max(0.9, Math.min(1, canvas.camera.z)))
    root.classList.add("panel-open")
    panel.open(id, from)
    history.replaceState(null, "", `/${location.search}#${id}`)
  }

  async function newSession(groupKey: string) {
    const g = store.groups().find((x) => x.key === groupKey)
    if (g) await createIn(g.directory)
  }

  async function createIn(directory: string, model: ModelRef | undefined = defaultModel(backend.kind), autoApprove = store.autoApproveAll) {
    try {
      const s = await backend.createSession(directory, model, autoApprove ? [ALLOW_ALL] : undefined)
      if (destroyed) return
      store.sessions.set(s.id, s)
      store.markStructure()
      launchpad?.refreshModel()
      // Wait a frame for the card to exist, then open it.
      requestAnimationFrame(() => requestAnimationFrame(() => openSession(s.id)))
    } catch (e) {
      toast(`Couldn't create a session: ${(e as Error).message}`)
    }
  }

  tiles = new TilesView(root, store, backend, {
    openOnCanvas: (id) => requestAnimationFrame(() => openSession(id)),
    openOrchestrator: () => openOrchestrator(),
    newSession: () => openPicker(),
    onPinChange: (id) => canvas.refreshPinState(id),
    closed: () => {
      updateStats()
      if (!orchestrator.isOpen && location.hash === "#tiles") history.replaceState(null, "", location.pathname + location.search)
    },
  })
  panel.tiles = tiles
  function openTiles() {
    if (helpEl) toggleHelp()
    if (picker.isOpen) picker.close(false)
    if (panel.isOpen) panel.close()
    if (orchestrator.isOpen) orchestrator.close()
    closeStylePop()
    tiles.open()
    history.replaceState(null, "", `/${location.search}#tiles`)
    updateStats()
  }

  orchestrator = new OrchestratorView(root, store, backend, {
    openCanvas: () => {
      if (location.pathname === "/orchestrate" || location.hash === "#orchestrate") {
        history.replaceState(null, "", `/${location.search}`)
      }
      updateStats()
    },
    openTiles: () => openTiles(),
    openSessionOnCanvas: (id) => requestAnimationFrame(() => openSession(id)),
    openNewPicker: () => openPicker(),
    closed: () => {
      updateStats()
      if (!tiles.isOpen && (location.pathname === "/orchestrate" || location.hash === "#orchestrate")) {
        history.replaceState(null, "", `/${location.search}`)
      }
    },
  })
  function openOrchestrator(focusSessionId?: string) {
    if (helpEl) toggleHelp()
    if (picker.isOpen) picker.close(false)
    if (panel.isOpen) panel.close()
    if (tiles.isOpen) tiles.close()
    closeStylePop()
    if (focusSessionId) orchestrator.focusSession(focusSessionId)
    else orchestrator.open()
    history.replaceState(null, "", `/orchestrate${location.search}`)
    updateStats()
  }

  panel.onOrchestrate = (id) => openOrchestrator(id)
  panel.onStep = (dir) => {
    const now = Date.now()
    const ordered = orderSessionsForTriage(
      store.roots().map((s) => ({
        id: s.id,
        title: store.title(s),
        projectLabel: store.projectLabel(s),
        directory: s.location.directory,
        status: store.status(s.id, now),
        updated: s.time.updated,
        subagents: store.subagentCount(s.id),
      })),
    )
    const next = findAdjacentSessionId(ordered, panel.id, dir)
    if (next && next !== panel.id) openSession(next)
  }

  const palette = new CommandPalette(root, store, {
    openSession: (id) => openSession(id),
    focusProject: (groupKey) => {
      if (tiles.isOpen) tiles.close()
      if (orchestrator.isOpen) orchestrator.close()
      if (panel.isOpen) panel.close()
      if (canvas.filter) setFilter(undefined)
      if (searchInput.value) {
        searchInput.value = ""
        search.classList.remove("has-value")
        root.classList.remove("searching")
        canvas.setQuery("")
        updateFilterBanner()
      }
      canvas.focusGroup(groupKey)
    },
    getActions: (): PaletteActionEntry[] => {
      const waiting = store.pendingPermissionCount()
      const acts: PaletteActionEntry[] = []
      if (waiting > 0) {
        acts.push({
          id: "approve-all",
          label: `Approve all waiting permissions (${waiting})`,
          detail: "Allow every blocked Hermes tool request once",
          keywords: ["allow", "permission", "unblock", "ask"],
          boost: 45,
          run: () => {
            void store.approveAllPending().then(
              (n) => toast(n ? `Approved ${n} waiting request${n === 1 ? "" : "s"}` : "No waiting requests"),
              (err) => toast((err as Error).message),
            )
          },
        })
      }
      acts.push(
        {
          id: "orchestrate",
          label: orchestrator.isOpen ? "Return to Canvas" : "Open Orchestrate",
          detail: orchestrator.isOpen ? "Go back to the spatial session canvas" : "Control multiple Hermes sessions from one unified chat",
          shortcut: "O",
          keywords: ["fleet", "multi", "broadcast", "chat"],
          boost: 22,
          run: () => (orchestrator.isOpen ? orchestrator.close() : openOrchestrator()),
        },
        {
          id: "tiles",
          label: tiles.isOpen ? "Close Tiles" : "Open Live Tiles",
          detail: "Every active session's transcript side by side",
          shortcut: "T",
          keywords: ["grid", "split", "live"],
          boost: 18,
          run: () => (tiles.isOpen ? tiles.close() : openTiles()),
        },
        {
          id: "new-session",
          label: "New Hermes session",
          detail: "Pick a project folder and start a fresh session",
          shortcut: "N",
          keywords: ["create", "spawn", "start"],
          boost: 16,
          run: () => openPicker(),
        },
        {
          id: "fit-all",
          label: "Fit all projects on canvas",
          detail: "Reset camera zoom to see every project cluster",
          shortcut: "0",
          keywords: ["zoom", "reset", "overview"],
          boost: 10,
          run: () => {
            if (tiles.isOpen) tiles.close()
            if (orchestrator.isOpen) orchestrator.close()
            if (panel.isOpen) panel.close()
            canvas.fitAll()
          },
        },
        {
          id: "auto-approve",
          label: store.autoApproveAll ? "Turn off Auto-approve" : "Turn on Auto-approve",
          detail: "Toggle automatic approval for Hermes tool requests",
          keywords: ["yolo", "permissions", "allow"],
          boost: 8,
          run: () => {
            const next = !store.autoApproveAll
            store.setAutoApproveAll(next)
            toast(next ? "Auto-approve enabled" : "Auto-approve disabled")
          },
        },
        {
          id: "layout-tree",
          label: "Layout: Tree",
          detail: "Group sessions in project columns",
          shortcut: "4",
          keywords: ["layout", "columns"],
          run: () => setLayout("tree"),
        },
        {
          id: "layout-fold",
          label: "Layout: Fold",
          detail: "Stack each project into a compact deck",
          shortcut: "2",
          keywords: ["layout", "stack"],
          run: () => setLayout("fold"),
        },
        {
          id: "layout-satellites",
          label: "Layout: Satellites",
          detail: "Orbit sessions around each project hub",
          shortcut: "1",
          keywords: ["layout", "orbit"],
          run: () => setLayout("satellites"),
        },
      )
      return acts
    },
  })

  const userHome = demo ? "/Users/you" : (cfg.userHome ?? cfg.home)
  const picker = new NewSessionPicker(root, store, backend, userHome, createIn)
  const openPicker = () => {
    if (helpEl) toggleHelp()
    const sel = canvas.selected ? store.sessions.get(canvas.selected) : undefined
    picker.open(sel?.location.directory)
  }

  // One chat box for launching independent sessions (and, in Team mode,
  // their native Hermes subagent teams) without opening the picker.
  launchpad = new Launchpad(root, store, backend, {
    home: userHome,
    selectedDirectory: () => {
      const sel = canvas.selected ? store.sessions.get(canvas.selected) : undefined
      return sel?.location.directory
    },
    openSession: (id) => openSession(id),
  })
  ;(window as any).hermesCanvas = { canvas, store, launchpad, orchestrator }

  // ---- chrome ----

  const top = el("div", "topbar")
  const brand = el("div", "brand")
  const markImg = document.createElement("img")
  markImg.src = pipMark
  markImg.alt = "Pip, the courier owl"
  markImg.className = "brand-mark"
  markImg.draggable = false
  const dot = el("span", "conn-dot")
  const stats = el("span", "stats")
  // Brand lockup: Pip, then the wordmark, then the live connection lamp.
  const lockup = el("div", "brand-lockup")
  lockup.append(el("span", "brand-name", "Hermes"), el("span", "brand-sub", "Canvas"))
  brand.append(markImg, lockup, dot)

  // Status counts double as filters: click one to see just those sessions.
  const chips = el("div", "chips")
  chips.setAttribute("role", "group")
  chips.setAttribute("aria-label", "Filter by status")
  const CHIP_ORDER: Status[] = ["needs-you", "working", "review"]
  const chipEls = new Map<Status, HTMLButtonElement>()
  for (const st of CHIP_ORDER) {
    const b = el("button", `chip ${st}`) as HTMLButtonElement
    b.type = "button"
    b.innerHTML = `<span class="chip-dot"></span><span class="chip-n">0</span><span class="chip-label">${STATUS_LABEL[st].toLowerCase()}</span>`
    b.addEventListener("click", () => setFilter(canvas.filter === st ? undefined : st))
    chipEls.set(st, b)
    chips.append(b)
  }
  // One click approves every waiting permission request, everywhere.
  const allowAll = el("button", "chip-action allow", "Allow all") as HTMLButtonElement
  allowAll.type = "button"
  allowAll.hidden = true
  allowAll.title = "Approve every waiting permission request once"
  allowAll.addEventListener("click", async () => {
    const n = await store.approveAllPending()
    toast(n ? `Approved ${n} request${n === 1 ? "" : "s"}` : "Nothing waiting")
  })
  chipEls.get("needs-you")!.after(allowAll)
  const markAll = el("button", "chip-action", "Mark all reviewed") as HTMLButtonElement
  markAll.type = "button"
  markAll.hidden = true
  markAll.addEventListener("click", () => {
    const t = Date.now()
    let n = 0
    for (const s of store.roots())
      if (store.inFilter(s.id, "review", t)) {
        store.markViewed(s.id)
        n++
      }
    toast(n ? `Marked ${n} session${n === 1 ? "" : "s"} as reviewed` : "Nothing to review")
  })
  chips.append(markAll, stats)
  brand.append(chips)

  function setFilter(st: Status | undefined) {
    canvas.setStatusFilter(st)
    for (const [k, b] of chipEls) {
      b.classList.toggle("on", k === st)
      b.setAttribute("aria-pressed", String(k === st))
    }
    markAll.hidden = st !== "review"
    root.classList.toggle("filtering", !!st)
    updateFilterBanner()
  }

  const search = el("label", "search")
  search.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.4 10.4 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
  const searchInput = el("input") as HTMLInputElement
  searchInput.type = "search"
  searchInput.placeholder = "Search sessions…"
  searchInput.setAttribute("aria-label", "Search sessions")
  searchInput.autocomplete = "off"
  searchInput.spellcheck = false
  const searchKbd = el("kbd", "search-kbd", "/")
  searchKbd.setAttribute("aria-hidden", "true")
  const searchClear = el("button", "search-clear", "×") as HTMLButtonElement
  searchClear.type = "button"
  searchClear.title = "Clear search (Esc)"
  searchClear.setAttribute("aria-label", "Clear search")
  searchClear.addEventListener("click", (e) => {
    e.preventDefault()
    e.stopPropagation()
    searchInput.value = ""
    search.classList.remove("has-value")
    root.classList.remove("searching")
    canvas.setQuery("")
    updateFilterBanner()
    searchInput.focus()
  })
  search.append(searchInput, searchKbd, searchClear)

  const right = el("div", "top-right")
  if (demo) right.append(el("span", "badge", "Simulated"))
  const orchLink = el("a", "orch-open-btn") as HTMLAnchorElement
  orchLink.href = `/orchestrate${location.search}`
  orchLink.innerHTML = `<span class="orch-icon" aria-hidden="true">⌘</span><span class="orch-label">Orchestrate</span>`
  orchLink.title = "Centralized multi-session orchestration chat (O)"
  orchLink.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    if (orchestrator.isOpen) orchestrator.close()
    else openOrchestrator()
  })
  const tilesBtn = el("button", "tiles-open-btn") as HTMLButtonElement
  tilesBtn.type = "button"
  tilesBtn.innerHTML = `<span class="tiles-icon" aria-hidden="true"></span><span class="tiles-label">Tiles</span><span class="tiles-n"></span>`
  tilesBtn.title = "Every running session's chat, side by side (T)"
  tilesBtn.addEventListener("click", () => (tiles.isOpen ? tiles.close() : openTiles()))
  const ac = new AbortController()
  right.append(autoApproveToggle(store, { signal: ac.signal }), orchLink, tilesBtn)
  const stopNotices = autoApprovedNotices(store)
  const newBtn = el("button", "new-btn") as HTMLButtonElement
  newBtn.type = "button"
  newBtn.innerHTML = `<span class="plus">+</span><span class="new-label">New session</span>`
  newBtn.title = "New session (N)"
  newBtn.addEventListener("click", () => openPicker())
  right.append(newBtn)
  const help = el("button", "icon-btn", "?") as HTMLButtonElement
  help.type = "button"
  help.setAttribute("aria-label", "Keyboard shortcuts")
  help.setAttribute("aria-expanded", "false")
  help.addEventListener("click", () => toggleHelp())
  right.append(help)
  top.append(brand, search, right)

  // ---- active filter / search bar ----
  const filterBanner = el("div", "filter-banner")
  filterBanner.hidden = true
  const filterText = el("span", "filter-banner-text")
  const filterClear = el("button", "filter-banner-clear", "Clear (Esc)") as HTMLButtonElement
  filterClear.type = "button"
  filterClear.addEventListener("click", () => {
    if (searchInput.value) {
      searchInput.value = ""
      search.classList.remove("has-value")
      root.classList.remove("searching")
      canvas.setQuery("")
    }
    if (canvas.filter) setFilter(undefined)
    updateFilterBanner()
  })
  filterBanner.append(filterText, filterClear)
  updateFilterBanner = () => {
    const summary = activeFilterSummary(canvas.filter, searchInput.value, visibleSessionCount)
    filterBanner.hidden = !summary
    if (summary) filterText.textContent = summary
  }

  // ---- collapsible projects navigator (spatial jump list) ----
  const projWrap = el("aside", "proj-wrap")
  projWrap.setAttribute("aria-label", "Projects navigator")
  const projToggle = el("button", "proj-toggle") as HTMLButtonElement
  projToggle.type = "button"
  projToggle.setAttribute("aria-expanded", "false")
  projToggle.title = "Jump to any project on the canvas (P)"
  const projToggleDot = el("span", "proj-toggle-dot")
  projToggleDot.setAttribute("aria-hidden", "true")
  const projToggleLabel = el("span", "proj-toggle-label", "Projects")
  const projToggleCount = el("span", "proj-toggle-count", "0")
  projToggle.append(projToggleDot, projToggleLabel, projToggleCount)

  const projDrawer = el("div", "proj-drawer")
  projDrawer.hidden = true
  const projHead = el("div", "proj-drawer-head")
  const projTitle = el("span", "proj-drawer-title", "Projects on canvas")
  const projFitBtn = el("button", "proj-fit-btn", "Fit all") as HTMLButtonElement
  projFitBtn.type = "button"
  projFitBtn.title = "Fit every project in view (0)"
  projFitBtn.addEventListener("click", () => canvas.fitAll())
  projHead.append(projTitle, projFitBtn)
  const projList = el("div", "proj-list")
  projDrawer.append(projHead, projList)
  projWrap.append(projToggle, projDrawer)

  let projOpen = false
  const setProjOpen = (open: boolean) => {
    projOpen = open
    projDrawer.hidden = !open
    projWrap.classList.toggle("open", open)
    projToggle.setAttribute("aria-expanded", String(open))
  }
  projToggle.addEventListener("click", (e) => {
    e.stopPropagation()
    setProjOpen(!projOpen)
  })

  const renderProjectsNav = () => {
    const groups = summarizeProjectGroups(store)
    projToggleCount.textContent = String(groups.length)
    const hasNeeds = groups.some((g) => g.needsYou > 0)
    const hasWork = groups.some((g) => g.working > 0)
    projToggleDot.dataset.priority = hasNeeds ? "needs-you" : hasWork ? "working" : "idle"
    projWrap.hidden = groups.length === 0
    projList.replaceChildren(
      ...groups.map((g) => {
        const row = el("div", `proj-item p-${g.priority}`)
        const btn = el("button", "proj-item-btn") as HTMLButtonElement
        btn.type = "button"
        btn.title = `${g.directory} · click to jump to this project`
        const dotEl = el("span", `proj-dot ${g.priority}`)
        dotEl.setAttribute("aria-hidden", "true")
        const nameEl = el("span", "proj-name", g.label)
        const metaEl = el("span", "proj-meta")
        const metaBits: string[] = []
        if (g.needsYou) metaBits.push(`${g.needsYou} ask`)
        if (g.working) metaBits.push(`${g.working} live`)
        if (g.review) metaBits.push(`${g.review} rev`)
        metaEl.textContent = metaBits.length ? metaBits.join(" · ") : `${g.total}`
        btn.append(dotEl, nameEl, metaEl)
        btn.addEventListener("click", () => {
          if (canvas.filter) setFilter(undefined)
          if (searchInput.value) {
            searchInput.value = ""
            search.classList.remove("has-value")
            root.classList.remove("searching")
            canvas.setQuery("")
          }
          canvas.focusGroup(g.key)
          if (typeof innerWidth === "number" && innerWidth < 900) setProjOpen(false)
        })
        const addBtn = el("button", "proj-add", "+") as HTMLButtonElement
        addBtn.type = "button"
        addBtn.title = `New session in ${g.label}`
        addBtn.setAttribute("aria-label", `New session in ${g.label}`)
        addBtn.addEventListener("click", (e) => {
          e.stopPropagation()
          void createIn(g.directory)
        })
        row.append(btn, addBtn)
        return row
      }),
    )
  }

  // ---- streamlined bottom dock (Layout + Style popover) ----
  const dock = el("div", "dock")
  const layoutSeg = segmented(LAYOUTS, LAYOUT_LABEL, layoutName, (v) => setLayout(v), "Layout")
  const spinSeg = segmented(SPINNERS, SPINNER_LABEL, spinnerStyle, (v) => setSpinner(v), "Spinner")
  let wallpaper = loadWallpaper()
  applyWallpaper(canvas.stage, wallpaper)
  const wallSeg = segmented(WALLPAPER_IDS, WALLPAPER_LABELS, wallpaper, (v) => setWallpaper(v), "Wallpaper")
  // The spinner only shows on working cards, often tiny or off screen, so each
  // button previews its own animation.
  layoutSeg.group.title = "How sessions are arranged on the canvas (1–4)"
  spinSeg.group.title = "Animation shown on working sessions"
  wallSeg.group.title = "Canvas background wallpaper"
  spinSeg.group.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((b, i) => {
    b.prepend(spinner(12, "seg-spin", SPINNERS[i]))
    b.classList.add("with-spin")
  })

  const styleWrap = el("div", "dock-style-wrap")
  const styleBtn = el("button", "dock-style-btn") as HTMLButtonElement
  styleBtn.type = "button"
  styleBtn.innerHTML = `<span class="ds-label">Style</span><span class="ds-caret" aria-hidden="true">▾</span>`
  styleBtn.title = "Spinner animation & canvas wallpaper"
  styleBtn.setAttribute("aria-haspopup", "dialog")
  styleBtn.setAttribute("aria-expanded", "false")
  const stylePop = el("div", "dock-style-pop")
  stylePop.setAttribute("role", "dialog")
  stylePop.setAttribute("aria-label", "Canvas appearance")
  stylePop.hidden = true
  stylePop.append(spinSeg.group, wallSeg.group)
  styleWrap.append(styleBtn, stylePop)

  let styleOpen = false
  function closeStylePop() {
    if (!styleOpen) return
    styleOpen = false
    stylePop.hidden = true
    styleWrap.classList.remove("open")
    styleBtn.setAttribute("aria-expanded", "false")
  }
  styleBtn.addEventListener("click", (e) => {
    e.stopPropagation()
    styleOpen = !styleOpen
    stylePop.hidden = !styleOpen
    styleWrap.classList.toggle("open", styleOpen)
    styleBtn.setAttribute("aria-expanded", String(styleOpen))
  })
  stylePop.addEventListener("pointerdown", (e) => e.stopPropagation())
  styleBtn.addEventListener("pointerdown", (e) => e.stopPropagation())
  document.addEventListener("pointerdown", closeStylePop, { signal: ac.signal })

  dock.append(layoutSeg.group, el("span", "dock-sep"), styleWrap)

  // ---- bottom-right canvas HUD (attention jump + zoom controls) ----
  const hud = el("div", "canvas-hud")
  hud.setAttribute("aria-label", "Canvas navigation")
  const hudAttn = el("button", "hud-btn hud-attn") as HTMLButtonElement
  hudAttn.type = "button"
  hudAttn.title = "Jump to next session needing attention (])"
  const hudAttnDot = el("span", "hud-attn-dot")
  hudAttnDot.setAttribute("aria-hidden", "true")
  const hudAttnLabel = el("span", "hud-attn-label", "Next")
  hudAttn.append(hudAttnDot, hudAttnLabel)
  hudAttn.addEventListener("click", () => jumpAttention(1))

  const zoomOutBtn = el("button", "hud-btn hud-zoom-step", "−") as HTMLButtonElement
  zoomOutBtn.type = "button"
  zoomOutBtn.title = "Zoom out (-)"
  zoomOutBtn.setAttribute("aria-label", "Zoom out")
  zoomOutBtn.addEventListener("click", () => canvas.zoomBy(0.8))

  zoomReadout = el("button", "hud-btn hud-zoom-val", formatZoomPercent(canvas.camera.z)) as HTMLButtonElement
  zoomReadout.type = "button"
  zoomReadout.title = "Fit all sessions (0)"
  zoomReadout.setAttribute("aria-label", "Reset zoom and fit all sessions")
  zoomReadout.addEventListener("click", () => canvas.fitAll())

  const zoomInBtn = el("button", "hud-btn hud-zoom-step", "+") as HTMLButtonElement
  zoomInBtn.type = "button"
  zoomInBtn.title = "Zoom in (+)"
  zoomInBtn.setAttribute("aria-label", "Zoom in")
  zoomInBtn.addEventListener("click", () => canvas.zoomBy(1.25))

  const fitBtn = el("button", "hud-btn hud-fit", "Fit") as HTMLButtonElement
  fitBtn.type = "button"
  fitBtn.title = "Fit everything in view (0)"
  fitBtn.setAttribute("aria-label", "Fit everything")
  fitBtn.addEventListener("click", () => canvas.fitAll())

  const cmdkBtn = el("button", "hud-btn hud-cmdk", "⌘K") as HTMLButtonElement
  cmdkBtn.type = "button"
  cmdkBtn.title = "Command palette — jump to any session, project, or action (⌘K)"
  cmdkBtn.setAttribute("aria-label", "Open command palette")
  cmdkBtn.addEventListener("click", () => palette.open())

  hud.append(hudAttn, el("span", "hud-sep"), cmdkBtn, el("span", "hud-sep"), zoomOutBtn, zoomReadout, zoomInBtn, fitBtn)

  root.append(top, filterBanner, projWrap, dock, hud)

  function setWallpaper(v: WallpaperId) {
    wallpaper = v
    wallSeg.set(v)
    saveWallpaper(v)
    applyWallpaper(canvas.stage, v)
  }

  function setLayout(v: LayoutName) {
    layoutName = v
    root.dataset.layout = v
    layoutSeg.set(v)
    pref.set("layout", v)
    canvas.setLayout(v)
  }

  function setSpinner(v: SpinnerStyle) {
    spinnerStyle = v
    spinSeg.set(v)
    setSpinnerStyle(v)
    pref.set("spinner", v)
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      canvas.setQuery(searchInput.value)
      updateFilterBanner()
    }, 90)
    const hasVal = !!searchInput.value
    search.classList.toggle("has-value", hasVal)
    root.classList.toggle("searching", !!searchInput.value.trim())
  })
  searchInput.addEventListener("keydown", (e) => {
    e.stopPropagation()
    if (e.key === "Escape") {
      if (searchInput.value) {
        searchInput.value = ""
        canvas.setQuery("")
        search.classList.remove("has-value")
        root.classList.remove("searching")
        updateFilterBanner()
      } else searchInput.blur()
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault()
      searchInput.blur()
      canvas.moveSelection(0, 1)
      if (e.key === "Enter" && canvas.selected) canvas.activate(canvas.selected)
    }
  })

  const updateStats = () => {
    const counts = store.statusCounts()
    const total = store.roots().length
    for (const [st, b] of chipEls) {
      const n = st === "review" ? counts.review + counts.failed : counts[st]
      b.querySelector(".chip-n")!.textContent = String(n)
      b.classList.toggle("zero", n === 0 && canvas.filter !== st)
      b.title = `${n} ${STATUS_LABEL[st].toLowerCase()}. Click to show only these`
    }
    stats.textContent = `${total} session${total === 1 ? "" : "s"}`
    const waiting = store.pendingPermissionCount()
    allowAll.hidden = waiting === 0
    allowAll.textContent = waiting > 1 ? `Allow all ${waiting}` : "Allow"
    const live = tiles.liveCount()
    tilesBtn.querySelector(".tiles-n")!.textContent = live ? String(live) : ""
    tilesBtn.classList.toggle("on", tiles.isOpen)
    tilesBtn.classList.toggle("live", counts.working + counts["needs-you"] > 0)
    orchLink.classList.toggle("on", orchestrator.isOpen)

    const attn = buildAttentionQueue(store, (id) => canvas.hasSession(id))
    hudAttn.hidden = attn.ids.length === 0
    hudAttn.classList.toggle("urgent", attn.needsYou > 0)
    hudAttnLabel.textContent =
      attn.needsYou > 0
        ? `Needs you (${attn.needsYou})`
        : attn.review > 0
          ? `Review (${attn.review})`
          : `Live (${attn.working})`

    renderProjectsNav()
    updateFilterBanner()

    // The tab title says what needs you, even from another tab.
    const bits: string[] = []
    if (counts["needs-you"]) bits.push(`${counts["needs-you"]} need${counts["needs-you"] === 1 ? "s" : ""} you`)
    if (counts.working) bits.push(`${counts.working} working`)
    const review = counts.review + counts.failed
    if (review) bits.push(`${review} to review`)
    const title = `${bits.length ? bits.join(" · ") + " — " : ""}Hermes Canvas`
    if (document.title !== title) document.title = title
  }
  // Relative times and the 48h review window move even without events.
  const statsTimer = setInterval(updateStats, 30_000)
  const updateConn = (s: ConnectionState) => {
    dot.dataset.state = s
    dot.title =
      s === "live" ? `Connected to Hermes ${cfg.version ?? ""}`.trim() : s === "demo" ? "Simulated sessions" : s === "reconnecting" ? "Reconnecting…" : "Connecting…"
  }
  const unsubStore = store.on({ structure: updateStats, cards: updateStats, connection: updateConn })
  updateConn(store.connection)

  // ---- help ----

  let helpEl: HTMLElement | undefined
  function toggleHelp() {
    if (helpEl) {
      helpEl.remove()
      helpEl = undefined
      help.setAttribute("aria-expanded", "false")
      return
    }
    helpEl = el("div", "help")
    helpEl.setAttribute("role", "dialog")
    helpEl.setAttribute("aria-label", "Keyboard shortcuts")
    help.setAttribute("aria-expanded", "true")
    helpEl.innerHTML = `
      <h2>Canvas</h2>
      <dl>
        <dt>Scroll · drag</dt><dd>Pan</dd>
        <dt>Pinch · ⌘/Ctrl + scroll</dt><dd>Zoom</dd>
        <dt>← ↑ → ↓</dt><dd>Move between sessions</dd>
        <dt>Enter · click</dt><dd>Open a stack or session</dd>
        <dt>Esc</dt><dd>Step back one level</dd>
        <dt>⌘K · Ctrl+K</dt><dd>Command palette: jump to any session, project, or action</dd>
        <dt>/ · type</dt><dd>Filter sessions on canvas</dd>
        <dt>1 – 4</dt><dd>Satellites, Fold, Tabs, Tree</dd>
        <dt>0 · double-click</dt><dd>Fit everything</dd>
        <dt>N</dt><dd>New session: pick a project or type a folder path</dd>
        <dt>L</dt><dd>Launch a task: type a prompt in the chat box, Enter starts it</dd>
        <dt>P</dt><dd>Toggle the Projects navigator to jump between projects</dd>
        <dt>O</dt><dd>Orchestrate: control multiple sessions from one unified chat</dd>
        <dt>T</dt><dd>Tiles: every running session's chat side by side</dd>
        <dt>] · [</dt><dd>Next / previous session (works on canvas and inside an open session)</dd>
      </dl>
      <h2>Status</h2>
      <dl class="legend">
        <dt><span class="mark needs-you"></span></dt><dd>Needs you: a permission or question is waiting</dd>
        <dt><span class="mark working-l"></span></dt><dd>Working: the agent is running</dd>
        <dt><span class="mark review"></span></dt><dd>To review: finished since you last opened it (48h)</dd>
        <dt><span class="mark failed"></span></dt><dd>Failed</dd>
        <dt><span class="mark stopped"></span></dt><dd>Stopped</dd>
        <dt><span class="mark done"></span></dt><dd>Done and seen</dd>
      </dl>
      <h2>Session</h2>
      <dl>
        <dt>Enter</dt><dd>Send, or steer while working</dd>
        <dt>Tab</dt><dd>Queue for after the current turn</dd>
        <dt>⇧ Enter</dt><dd>New line</dd>
        <dt>⌘ .</dt><dd>Stop</dd>
      </dl>
      <h2>Launchpad</h2>
      <dl>
        <dt>L</dt><dd>Jump to the task box</dd>
        <dt>Enter</dt><dd>Launch a new session; each launch is independent</dd>
        <dt>Team · Solo</dt><dd>Team asks Hermes to split the task across subagents</dd>
        <dt>@project</dt><dd>Start this task at that project (e.g. @hermes-canvas fix tests)</dd>
      </dl>`
    helpEl.addEventListener("click", () => {
      if (typeof window.getSelection === "function" && window.getSelection()?.toString()) return
      toggleHelp()
    })
    root.append(helpEl)
  }

  function jumpAttention(dir: 1 | -1) {
    const q = buildAttentionQueue(store, (id) => canvas.hasSession(id))
    const next = nextAttentionId(q.ids, canvas.selected, dir)
    if (!next) return toast("Nothing needs you right now")
    canvas.select(next, false)
    canvas.centerOn(next, Math.max(0.8, canvas.camera.z))
  }

  // ---- keyboard ----

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "k" && (e.metaKey || e.ctrlKey) && !e.altKey) {
      e.preventDefault()
      if (helpEl) toggleHelp()
      palette.toggle()
      return
    }
    if (palette.isOpen) {
      if (e.key === "Escape") {
        e.preventDefault()
        palette.handleEscape()
      }
      return
    }
    if (picker.isOpen) {
      if (e.key === "Escape") {
        e.preventDefault()
        picker.handleEscape()
      }
      return
    }
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']")) return
    if (e.key === "." && (e.metaKey || e.ctrlKey)) {
      if (panel.isOpen) {
        e.preventDefault()
        void panel.interrupt()
        return
      }
      const targetId = tiles.isOpen ? tiles.maximized : canvas.selected
      if (targetId && store.running.has(targetId)) {
        e.preventDefault()
        void backend.interrupt(targetId).catch((err) => toast((err as Error).message))
        return
      }
    }
    if (e.key === "Escape") {
      if (palette.handleEscape()) return
      if (helpEl) return toggleHelp()
      if (launchpad?.closeOpenMenu()) return
      if (styleOpen) return closeStylePop()
      if (panel.handleEscape()) return
      if (orchestrator.handleEscape()) return
      if (tiles.isOpen) {
        if (tiles.maximized) return tiles.toggleMax(tiles.maximized)
        return tiles.close()
      }
      if (projOpen) return setProjOpen(false)
      if (searchInput.value) {
        searchInput.value = ""
        search.classList.remove("has-value")
        root.classList.remove("searching")
        canvas.setQuery("")
        return updateFilterBanner()
      }
      if (canvas.filter) return setFilter(undefined)
      if (canvas.closeStack()) return
      return canvas.select(undefined)
    }
    if (panel.isOpen) {
      if ((e.key === "]" || e.key === "[") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        panel.onStep?.(e.key === "]" ? 1 : -1)
        return
      }
      const interactive = target?.closest("button, a, [role='button'], [role='menuitem'], summary")
      if (!interactive && e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
        panel.focusInput()
      }
      return
    }
    if ((e.key === "o" || e.key === "O") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      return orchestrator.isOpen ? orchestrator.close() : openOrchestrator()
    }
    if ((e.key === "t" || e.key === "T") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      return tiles.isOpen ? tiles.close() : openTiles()
    }
    // The canvas shortcuts below don't apply on the tiled or orchestrator views.
    if (tiles.isOpen || orchestrator.isOpen) return
    if (e.key === "/") {
      e.preventDefault()
      searchInput.focus()
      searchInput.select()
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) {
      if (e.key === "=" || e.key === "+") {
        e.preventDefault()
        canvas.zoomBy(1.25)
      } else if (e.key === "-") {
        e.preventDefault()
        canvas.zoomBy(0.8)
      } else if (e.key === "0") {
        e.preventDefault()
        canvas.fitAll()
      }
      return
    }
    const dirs: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }
    if (dirs[e.key]) {
      e.preventDefault()
      return canvas.moveSelection(...dirs[e.key])
    }
    if (e.key === "Enter" && canvas.selected) {
      e.preventDefault()
      return canvas.activate(canvas.selected)
    }
    if (/^[1-4]$/.test(e.key)) return setLayout(LAYOUTS[Number(e.key) - 1])
    if (e.key === "0") return canvas.fitAll()
    if (e.key === "=" || e.key === "+") return canvas.zoomBy(1.25)
    if (e.key === "-") return canvas.zoomBy(0.8)
    if (e.key === "n" || e.key === "N") {
      e.preventDefault()
      return openPicker()
    }
    if (e.key === "l" || e.key === "L") {
      e.preventDefault()
      return launchpad?.focus()
    }
    if (e.key === "p" || e.key === "P") {
      e.preventDefault()
      return setProjOpen(!projOpen)
    }
    if (e.key === "?") return toggleHelp()
    // Jump between sessions that want attention: needs you, then review, then working.
    if (e.key === "]" || e.key === "[") return jumpAttention(e.key === "]" ? 1 : -1)
    // Typing anywhere starts a search.
    if (e.key.length === 1 && /\S/.test(e.key)) {
      searchInput.focus()
    }
  }
  window.addEventListener("keydown", onKeyDown)

  const destroy = () => {
    destroyed = true
    ac.abort()
    stopNotices()
    clearTimeout(searchTimer)
    clearInterval(statsTimer)
    unsubStore()
    window.removeEventListener("keydown", onKeyDown)
    store.stop()
    helpEl?.remove()
    helpEl = undefined
    palette.destroy()
    picker.close(false)
    panel.destroy()
    launchpad?.destroy()
    orchestrator.destroy()
    tiles.destroy()
    canvas.destroy()
  }

  try {
    await store.start()
  } catch (e) {
    destroy()
    showUnavailable(root, { ...cfg, mode: "live", connected: false, error: (e as Error).message })
    return undefined
  }

  if (destroyed) return { store, canvas, panel, tiles, orchestrator, picker, launchpad, destroy }

  // Deep links: /orchestrate, /#orchestrate, /#tiles, /#ses_…
  const hash = location.hash.slice(1)
  if (location.pathname === "/orchestrate" || hash === "orchestrate") openOrchestrator()
  else if (hash === "tiles") openTiles()
  else if (hash && store.sessions.has(hash)) requestAnimationFrame(() => requestAnimationFrame(() => openSession(hash)))

  return { store, canvas, panel, tiles, orchestrator, picker, launchpad, destroy }
}

if (typeof document !== "undefined" && document.getElementById("app") && !(globalThis as any).__HERMES_TEST__) {
  void boot()
}
