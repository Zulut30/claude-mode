# ⚡ token-speed — model response speed

> **Superseded.** The same speed (live and per turn, with the step chart) is now the SPEED column of [usage-band](../usage-band). Don't install both: you'd see the speed twice. This mod stays for those who want the speed alone in the status line.

The response speed in tokens per second, in the status line under the prompt.

```
⚡ ≈48 tok/s ▂▄▆                                 while it answers: the last 2 seconds
⚡ 52 tok/s ▂▄▆▅▇ · 3,400 tokens in 1 min 5 s   after: the average for the turn, exact from the API
```

- **While it answers** — a live estimate from the last 2 seconds of text, refreshed about 4 times a second. The API doesn't report token counts mid-answer, hence the "≈".
- **After it answers** — the average speed for the whole turn from the API's exact token counts: a Claude turn has many steps, and all of them count, not just the last one.
- **Sparkline ▂▄▆▅▇** — the speed of the turn's recent steps; steps under 40 tokens are left out.
- Timing starts at the first piece of the answer, so the wait before the answer doesn't drag the speed down.
- The estimate calibrates itself from the exact figures of earlier answers (except ones with thinking) — for prose in any language and for code.
- Only the main answer counts; parallel subagents don't mix in.

If the model thinks for a long time and its thinking text isn't streamed, the live estimate reads low; the final figure is exact. An interrupted answer doesn't leave the line stuck: the turn's total stays.

**No commands.** **Reads** only the model's response stream. **Runs nothing** and makes no network calls.

Installation: see the [main README](../../README.md#installation).
