# claude-mode

Mods for **Claude Code**: the Code tab of the desktop app and the terminal. Each mod is its own folder — install only the ones you want.

[Русская версия →](README.ru.md)

| | Mod | What it gives you | Where | Command | Network |
| --- | --- | --- | --- | --- | --- |
| 📊 | [**usage-band**](en/usage-band) | Context fill, memory files, subscription limits (5 hours and week), response speed and a prompt-cache timer | Band above the prompt | — | no |
| 🗺️ | [**roadmap**](en/roadmap) | Stages of the current task: context → work → checks → tests → push → deploy, plus Claude's plan | “Roadmap” pane or a band under the chat | `/roadmap` | no |
| 🌿 | [**git-branches**](en/git-branches) | Branches, sync with the remote, GitHub pull requests and commits, GitLens-style | “Branches” pane | `/branches` | `gh`, `git fetch` |
| 🧭 | [**context-inspector**](en/context-inspector) | What fills the context window and what you can free | “Context” pane | `/inspector` | no |
| 🎛️ | [**command-deck**](en/command-deck) | The main slash commands with a one-line why and one-click run | “Commands” pane | `/deck` | no |
| ➡️ | [**next-steps**](en/next-steps) | The session goal, what Claude is waiting on from you, and 2–3 next prompts as buttons; a click drafts one | Line above the prompt | `/next` | Haiku via Claude Code |
| ⚡ | [**token-speed**](en/token-speed) | *Superseded by usage-band's SPEED column — don't install both* | Status line | — | no |

Every mod comes in English ([`en/`](en)) and Russian ([`ru/`](ru)). Pick one language per mod: both versions share the same name.

All panes share one style: a header with the main fact and quiet icon buttons, sections as cards with a colored icon and a count, and color only where it means something (green done, yellow waiting, red error, blue now).

## What it looks like

**usage-band** — above the prompt:

```
CONTEXT                    MEMORY                  5 HOURS
42% ━━━━──── 84k/200k      2 files ~2k tok.        24% ━━────── ↻ 2h 15 min

WEEK                       SPEED                   CACHE
91% ━━━━━━━─ ↻ 3d 4h       52 tok/s ▂▄▆▅▇ 3,400 tok 42 min ━━━───── of 1h
```

**roadmap** — the “Roadmap” pane:

```
build the login page                                  ↺  ⤓
Claude is working · stage 3 of 4 · 6 min

◉ STAGES                                            2/4
  ✓ Context                                        1 min
  ✓ Implementation                                 4 min
  │ 3 files: login.tsx, api.ts, styles.css
  ● Tests                                         <1 min
  ○ Push

☰ PLAN                                              2/5
  ✓ 2 steps done
  ● Wire up the API
```

**git-branches** — the “Branches” pane:

```
⎇ acme/site · main                                  ↻  ⇣
 ↑2 unpushed   ✎ 3 changes   updated just now

⎇ BRANCHES                                            2
  feature/login                       ↓5  #12   AN   2d
⇄ PULL REQUESTS                                       1
  #12 Login page                           approved  ✓
◉ COMMITS                                             8
  a1b2c3d fix: header                            IP   3h
```

**context-inspector** — the “Context” pane:

```
Context 42%                                           ↻
84k of 200k tokens · updated just now
████████▓▓▓▓▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒▒▒▒

⚠ MCP server “supabase” takes 10k — disable it in /mcp if you don't need it

▤ BREAKDOWN                                 ~84k tok
  ● Messages                               55k · 28%
```

**command-deck** — the “Commands” pane:

```
◐ CONTEXT & MEMORY                                      4
  /compact                                              ▶
  Condense the conversation to free up context
```

**next-steps** — above the prompt after a reply:

```
◆ Login page with password checks     ⏳ waiting on you: confirm deleting token-speed
NEXT [ 1 · Yes, delete the token-speed folder ] [ 2 · Rerun the login tests ] [ 3 · Open a draft PR ] ✕
```

## Installation

Requires **Claude Code 2.1.288** or newer. The mods use the function-hooks API, which is in early access and may change between versions.

**1. Clone the repository** into a permanent folder:

```bash
git clone https://github.com/Zulut30/claude-mode.git ~/claude-mode
```

**2. Point Claude Code at the mods you want.**

*Desktop app (and every session).* Open `~/.claude/settings.json` and add `CLAUDE_CODE_PLUGIN_DIRS` to the `env` block: absolute paths to the mod folders, separated by `;` on Windows or `:` on macOS/Linux. If there is already an `env` block, add the line inside it.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/claude-mode/en/usage-band:/Users/you/claude-mode/en/roadmap:/Users/you/claude-mode/en/git-branches:/Users/you/claude-mode/en/context-inspector:/Users/you/claude-mode/en/command-deck:/Users/you/claude-mode/en/next-steps"
  }
}
```

*Terminal only, for one run:*

```bash
claude --plugin-dir ~/claude-mode/en/usage-band --plugin-dir ~/claude-mode/en/roadmap --plugin-dir ~/claude-mode/en/git-branches --plugin-dir ~/claude-mode/en/context-inspector --plugin-dir ~/claude-mode/en/command-deck --plugin-dir ~/claude-mode/en/next-steps
```

**3. Restart the app** or open a new session.

**Update:** `git pull` in the repository folder, then a new session. **Remove:** take the paths out of `CLAUDE_CODE_PLUGIN_DIRS`.

## Commands

| Command | What it does |
| --- | --- |
| `/roadmap` | Open the roadmap |
| `/roadmap reset` | Start a new task; the current one moves to “Earlier” |
| `/roadmap band` · `/roadmap pane` | Move the roadmap under the chat (above the prompt) or back into the pane |
| `/branches` | Open the branches pane and refresh |
| `/branches fetch` | Run `git fetch --all --prune` and refresh |
| `/inspector` | Open the context inspector and recount |
| `/deck` | Open the “Commands” pane |
| `/next` · `/next off` · `/next on` | Next-step suggestions: status, turn off, turn on |

The band above the prompt and the next-step suggestions work on their own. The roadmap, the context inspector and “Commands” open by themselves when a session starts; “Branches” does in a git project.

## What the mods read and run

| Mod | Reads | Runs | Network |
| --- | --- | --- | --- |
| usage-band | Session figures from Claude Code: context, memory, limits; the model's response stream (speed, cache lifetime) | — | no |
| roadmap | Your prompts (for the task title) and Claude's tool calls in the session; whether the project has files like `package.json`, `vercel.json` | `git rev-parse` | no |
| git-branches | The repository in the session folder (or a subfolder) | `git for-each-ref`, `git status`, `git log`, `git remote`; `gh pr list`; `git fetch` only from the ⇣ button | `gh` talks to GitHub as you; `fetch` to your remote |
| context-inspector | Claude Code's context breakdown (a local estimate, like `/context`) | — | no |
| command-deck | Claude Code's command list | Commands — only when you press ▶ | no |
| next-steps | The session's last messages | One Haiku call after a reply (off with `/next off`) | Through Claude Code: same account and API |
| token-speed | The model's response stream | — | no |

The mods write nothing to your files and send nothing to third parties. Their state lives in the Claude Code session; next-steps keeps only an “off” flag in Claude Code's plugin store.

**Load:** git and recounts run only while the matching pane is open, the PR list is cached for 5 minutes, context usage is read from Claude Code only when it changes, and the live speed updates once a second.

## If something doesn't show

- **No band, speed or cache.** Speed and cache appear after the model's first reply. Check that the paths in `CLAUDE_CODE_PLUGIN_DIRS` are absolute and point at the mod folder (the one holding `.claude-plugin`), then open a new session.
- **The branches pane says there's no git repository.** Neither the session folder nor its subfolders is a git project.
- **No pull requests.** Install the [GitHub CLI](https://cli.github.com/) and run `gh auth login`.
- **Digits 1–3 don't draft a suggestion.** Click it instead — clicks work everywhere.
- **A pane opened on the wrong side.** The app decides where panes go; a mod can't pin one to a side or add a menu item.

## For developers

```
en/  ru/                     two language versions of each mod
  <mod>/
    .claude-plugin/plugin.json   manifest
    hooks/hooks.json             which module to load
    hooks/register.ts(x)         the mod's code
    hooks/register.test.ts(x)    tests
    types/index.d.ts             state types (if the mod keeps state)
```

Tests and manifest check: `claude plugin test en/roadmap`, `claude plugin validate en/roadmap`.
