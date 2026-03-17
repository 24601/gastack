# gstack

**Thirteen opinionated skills that turn Claude Code into a team you can manage.**

Planning is not review. Review is not shipping. Founder taste is not engineering rigor. If you blur all of that together, you get a mediocre blend of all four.

I want explicit gears. I want to tell the model what kind of brain to use right now — founder, eng manager, paranoid reviewer, release machine — and have it commit to that mode completely.

That is what gstack does.

Created by [Garry Tan](https://x.com/garrytan), President & CEO of [Y Combinator](https://www.ycombinator.com/).

| Skill | Mode | What it does |
|-------|------|--------------|
| `/plan-ceo-review` | Founder | Rethink the problem. Find the 10-star product hiding inside the request. |
| `/plan-eng-review` | Eng manager | Lock in architecture, data flow, diagrams, edge cases, and tests. |
| `/plan-design-review` | Senior designer | 80-item design audit with letter grades and AI Slop detection. Report only. |
| `/design-consultation` | Design partner | Build a complete design system from scratch. Knows the landscape, proposes creative risks, generates realistic mockups. |
| `/review` | Staff engineer | Find the bugs that pass CI but blow up in production. Auto-fixes the obvious ones. |
| `/ship` | Release engineer | Sync main, run tests, audit coverage, push, open PR. One command. |
| `/browse` | QA engineer | Give the agent eyes. Real browser, real clicks, real screenshots. ~100ms per command. |
| `/qa` | QA lead | Test your app, find bugs, fix them, re-verify. Generates regression tests for every fix. |
| `/qa-only` | QA reporter | Same testing methodology as /qa but report only — never touches code. |
| `/qa-design-review` | Designer who codes | Same audit as /plan-design-review, then fixes what it finds. Atomic commits, before/after screenshots. |
| `/setup-browser-cookies` | Session manager | Import cookies from your real browser into the headless session. Test authenticated pages. |
| `/retro` | Eng manager | Team-aware weekly retro with per-person breakdowns, metrics, and trends. |
| `/document-release` | Technical writer | Update all project docs to match what you just shipped. |

**[Detailed guides with examples and philosophy for every skill](docs/skills.md)**

## Demo

```
You:   I want to add seller photo upload to the listing app.

You:   /plan-ceo-review

Claude: "Photo upload" is not the feature. The real job is helping sellers
        create listings that actually sell. Here's the 10-star version:
        auto-identify the product, pull specs and comps from the web,
        draft the title and description, suggest the best hero image...

You:   /plan-eng-review

Claude: [Architecture diagram, state machine for upload → classify → enrich
        → draft pipeline, async job boundaries, failure modes, test matrix]

You:   [implement the plan]

You:   /review

Claude: Race condition: two tabs can overwrite cover-photo selection.
        Trust boundary: web data into draft generation = prompt injection.
        [AUTO-FIXED] 2 issues. 1 needs your input.

You:   /ship

Claude: Tests: 42 → 47 (+5 new). PR: github.com/you/app/pull/42

You:   /qa https://staging.myapp.com

Claude: All 3 affected routes working. Upload + enrichment flow passes
        end to end. Regression test generated.

You:   /plan-design-review https://staging.myapp.com

Claude: Design Score: B  |  AI Slop Score: C
        "The site communicates competence but not confidence."
        Top issues: generic typography, AI slop patterns, flat heading scale.
```

## Who this is for

You already use Claude Code and want it to stop being one mushy generic mode. You want the model to have opinions, catch things you would miss, and execute without hand-holding.

This is not a prompt pack for beginners. It is an operating system for people who ship.

## 10 sessions at once

gstack is powerful with one session. It is transformative with ten.

[Conductor](https://conductor.build) runs multiple Claude Code sessions in parallel — each in its own isolated workspace. One session running `/qa` on staging, another doing `/review` on a PR, a third implementing a feature, and seven more on other branches. All at the same time.

Each workspace gets its own isolated browser instance automatically. No port collisions, no shared state, no configuration. One person, ten parallel agents, each with the right cognitive mode. That is a different way of building software.

## Install

**Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Git](https://git-scm.com/), [Bun](https://bun.sh/) v1.0+

### Step 1: Install on your machine

Open Claude Code and paste this. Claude does the rest.

> Install gstack: run `git clone https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup` then add a "gstack" section to CLAUDE.md that says to use the /browse skill from gstack for all web browsing, never use mcp\_\_claude-in-chrome\_\_\* tools, and lists the available skills: /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /review, /ship, /browse, /qa, /qa-only, /qa-design-review, /setup-browser-cookies, /retro, /document-release. Then ask the user if they also want to add gstack to the current project so teammates get it.

### Step 2: Add to your repo so teammates get it (optional)

> Add gstack to this project: run `cp -Rf ~/.claude/skills/gstack .claude/skills/gstack && rm -rf .claude/skills/gstack/.git && cd .claude/skills/gstack && ./setup` then add a "gstack" section to this project's CLAUDE.md that says to use the /browse skill from gstack for all web browsing, never use mcp\_\_claude-in-chrome\_\_\* tools, lists the available skills: /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /review, /ship, /browse, /qa, /qa-only, /qa-design-review, /setup-browser-cookies, /retro, /document-release, and tells Claude that if gstack skills aren't working, run `cd .claude/skills/gstack && ./setup` to build the binary and register skills.

Real files get committed to your repo (not a submodule), so `git clone` just works. The binary and node\_modules are gitignored — teammates run `cd .claude/skills/gstack && ./setup` once to build.

Everything lives inside `.claude/`. Nothing touches your PATH or runs in the background.

---

```
+----------------------------------------------------------------------------+
|                                                                            |
|   Are you a great software engineer who loves to write 10K LOC/day         |
|   and land 10 PRs a day like Garry?                                        |
|                                                                            |
|   Come work at YC: ycombinator.com/software                                |
|                                                                            |
|   Extremely competitive salary and equity.                                 |
|   Now hiring in San Francisco, Dogpatch District.                          |
|   Come join the revolution.                                                |
|                                                                            |
+----------------------------------------------------------------------------+
```

---

## Greptile integration

[Greptile](https://greptile.com) reviews your PRs automatically. gstack triages Greptile's comments as part of `/review` and `/ship` — valid issues get fixed, false positives get pushed back with evidence, already-fixed issues get auto-acknowledged. **[Setup guide](docs/greptile.md)**

## Contributor mode

Turn on contributor mode and gstack files bug reports when something goes wrong. Fork gstack and fix it yourself. **[Guide](docs/contributor-mode.md)**

## Troubleshooting

**Skill not showing up?**
`cd ~/.claude/skills/gstack && ./setup`

**`/browse` fails?**
`cd ~/.claude/skills/gstack && bun install && bun run build`

**Project copy is stale?**
Run `/gstack-upgrade`

**`bun` not installed?**
`curl -fsSL https://bun.sh/install | bash`

## Upgrading

Run `/gstack-upgrade` in Claude Code. Or set `auto_upgrade: true` in `~/.gstack/config.yaml`.

## Uninstalling

> Uninstall gstack: remove the skill symlinks by running `for s in browse plan-ceo-review plan-eng-review plan-design-review design-consultation review ship retro qa qa-only qa-design-review setup-browser-cookies document-release; do rm -f ~/.claude/skills/$s; done` then run `rm -rf ~/.claude/skills/gstack` and remove the gstack section from CLAUDE.md. If this project also has gstack at .claude/skills/gstack, remove it by running `for s in browse plan-ceo-review plan-eng-review plan-design-review design-consultation review ship retro qa qa-only qa-design-review setup-browser-cookies document-release; do rm -f .claude/skills/$s; done && rm -rf .claude/skills/gstack` and remove the gstack section from the project CLAUDE.md too.

## Docs

| Doc | What it covers |
|-----|---------------|
| [Skill Deep Dives](docs/skills.md) | Philosophy, examples, and workflow for every skill |
| [Greptile Integration](docs/greptile.md) | Setup and triage workflow |
| [Contributor Mode](docs/contributor-mode.md) | How to help improve gstack |
| [Browser Reference](BROWSER.md) | Full command reference for `/browse` |
| [Architecture](ARCHITECTURE.md) | Design decisions and system internals |
| [Contributing](CONTRIBUTING.md) | Dev setup, testing, and dev mode |
| [Changelog](CHANGELOG.md) | What's new in every version |

## License

MIT
