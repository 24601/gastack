---
name: setup-team-sync
version: 1.0.0
description: |
  Set up team sync with Supabase. Creates .gstack-sync.json if missing,
  authenticates via OAuth, verifies connectivity, and configures sync settings.
  Idempotent — safe to run multiple times. Use before first /ship, /retro, or /qa
  to enable team data sharing.
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Preamble (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
mkdir -p ~/.gstack/sessions
touch ~/.gstack/sessions/"$PPID"
_SESSIONS=$(find ~/.gstack/sessions -mmin -120 -type f 2>/dev/null | wc -l | tr -d ' ')
find ~/.gstack/sessions -mmin +120 -type f -delete 2>/dev/null || true
_CONTRIB=$(~/.claude/skills/gstack/bin/gstack-config get gstack_contributor 2>/dev/null || true)
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
_LAKE_SEEN=$([ -f ~/.gstack/.completeness-intro-seen ] && echo "yes" || echo "no")
echo "LAKE_INTRO: $_LAKE_SEEN"
```

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined). If `JUST_UPGRADED <from> <to>`: tell user "Running gstack v{to} (just updated!)" and continue.

If `LAKE_INTRO` is `no`: Before continuing, introduce the Completeness Principle.
Tell the user: "gstack follows the **Boil the Lake** principle — always do the complete
thing when AI makes the marginal cost near-zero. Read more: https://garryslist.org/posts/boil-the-ocean"
Then offer to open the essay in their default browser:

```bash
open https://garryslist.org/posts/boil-the-ocean
touch ~/.gstack/.completeness-intro-seen
```

Only run `open` if the user says yes. Always run `touch` to mark as seen. This only happens once.

## AskUserQuestion Format

**ALWAYS follow this structure for every AskUserQuestion call:**
1. **Re-ground:** State the project, the current branch (use the `_BRANCH` value printed by the preamble — NOT any branch from conversation history or gitStatus), and the current plan/task. (1-2 sentences)
2. **Simplify:** Explain the problem in plain English a smart 16-year-old could follow. No raw function names, no internal jargon, no implementation details. Use concrete examples and analogies. Say what it DOES, not what it's called.
3. **Recommend:** `RECOMMENDATION: Choose [X] because [one-line reason]` — always prefer the complete option over shortcuts (see Completeness Principle). Include `Completeness: X/10` for each option. Calibration: 10 = complete implementation (all edge cases, full coverage), 7 = covers happy path but skips some edges, 3 = shortcut that defers significant work. If both options are 8+, pick the higher; if one is ≤5, flag it.
4. **Options:** Lettered options: `A) ... B) ... C) ...` — when an option involves effort, show both scales: `(human: ~X / CC: ~Y)`

Assume the user hasn't looked at this window in 20 minutes and doesn't have the code open. If you'd need to read the source to understand your own explanation, it's too complex.

Per-skill instructions may add additional formatting rules on top of this baseline.

## Completeness Principle — Boil the Lake

AI-assisted coding makes the marginal cost of completeness near-zero. When you present options:

- If Option A is the complete implementation (full parity, all edge cases, 100% coverage) and Option B is a shortcut that saves modest effort — **always recommend A**. The delta between 80 lines and 150 lines is meaningless with CC+gstack. "Good enough" is the wrong instinct when "complete" costs minutes more.
- **Lake vs. ocean:** A "lake" is boilable — 100% test coverage for a module, full feature implementation, handling all edge cases, complete error paths. An "ocean" is not — rewriting an entire system from scratch, adding features to dependencies you don't control, multi-quarter platform migrations. Recommend boiling lakes. Flag oceans as out of scope.
- **When estimating effort**, always show both scales: human team time and CC+gstack time. The compression ratio varies by task type — use this reference:

| Task type | Human team | CC+gstack | Compression |
|-----------|-----------|-----------|-------------|
| Boilerplate / scaffolding | 2 days | 15 min | ~100x |
| Test writing | 1 day | 15 min | ~50x |
| Feature implementation | 1 week | 30 min | ~30x |
| Bug fix + regression test | 4 hours | 15 min | ~20x |
| Architecture / design | 2 days | 4 hours | ~5x |
| Research / exploration | 1 day | 3 hours | ~3x |

- This principle applies to test coverage, error handling, documentation, edge cases, and feature completeness. Don't skip the last 10% to "save time" — with AI, that 10% costs seconds.

**Anti-patterns — DON'T do this:**
- BAD: "Choose B — it covers 90% of the value with less code." (If A is only 70 lines more, choose A.)
- BAD: "We can skip edge case handling to save time." (Edge case handling costs minutes with CC.)
- BAD: "Let's defer test coverage to a follow-up PR." (Tests are the cheapest lake to boil.)
- BAD: Quoting only human-team effort: "This would take 2 weeks." (Say: "2 weeks human / ~1 hour CC.")

## Contributor Mode

If `_CONTRIB` is `true`: you are in **contributor mode**. You're a gstack user who also helps make it better.

**At the end of each major workflow step** (not after every single command), reflect on the gstack tooling you used. Rate your experience 0 to 10. If it wasn't a 10, think about why. If there is an obvious, actionable bug OR an insightful, interesting thing that could have been done better by gstack code or skill markdown — file a field report. Maybe our contributor will help make us better!

**Calibration — this is the bar:** For example, `$B js "await fetch(...)"` used to fail with `SyntaxError: await is only valid in async functions` because gstack didn't wrap expressions in async context. Small, but the input was reasonable and gstack should have handled it — that's the kind of thing worth filing. Things less consequential than this, ignore.

**NOT worth filing:** user's app bugs, network errors to user's URL, auth failures on user's site, user's own JS logic bugs.

**To file:** write `~/.gstack/contributor-logs/{slug}.md` with **all sections below** (do not truncate — include every section through the Date/Version footer):

```
# {Title}

Hey gstack team — ran into this while using /{skill-name}:

**What I was trying to do:** {what the user/agent was attempting}
**What happened instead:** {what actually happened}
**My rating:** {0-10} — {one sentence on why it wasn't a 10}

## Steps to reproduce
1. {step}

## Raw output
```
{paste the actual error or unexpected output here}
```

## What would make this a 10
{one sentence: what gstack should have done differently}

**Date:** {YYYY-MM-DD} | **Version:** {gstack version} | **Skill:** /{skill}
```

Slug: lowercase, hyphens, max 60 chars (e.g. `browse-js-no-await`). Skip if file already exists. Max 3 reports per session. File inline and continue — don't stop the workflow. Tell user: "Filed gstack field report: {title}"

# Setup Team Sync

Set up gstack team sync with Supabase. This skill is idempotent — safe to run anytime.

## Steps

### Step 1: Check project config

```bash
cat .gstack-sync.json 2>/dev/null || echo "NOT_FOUND"
```

- If the file exists and has `supabase_url`, `supabase_anon_key`, and `team_slug`: print "Team config found: {team_slug} at {supabase_url}" and skip to Step 3.
- If NOT_FOUND: proceed to Step 2.

### Step 2: Create .gstack-sync.json

Ask the user for three values using AskUserQuestion:

1. **Supabase URL** — e.g., `https://xyzcompany.supabase.co`
   - Found in Supabase Dashboard → Project Settings → API → Project URL
2. **Anon Key** — the public `anon` key (NOT the `service_role` key)
   - Found in Supabase Dashboard → Project Settings → API → Project API keys → `anon` `public`
   - This key is safe to commit — it's public by design (like a Firebase API key). RLS enforces real access control.
3. **Team slug** — a short identifier like `my-team` or `yc-internal`

Then write `.gstack-sync.json`:

```bash
cat > .gstack-sync.json << 'ENDCONFIG'
{
  "supabase_url": "USER_PROVIDED_URL",
  "supabase_anon_key": "USER_PROVIDED_KEY",
  "team_slug": "USER_PROVIDED_SLUG"
}
ENDCONFIG
echo "Created .gstack-sync.json"
```

Tell the user: "Commit this file to your repo so team members get it automatically. The anon key is public by Supabase design — RLS enforces real access control."

### Step 3: Check authentication

```bash
~/.claude/skills/gstack/bin/gstack-sync status 2>&1
```

Look at the output:
- If `Authenticated: yes` → skip to Step 5
- If `Authenticated: no` → proceed to Step 4

### Step 4: Authenticate

```bash
~/.claude/skills/gstack/bin/gstack-sync setup 2>&1
```

This opens a browser for OAuth. Tell the user to complete authentication in their browser. Wait for the output to show "Authenticated as ..." or an error.

If it fails with "Port 54321 is in use", ask the user to close the other process and retry.

### Step 5: Test connectivity

```bash
~/.claude/skills/gstack/bin/gstack-sync test 2>&1
```

This runs a full push + pull test. All 4 steps should show `ok`:
1. Config: ok
2. Auth: ok
3. Push: ok (with latency)
4. Pull: ok (with row count)

If Step 3 (Push) fails, tell the user: "The Supabase migrations may not be applied yet. Copy the SQL files from `supabase/migrations/` and run them in your Supabase SQL editor, in order (001 through 006)."

### Step 6: Configure sync settings

```bash
~/.claude/skills/gstack/bin/gstack-config get sync_enabled 2>/dev/null
~/.claude/skills/gstack/bin/gstack-config get sync_transcripts 2>/dev/null
```

Ask the user if they want to enable transcript sync (opt-in, shares Claude session data with the team):

- If they say yes:
  ```bash
  ~/.claude/skills/gstack/bin/gstack-config set sync_enabled true
  ~/.claude/skills/gstack/bin/gstack-config set sync_transcripts true
  ```

- If they say no (or just want basic sync without transcripts):
  ```bash
  ~/.claude/skills/gstack/bin/gstack-config set sync_enabled true
  ```

### Step 7: Summary

Print a summary:

```
Team sync setup complete!

  Project config: .gstack-sync.json ✓ (commit to repo)
  Authentication: {email} ✓
  Connectivity:   {supabase_url} ✓
  Sync enabled:   yes
  Transcripts:    {yes/no}

Next steps:
  • Run /ship, /retro, or /qa — data syncs automatically
  • View team data: gstack-sync show
  • Check status anytime: gstack-sync status
```
