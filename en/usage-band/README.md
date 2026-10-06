# 📊 usage-band — context, memory, limits, speed and cache

A band above the prompt: six even columns — a title on top, the value below. As many fit in a row as the window allows; if not all do, the rows are split evenly. It shares the space with other mods: the roadmap "under the chat", for example, goes below it.

```
CONTEXT                  MEMORY                   5 HOURS
42% ━━━━──── 84k/200k    2 files ~2k tok.         24% ━━────── ↻ 2h 15 min

WEEK                     SPEED                    CACHE
91% ━━━━━━━─ ↻ 3d 4h     52 tok/s ▂▄▆▅▇ 1,000 tok  48 min ━━────── of 1h
```

- **Context** — how full the context window is, in percent and tokens.
- **Memory** — how many memory files are loaded (CLAUDE.md, auto-memory) and their size. Estimated locally, no API calls.
- **5 hours / Week** — usage of the subscription's 5-hour and weekly limits and the time until each resets. They appear after the model's first reply in the session.
- **Speed** — the model's response speed in tokens per second: a live estimate (≈) while it answers, the turn's average from the API's exact counts after. The mini chart shows the speed of the turn's recent steps; subagents don't mix in.
- **Cache** — how much of the prompt cache's lifetime is left (1 hour on a subscription, 5 minutes with an API key, or whatever the API reports). While the cache is warm, your next message reuses the already-processed conversation and costs much less against your usage limits; once it's cold, the whole context is processed again. It turns yellow, then red as time runs out; after that it shows "cold · 84k anew".

Bar colors: green below 70%, yellow 70–89%, red from 90%. Refreshes after every turn; the countdowns tick every minute, the live speed once a second.

**No commands** — the band shows up by itself. **Reads** only the session figures and the model's response stream from Claude Code. **Runs nothing** and makes no network calls.

Installation: see the [main README](../../README.md#installation).
