# 💡 next-steps — what to ask next

After each Claude reply, 2–3 likely next prompts show up above the input — below other mods' bands, closest to where you type.

```
NEXT  1 · Rerun the login tests  2 · Add the same check to signup.ts  3 · Open a draft PR  0 · hide
```

- **Suggestions** — short, concrete prompts about what just happened (the file, test or function by name), in the language you write in.
- **Pick one** — click it, or type its digit 1–3 into an empty prompt: it's drafted into the input for you to edit and send. Nothing is ever sent by itself.
- **Hide** — 0 in an empty prompt or a click on "0 · hide". They also go away when you send a prompt or a new turn starts, and stay hidden while Claude is working.
- **Narrow window** — one line if everything fits; otherwise one prompt per line, or one line with each prompt trimmed evenly.
- **Cost** — one Haiku call per reply longer than 40 characters. Skipped for subagent turns and while background agents are still running.

**Commands:** `/next off` turns the suggestions off and stops the Haiku calls (remembered across restarts), `/next on` turns them back on, `/next` shows the status. **Reads** the last few messages of the session. **Uses the network** only for that one Haiku call through Claude Code; runs nothing.

Installation: see the [main README](../../README.md#installation).
