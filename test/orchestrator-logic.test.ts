import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  filterAndGroupFleet,
  orchestratorSuggestions,
  parseOrchestratorInput,
  resolveOrchestratorTargets,
  resolveSpawnProject,
  rollupDispatchStates,
  type FleetSession,
} from "../src/app/orchestrator-logic"

const FLEET: FleetSession[] = [
  {
    id: "ses_web1",
    title: "Checkout redesign",
    projectKey: "p_web",
    projectLabel: "storefront-web",
    directory: "/code/storefront-web",
    status: "working",
    running: true,
    needsInput: undefined,
    activity: "Running bun test",
    modelLabel: "claude-sonnet",
    subagents: 3,
    updated: 1000,
    preview: "Two-step checkout layout complete.",
  },
  {
    id: "ses_api1",
    title: "Refund webhooks",
    projectKey: "p_api",
    projectLabel: "payments-api",
    directory: "/code/payments-api",
    status: "needs-you",
    running: true,
    needsInput: "permission",
    activity: "Needs permission",
    modelLabel: "claude-sonnet",
    subagents: 2,
    updated: 900,
    preview: "Waiting to push feature branch.",
  },
  {
    id: "ses_ds1",
    title: "Dark mode tokens",
    projectKey: "p_ds",
    projectLabel: "design-system",
    directory: "/code/design-system",
    status: "review",
    running: false,
    needsInput: undefined,
    activity: "",
    modelLabel: "gemini-2.5",
    subagents: 1,
    updated: 800,
    preview: "Added dark and light CSS tokens.",
  },
  {
    id: "ses_infra1",
    title: "Cost review",
    projectKey: "p_infra",
    projectLabel: "infra",
    directory: "/code/infra",
    status: "done",
    running: false,
    needsInput: undefined,
    activity: "",
    modelLabel: "gpt-4o",
    subagents: 0,
    updated: 500,
    preview: "Idle previews auto-stop after 2h.",
  },
]

describe("orchestrator-logic", () => {
  it("parses plain prompts, delivery overrides, @mentions, and slash commands", () => {
    const plain = parseOrchestratorInput("Run the unit tests and report failures", "steer")
    assert.equal(plain.kind, "prompt")
    assert.equal(plain.delivery, "steer")
    assert.deepEqual(plain.mentions, [])
    assert.equal(plain.text, "Run the unit tests and report failures")

    const mentioned = parseOrchestratorInput("@payments-api @storefront-web verify webhook retries", "queue")
    assert.equal(mentioned.kind, "prompt")
    assert.equal(mentioned.delivery, "queue")
    assert.deepEqual(mentioned.mentions, ["payments-api", "storefront-web"])
    assert.equal(mentioned.text, "verify webhook retries")

    const team = parseOrchestratorInput("/team @storefront-web audit checkout a11y")
    assert.equal(team.kind, "spawn")
    assert.equal(team.team, true)
    assert.deepEqual(team.mentions, ["storefront-web"])
    assert.equal(team.text, "audit checkout a11y")

    const solo = parseOrchestratorInput("/spawn @infra rotate staging certs")
    assert.equal(solo.kind, "spawn")
    assert.equal(solo.team, false)
    assert.deepEqual(solo.mentions, ["infra"])
    assert.equal(solo.text, "rotate staging certs")

    const q = parseOrchestratorInput("/queue @live summarize remaining todos")
    assert.equal(q.kind, "prompt")
    assert.equal(q.delivery, "queue")
    assert.deepEqual(q.mentions, ["live"])
    assert.equal(q.text, "summarize remaining todos")

    const status = parseOrchestratorInput("/status @live")
    assert.equal(status.kind, "status")
    assert.deepEqual(status.mentions, ["live"])

    const collect = parseOrchestratorInput("/collect")
    assert.equal(collect.kind, "collect")

    const stop = parseOrchestratorInput("/stop @payments-api")
    assert.equal(stop.kind, "stop")
    assert.deepEqual(stop.mentions, ["payments-api"])

    const unknownSlash = parseOrchestratorInput("/etc/hosts check file")
    assert.equal(unknownSlash.kind, "prompt")
    assert.equal(unknownSlash.text, "/etc/hosts check file")
  })

  it("resolves explicit @mentions and falls back cleanly to checkbox selection", () => {
    const selected = new Set(["ses_web1", "ses_ds1"])
    const fallback = resolveOrchestratorTargets(FLEET, selected, [])
    assert.equal(fallback.usedMentions, false)
    assert.deepEqual(
      fallback.sessions.map((s) => s.id),
      ["ses_web1", "ses_ds1"],
    )
    assert.equal(fallback.scopeLabel, "2 selected sessions")

    const live = resolveOrchestratorTargets(FLEET, selected, ["live"])
    assert.equal(live.usedMentions, true)
    assert.deepEqual(
      live.sessions.map((s) => s.id),
      ["ses_web1", "ses_api1"],
    )
    assert.equal(live.scopeLabel, "@live")

    const ask = resolveOrchestratorTargets(FLEET, selected, ["ask"])
    assert.deepEqual(
      ask.sessions.map((s) => s.id),
      ["ses_api1"],
    )

    const projAndTitle = resolveOrchestratorTargets(FLEET, selected, ["design-system", "cost-review", "nope"])
    assert.deepEqual(
      projAndTitle.sessions.map((s) => s.id),
      ["ses_ds1", "ses_infra1"],
    )
    assert.deepEqual(projAndTitle.unknownMentions, ["nope"])
  })

  it("resolves spawn project mentions by exact name or unique prefix", () => {
    const projects = [
      { label: "storefront-web", directory: "/code/storefront-web" },
      { label: "payments-api", directory: "/code/payments-api" },
      { label: "design-system", directory: "/code/design-system" },
    ]
    assert.equal(resolveSpawnProject(projects, ["payments-api"])?.directory, "/code/payments-api")
    assert.equal(resolveSpawnProject(projects, ["store"])?.directory, "/code/storefront-web")
    assert.equal(resolveSpawnProject(projects, ["unknown"]), undefined)
  })

  it("filters and groups fleet sessions by urgency and search query", () => {
    const allGroups = filterAndGroupFleet(FLEET, "all", "")
    assert.equal(allGroups[0]?.label, "payments-api") // needs-you first
    assert.equal(allGroups[1]?.label, "storefront-web") // working second

    const liveGroups = filterAndGroupFleet(FLEET, "live", "")
    assert.equal(liveGroups.length, 2)

    const searched = filterAndGroupFleet(FLEET, "all", "tokens")
    assert.equal(searched.length, 1)
    assert.equal(searched[0]?.sessions[0]?.id, "ses_ds1")
  })

  it("provides autocomplete suggestions for /commands and @targets and rolls up dispatch states", () => {
    const cmds = orchestratorSuggestions("/st", FLEET, [])
    assert.ok(cmds.some((c) => c.label === "/status"))
    assert.ok(cmds.some((c) => c.label === "/steer"))
    assert.ok(cmds.some((c) => c.label === "/stop"))

    const mentions = orchestratorSuggestions("please check @pay", FLEET, [
      { label: "payments-api", directory: "/code/payments-api" },
    ])
    assert.equal(mentions[0]?.label, "@payments-api")

    const rollup = rollupDispatchStates(["running", "succeeded", "failed", "interrupted", "queued"])
    assert.deepEqual(rollup, {
      total: 5,
      active: 2,
      succeeded: 1,
      failed: 1,
      interrupted: 1,
      done: 3,
    })
  })
})
