# gstack-browse development

## Commands

```bash
bun install          # install dependencies
bun test             # run integration tests (40 tests with fixture server)
bun run dev <cmd>    # run CLI in dev mode, e.g. bun run dev goto https://example.com
bun run build        # compile binary to dist/browse
```

## Deploying to the active skill

The active skill lives at `~/.claude/skills/gstack-browse/`. After making changes:

1. Push your branch
2. Pull in the skill directory: `cd ~/.claude/skills/gstack-browse && git pull`
3. Rebuild: `cd ~/.claude/skills/gstack-browse && bun run build`

Or copy the binary directly: `cp dist/browse ~/.claude/skills/gstack-browse/dist/browse`
