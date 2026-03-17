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
```

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined). If `JUST_UPGRADED <from> <to>`: tell user "Running gstack v{to} (just updated!)" and continue.

## AskUserQuestion Format

**ALWAYS follow this structure for every AskUserQuestion call:**
1. Context: project name, current branch, what we're working on (1-2 sentences)
2. The specific question or decision point
3. `RECOMMENDATION: Choose [X] because [one-line reason]`
4. Lettered options: `A) ... B) ... C) ...`

If `_SESSIONS` is 3 or more: the user is juggling multiple gstack sessions and context-switching heavily. **ELI16 mode** — they may not remember what this conversation is about. Every AskUserQuestion MUST re-ground them: state the project, the branch, the current plan/task, then the specific problem, THEN the recommendation and options. Be extra clear and self-contained — assume they haven't looked at this window in 20 minutes.

Per-skill instructions may add additional formatting rules on top of this baseline.

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
