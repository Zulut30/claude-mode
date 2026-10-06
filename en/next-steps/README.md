# 💡 next-steps — what to ask next

After each Claude reply, 2–3 likely next prompts show up above the input — below other mods' bands, closest to where you type.

```
◆ Login page with password checks     ⏳ waiting on you: confirm deleting token-speed
NEXT [ 1 · Yes, delete the token-speed folder ] [ 2 · Rerun the login tests ] [ 3 · Open a draft PR ] ✕
```

- **Goal** — the session's overall aim in a few words. It carries across prompts and changes only when the task really does.
- **Waiting on you** — in yellow, when Claude is waiting on you: an answer, a confirmation, a manual check.
- **Suggestions** — short, concrete prompts in your own voice about what just happened (the file, test or function by name), in the language you write in. If Claude ended with a question or an offer, the first one agrees to it; things Claude already did are never suggested.
- **Pick one** — click its button, or type its digit 1–3 into an empty prompt: it's drafted into the input for you to edit and send. Nothing is ever sent by itself.
- **Hide** — 0 in an empty prompt or a click on ✕. They also go away when you send a prompt or a new turn starts, and stay hidden while Claude is working.
- **Narrow window** — one line with the buttons sharing the width; if that gets too tight, the buttons wrap.
- **Cost** — one Haiku call per reply longer than 40 characters; the goal, "waiting on you" and the suggestions all come in that one call. Skipped for subagent turns and while background agents are still running.

**Commands:** `/next off` turns the suggestions off and stops the Haiku calls (remembered across restarts), `/next on` turns them back on, `/next` shows the status. **Reads** the last few messages of the session. **Uses the network** only for that one Haiku call through Claude Code; runs nothing.

Installation: see the [main README](../../README.md#installation).
