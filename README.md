# gstack

**Garry's Stack — the AI engineering toolkit that Claude Code deserves.** Browser automation, workflow skills, and more. One repo, one install. No MCP. No Chrome extension. No bullshit.

Created by [Garry Tan](https://x.com/garrytan), President & CEO of [Y Combinator](https://www.ycombinator.com/).

## What's in the box

### Browser (`browse`)
Persistent headless Chromium daemon with ~100ms commands. Navigate, click, fill forms, take screenshots, run JavaScript, inspect CSS/DOM, capture console/network logs. The killer feature: **ref-based element selection** via accessibility tree snapshots.

### Skills
- **ship** — merge, test, review, bump version, changelog, commit, push, PR
- **review** — pre-landing PR review with structural analysis
- **plan-exit-review** — thorough plan review before implementation
- **plan-mega-review** — the most rigorous plan review possible (3 modes)
- **retro** — weekly engineering retrospective with trend tracking

## The Problem

Claude Code needs to browse the web. Check a deployment. Verify a UI change. Read documentation. Fill out a form. Take a screenshot. Simple stuff.

The existing solutions are all terrible:

### Why Chrome MCP sucks

Chrome MCP (the "Claude in Chrome" integration) is the default browser tool in Claude Code. It is painfully slow and unreliable. Every tool call dumps a massive JSON schema into your context window. The Chrome extension loses connection randomly. Screenshots take 5+ seconds. Multi-step flows fail halfway through because the WebSocket dropped. Half the time it can't even find the tab you're looking at. And every single call bloats your context with MCP protocol overhead that has nothing to do with your actual task.

If you've used it, you know. It's the tool you learn to avoid.

### Why MCP itself is the problem for local tools

MCP is a well-intentioned standard that adds a layer of complexity between the AI and the tool. For browser automation, that layer is pure overhead:

- **Context bloat**: Every MCP tool call includes full JSON schemas, capability declarations, and protocol framing. A simple "get the page text" costs 10x more context tokens than it should.
- **Connection fragility**: MCP uses persistent connections (WebSocket/stdio). Connections drop. Reconnection is unreliable.
- **Unnecessary abstraction**: The AI agent is *already running in a shell*. It can already call CLI tools via Bash. MCP adds a client-server protocol on top of... calling a local process.

**The insight**: Claude Code already has `Bash`. A CLI tool that prints to stdout is the simplest, fastest, most reliable interface possible. No protocol overhead. No connection management. No schema bloat. Just input and output.

## The Solution

A CLI that talks to a persistent local Chromium daemon via HTTP. That's it.

```
Claude Code ──Bash──> browse CLI ──HTTP──> Bun server ──Playwright──> Chromium
                         |                     |
                    compiled binary       persistent daemon
                     (~1ms startup)      (port 9400, auto-start,
                                          30 min idle shutdown)
```

**First call**: CLI auto-starts the Chromium daemon (~3 seconds). You never think about it.

**Every call after that**: ~100-200ms. The browser is already running. The page is already loaded. You're just querying it.

**No MCP**: Zero protocol overhead. Zero context bloat. The CLI prints plain text to stdout. Claude reads it. Done.

**No Chrome extension**: No permissions dialogs. No "extension not responding." No WebSocket reconnection prayer circles.

**Crash recovery**: If Chromium crashes, the server exits. Next CLI call auto-starts a fresh one. No stale state.

## What it can do

40+ commands covering everything Claude Code needs:

```bash
B=~/.claude/skills/gstack/browse/dist/browse

# Navigate and read pages
$B goto https://yourapp.com
$B text                              # cleaned page text (no scripts/styles)
$B html "main"                       # innerHTML of any element
$B links                             # all links as "text -> href"
$B forms                             # all forms + fields as structured JSON
$B accessibility                     # full ARIA tree

# Snapshot: accessibility tree with refs for interaction
$B snapshot -i                       # interactive elements only
# Output:
#   @e1 [link] "Home"
#   @e2 [textbox] "Email"
#   @e3 [button] "Submit"

# Interact by ref (after snapshot)
$B fill @e2 "test@test.com"
$B click @e3

# Or interact by CSS selector
$B click "button.submit"
$B fill "#email" "test@test.com"
$B select "#country" "US"
$B type "search query"
$B press "Enter"
$B wait ".loaded"                    # wait for element (max 10s)

# Inspect everything
$B js "document.title"               # run any JavaScript
$B css "body" "font-family"          # computed CSS properties
$B attrs "nav"                       # element attributes as JSON
$B console                           # captured console.log/warn/error
$B network                           # every HTTP request with status/timing/size
$B cookies                           # all cookies as JSON
$B storage                           # localStorage + sessionStorage
$B perf                              # page load performance timings

# Visual verification
$B screenshot /tmp/page.png          # screenshot (Claude can read images)
$B responsive /tmp/layout            # 3 screenshots: mobile, tablet, desktop
$B pdf /tmp/page.pdf                 # save as PDF

# Compare pages
$B diff https://prod.app https://staging.app   # text diff between two URLs

# Multi-step flows (single call)
echo '[
  ["goto", "https://app.com/login"],
  ["snapshot", "-i"],
  ["fill", "@e2", "user@test.com"],
  ["fill", "@e3", "secret"],
  ["click", "@e4"],
  ["wait", ".dashboard"],
  ["screenshot", "/tmp/logged-in.png"]
]' | $B chain

# Multi-tab browsing
$B newtab https://docs.example.com
$B tabs                              # list all tabs
$B tab 1                             # switch back to first tab

# Server management
$B status                            # health, uptime, tab count
$B stop                              # shut down (or just let it idle-timeout)
```

The browser **persists between calls**. Navigate once, then query as many times as you want. Cookies, tabs, localStorage all carry over.

## Install

### 1. Add gstack to your project

```bash
# Project-level (teams — committed to repo):
git submodule add https://github.com/garrytan/gstack.git .claude/skills/gstack

# Or user-level (personal — available everywhere):
git clone https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
```

### 2. Add to your CLAUDE.md (required)

Paste this into your project's `CLAUDE.md`:

````markdown
## Browser
Use gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.
````

### 3. Done

First time Claude needs the browser, it will ask to run a 10-second one-time setup. Say yes. All skills are available from then on.

**Prerequisite**: [Bun](https://bun.sh/) v1.0+ (Claude will tell you if it's missing).

### Update

```bash
cd .claude/skills/gstack && git pull && ./setup
```

### Worktrees

New worktrees need `git submodule update --init .claude/skills/gstack` to populate the directory. Claude's auto-setup handles this — it detects an empty submodule and runs the init for you.

## Command Reference

| Category | Commands |
|----------|----------|
| Navigate | `goto <url>`, `back`, `forward`, `reload`, `url` |
| Read | `text`, `html [sel]`, `links`, `forms`, `accessibility` |
| Snapshot | `snapshot [-i] [-c] [-d N] [-s sel]` |
| Interact | `click <sel>`, `fill <sel> <val>`, `select <sel> <val>`, `hover <sel>`, `type <text>`, `press <key>`, `scroll [sel]`, `wait <sel>`, `viewport <WxH>` |
| Inspect | `js <expr>`, `eval <file>`, `css <sel> <prop>`, `attrs <sel>`, `console`, `network`, `cookies`, `storage`, `perf` |
| Visual | `screenshot [path]`, `pdf [path]`, `responsive [prefix]` |
| Compare | `diff <url1> <url2>` |
| Tabs | `tabs`, `tab <id>`, `newtab [url]`, `closetab [id]` |
| Multi-step | `chain` (reads JSON array from stdin) |
| Server | `status`, `stop`, `restart` |

All commands that take `<sel>` accept either CSS selectors or `@ref` after `snapshot`.

## Architecture

```
gstack/
├── browse/          # Browser CLI (Playwright)
│   ├── src/         # CLI + server + commands + snapshot
│   ├── test/        # Integration tests + fixtures
│   └── dist/        # Compiled binary (~58MB)
├── ship/            # Ship workflow skill
├── review/          # PR review skill
├── plan-exit-review/# Plan review skill
├── plan-mega-review/# Mega plan review skill
├── retro/           # Retrospective skill
├── setup            # One-time setup: build + symlink skills
└── SKILL.md         # Browse skill (Claude discovers this)
```

- **Compiled CLI binary** (Bun `--compile`) — ~1ms startup
- **Persistent Bun HTTP server** — launches headless Chromium via Playwright, localhost:9400-9410
- **Bearer token auth** — random UUID per session, stored in state file (chmod 600)
- **Console/network buffers** — all entries in memory, flushed to `/tmp/browse-*.log` every 1s
- **Auto-idle shutdown** — 30 minutes (configurable via `BROWSE_IDLE_TIMEOUT`)
- **Crash handling** — Chromium crash kills server, CLI auto-restarts on next command

### Multi-workspace support

Each workspace gets its own isolated browser instance. If `CONDUCTOR_PORT` is set (e.g., by [Conductor](https://conductor.dev)), the browse port is derived deterministically:

```
browse_port = CONDUCTOR_PORT - 45600
```

| Workspace | CONDUCTOR_PORT | Browse port | State file |
|-----------|---------------|-------------|------------|
| Workspace A | 55040 | 9440 | `/tmp/browse-server-9440.json` |
| Workspace B | 55041 | 9441 | `/tmp/browse-server-9441.json` |
| No Conductor | — | 9400 (scan) | `/tmp/browse-server.json` |

Each instance has its own Chromium process, tabs, cookies, console/network logs. No cross-workspace interference. You can also set `BROWSE_PORT` directly if you're not using Conductor.

## Performance comparison

| Tool | First call | Subsequent calls | Context overhead per call |
|------|-----------|-----------------|--------------------------
| Chrome MCP | ~5s | ~2-5s | ~2000 tokens (schema + protocol) |
| Playwright MCP | ~3s | ~1-3s | ~1500 tokens (schema + protocol) |
| **gstack** | **~3s** | **~100-200ms** | **0 tokens** (plain text stdout) |

The context overhead difference compounds fast. In a 20-command browser session, MCP tools burn 30,000-40,000 tokens on protocol framing alone. gstack burns zero.

## Development

```bash
bun install              # install dependencies
bun test                 # run 55 integration tests (~3s)
bun run dev <cmd>        # run CLI from source (no compile)
bun run build            # compile to browse/dist/browse
```

## License

MIT
