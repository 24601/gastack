# Changelog

## 0.3.2 — 2026-03-13

### Fixed
- Cookie import picker now returns JSON instead of HTML — `jsonResponse()` referenced `url` out of scope, crashing every API call
- `help` command routed correctly (was unreachable due to META_COMMANDS dispatch ordering)

### Added
- `help` command — agents can self-discover all commands and snapshot flags
- Version-aware `find-browse` with META signal protocol — detects stale binaries and prompts agents to update
- `browse/dist/find-browse` compiled binary with git SHA comparison against origin/main (4hr cached)
- `.version` file written at build time for binary version tracking
- Route-level tests for cookie picker (13 tests) and find-browse version check (10 tests)

### Changed
- SKILL.md setup checks parse META signals and handle `META:UPDATE_AVAILABLE`
- `jsonResponse`/`errorResponse` use options objects to prevent positional parameter confusion
- Build script compiles both `browse` and `find-browse` binaries, cleans up `.bun-build` temp files

## 0.3.1 — 2026-03-12

### Phase 3.5: Browser cookie import

- `cookie-import-browser` command — decrypt and import cookies from real Chromium browsers (Comet, Chrome, Arc, Brave, Edge)
- Interactive cookie picker web UI served from the browse server (dark theme, two-panel layout, domain search, import/remove)
- Direct CLI import with `--domain` flag for non-interactive use
- `/setup-browser-cookies` skill for Claude Code integration
- macOS Keychain access with async 10s timeout (no event loop blocking)
- Per-browser AES key caching (one Keychain prompt per browser per session)
- DB lock fallback: copies locked cookie DB to /tmp for safe reads
- 18 unit tests with encrypted cookie fixtures

## 0.3.0 — 2026-03-12

### Phase 3: /qa skill — systematic QA testing

- New `/qa` skill with 6-phase workflow (Initialize, Authenticate, Orient, Explore, Document, Wrap up)
- Three modes: full (systematic, 5-10 issues), quick (30-second smoke test), regression (compare against baseline)
- Issue taxonomy: 7 categories, 4 severity levels, per-page exploration checklist
- Structured report template with health score (0-100, weighted across 7 categories)
- Framework detection guidance for Next.js, Rails, WordPress, and SPAs
- `browse/bin/find-browse` — DRY binary discovery using `git rev-parse --show-toplevel`

### Phase 2: Enhanced browser

- Dialog handling: auto-accept/dismiss, dialog buffer, prompt text support
- File upload: `upload <sel> <file1> [file2...]`
- Element state checks: `is visible|hidden|enabled|disabled|checked|editable|focused <sel>`
- Annotated screenshots with ref labels overlaid (`snapshot -a`)
- Snapshot diffing against previous snapshot (`snapshot -D`)
- Cursor-interactive element scan for non-ARIA clickables (`snapshot -C`)
- `wait --networkidle` / `--load` / `--domcontentloaded` flags
- `console --errors` filter (error + warning only)
- `cookie-import <json-file>` with auto-fill domain from page URL
- CircularBuffer O(1) ring buffer for console/network/dialog buffers
- Async buffer flush with Bun.write()
- Health check with page.evaluate + 2s timeout
- Playwright error wrapping — actionable messages for AI agents
- Context recreation preserves cookies/storage/URLs (useragent fix)
- SKILL.md rewritten as QA-oriented playbook with 10 workflow patterns
- 166 integration tests (was ~63)

## 0.0.2 — 2026-03-12

- Fix project-local `/browse` installs — compiled binary now resolves `server.ts` from its own directory instead of assuming a global install exists
- `setup` rebuilds stale binaries (not just missing ones) and exits non-zero if the build fails
- Fix `chain` command swallowing real errors from write commands (e.g. navigation timeout reported as "Unknown meta command")
- Fix unbounded restart loop in CLI when server crashes repeatedly on the same command
- Cap console/network buffers at 50k entries (ring buffer) instead of growing without bound
- Fix disk flush stopping silently after buffer hits the 50k cap
- Fix `ln -snf` in setup to avoid creating nested symlinks on upgrade
- Use `git fetch && git reset --hard` instead of `git pull` for upgrades (handles force-pushes)
- Simplify install: global-first with optional project copy (replaces submodule approach)
- Restructured README: hero, before/after, demo transcript, troubleshooting section
- Six skills (added `/retro`)

## 0.0.1 — 2026-03-11

Initial release.

- Five skills: `/plan-ceo-review`, `/plan-eng-review`, `/review`, `/ship`, `/browse`
- Headless browser CLI with 40+ commands, ref-based interaction, persistent Chromium daemon
- One-command install as Claude Code skills (submodule or global clone)
- `setup` script for binary compilation and skill symlinking
