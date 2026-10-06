# 📊 usage-band — context, memory and limits

A two-line band above the prompt.

```
━━━━────── 42% context · 84k / 200k       ━━──────── 24% limit 5h · resets in 2h 15m
memory: 2 files · ~2k tokens               ━━━━━━━━━─ 91% weekly limit · resets in 3d 4h
```

- **Context** — how full the context window is, in percent and tokens.
- **Memory** — how many memory files are loaded (CLAUDE.md, auto-memory) and their size. Estimated locally, no API calls.
- **Subscription limits** — usage of the 5-hour and weekly limits and the time until each resets. They appear after the model's first answer in the session.

Bar colors: green below 70%, yellow 70–89%, red from 90%. Refreshes after every turn; the reset countdown ticks every minute.

**No commands** — the band shows up by itself. **Reads** only the session figures from Claude Code. **Runs nothing** and makes no network calls.

Installation: see the [main README](../../README.md#install).
