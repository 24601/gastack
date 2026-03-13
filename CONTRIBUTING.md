# Contributing to gstack

Thanks for wanting to make gstack better. Whether you're fixing a typo in a skill prompt or building an entirely new workflow, this guide will get you up and running fast.

## Quick start

```bash
bin/dev-setup      # activate dev mode — skills resolve from your working tree
```

That's it. Edit any `SKILL.md`, run the skill in Claude Code (e.g. `/review`), and your changes take effect immediately. No copying, no deploying, no restarting.

When you're done:

```bash
bin/dev-teardown   # deactivate — back to your global install
```

## How dev mode works

Claude Code discovers skills from `.claude/skills/` (project-local) or `~/.claude/skills/` (global). `bin/dev-setup` creates a local `.claude/skills/` with symlinks pointing back to your working tree, so Claude Code picks up your edits live.

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
bun test                     # all tests (browse integration + snapshot)
bun run dev <cmd>            # run CLI in dev mode, e.g. bun run dev goto https://example.com
bun run build                # compile binary to browse/dist/browse
```

Tests run against the browse binary directly — they don't require dev mode.

## Things to know

- **SKILL.md changes are instant.** They're just Markdown. Edit, save, invoke.
- **Browse source changes need a rebuild.** If you touch `browse/src/*.ts`, run `bun run build`.
- **Dev mode shadows your global install.** Project-local skills take priority over `~/.claude/skills/gstack`. `bin/dev-teardown` restores the global one.
- **Conductor workspaces are independent.** Each workspace is its own clone. Run `bin/dev-setup` in the one you're working in.
- **`.claude/skills/` is gitignored.** The symlinks never get committed.

## Shipping your changes

When you're happy with your skill edits:

```bash
/ship
```

This runs tests, reviews the diff, bumps the version, and opens a PR. See `ship/SKILL.md` for the full workflow.
