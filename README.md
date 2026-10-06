# claude-mode

Mods for **Claude Code** (desktop Code tab and terminal), built on the function-hooks plugin API.

[Русская версия →](README.ru.md)

| Mod | What it shows |
| --- | --- |
| **usage-band** | A two-line band above the prompt: context window fill, memory files loaded, and subscription limits (5-hour and weekly) with a reset countdown. |
| **roadmap** | A **Roadmap** pane: the current task and its stages top to bottom — context → implementation → checks → tests → push → deploy — detected from what Claude actually does, plus Claude's own plan, durations and an "Earlier" history. |
| **git-branches** | A GitLens-style **Branches** pane: current branch, ahead/behind, working-tree changes, local and remote branches, GitHub pull requests with check status, and recent commits. |

Every mod ships in two languages: [`en/`](en) and [`ru/`](ru). Load one language per mod — both use the same plugin names.

## Install

Requires Claude Code **2.1.288** or newer. The function-hooks API is in early access and may change between releases.

### Terminal

```bash
claude --plugin-dir ./en/usage-band --plugin-dir ./en/roadmap --plugin-dir ./en/git-branches
```

### Desktop app (and every session)

Add the folders to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. Use absolute paths separated by `;` on Windows or `:` on macOS/Linux:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\code\\claude-mode\\en\\usage-band;C:\\code\\claude-mode\\en\\roadmap;C:\\code\\claude-mode\\en\\git-branches"
  }
}
```

Restart the app or open a new session to load them.

## Usage

| Command | Action |
| --- | --- |
| `/roadmap` | Open the Roadmap pane |
| `/roadmap reset` | Start a new task (the current one moves to "Earlier") |
| `/branches` | Open the Branches pane |
| `/branches fetch` | Run `git fetch --all --prune`, then refresh |

The band needs no command — it appears above the prompt by itself.

### How the roadmap works

- Every new prompt starts a new task. Short confirmations (`yes`, `ok`, `go ahead`, `continue`…) continue the current one.
- Stages are detected from tool calls: reads and searches → **Context**; edits and other shell commands → **Implementation**; `tsc`, linters, `validate`, `build` → **Checks**; `npm test`, `pytest`, `jest`… → **Tests**; `git commit` / `git push` → **Push**; `vercel`, `netlify`, `wrangler`, `docker push`… → **Deploy**.
- Stages adapt to the project: **Push** only shows in a git repository, **Deploy** only when deploy config exists (`vercel.json`, `Dockerfile`, `.github/workflows`, …), **Checks** and **Tests** only when the project has them — unless they actually happened.
- When Claude keeps a todo list, it appears under **Implementation** with its own progress.

### Branches pane requirements

- `git` on `PATH`.
- For pull requests: the [GitHub CLI](https://cli.github.com/) signed in (`gh auth login`). Without it the pane still shows branches and commits.
- The pane is read-only apart from **Fetch**.

## Notes

- The app decides where a pane is placed; a mod cannot dock it to a particular side or add items to the app's own menus.
- Each mod has tests: `claude plugin test en/roadmap`.

## Layout

```
en/  usage-band  roadmap  git-branches   English
ru/  usage-band  roadmap  git-branches   Russian
```

Each mod: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, `hooks/register.test.tsx`, and `types/index.d.ts` when it keeps state.
