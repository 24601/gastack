# gstack-browse

Fast headless browser for Claude Code. Persistent Chromium daemon with ~100ms commands.

Navigate pages, read content, click elements, fill forms, run JavaScript, take screenshots, inspect CSS/DOM, capture console/network logs. No MCP server, no Chrome extension — just a fast CLI that Claude calls via Bash.

Created by [Garry Tan](https://x.com/garrytan), President & CEO of [Y Combinator](https://www.ycombinator.com/) and founder of [Garry's List](https://garryslist.org).

## Why

Claude Code needs to browse the web — check deployments, read docs, verify UI changes, test forms. Existing options (MCP servers, Chrome extensions) are slow, flaky, or require complex setup.

gstack-browse is different:
- **Fast**: persistent Chromium daemon, ~100ms per command after first call
- **Simple**: single CLI binary, auto-starts on first use, auto-shuts down after 30 min
- **Reliable**: no WebSocket fragility, no extension permissions, just HTTP to a local server
- **Zero config**: clone, build, done

## Install

### Prerequisites

- [Bun](https://bun.sh/) v1.0+

### Option A: Project-level (recommended for teams)

Install into your repo so every contributor gets it automatically:

```bash
cd your-repo
git submodule add https://github.com/garrytan/gstack-browse.git .claude/skills/gstack-browse
cd .claude/skills/gstack-browse
bun install && bun run build
```

Commit the submodule. Anyone who clones your repo gets the skill.

### Option B: User-level (personal)

Install once, available across all your projects:

```bash
git clone https://github.com/garrytan/gstack-browse.git ~/.claude/skills/gstack-browse
cd ~/.claude/skills/gstack-browse
bun install && bun run build
```

### Verify

```bash
# Project-level:
.claude/skills/gstack-browse/dist/browse --help

# User-level:
~/.claude/skills/gstack-browse/dist/browse --help
```

## Teach Claude to use it

Add this to your project's `CLAUDE.md` so Claude knows the skill is available:

````markdown
## Web browsing

Use gstack-browse for all web browsing tasks. It's a fast headless browser CLI.

```bash
# Set the path (project-level install):
B=.claude/skills/gstack-browse/dist/browse
# Or user-level install:
# B=~/.claude/skills/gstack-browse/dist/browse

# Navigate and read
$B goto https://example.com
$B text                          # cleaned page text
$B html "main"                   # innerHTML of element
$B links                         # all links as "text -> href"

# Interact
$B click "button.submit"
$B fill "#email" "test@test.com"
$B select "#country" "US"
$B wait ".loaded"                # wait for element (max 10s)

# Inspect
$B js "document.title"           # run JavaScript
$B css "body" "font-family"      # computed CSS
$B console                       # captured console messages
$B network                       # captured network requests
$B screenshot /tmp/page.png      # take screenshot

# Tabs
$B tabs                          # list open tabs
$B newtab https://other.com      # open new tab
$B tab 2                         # switch to tab

# Multi-step (single call)
echo '[["goto","https://example.com"],["fill","#email","test@test.com"],["click","#submit"]]' | $B chain
```

Navigate once, then query many times — goto loads the page, everything else runs against it instantly.
````

## Quick reference

| Category | Commands |
|----------|----------|
| Navigate | `goto <url>`, `back`, `forward`, `reload`, `url` |
| Read | `text`, `html [sel]`, `links`, `forms`, `accessibility` |
| Interact | `click <sel>`, `fill <sel> <val>`, `select <sel> <val>`, `hover <sel>`, `type <text>`, `press <key>`, `scroll [sel]`, `wait <sel>`, `viewport <WxH>` |
| Inspect | `js <expr>`, `eval <file>`, `css <sel> <prop>`, `attrs <sel>`, `console`, `network`, `cookies`, `storage`, `perf` |
| Visual | `screenshot [path]`, `pdf [path]`, `responsive [prefix]` |
| Compare | `diff <url1> <url2>` |
| Tabs | `tabs`, `tab <id>`, `newtab [url]`, `closetab [id]` |
| Server | `status`, `stop`, `restart` |

See [SKILL.md](SKILL.md) for the full command reference with examples.

## Architecture

```
Claude Code ──Bash──> browse CLI ──HTTP──> Bun server ──Playwright──> Chromium
                         |                     |
                    thin client           persistent daemon
                  (sends commands)      (port 9400-9410, auto-start,
                                         30 min idle shutdown)
```

- CLI reads `/tmp/browse-server.json` for server port + auth token
- If no server running, CLI auto-starts one in the background (~3s)
- All commands go over HTTP POST with bearer token auth
- Chromium crash or idle timeout kills the server; next CLI call restarts it

## Development

```bash
bun install              # install dependencies
bun test                 # run 40 integration tests
bun run dev <cmd>        # run CLI without compiling
bun run build            # compile to dist/browse
```

## License

MIT
