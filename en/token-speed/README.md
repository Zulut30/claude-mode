# ⚡ token-speed — model response speed

The response speed in tokens per second, in the status line under the prompt.

```
⚡ ≈48 tok/s                            while it answers (estimate)
⚡ 52 tok/s · 1,240 tokens in 24 s      after it answers (exact, from the API)
```

- **While it answers** — a live estimate from the incoming text, refreshed about 4 times a second. The API doesn't report token counts mid-answer, hence the "≈".
- **After it answers** — the exact speed from the API's token count. The line stays until the next answer.
- Timing starts at the first piece of the answer, so the wait before the answer doesn't drag the speed down.
- The estimate calibrates itself from the exact figures of earlier answers — for prose in any language and for code.
- Only the main answer counts; parallel subagents don't mix in.

If the model thinks for a long time and its thinking text isn't streamed, the live estimate reads low; the final figure is exact.

**No commands.** **Reads** only the model's response stream. **Runs nothing** and makes no network calls.

Installation: see the [main README](../../README.md#install).
