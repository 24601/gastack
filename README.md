# gastack — the gstack-gastown bridge

> Design doc in, merged code out.

gastack is a continuous verification pipeline that connects [gstack](https://github.com/garrytan/gstack) (AI code review and design tools by [@garrytan](https://github.com/garrytan)) to [Gas Town](https://github.com/24601/gastown) (multi-agent orchestration). Point it at a design doc and a rig. It extracts tasks, dispatches them to AI coding agents, runs code review and security audit in parallel, applies quality gates, blocks when human judgment is needed, and lands through the merge queue.

Six stages. Crash recovery. One event log. You approve one security finding. That's your only input.

```
Design Doc → PLAN → EXECUTE → REVIEW → REFINE → DEPLOY → DONE
                      ↑                    ↑
                   gastown               gstack
               (agent fleet)        (review + security)
```

---

## Find your entry point

### I use gstack already

The bridge automates everything after `/plan-ceo-review` approves your design. Instead of manually creating work items, dispatching agents, running `/review` and `/cso`, interpreting findings, and triggering merges — the bridge does it as a single pipeline. Your gstack skills become quality gates in an automated flow.

**[Jump to install →](#install)**

### I use Gas Town already

The bridge feeds gstack's `/review` and `/cso` quality gates into your convoy/polecat workflow. Instead of dispatching work and hoping it's correct, every task goes through structured code review and security audit before landing. Quality policy decides what passes, what warns, and what blocks for human approval.

**[Jump to install →](#install)**

### What is gstack?

[gstack](https://github.com/garrytan/gstack) by Garry Tan turns Claude Code into a virtual engineering team — 20+ slash-command specialists covering design, review, QA, security, and shipping. `/review` finds production bugs, `/cso` runs OWASP + STRIDE security audits, `/ship` handles the release. The bridge uses `/review` and `/cso` as its quality gates.

### What is Gas Town?

[Gas Town](https://github.com/24601/gastown) is a multi-agent workspace manager. It runs fleets of AI coding agents (polecats) coordinated by crew workers, with a witness for lifecycle management and a refinery for merge queues. The bridge uses Gas Town's convoy system to dispatch tasks and land merged code.

---

## The problem we solve

Without the bridge, you are the integration layer:

| Step | Without bridge | With bridge |
|------|---------------|-------------|
| Read design doc, extract tasks | Manual | `PLAN` stage (regex + LLM) |
| Create beads, dispatch to agents | Manual (`bd new`, `gt sling` × N) | `EXECUTE` stage (convoy create + sling) |
| Wait for completion, run reviews | Manual (`claude -p /review`, `/cso`) | `REVIEW` stage (parallel, automatic) |
| Interpret findings, decide action | Manual | `quality.ts` policy engine |
| Approve blocking findings | Manual | `REFINE` stage (scoped signals) |
| Trigger merge | Manual (`gt convoy land`) | `DEPLOY` stage (merge queue) |

Every manual step loses context and invites shortcuts. The bridge replaces you as the router.

---

## Install

**Prerequisites:** [gstack](https://github.com/garrytan/gstack) installed (`claude` on PATH), [Gas Town](https://github.com/24601/gastown) installed (`gt` and `bd` on PATH), [Bun](https://bun.sh/) v1.0+

### Option A: Use this fork (recommended)

If you want gstack + bridge together. All upstream gstack skills work unchanged.

```bash
# Replace your gstack install with this fork
git clone https://github.com/24601/gastack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup
```

To stay current with upstream gstack:
```bash
cd ~/.claude/skills/gstack
git fetch upstream   # upstream = garrytan/gstack (auto-configured)
git merge upstream/main
```

### Option B: Add bridge to existing gstack (standalone)

If you want to keep garrytan/gstack untouched and add bridge separately.

```bash
# Clone just the bridge (zero npm dependencies, runs on Bun builtins)
git clone --depth 1 https://github.com/24601/gastack.git /tmp/gastack-bridge
cp -r /tmp/gastack-bridge/bridge ~/gstack-bridge
cd ~/gstack-bridge

# Run it
bun run cli.ts start --design-doc <path> --rig <name>
```

The bridge has **zero dependencies on parent gstack code** — all imports are internal (`./events.js`, `./orchestrate.js`) or Node builtins (`fs`, `path`, `crypto`). It shells out to `claude` and `gt` CLIs, which must be on your PATH.

---

## Quick start

```bash
# Start a pipeline from a design doc
bun run bridge/cli.ts start --design-doc ~/.gstack/projects/my-design.md --rig myproject

# Watch events in real time
bun run bridge/cli.ts watch <run-id>

# Check pipeline status
bun run bridge/cli.ts status <run-id>

# Approve a blocked finding
bun run bridge/cli.ts approve <run-id> --stage REVIEW --cycle 1 --reason "accepted risk"

# Reject (cancel the run)
bun run bridge/cli.ts reject <run-id> --stage REVIEW --cycle 1 --reason "fix needed"

# List all sessions
bun run bridge/cli.ts list
```

---

## How it works

### The stage machine

| Stage | What happens | External calls |
|-------|-------------|----------------|
| **PLAN** | Extract tasks from design doc (regex + Haiku LLM) | — |
| **EXECUTE** | Create convoy, dispatch tasks to polecats | `gt convoy create`, `gt sling` × N |
| **REVIEW** | Run code review + security audit in parallel | `claude -p /review`, `claude -p /cso` |
| **REFINE** | Quality gate evaluation → PASS / WARN / BLOCKED | Human approval if blocked |
| **DEPLOY** | Land through refinery merge queue | `gt convoy land` |
| **DONE** | Pipeline complete | — |

### Event-sourced state

The orchestrator has zero mutable state fields. Everything is derived from an append-only JSONL event log at `~/.gstack/runs/{id}/events.jsonl`. On crash, `Orchestrator.resume()` replays the log and reconstructs the current stage, pending tasks, and completed work.

Every external call gets an idempotency token (SHA-256 of adapter + command + args) written to the log before the result is processed. On restart, completed calls return cached results — no duplicate convoys, reviews, or merges.

### Quality policy

| Gate | PASS | WARN | BLOCKED |
|------|------|------|---------|
| Security (`/cso`) | No findings | MINOR severity | CRITICAL or MAJOR |
| Correctness (`/review`) | Grade ≥ C | Minor findings | Grade < C or not run |

Security CRITICAL+ requires explicit human approval with a reason. The bridge fail-closes: if `gt --json` returns non-JSON, it blocks. No text scraping as fallback.

---

## Architecture

~3K lines source + ~2K lines tests. Zero npm dependencies.

```
bridge/
├── orchestrate.ts         528 lines — stage machine, state derivation
├── events.ts              462 lines — 13-event schema, JSONL log, idempotency
├── cli.ts                 571 lines — start, status, watch, approve, reject
├── quality.ts             350 lines — quality policy engine
├── output.ts              360 lines — adaptive output calibration
├── notify.ts              307 lines — Slack/Discord webhooks
├── adapters/
│   ├── gastown.ts         406 lines — gt CLI wrapper, event tailer
│   └── gstack.ts          282 lines — claude -p executor, grade/finding parsers
└── *.test.ts             2K+ lines — tests for every module
```

### Key engineering decisions

1. **Event log IS the state.** No checkpoint file. Crash → replay JSONL → reconstruct.
2. **Idempotent external calls.** SHA-256 content addressing. Written before result processing.
3. **Scoped approval signals.** `{runId, stage, reviewCycle}` — stale approvals from previous cycles are ignored.
4. **Array args everywhere.** `Bun.spawn(['gt', 'sling', beadId])` — no shell interpolation, no injection.
5. **Adaptive output.** First run: verbose. Run 10+: terse. `--verbose`/`--quiet` override.

---

## Upstream sync

This fork tracks [garrytan/gstack](https://github.com/garrytan/gstack) upstream. The `bridge/` directory is our only addition — it doesn't touch any upstream files.

**For fork users — staying current:**
```bash
cd ~/.claude/skills/gstack    # or wherever you cloned gastack
git remote add upstream https://github.com/garrytan/gstack.git  # one-time
git fetch upstream
git merge upstream/main       # bridge/ won't conflict — it's a new directory
git push
```

**For contributors:** PRs that touch only `bridge/` go here. PRs that touch upstream gstack code should go to [garrytan/gstack](https://github.com/garrytan/gstack).

---

## Roadmap

- **Phase B1 (current):** Bun-only spike. Local daemon. Terminal UI. Works today.
- **Phase B2:** Temporal migration. Durable workflow state. Multi-machine resume.
- **Phase C:** Extensible policy engine. Custom stage definitions. Plugin adapters.

---

## Attribution

This fork adds the gstack-gastown bridge. All gstack skills, the browse binary, the design tools, and the Chrome extension are by [@garrytan](https://github.com/garrytan) and the gstack community. We build on top of their work.

- **gstack:** [github.com/garrytan/gstack](https://github.com/garrytan/gstack) — MIT licensed
- **Gas Town:** [github.com/24601/gastown](https://github.com/24601/gastown)
- **Bridge:** [github.com/24601/gastack](https://github.com/24601/gastack) — MIT licensed

## License

MIT
