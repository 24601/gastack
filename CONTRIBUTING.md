# Contributing to gstack

Thanks for wanting to make gstack better. Whether you're fixing a typo in a skill prompt or building an entirely new workflow, this guide will get you up and running fast.

## Quick start

gstack skills are Markdown files that Claude Code discovers from a `skills/` directory. Normally they live at `~/.claude/skills/gstack/` (your global install). But when you're developing gstack itself, you want Claude Code to use the skills *in your working tree* — so edits take effect instantly without copying or deploying anything.

That's what dev mode does. It symlinks your repo into the local `.claude/skills/` directory so Claude Code reads skills straight from your checkout.

```bash
git clone <repo> && cd gstack
bun install                    # install dependencies
bin/dev-setup                  # activate dev mode
```

Now edit any `SKILL.md`, invoke it in Claude Code (e.g. `/review`), and see your changes live. When you're done developing:

```bash
bin/dev-teardown               # deactivate — back to your global install
```

## How dev mode works

`bin/dev-setup` creates a `.claude/skills/` directory inside the repo (gitignored) and fills it with symlinks pointing back to your working tree. Claude Code sees the local `skills/` first, so your edits win over the global install.

```
gstack/                          <- your working tree
├── .claude/skills/              <- created by dev-setup (gitignored)
│   ├── gstack -> ../../         <- symlink back to repo root
│   ├── review -> gstack/review
│   ├── ship -> gstack/ship
│   └── ...                      <- one symlink per skill
├── review/
│   └── SKILL.md                 <- edit this, test with /review
├── ship/
│   └── SKILL.md
├── browse/
│   ├── src/                     <- TypeScript source
│   └── dist/                    <- compiled binary (gitignored)
└── ...
```

## Day-to-day workflow

```bash
# 1. Enter dev mode
bin/dev-setup

# 2. Edit a skill
vim review/SKILL.md

# 3. Test it in Claude Code — changes are live
#    > /review

# 4. Editing browse source? Rebuild the binary
bun run build

# 5. Done for the day? Tear down
bin/dev-teardown
```

## Running tests

```bash
bun test                     # Tier 1: browse integration + skill validation (free, <5s)
bun run test:eval            # Tier 3: LLM-as-judge quality evals (needs ANTHROPIC_API_KEY, ~$0.03)
bun run test:e2e             # Tier 2: E2E skill tests via Agent SDK (needs SKILL_E2E=1, ~$0.50)
bun run test:all             # Tier 1 + Tier 2
bun run dev <cmd>            # run CLI in dev mode, e.g. bun run dev goto https://example.com
bun run build                # gen docs + compile binaries
```

**Tier 1** (static validation) runs automatically — it parses every `$B` command in SKILL.md files and validates them against the command registry. **Tier 2** (E2E) spawns real Claude sessions and costs money. **Tier 3** (LLM-as-judge) uses Haiku to score generated docs on clarity/completeness/actionability.

Tests run against the browse binary directly — they don't require dev mode.

## Editing SKILL.md files

SKILL.md files are **generated** from `.tmpl` templates. Don't edit the `.md` directly — your changes will be overwritten on the next build.

```bash
# 1. Edit the template
vim SKILL.md.tmpl              # or browse/SKILL.md.tmpl

# 2. Regenerate
bun run gen:skill-docs

# 3. Check health
bun run skill:check

# Or use watch mode — auto-regenerates on save
bun run dev:skill
```

To add a browse command, add it to `browse/src/commands.ts`. To add a snapshot flag, add it to `SNAPSHOT_FLAGS` in `browse/src/snapshot.ts`. Then rebuild.

## Things to know

- **SKILL.md files are generated.** Edit the `.tmpl` template, not the `.md`. Run `bun run gen:skill-docs` to regenerate.
- **Browse source changes need a rebuild.** If you touch `browse/src/*.ts`, run `bun run build`.
- **Dev mode shadows your global install.** Project-local skills take priority over `~/.claude/skills/gstack`. `bin/dev-teardown` restores the global one.
- **Conductor workspaces are independent.** Each workspace is its own clone. Run `bin/dev-setup` in the one you're working in.
- **`.claude/skills/` is gitignored.** The symlinks never get committed.

## Testing a branch in another repo

When you're developing gstack in one workspace and want to test your branch in a
different project (e.g. testing browse changes against your real app), there are
two cases depending on how gstack is installed in that project.

### Global install only (no `.claude/skills/gstack/` in the project)

Point your global install at the branch:

```bash
cd ~/.claude/skills/gstack
git fetch origin
git checkout origin/<branch>        # e.g. origin/v0.3.2
bun install                         # in case deps changed
bun run build                       # rebuild the binary
```

Now open Claude Code in the other project — it picks up skills from
`~/.claude/skills/` automatically. To go back to main when you're done:

```bash
cd ~/.claude/skills/gstack
git checkout main && git pull
bun run build
```

### Vendored project copy (`.claude/skills/gstack/` checked into the project)

Some projects vendor gstack by copying it into the repo (no `.git` inside the
copy). Project-local skills take priority over global, so you need to update
the vendored copy too. This is a three-step process:

1. **Update your global install to the branch** (so you have the source):
   ```bash
   cd ~/.claude/skills/gstack
   git fetch origin
   git checkout origin/<branch>      # e.g. origin/v0.3.2
   bun install && bun run build
   ```

2. **Replace the vendored copy** in the other project:
   ```bash
   cd /path/to/other-project

   # Remove old skill symlinks and vendored copy
   for s in browse plan-ceo-review plan-eng-review review ship retro qa setup-browser-cookies; do
     rm -f .claude/skills/$s
   done
   rm -rf .claude/skills/gstack

   # Copy from global install (strips .git so it stays vendored)
   cp -Rf ~/.claude/skills/gstack .claude/skills/gstack
   rm -rf .claude/skills/gstack/.git

   # Rebuild binary and re-create skill symlinks
   cd .claude/skills/gstack && ./setup
   ```

3. **Test your changes** — open Claude Code in that project and use the skills.

To revert to main later, repeat steps 1-2 with `git checkout main && git pull`
instead of `git checkout origin/<branch>`.

## Shipping your changes

When you're happy with your skill edits:

```bash
/ship
```

This runs tests, reviews the diff, bumps the version, and opens a PR. See `ship/SKILL.md` for the full workflow.
