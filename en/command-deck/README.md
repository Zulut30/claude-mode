# 🎛️ command-deck — the main commands, one click away

A **Commands** pane: the main Claude Code slash commands, each with a one-line why and a ▶ button to run it.

```
◐ CONTEXT & MEMORY                                     4
  /compact                                             ▶
  Condense the conversation to free up context
  /clear                                               ▶
  Start over: the conversation is cleared
  /context                                             ▶
  What fills the context window
  /memory                                              ▶
  Open the memory files (CLAUDE.md)

◇ PROJECT & CODE                                       2
  /init                                                ▶
  Create a CLAUDE.md that describes the project
  /engineering:code-review                             ▶
  Review the current changes for bugs

◷ SESSION                                              2
  /cost                                                ▶
  How much this session has spent
  /model                                               ▶
  Pick the model that answers

▣ OUR PANES                                            1
  /inspector                                           ▶
  What makes up the context

/ EVERYTHING ELSE                                     38
  Show 38
```

- **Groups** — Context & memory (`/compact`, `/clear`, `/context`, `/memory`), Project & code (`/init`, `/review`, `/code-review`, `/security-review`), Session (`/cost`, `/usage`, `/resume`, `/export`, `/model`) and Our panes (`/roadmap`, `/branches`, `/inspector`), each command with a one-line why.
- **▶** runs the command as if you typed it. What it did shows in the chat; a toast appears only if the command replied with something or failed to start.
- **`/clear` and `/exit` ask first** — "Clear the conversation and start fresh?" and "Quit the Claude Code session?".
- **Only what exists:** commands this Claude Code doesn't have are not shown. Plugin commands are found by name (`/engineering:code-review` for `code-review`). Commands that do nothing without arguments (`/add-dir`, `/btw`, `/loop`) are left out.
- **Everything else** — all the other commands, alphabetically, each with its own description; collapsed until you press "Show N".
- Each group shows 6 rows and an "N more" button.

**Command:** `/deck` opens the pane. It also opens by itself when a session starts, as a tab next to the other panes.

**Reads** the list of slash commands from Claude Code. **Runs** only the command you press ▶ on, the same way as typing it. Makes no network calls of its own (the command you run may).

Installation — see the [main README](../../README.md#installation).
