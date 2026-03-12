# gstack development

## Commands

```bash
bun install          # install dependencies
bun test             # run integration tests (browse + snapshot)
bun run dev <cmd>    # run CLI in dev mode, e.g. bun run dev goto https://example.com
bun run build        # compile binary to browse/dist/browse
```

## Project structure

```
gstack/
├── browse/          # Headless browser CLI (Playwright)
│   ├── src/         # CLI + server + commands
│   ├── test/        # Integration tests + fixtures
│   └── dist/        # Compiled binary
├── ship/            # Ship workflow skill
├── review/          # PR review skill
├── plan-exit-review/# Plan review skill
├── plan-mega-review/# Mega plan review skill
├── retro/           # Retrospective skill
├── setup            # One-time setup: build binary + symlink skills
├── SKILL.md         # Browse skill (Claude discovers this)
└── package.json     # Build scripts for browse
```

## Deploying to the active skill

The active skill lives at `~/.claude/skills/gstack/`. After making changes:

1. Push your branch
2. Pull in the skill directory: `cd ~/.claude/skills/gstack && git pull`
3. Rebuild: `cd ~/.claude/skills/gstack && bun run build`

Or copy the binary directly: `cp browse/dist/browse ~/.claude/skills/gstack/browse/dist/browse`
