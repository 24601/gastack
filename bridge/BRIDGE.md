# The Bridge: gstack ↔ gastown

The bridge maps **gstack's opinionated wisdom** (what to build, how to review,
what quality means) to **gastown's execution power** (parallel autonomous agents,
convoys, merge queues) and back.

gstack encodes the intent. gastown executes it. The bridge translates between them.

## Three Commands

Everything starts and ends with three slash commands:

| Command | Direction | What it does |
|---------|-----------|-------------|
| `/dispatch` | gstack → gastown | Take a design doc, extract tasks, create beads, dispatch a convoy of polecats |
| `/convoy-status` | monitoring | Check what's running, find stranded convoys, surface approval gates |
| `/collect` | gastown → gstack | Gather results, run Review Army + CSO + health, merge or escalate |

### Example workflow

```
You: /dispatch docs/designs/auth-system.md
  → Extracts 8 tasks, creates beads, dispatches convoy cv-abc123
  → "Monitor with /convoy-status, collect with /collect when done"

You: /convoy-status
  → Shows 6/8 beads complete, 2 in progress, no stalls

You: /collect
  → Runs Review Army (7 specialists), CSO scan, health check
  → Grade: B+, Health: 8/10, 1 MINOR security finding
  → Merged via pre-verified fast-path (5s)
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Slash Commands                  │
│         /dispatch  /collect  /convoy-status      │
├─────────────────────────────────────────────────┤
│               Bridge Orchestrator                │
│     7-stage event-sourced state machine          │
│  PLAN → EXECUTE → REVIEW → REFINE → DEPLOY →   │
│              VERIFY → DONE                       │
├──────────────────┬──────────────────────────────┤
│  gstack Adapter  │     gastown Adapter           │
│  claude -p       │     gt CLI (Bun.spawn)        │
│  /review /cso    │     convoy, sling, mountain   │
│  /health /learn  │     beads, mail, patrol       │
├──────────────────┴──────────────────────────────┤
│              Event Log (JSONL)                    │
│  Event-sourced state — replay to recover         │
└─────────────────────────────────────────────────┘
```

### Key design principles

- **Event-sourced**: All state derives from an append-only JSONL log. Crash at any
  point, replay events, continue from exactly where you left off.
- **Idempotent**: Every external call is cached by `(adapter, command, args)` hash.
  Safe to retry sessions without duplicate beads or convoys.
- **Adapter pattern**: gstack and gastown plug in via the `Adapter` interface.
  Each adapter translates bridge commands to CLI calls.
- **Identity-safe**: Sensitive env vars (API keys, identity tokens) are stripped
  from child processes. Agents get identity via hooks, not env leakage.

## The 7 Stages

| Stage | What happens | Adapter |
|-------|-------------|---------|
| **PLAN** | Extract tasks from design doc (regex + LLM reconciliation). Detect target branch. Classify priorities (P0 security, P1 fixes, P2 features). | gstack |
| **EXECUTE** | Create beads, dispatch convoy/mountain. Monitor for completion via `convoy.watch`. Handle death events (retry → investigate → halt). | gastown |
| **REVIEW** | Run Review Army (7 specialists), CSO security scan, health check. Route: inline for small diffs, review-only polecat for large/sensitive changes. | gstack + gastown |
| **REFINE** | If REVIEW blocked with fixable findings: create fix tasks, re-dispatch, re-review. Max 3 iterations before human escalation. | gastown |
| **DEPLOY** | Push branch, submit to merge queue. PASS → pre-verified fast-path (5s). BLOCKED → quarantine on branch. | gastown |
| **VERIFY** | Run canary/smoke tests on merged code. Failure loops back to REFINE. | gstack |
| **DONE** | Terminal state. Session complete. | — |

## Quality Gates

Three gates evaluated in `/collect`:

| Gate | PASS | WARN | BLOCKED |
|------|------|------|---------|
| **Correctness** (Review Army) | Grade ≥ C | Minor findings with passing grade | Grade < C or CRITICAL findings |
| **Security** (CSO) | No findings | MINOR severity | CRITICAL or MAJOR severity |
| **Health** (/health) | Score ≥ 7/10 | Score 4-6/10 | Score < 4/10 |

Overall: BLOCKED if any gate blocked, WARN if any warns, PASS otherwise.

### Review Army Specialists

7 parallel specialists with adaptive gating:

| Specialist | Focus | Exempt from gating? |
|-----------|-------|-------------------|
| Security | Auth, injection, crypto, secrets, XSS | Yes (insurance) |
| Performance | Queries, caching, rendering, memory | No |
| Testing | Coverage gaps, untested paths, fixtures | No |
| Data Migration | Migration safety, rollback, data integrity | Yes (insurance) |
| Maintainability | Complexity, readability, tech debt | No |
| API Contract | Breaking changes, versioning, deprecation | No |
| Red Team | Adversarial thinking, edge cases, attack surface | No |

**Adaptive gating**: After 10 consecutive zero-finding runs, a specialist is
auto-skipped (except security and data-migration). Finding something un-gates it.

**Finding dedup**: Same finding from multiple specialists → keep highest severity.
Fingerprint-based matching prevents duplicate noise.

## Multi-Model Review

The bridge uses two model families for genuine independent review:

- **Primary** (default: claude) — authors the code during EXECUTE
- **Review** (default: codex/GPT-5.4) — independently reviews during REVIEW

This is gstack's "20th dentist" philosophy: two models disagreeing is signal, not noise.

## Failure Handling

Death events from gastown follow a three-level response:

1. **Auto-retry** (first failure) — transient crash, OOM, network blip
2. **Investigate** (repeated failure) — `/investigate` Iron Law: no fixes without root cause
3. **Halt** (mass death or systemic) — stop all dispatch, surface to human

**Rate-limit watchdog**: gastown's rate-limit-watchdog plugin auto-detects API 429s
and halts dispatch. Bridge surfaces this as an approval gate.

**Scope expansion**: When a polecat requests scope expansion, bridge intercepts
the mail and creates an approval gate. Human decides via `approve/reject`.

## Configuration

Bridge config lives in `bridge.json` in the project root:

```json
{
  "multiModel": {
    "enabled": true,
    "primary": "claude",
    "review": "codex",
    "maxReviewIterations": 3,
    "reviewMode": "quick"
  },
  "gastown": {
    "effortIdle": "abbreviated",
    "useConvoyWatch": true,
    "requireReview": {},
    "scopeExpansionApproval": true,
    "preVerifiedMerge": true
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `multiModel.enabled` | `true` | Use different model for review vs authoring |
| `multiModel.reviewMode` | `"quick"` | `"quick"` (headless) or `"deep"` (full workspace) |
| `multiModel.maxReviewIterations` | `3` | Review-fix-rereview loop limit |
| `gastown.effortIdle` | `"abbreviated"` | Idle patrol effort level (90% cost savings) |
| `gastown.useConvoyWatch` | `true` | Push notifications vs polling for completion |
| `gastown.preVerifiedMerge` | `true` | 5s fast-path merge when all gates pass |
| `gastown.scopeExpansionApproval` | `true` | Intercept polecat scope expansion requests |

## Event Schema (17 events)

The bridge uses 17 event types in its JSONL log:

**Session lifecycle** (1-2): `SESSION_CREATED`, `SESSION_RESUMED`
**Stage transitions** (3-4): `STAGE_ENTERED`, `STAGE_COMPLETED`
**Task execution** (5-8): `TASK_QUEUED`, `TASK_STARTED`, `TASK_COMPLETED`, `TASK_FAILED`
**External calls** (9-10): `EXTERNAL_CALL_INITIATED`, `EXTERNAL_CALL_COMPLETED`
**Approvals** (11-12): `APPROVAL_REQUESTED`, `APPROVAL_DECISION`
**Terminal** (13): `SESSION_COMPLETED`
**B2 extensions** (14-17): `CHECKPOINT_SAVED`, `RATE_LIMIT_DETECTED`, `SCOPE_EXPANSION_REQUESTED`, `SPECIALIST_GATING_UPDATED`

All events are additive — old logs remain compatible when new types are added.

## File Map

```
bridge/
├── cli.ts                    # CLI entry: start, status, list, watch, approve, reject
├── orchestrate.ts            # 7-stage state machine with event sourcing
├── events.ts                 # 17-event schema, EventLog class, corruption repair
├── dispatch.ts               # Priority sorting, convoy/mountain dispatch
├── config.ts                 # BridgeConfig (multi-model + gastown)
├── quality.ts                # Quality gates: correctness, security, health
├── specialist-gating.ts      # Adaptive specialist gating + finding dedup
├── task-extract.ts           # Regex task extraction from design docs
├── extract.ts                # LLM extraction + reconciliation
├── output.ts                 # Adaptive output calibration
├── stranded.ts               # Convoy diagnosis
├── notify.ts                 # Slack/Discord webhooks
├── adapters/
│   ├── gstack.ts             # claude -p, review/cso/health/investigate parsing
│   └── gastown.ts            # gt CLI wrapper, event tailer, identity sanitization
├── test/                     # 700+ tests, all gate-tier (no network)
└── BRIDGE.md                 # This file
```
