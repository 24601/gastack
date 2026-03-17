# TODOS

## Browse

### Bundle server.ts into compiled binary

**What:** Eliminate `resolveServerScript()` fallback chain entirely — bundle server.ts into the compiled browse binary.

**Why:** The current fallback chain (check adjacent to cli.ts, check global install) is fragile and caused bugs in v0.3.2. A single compiled binary is simpler and more reliable.

**Context:** Bun's `--compile` flag can bundle multiple entry points. The server is currently resolved at runtime via file path lookup. Bundling it removes the resolution step entirely.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Sessions (isolated browser instances)

**What:** Isolated browser instances with separate cookies/storage/history, addressable by name.

**Why:** Enables parallel testing of different user roles, A/B test verification, and clean auth state management.

**Context:** Requires Playwright browser context isolation. Each session gets its own context with independent cookies/localStorage. Prerequisite for video recording (clean context lifecycle) and auth vault.

**Effort:** L
**Priority:** P3

### Video recording

**What:** Record browser interactions as video (start/stop controls).

**Why:** Video evidence in QA reports and PR bodies. Currently deferred because `recreateContext()` destroys page state.

**Context:** Needs sessions for clean context lifecycle. Playwright supports video recording per context. Also needs WebM → GIF conversion for PR embedding.

**Effort:** M
**Priority:** P3
**Depends on:** Sessions

### v20 encryption format support

**What:** AES-256-GCM support for future Chromium cookie DB versions (currently v10).

**Why:** Future Chromium versions may change encryption format. Proactive support prevents breakage.

**Effort:** S
**Priority:** P3

### State persistence

**What:** Save/load cookies + localStorage to JSON files for reproducible test sessions.

**Why:** Enables "resume where I left off" for QA sessions and repeatable auth states.

**Effort:** M
**Priority:** P3
**Depends on:** Sessions

### Auth vault

**What:** Encrypted credential storage, referenced by name. LLM never sees passwords.

**Why:** Security — currently auth credentials flow through the LLM context. Vault keeps secrets out of the AI's view.

**Effort:** L
**Priority:** P3
**Depends on:** Sessions, state persistence

### Iframe support

**What:** `frame <sel>` and `frame main` commands for cross-frame interaction.

**Why:** Many web apps use iframes (embeds, payment forms, ads). Currently invisible to browse.

**Effort:** M
**Priority:** P4

### Semantic locators

**What:** `find role/label/text/placeholder/testid` with attached actions.

**Why:** More resilient element selection than CSS selectors or ref numbers.

**Effort:** M
**Priority:** P4

### Device emulation presets

**What:** `set device "iPhone 16 Pro"` for mobile/tablet testing.

**Why:** Responsive layout testing without manual viewport resizing.

**Effort:** S
**Priority:** P4

### Network mocking/routing

**What:** Intercept, block, and mock network requests.

**Why:** Test error states, loading states, and offline behavior.

**Effort:** M
**Priority:** P4

### Download handling

**What:** Click-to-download with path control.

**Why:** Test file download flows end-to-end.

**Effort:** S
**Priority:** P4

### Content safety

**What:** `--max-output` truncation, `--allowed-domains` filtering.

**Why:** Prevent context window overflow and restrict navigation to safe domains.

**Effort:** S
**Priority:** P4

### Streaming (WebSocket live preview)

**What:** WebSocket-based live preview for pair browsing sessions.

**Why:** Enables real-time collaboration — human watches AI browse.

**Effort:** L
**Priority:** P4

### CDP mode

**What:** Connect to already-running Chrome/Electron apps via Chrome DevTools Protocol.

**Why:** Test production apps, Electron apps, and existing browser sessions without launching new instances.

**Effort:** M
**Priority:** P4

### Linux/Windows cookie decryption

**What:** GNOME Keyring / kwallet / DPAPI support for non-macOS cookie import.

**Why:** Cross-platform cookie import. Currently macOS-only (Keychain).

**Effort:** L
**Priority:** P4

## Ship

### Ship log — persistent record of /ship runs

**What:** Append structured JSON entry to `.gstack/ship-log.json` at end of every /ship run (version, date, branch, PR URL, review findings, Greptile stats, todos completed, test results).

**Why:** /retro has no structured data about shipping velocity. Ship log enables: PRs-per-week trending, review finding rates, Greptile signal over time, test suite growth.

**Context:** /retro already reads greptile-history.md — same pattern. Eval persistence (eval-store.ts) shows the JSON append pattern exists in the codebase. ~15 lines in ship template.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Post-deploy verification (ship + browse)

**What:** After push, browse staging/preview URL, screenshot key pages, check console for JS errors, compare staging vs prod via snapshot diff. Include verification screenshots in PR body. STOP if critical errors found.

**Why:** Catch deployment-time regressions (JS errors, broken layouts) before merge.

**Context:** Requires S3 upload infrastructure for PR screenshots. Pairs with visual PR annotations.

**Effort:** L
**Priority:** P2
**Depends on:** /setup-gstack-upload, visual PR annotations

### Visual verification with screenshots in PR body

**What:** /ship Step 7.5: screenshot key pages after push, embed in PR body.

**Why:** Visual evidence in PRs. Reviewers see what changed without deploying locally.

**Context:** Part of Phase 3.6. Needs S3 upload for image hosting.

**Effort:** M
**Priority:** P2
**Depends on:** /setup-gstack-upload

## Review

### Inline PR annotations

**What:** /ship and /review post inline review comments at specific file:line locations using `gh api` to create pull request review comments.

**Why:** Line-level annotations are more actionable than top-level comments. The PR thread becomes a line-by-line conversation between Greptile, Claude, and human reviewers.

**Context:** GitHub supports inline review comments via `gh api repos/$REPO/pulls/$PR/reviews`. Pairs naturally with Phase 3.6 visual annotations.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Greptile training feedback export

**What:** Aggregate greptile-history.md into machine-readable JSON summary of false positive patterns, exportable to the Greptile team for model improvement.

**Why:** Closes the feedback loop — Greptile can use FP data to stop making the same mistakes on your codebase.

**Context:** Was a P3 Future Idea. Upgraded to P2 now that greptile-history.md data infrastructure exists. The signal data is already being collected; this just makes it exportable. ~40 lines.

**Effort:** S
**Priority:** P2
**Depends on:** Enough FP data accumulated (10+ entries)

### Visual review with annotated screenshots

**What:** /review Step 4.5: browse PR's preview deploy, annotated screenshots of changed pages, compare against production, check responsive layouts, verify accessibility tree.

**Why:** Visual diff catches layout regressions that code review misses.

**Context:** Part of Phase 3.6. Needs S3 upload for image hosting.

**Effort:** M
**Priority:** P2
**Depends on:** /setup-gstack-upload

## QA

### QA trend tracking

**What:** Compare baseline.json over time, detect regressions across QA runs.

**Why:** Spot quality trends — is the app getting better or worse?

**Context:** `eval:trend` now tracks test-level pass rates (eval infrastructure). QA-run-level trending (health scores over time across QA report files) is a separate feature that could reuse `computeTrends` pattern from `lib/cli-eval.ts`.

**Effort:** S
**Priority:** P2

### CI/CD QA integration

**What:** `/qa` as GitHub Action step, fail PR if health score drops.

**Why:** Automated quality gate in CI. Catch regressions before merge.

**Effort:** M
**Priority:** P2

### Smart default QA tier

**What:** After a few runs, check index.md for user's usual tier pick, skip the AskUserQuestion.

**Why:** Reduces friction for repeat users.

**Effort:** S
**Priority:** P2

### Accessibility audit mode

**What:** `--a11y` flag for focused accessibility testing.

**Why:** Dedicated accessibility testing beyond the general QA checklist.

**Effort:** S
**Priority:** P3

## Retro

### Deployment health tracking (retro + browse)

**What:** Screenshot production state, check perf metrics (page load times), count console errors across key pages, track trends over retro window.

**Why:** Retro should include production health alongside code metrics.

**Context:** Requires browse integration. Screenshots + metrics fed into retro output.

**Effort:** L
**Priority:** P3
**Depends on:** Browse sessions

## Team Sync

### Streaming parser for large session files

**What:** Replace readFileSync with readline/createReadStream for session files >10MB.

**Why:** Currently skip files >10MB. Long sessions (1000+ turns, 35MB) lose enrichment data (tools_used, full turn count).

**Context:** Current 10MB cap is defensive. Session files at `~/.claude/projects/{hash}/{sid}.jsonl` can be 35MB for marathon sessions. Streaming parser removes the cap while keeping memory usage constant.

**Effort:** S
**Priority:** P3
**Depends on:** Transcript sync (Phase 3)

### Session effectiveness scoring

**What:** Compute a 1-5 effectiveness score per session based on turns to achieve goal, tool diversity, whether code was shipped, and session duration.

**Why:** Enables `show sessions --best` and team-level AI effectiveness metrics. Raw data (tools_used, turns, duration, summary) already in Supabase after transcript sync.

**Context:** Year 2 roadmap item. Scoring heuristics need iteration. Could start with: fewer turns = more efficient, more tool diversity = better problem decomposition, shipped code (detected via git) = successful outcome.

**Effort:** M
**Priority:** P2
**Depends on:** Transcript sync (Phase 3)

### ~~Weekly AI usage digest~~ ✓ Shipped in Phase 4

Implemented as `supabase/functions/weekly-digest/index.ts`. pg_cron Monday 9am UTC, aggregates 7-day team data, sends Slack summary.

## Team Dashboard

### Regression alert: include failing test names + dashboard link

**What:** Slack alert message should list the specific tests that regressed and include a direct URL to the dashboard Evals tab.

**Why:** Current alert says "pass rate dropped 89% → 82%" but doesn't say which tests. The person paged has to open the dashboard and hunt. Including test names and a direct link saves 2 minutes of triage.

**Context:** `all_results` array in eval_runs has per-test data. `formatSlackMessage()` in regression-alert/index.ts is the change point. Dashboard URL can be derived from SUPABASE_URL.

**Effort:** S
**Priority:** P2
**Depends on:** Phase 4 (shipped)

### Projected monthly cost annotation on dashboard

**What:** Add "Projected monthly: ~$X" annotation to the cost chart on the dashboard.

**Why:** Everyone wants the monthly number for budgeting. One line of math (last 4 weeks average × 4.33), huge value for finance conversations.

**Context:** `renderVBarChart` or `renderCosts` in dashboard/ui.ts. Data is already fetched.

**Effort:** XS
**Priority:** P3

### Ship notification to Slack

**What:** Post a Slack message when someone ships: "alice shipped v0.4.2 → repo-slug (PR #45)". Reuses existing Slack webhook from team_settings.

**Why:** Real-time team shipping awareness. Currently only regression alerts go to Slack — positive events (ships) should too.

**Context:** Either add to the sync push path in ship/SKILL.md.tmpl or create a new edge function triggered on ship_logs INSERT (same pattern as regression-alert).

**Effort:** S
**Priority:** P2
**Depends on:** Phase 4 (shipped)

### Dynamic favicon based on team pass rate

**What:** Dashboard favicon changes color (green/yellow/red dot) based on current overall eval pass rate. Visible from the browser tab bar without switching to the dashboard tab.

**Why:** Zero-click observability. At a glance from your tab bar, you know if the team is healthy.

**Context:** Canvas → data URL favicon, update on each fetchAll() refresh in dashboard/ui.ts. Green >80%, yellow 50-80%, red <50%.

**Effort:** XS
**Priority:** P3

### Server-side aggregation / materialized views

**What:** Replace client-side data fetching (6 parallel REST calls per refresh) with server-side pre-aggregated views or Supabase materialized views.

**Why:** Current approach pulls up to 100 rows per table per refresh. With 5+ users and 60s refresh, this puts pressure on Supabase request limits. Materialized views would return pre-computed summaries in a single call.

**Context:** Could use Supabase pg_cron to refresh materialized views every 5 minutes. Dashboard would fetch one view instead of 6 tables.

**Effort:** L
**Priority:** P3
**Depends on:** Phase 4 (shipped)

### Real-time SSE streaming on dashboard

**What:** Server-Sent Events stream from a Supabase edge function that pushes updates when new data arrives (eval_runs INSERT, ship_logs INSERT, heartbeats).

**Why:** Dashboard currently polls every 60s. SSE would make it truly real-time — see an eval complete the moment it finishes.

**Context:** Supabase Realtime can be used client-side, or a custom SSE edge function can listen to Postgres NOTIFY. Year 2 roadmap item.

**Effort:** L
**Priority:** P3

### GitHub Check Run integration

**What:** When an eval run is pushed, create a GitHub Check Run on the corresponding commit/PR showing pass rate, regressions, and cost.

**Why:** Eval results become visible directly in the PR review workflow. Regressions can block merge.

**Context:** Requires GitHub App installation or personal access token. Uses GitHub REST API `POST /repos/{owner}/{repo}/check-runs`. Year 2 roadmap item.

**Effort:** L
**Priority:** P3
**Depends on:** Phase 4 (shipped)

### ship_logs index on (team_id, created_at)

**What:** Add composite index `idx_ship_logs_team_date ON ship_logs(team_id, created_at DESC)`.

**Why:** Weekly digest queries `ship_logs WHERE team_id = ? AND created_at >= ?`. Without this index, it table-scans. Low priority because ship_logs volume is small in Year 1, but needed before scale.

**Context:** Add to a new migration 008 or append to 007.

**Effort:** XS
**Priority:** P3

## Infrastructure

### /setup-gstack-upload skill (S3 bucket)

**What:** Configure S3 bucket for image hosting. One-time setup for visual PR annotations.

**Why:** Prerequisite for visual PR annotations in /ship and /review.

**Effort:** M
**Priority:** P2

### gstack-upload helper

**What:** `browse/bin/gstack-upload` — upload file to S3, return public URL.

**Why:** Shared utility for all skills that need to embed images in PRs.

**Effort:** S
**Priority:** P2
**Depends on:** /setup-gstack-upload

### WebM to GIF conversion

**What:** ffmpeg-based WebM → GIF conversion for video evidence in PRs.

**Why:** GitHub PR bodies render GIFs but not WebM. Needed for video recording evidence.

**Effort:** S
**Priority:** P3
**Depends on:** Video recording

### Deploy-verify skill

**What:** Lightweight post-deploy smoke test: hit key URLs, verify 200s, screenshot critical pages, console error check, compare against baseline snapshots. Pass/fail with evidence.

**Why:** Fast post-deploy confidence check, separate from full QA.

**Effort:** M
**Priority:** P2

### GitHub Actions eval upload

**What:** Run eval suite in CI, upload result JSON as artifact, post summary comment on PR.

**Why:** CI integration catches quality regressions before merge and provides persistent eval records per PR.

**Context:** Requires `ANTHROPIC_API_KEY` in CI secrets. Cost is ~$4/run. Eval persistence system (v0.3.6) writes JSON to `~/.gstack-dev/evals/` — CI would upload as GitHub Actions artifacts and use `eval:compare` to post delta comment.

**Effort:** M
**Priority:** P2
**Depends on:** Eval persistence (shipped in v0.3.6)

### E2E model pinning

**What:** Pin E2E tests to claude-sonnet-4-6 for cost efficiency, add retry:2 for flaky LLM responses.

**Why:** Reduce E2E test cost and flakiness.

**Status:** Model pinning shipped (session-runner.ts passes `--model` from `EVAL_TIER` env). Retry:2 still TODO.

**Effort:** XS
**Priority:** P2

### Eval web dashboard

**What:** `bun run eval:dashboard` serves local HTML with charts: cost trending, detection rate, pass/fail history.

**Why:** Visual charts better for spotting trends than CLI tools.

**Context:** Reads `~/.gstack-dev/evals/*.json`. ~200 lines HTML + chart.js via Bun HTTP server.

**Effort:** M
**Priority:** P3
**Depends on:** Eval persistence (shipped in v0.3.6)

### CI/CD QA quality gate

**What:** Run `/qa` as a GitHub Action step, fail PR if health score drops below threshold.

**Why:** Automated quality gate catches regressions before merge. Currently QA is manual — CI integration makes it part of the standard workflow.

**Context:** Requires headless browse binary available in CI. The `/qa` skill already produces `baseline.json` with health scores — CI step would compare against the main branch baseline and fail if score drops. Would need `ANTHROPIC_API_KEY` in CI secrets since `/qa` uses Claude.

**Effort:** M
**Priority:** P2
**Depends on:** None

### CDP-based DOM mutation detection for ref staleness

**What:** Use Chrome DevTools Protocol `DOM.documentUpdated` / MutationObserver events to proactively invalidate stale refs when the DOM changes, without requiring an explicit `snapshot` call.

**Why:** Current ref staleness detection (async count() check) only catches stale refs at action time. CDP mutation detection would proactively warn when refs become stale, preventing the 5-second timeout entirely for SPA re-renders.

**Context:** Parts 1+2 of ref staleness fix (RefEntry metadata + eager validation via count()) are shipped. This is Part 3 — the most ambitious piece. Requires CDP session alongside Playwright, MutationObserver bridge, and careful performance tuning to avoid overhead on every DOM change.

**Effort:** L
**Priority:** P3
**Depends on:** Ref staleness Parts 1+2 (shipped)

## Design Review

### /design-consultation interactive skill — SHIPPED

~~**What:** Interactive skill that walks user through creating a DESIGN.md from scratch.~~

Shipped as `/design-consultation` on garrytan/design branch. Renamed from `/setup-design-md` to reflect the consultant approach (agent proposes a complete coherent system, user adjusts). Includes competitive research via WebSearch, combined font+color preview page, coherence validation, and LLM-judged E2E tests.

## Document-Release

### Auto-invoke /document-release from /ship

**What:** Add Step 8.5 to /ship that reads document-release/SKILL.md and executes the doc update workflow after creating the PR.

**Why:** Zero-friction doc updates — user runs /ship and docs are automatically current. No extra command to remember.

**Context:** /ship currently ends at Step 8 (PR URL output). Step 8.5 would continue into the document-release workflow. Same pattern as /ship calling /review's checklist in Step 3.5.

**Effort:** S
**Priority:** P1
**Depends on:** /document-release shipped

### `{{DOC_VOICE}}` shared resolver

**What:** Create a placeholder resolver in gen-skill-docs.ts encoding the gstack voice guide (friendly, user-forward, lead with benefits). Inject into /ship Step 5, /document-release Step 5, and reference from CLAUDE.md.

**Why:** DRY — voice rules currently live inline in 3 places (CLAUDE.md CHANGELOG style section, /ship Step 5, /document-release Step 5). When the voice evolves, all three drift.

**Context:** Same pattern as `{{QA_METHODOLOGY}}` — shared block injected into multiple templates to prevent drift. ~20 lines in gen-skill-docs.ts.

**Effort:** S
**Priority:** P2
**Depends on:** None

## Completed

### Phase 1: Foundations (v0.2.0)
- Rename to gstack
- Restructure to monorepo layout
- Setup script for skill symlinks
- Snapshot command with ref-based element selection
- Snapshot tests
**Completed:** v0.2.0

### Phase 2: Enhanced Browser (v0.2.0)
- Annotated screenshots, snapshot diffing, dialog handling, file upload
- Cursor-interactive elements, element state checks
- CircularBuffer, async buffer flush, health check
- Playwright error wrapping, useragent fix
- 148 integration tests
**Completed:** v0.2.0

### Phase 3: QA Testing Agent (v0.3.0)
- /qa SKILL.md with 6-phase workflow, 3 modes (full/quick/regression)
- Issue taxonomy, severity classification, exploration checklist
- Report template, health score rubric, framework detection
- wait/console/cookie-import commands, find-browse binary
**Completed:** v0.3.0

### Phase 3.5: Browser Cookie Import (v0.3.x)
- cookie-import-browser command (Chromium cookie DB decryption)
- Cookie picker web UI, /setup-browser-cookies skill
- 18 unit tests, browser registry (Comet, Chrome, Arc, Brave, Edge)
**Completed:** v0.3.1

### E2E test cost tracking
- Track cumulative API spend, warn if over threshold
**Completed:** v0.3.6

### Auto-upgrade mode + smart update check
- Config CLI (`bin/gstack-config`), auto-upgrade via `~/.gstack/config.yaml`, 12h cache TTL, exponential snooze backoff (24h→48h→1wk), "never ask again" option, vendored copy sync on upgrade
**Completed:** v0.3.8
