// Hermes Command Palette (Cmd/Ctrl+K): instant jump to any session, project,
// or Hermes Canvas / Agent action from anywhere in the workspace.

import {
  rankPaletteItems,
  type PaletteActionSpec,
  type PaletteProjectItem,
  type PaletteResult,
  type PaletteSessionItem,
} from "./palette-logic"
import type { Store } from "./store"
import { summarizeProjectGroups } from "./ux-helpers"

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export interface PaletteActionEntry extends PaletteActionSpec {
  run: () => void
}

export interface CommandPaletteHandlers {
  getActions: () => PaletteActionEntry[]
  openSession: (id: string) => void
  focusProject: (groupKey: string) => void
}

export class CommandPalette {
  private scrim: HTMLElement
  private modal: HTMLElement
  private input: HTMLInputElement
  private list: HTMLElement
  private items: PaletteResult[] = []
  private actionMap = new Map<string, () => void>()
  private activeIdx = 0
  private openState = false
  private returnFocus?: HTMLElement | null

  constructor(
    host: HTMLElement,
    private store: Store,
    private handlers: CommandPaletteHandlers,
  ) {
    this.scrim = h("div", "cmdk-scrim")
    this.scrim.hidden = true
    this.scrim.addEventListener("pointerdown", (e) => {
      if (e.target === this.scrim) this.close()
    })

    this.modal = h("div", "cmdk-modal")
    this.modal.setAttribute("role", "dialog")
    this.modal.setAttribute("aria-modal", "true")
    this.modal.setAttribute("aria-label", "Command palette")

    const head = h("div", "cmdk-head")
    const icon = h("span", "cmdk-icon")
    icon.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.4 10.4 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
    this.input = h("input", "cmdk-input") as HTMLInputElement
    this.input.type = "search"
    this.input.placeholder = "Jump to a session, project, or Hermes action…"
    this.input.setAttribute("aria-label", "Search sessions, projects, and actions")
    this.input.setAttribute("aria-autocomplete", "list")
    this.input.setAttribute("aria-controls", "cmdk-listbox")
    this.input.autocomplete = "off"
    this.input.spellcheck = false

    const escHint = h("kbd", "cmdk-esc", "ESC")
    escHint.setAttribute("aria-hidden", "true")
    head.append(icon, this.input, escHint)

    this.list = h("div", "cmdk-list")
    this.list.id = "cmdk-listbox"
    this.list.setAttribute("role", "listbox")

    const foot = h("div", "cmdk-foot")
    foot.innerHTML = `<span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> select</span><span><kbd>Esc</kbd> close</span>`

    this.modal.append(head, this.list, foot)
    this.scrim.append(this.modal)
    host.append(this.scrim)

    this.input.addEventListener("input", () => {
      this.activeIdx = 0
      this.render()
    })
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation()
      if (e.key === "Escape") {
        e.preventDefault()
        this.close()
        return
      }
      if (e.key === "ArrowDown") {
        e.preventDefault()
        if (this.items.length) {
          this.activeIdx = (this.activeIdx + 1) % this.items.length
          this.syncActive()
        }
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        if (this.items.length) {
          this.activeIdx = (this.activeIdx - 1 + this.items.length) % this.items.length
          this.syncActive()
        }
        return
      }
      if (e.key === "Enter") {
        e.preventDefault()
        const picked = this.items[this.activeIdx]
        if (picked) this.runItem(picked)
      }
    })
  }

  get isOpen() {
    return this.openState
  }

  open() {
    if (this.openState) return
    this.openState = true
    this.returnFocus = document.activeElement as HTMLElement | null
    this.input.value = ""
    this.activeIdx = 0
    this.scrim.hidden = false
    this.render()
    requestAnimationFrame(() => this.input.focus())
  }

  close(restoreFocus = true) {
    if (!this.openState) return
    this.openState = false
    this.scrim.hidden = true
    if (restoreFocus && this.returnFocus && typeof this.returnFocus.focus === "function") {
      this.returnFocus.focus()
    }
    this.returnFocus = undefined
  }

  toggle() {
    if (this.openState) this.close()
    else this.open()
  }

  handleEscape(): boolean {
    if (!this.openState) return false
    this.close()
    return true
  }

  destroy() {
    this.close(false)
    this.scrim.remove()
  }

  private render() {
    const now = Date.now()
    const actions = this.handlers.getActions()
    this.actionMap.clear()
    for (const a of actions) this.actionMap.set(a.id, a.run)

    const sessions: PaletteSessionItem[] = this.store.roots().map((s) => {
      const status = this.store.status(s.id, now)
      return {
        id: s.id,
        title: this.store.title(s),
        projectLabel: this.store.projectLabel(s),
        directory: s.location.directory,
        status,
        activity: status === "working" ? this.store.activityLabel(s.id) : undefined,
        updated: s.time.updated,
        needsPermission: this.store.needsInput(s.id) === "permission",
        subagents: this.store.subagentCount(s.id),
      }
    })

    const projects: PaletteProjectItem[] = summarizeProjectGroups(this.store, now).map((g) => ({
      key: g.key,
      label: g.label,
      directory: g.directory,
      total: g.total,
      needsYou: g.needsYou,
      working: g.working,
      review: g.review,
    }))

    this.items = rankPaletteItems(this.input.value, actions, sessions, projects, 16)
    if (this.activeIdx >= this.items.length) this.activeIdx = Math.max(0, this.items.length - 1)

    if (!this.items.length) {
      this.list.replaceChildren(h("div", "cmdk-empty", "No matching sessions, projects, or actions."))
      this.input.removeAttribute("aria-activedescendant")
      return
    }

    const frag = document.createDocumentFragment()
    let lastSection = ""
    this.items.forEach((item, idx) => {
      if (item.section !== lastSection) {
        lastSection = item.section
        frag.append(h("div", "cmdk-section", item.section))
      }
      const btn = h("button", `cmdk-item kind-${item.kind}${item.status ? ` st-${item.status}` : ""}${idx === this.activeIdx ? " on" : ""}`) as HTMLButtonElement
      btn.type = "button"
      btn.id = `cmdk-opt-${idx}`
      btn.setAttribute("role", "option")
      btn.setAttribute("aria-selected", String(idx === this.activeIdx))

      const left = h("div", "cmdk-item-left")
      if (item.kind === "session") {
        const dot = h("span", `cmdk-dot st-${item.status ?? "done"}`)
        dot.setAttribute("aria-hidden", "true")
        left.append(dot)
      } else if (item.kind === "project") {
        const badge = h("span", "cmdk-glyph", "◆")
        badge.setAttribute("aria-hidden", "true")
        left.append(badge)
      } else {
        const badge = h("span", "cmdk-glyph act", "→")
        badge.setAttribute("aria-hidden", "true")
        left.append(badge)
      }

      const textWrap = h("div", "cmdk-item-text")
      textWrap.append(h("span", "cmdk-item-title", item.title))
      const subParts = [item.subtitle]
      if (item.meta) subParts.push(item.meta)
      textWrap.append(h("span", "cmdk-item-sub", subParts.join(" · ")))
      left.append(textWrap)

      btn.append(left)
      if (item.shortcut) {
        btn.append(h("kbd", "cmdk-kbd", item.shortcut))
      }

      btn.addEventListener("pointerenter", () => {
        if (this.activeIdx !== idx) {
          this.activeIdx = idx
          this.syncActive(false)
        }
      })
      btn.addEventListener("click", () => this.runItem(item))
      frag.append(btn)
    })

    this.list.replaceChildren(frag)
    this.syncActive(false)
  }

  private syncActive(scroll = true) {
    const opts = this.list.querySelectorAll<HTMLElement>(".cmdk-item")
    opts.forEach((el, i) => {
      const on = i === this.activeIdx
      el.classList.toggle("on", on)
      el.setAttribute("aria-selected", String(on))
      if (on && scroll && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "nearest" })
      }
    })
    if (this.items.length) this.input.setAttribute("aria-activedescendant", `cmdk-opt-${this.activeIdx}`)
  }

  private runItem(item: PaletteResult) {
    this.close(false)
    if (item.kind === "session") {
      this.handlers.openSession(item.id)
    } else if (item.kind === "project") {
      this.handlers.focusProject(item.id)
    } else {
      this.actionMap.get(item.id)?.()
    }
  }
}
