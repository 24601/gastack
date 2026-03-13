# Developing gstack

How to test gstack skills from within the gstack repo itself.

## The problem

Claude Code discovers skills from `.claude/skills/` (project-local) or `~/.claude/skills/` (global). When developing gstack, you want to edit a SKILL.md and test it immediately — without copying files or deploying to the global install.

## Dev mode

```bash
bin/dev-setup      # activate — skills resolve from this working tree
bin/dev-teardown   # deactivate — back to global install
```

### What `bin/dev-setup` does

1. Creates `.claude/skills/` inside the repo (gitignored)
2. Symlinks `.claude/skills/gstack` → repo root
3. Runs `./setup` which:
   - Builds the browse binary (if needed)
   - Creates individual skill symlinks: `.claude/skills/review` → `.claude/skills/gstack/review`, etc.

After this, Claude Code in this directory discovers skills from your working tree. Edit `review/SKILL.md`, run `/review` — changes take effect immediately.

### What `bin/dev-teardown` does

Removes all symlinks under `.claude/skills/` and cleans up the directory. Your global install (`~/.claude/skills/gstack`) becomes active again.

## Directory structure in dev mode

```
gstack/                          ← your working tree (repo root)
├── .claude/                     ← gitignored
│   └── skills/
│       ├── gstack → ../../      ← symlink back to repo root
│       ├── review → gstack/review
│       ├── ship → gstack/ship
│       ├── browse → gstack/browse
│       ├── qa → gstack/qa
│       ├── retro → gstack/retro
│       ├── plan-ceo-review → gstack/plan-ceo-review
│       ├── plan-eng-review → gstack/plan-eng-review
│       └── setup-browser-cookies → gstack/setup-browser-cookies
├── review/
│   ├── SKILL.md                 ← edit this, test with /review
│   ├── checklist.md
│   └── greptile-triage.md
├── ship/
│   └── SKILL.md
├── browse/
│   ├── SKILL.md
│   ├── src/                     ← TypeScript source
│   └── dist/                    ← compiled binary (gitignored)
└── ...
```

## Workflow

```bash
# 1. Start dev mode
bin/dev-setup

# 2. Edit a skill
vim review/SKILL.md

# 3. Test it — Claude Code picks up changes immediately
#    (in Claude Code): /review

# 4. Edit browse source? Rebuild the binary
bun run build

# 5. Done developing? Tear down
bin/dev-teardown
```

## Gotchas

- **Project-local skills override global.** While dev mode is active, the global install at `~/.claude/skills/gstack` is shadowed. `bin/dev-teardown` restores it.
- **Browse binary changes need a rebuild.** SKILL.md changes are instant (they're just Markdown). But if you edit `browse/src/*.ts`, run `bun run build` to recompile.
- **`.claude/` is gitignored.** The dev symlinks never get committed. This is intentional.
- **Conductor workspaces.** Each Conductor workspace is an independent clone. Run `bin/dev-setup` in the workspace you're developing in. Other workspaces are unaffected.
- **Don't mix dev and global.** If you have dev mode active and also update the global install, the project-local one wins. Tear down first if you want to test the global install.

## Running tests

```bash
bun test                     # all tests (browse integration + snapshot)
bun run dev <cmd>            # run CLI in dev mode, e.g. bun run dev goto https://example.com
bun run build                # compile binary to browse/dist/browse
```

Tests don't require dev mode — they test the browse binary directly, not the skill prompts.
