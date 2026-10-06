# claude-mode

Five mods for **Claude Code** — the desktop app's Code tab and the terminal. Each mod is its own folder: install only the ones you want.

[Русская версия →](README.ru.md)

| | Mod | What it gives you | Where it shows |
| --- | --- | --- | --- |
| 📊 | [**usage-band**](en/usage-band) | Context window fill, loaded memory files and subscription limits (5-hour and weekly) | A band above the prompt |
| 🗺️ | [**roadmap**](en/roadmap) | The stages of the current task: context → implementation → checks → tests → push → deploy | A **Roadmap** pane |
| 🌿 | [**git-branches**](en/git-branches) | Branches, sync with the remote, GitHub pull requests and commits, GitLens-style | A **Branches** pane |
| 🧭 | [**context-inspector**](en/context-inspector) | What fills the context window: categories, MCP servers, skills, memory and tips on what to free up | A **Context** pane |
| ⚡ | [**token-speed**](en/token-speed) | The model's response speed in tokens per second | The status line under the prompt |

Every mod ships in English ([`en/`](en)) and Russian ([`ru/`](ru)). Pick one language per mod — both versions use the same plugin name.

## What it looks like

**usage-band** — above the prompt:

```
━━━━────── 42% context · 84k / 200k       ━━──────── 24% limit 5h · resets in 2h 15m
memory: 2 files · ~2k tokens               ━━━━━━━━━─ 91% weekly limit · resets in 3d 4h
```

**roadmap** — the Roadmap pane:

```
TASK                                 ● Claude is working · 6m
build the login page
━━━━━━━━━━━━──────────  2 of 4

✓ Context                                                1m
  read 6 files · 14 actions
● Implementation                                         4m
  3 files: login.tsx, api.ts, styles.css
  ✓ Lay out the form
  ● Wire up the API
○ Tests
○ Push

[ Details ]  [ New task ]
▸ Earlier · 3
```

**git-branches** — the Branches pane:

```
acme/site                            [ ↻ Refresh ] [ ⇣ Fetch ]
updated 1m ago · open on GitHub

● main                                            ↑2 to push
  ✎ 2 modified · 1 untracked

BRANCHES · 3
○ feature/login                                ↓5  #12   2d
  b2c3d4e feat: login
○ wip                                            local only
PULL REQUESTS · 1
✓ Login page                                            #12
  feature/login · checks passed · approved
COMMITS · main · 8
│ a1b2c3d fix: header                                    3h
```

**context-inspector** — the Context pane:

```
CONTEXT · claude-opus-5-5                          [ ↻ Refresh ]
84k of 200k · 42%
████████▓▓▓▓▒▒▒░░░░░░░░░░░░░░░░░░░░░░░

• MCP server “supabase” takes 10k (2 tools) — disable it in /mcp if you don't need it

WHAT FILLS IT
● Messages                                     55k · 28%
● System tools                                 14k · 7%
MCP SERVERS · 3
● supabase                                   2 tools · 10k
◌ vercel                                       2 on demand
```

**token-speed** — under the prompt:

```
⚡ ≈48 tok/s                            while it answers (estimate)
⚡ 52 tok/s · 1,240 tokens in 24 s      after it answers (exact, from the API)
```

## Install

Requires **Claude Code 2.1.288** or newer. The mods use the function-hooks API, which is in early access and may change between releases.

**1. Clone the repository** somewhere permanent:

```bash
git clone https://github.com/Zulut30/claude-mode.git ~/claude-mode
```

**2. Turn on the mods you want.**

*Desktop app (and every session).* Open `~/.claude/settings.json` and add `CLAUDE_CODE_PLUGIN_DIRS` to its `env` block: absolute paths to the mod folders, separated by `;` on Windows or `:` on macOS/Linux. If you already have an `env` block, add the line inside it.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/claude-mode/en/usage-band:/Users/you/claude-mode/en/roadmap:/Users/you/claude-mode/en/git-branches:/Users/you/claude-mode/en/context-inspector:/Users/you/claude-mode/en/token-speed"
  }
}
```

On Windows: `"C:\\Users\\you\\claude-mode\\en\\usage-band;C:\\Users\\you\\claude-mode\\en\\roadmap;…"`.

*Terminal only, for one run:*

```bash
claude --plugin-dir ~/claude-mode/en/usage-band --plugin-dir ~/claude-mode/en/roadmap --plugin-dir ~/claude-mode/en/git-branches --plugin-dir ~/claude-mode/en/context-inspector --plugin-dir ~/claude-mode/en/token-speed
```

**3. Restart the app** or open a new session.

**Update:** `git pull` in the repository folder, then start a new session. **Remove:** take the paths out of `CLAUDE_CODE_PLUGIN_DIRS`.

## Commands

| Command | What it does |
| --- | --- |
| `/roadmap` | Open the Roadmap pane |
| `/roadmap reset` | Start a new task; the current one moves to "Earlier" |
| `/branches` | Open the Branches pane |
| `/branches fetch` | Run `git fetch --all --prune`, then refresh |
| `/inspector` | Open the context inspector and recount |

The usage band and token speed need no command. The Roadmap and Context panes open by themselves when a session starts, the Branches pane opens by itself in a git project.

## What the mods read and run

The mods run inside Claude Code and send nothing to third parties.

| Mod | Reads | Runs | Network |
| --- | --- | --- | --- |
| usage-band | Session figures from Claude Code: context, memory, limits | — | none |
| roadmap | Your prompts (for the task title) and Claude's tool calls in the session; whether files like `package.json` or `vercel.json` exist in the project | `git rev-parse` | none |
| git-branches | The state of the repository in the session folder | `git for-each-ref`, `git status`, `git log`, `git remote`; `gh pr list`; `git fetch` only when you press **Fetch** | `gh` calls GitHub as your account; `fetch` talks to your remote |
| context-inspector | The context breakdown from Claude Code (a local estimate, like `/context`) | — | none |
| token-speed | The model's response stream (counts characters and tokens) | — | none |

Mod state lives in the Claude Code session; nothing is written to disk.

## Troubleshooting

- **No band or speed line.** The speed appears during or after the model's first answer. Check that the paths in `CLAUDE_CODE_PLUGIN_DIRS` are absolute and point at the mod folder (the one containing `.claude-plugin`).
- **"No git repository here" in the Branches pane.** The session is not open in a project folder that uses git.
- **No pull requests.** Install the [GitHub CLI](https://cli.github.com/) and run `gh auth login`.
- **The pane opens in the wrong place.** The app decides where panes go; a mod cannot dock a pane to a side or add items to the app's menus.

## For developers

```
en/  ru/                     two language versions of every mod
  <mod>/
    .claude-plugin/plugin.json   manifest
    hooks/hooks.json             which module to load
    hooks/register.ts(x)         the mod's code
    hooks/register.test.ts(x)    tests
    types/index.d.ts             state types (when the mod keeps state)
```

Tests and manifest checks: `claude plugin test en/roadmap`, `claude plugin validate en/roadmap`.
