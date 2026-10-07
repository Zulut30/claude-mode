# 💡 next-steps — what to ask next

After each Claude reply, two rows show up above the input — below other mods' bands, closest to where you type: the session goal and what Claude is waiting on from you on top, 2–3 likely next prompts below.

```
◆ Mods for Claude Code      waiting on you  pick what to do next
NEXT  [1 · Check the look]  [2 · One-step install]  [3 · Command safety net]    ✕
```

- **Goal** — the session's overall aim in a few words. It carries across prompts and changes only when the task really does.
- **Waiting on you** — in yellow, when Claude is waiting on you: an answer, a confirmation, a manual check.
- **Long text** — a long goal or "waiting on you" is truncated by the app itself to the real window width; the row never wraps.
- **Suggestions** — concrete prompts in your own voice about what just happened (the file, test or function by name), in the language you write in. If Claude ended with a question or an offer, the first one agrees to it; things Claude already did are never suggested.
- **Pick one** — the button shows a short 2–4 word label; the draft is the full prompt. Click the button, or type its digit 1–3 into an empty prompt: the prompt is drafted into the input for you to edit and send. Nothing is ever sent by itself.
- **Hide** — 0 in an empty prompt or a click on ✕ (always on the right). They also go away when you send a prompt or a new turn starts, and stay hidden while Claude is working.
- **Narrow window** — the buttons always stay on one line: labels get shorter, but never wrap to a second line.
- **Cost** — one Haiku call per reply longer than 40 characters; the goal, "waiting on you" and the suggestions all come in that one call. Skipped for subagent turns and while background agents are still running.

**Commands:** `/next off` turns the suggestions off and stops the Haiku calls (remembered across restarts), `/next on` turns them back on, `/next` shows the status. **Reads** the last few messages of the session. **Uses the network** only for that one Haiku call through Claude Code; runs nothing.

Installation: see the [main README](../../README.md#installation).
