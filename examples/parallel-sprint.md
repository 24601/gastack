# Parallel Sprint — 10 Workers, One Afternoon

Real example of running 10 parallel Claude Code sessions with gstack, each handling a different part of a product launch.

---

## The Setup

Launching a new feature: team dashboards with real-time activity feeds. One afternoon, 10 parallel workers, each with a clear job.

## The Sprint

| Worker | Skill | Task | Time | Output |
|--------|-------|------|------|--------|
| 1 | `/office-hours` | Refine dashboard requirements | 8 min | Design doc with 3 user personas, priority matrix |
| 2 | `/plan-ceo-review` | Challenge scope — do we need real-time? | 12 min | Verdict: yes, but polling (not WebSocket) for v1 |
| 3 | `/plan-eng-review` | Architecture: data flow, state, API design | 15 min | ASCII diagrams, API contract, test plan |
| 4 | *(implement)* | Build dashboard API endpoints | 22 min | 4 endpoints, 380 lines, 12 tests |
| 5 | *(implement)* | Build dashboard UI components | 18 min | 6 components, 520 lines, responsive |
| 6 | *(implement)* | Build activity feed with polling | 14 min | Feed component, 5s poll interval, optimistic updates |
| 7 | `/review` | Review all three implementation branches | 10 min | 1 critical (XSS in feed), 3 minor, all auto-fixed |
| 8 | `/qa` | QA the merged feature on staging | 15 min | 2 bugs found and fixed, 2 regression tests added |
| 9 | `/cso` | Security audit of new endpoints | 8 min | Clean — no findings above threshold |
| 10 | `/ship` | Final review, changelog, PR | 6 min | PR #247 with 1,400 lines, 22 tests, coverage audit |

**Total wall-clock time: ~45 minutes** (workers 1-3 ran first, 4-6 in parallel after planning, 7-10 in sequence on the merged result).

## What Happened

**Worker 1** (`/office-hours`) pushed back on "team dashboard" and reframed it as "team awareness tool" — the activity feed became the hero feature, not the stats grid. This reframe propagated through all downstream workers because they read the design doc.

**Worker 2** (`/plan-ceo-review`) killed WebSocket for v1. "Polling every 5 seconds is indistinguishable from real-time for a dashboard nobody stares at. Ship polling, measure usage, add WebSocket if someone actually watches it for more than 30 seconds." Saved ~2 days of implementation complexity.

**Worker 7** (`/review`) caught an XSS vulnerability in the activity feed — user-generated content was rendered with `dangerouslySetInnerHTML`. Auto-fixed to sanitized rendering. This would have passed all tests.

**Worker 8** (`/qa`) found that the dashboard crashed when a team had zero activity (empty state not handled) and that the polling created a memory leak when navigating away (interval not cleaned up on unmount). Both fixed with atomic commits and regression tests.

## The Numbers

- **1,400 lines of production code** (35% tests)
- **22 new tests** (including 2 regression tests from QA)
- **1 security vulnerability caught and fixed** before it reached staging
- **2 runtime bugs caught and fixed** by QA
- **45 minutes wall-clock** from "let's build dashboards" to PR ready for merge

## Why This Works

The sprint structure is load-bearing. Without it, 10 parallel agents is 10 sources of chaos — conflicting architectures, duplicate work, inconsistent patterns. With the gstack sprint (think → plan → build → review → test → ship), each agent knows exactly what to do and when to stop.

The CEO review killing WebSocket saved more time than all 10 workers combined would have spent implementing it. The right decision at the top propagates through every downstream step.

---

*This is a representative afternoon. Some days it's 6 workers on 6 different repos. Some days it's 15 workers on one big feature. The pattern is the same: plan first, build in parallel, review and test the merged result.*
