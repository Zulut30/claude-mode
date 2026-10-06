# 🧭 context-inspector — what fills the context

A **Context** pane: what takes up the context window and what you can free up.

```
CONTEXT · claude-opus-5-5                          [ ↻ Refresh ]
84k of 200k · 42%
████████▓▓▓▓▒▒▒░░░░░░░░░░░░░░░░░░░░░░░
auto-compact at 167k

• MCP server “supabase” takes 10k (2 tools) — disable it in /mcp if you don't need it
✓ 2 MCP tools load on demand and don't use the window

WHAT FILLS IT
● Messages                                     55k · 28%
● System tools                                 14k · 7%
● MCP tools                                    12k · 6%
● System prompt                               3.0k · 1.5%
◌ Autocompact buffer                           33k · 17%
MCP SERVERS · 3
● supabase                                   2 tools · 10k
● 23eb0007… · agents_create                 1 tool · 2.0k
◌ vercel                                       2 on demand
SKILLS · 3 of 3 listed · 900
MEMORY · 2 files
```

- **Fill** — how much is used, with a stacked bar: each category in its own color, the auto-compact reserve in pale yellow, free space in gray.
- **Tips** — what to do: `/compact` from 85% full, how much is left before auto-compact, which MCP server is heavy, whether memory files or the skill list have grown too big.
- **What fills it** — the same categories as `/context`: messages, system prompt, tools, memory, skills, free space, reserve.
- **MCP servers** — grouped, with how many tools are in the window and their tokens. Servers whose tools load on demand don't use the window. Connectors with long UUID names show an example tool so you can tell them apart.
- **Skills, memory, agents** — heaviest first.
- Each section shows 5 rows and a "More N" button.

**Command:** `/inspector` opens it and recounts. The pane opens by itself when a session starts and recounts after every turn while it's open.

**Reads** the context breakdown from Claude Code — a local estimate, like `/context`, with no API calls. **Runs nothing** and makes no network calls.

Installation: see the [main README](../../README.md#install).
