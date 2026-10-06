# 🧭 context-inspector — what fills the context

A **Context** pane: how much of the window is used, by what exactly, and what you can free up.

```
Context 42%                                            ↻
84k of 200k tokens · updated just now
████████▓▓▓▓▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒▒▒▒▒
auto-compact at 167k

• MCP server “supabase” takes 10k (2 tools) — disable it
  in /mcp if you don't need it
✓ 2 MCP tools load on demand and don't use the window

▤ BREAKDOWN                                   ~84k tok
  ● Messages                                  55k · 28%
  ● System tools                              14k · 7%
  ● MCP tools                                 12k · 6%
  ● System prompt                           3.0k · 1.5%
  ○ Free space                                83k · 42%
  2 more

◆ MCP SERVERS                             3 · ~12k tok
  supabase                                2 tools · 10k
  23eb0007… · agents_create               1 tool · 2.0k
  vercel                                    2 on demand

✦ SKILLS                                  3 · ~900 tok
◫ MEMORY                                 2 · ~2.1k tok
◎ AGENTS                                   1 · ~300 tok
```

- **Header** — a big "Context 42%" in the level color (green up to 70%, amber up to 90%, red beyond), the tokens used out of the window and when it was last updated. A quiet **↻** recounts.
- **Fill bar** — stacked: each category in its own color, free space as the track, the auto-compact reserve hatched at the right. Under it, the point where auto-compact kicks in.
- **Tips** — one card, tinted by severity: `/compact` from 85% full, how much is left before auto-compact, a heavy MCP server, memory files or a skill list that grew too big — or "All good".
- **Cards** — **BREAKDOWN**, **MCP SERVERS**, **SKILLS**, **MEMORY**, **AGENTS**. Every category has a fixed color, the same in the bar, in the breakdown and on its card's icon. Rows show tokens and, on desktop, a mini share bar.
- **Breakdown** — the same categories as `/context`, in the bar's order: used, free space, reserve; tools loaded on demand come last, marked "outside the window".
- **MCP servers** — grouped, with how many tools are in the window and their tokens. Servers whose tools load on demand don't use the window. Connectors with long UUID names show an example tool so you can tell them apart.
- Each card shows 5 rows and an "N more" button.

**Command:** `/inspector` opens it and recounts. The pane opens by itself when a session starts and refreshes only while it is open.

**Reads** the context breakdown from Claude Code — a local estimate, like `/context`, with no API calls. **Runs nothing** and makes no network calls.

Installation — see the [main README](../../README.md#installation).
