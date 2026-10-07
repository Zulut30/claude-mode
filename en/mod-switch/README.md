# 🎛️ mod-switch — switches for your mods

The Mods pane: turn your other mods on and off with one button, without remembering their commands. `/mods` opens it — it doesn't pop up by itself at start.

```
◈ SUGGESTIONS & SAFETY
  Next                                        ● On
  after a reply — the goal and 2–3 next prompts; …
  Safety net                                 ○ Off
  asks before rm -r, push --force, reset --hard

▤ BAND ABOVE THE PROMPT
  Context                                     ● On
  Memory                                      ● On
  Limits                                      ● On
  Speed                                      ○ Off
  Cache                                       ● On

◇ ROADMAP
  Where to show                        ▣ In a pane
  in a pane — a side tab; under the chat — a band…
```

- **Suggestions & safety** — "Next" (next-steps) and the safety net (command-guard): on or off, each with a one-line note on what it does.
- **Band above the prompt** — a switch for each usage-band column: context, memory, limits, speed, cache. A hidden column takes no room; the rest share the row evenly.
- **Roadmap** — where it shows: in a side pane or as a band under the chat.
- **The button on the right** shows the current state: ● On (green) or ○ Off (gray). A press flips it.
- **Each mod owns its settings.** The pane stores nothing and changes nothing by itself: it runs the mod's own command (`/next off`, `/guard on`, `/band hide cache`, `/roadmap band`) as if you typed it, and the mod changes and remembers the value. The command's reply shows in the chat; a toast pops up only when the command didn't work.
- **Live state** — flip something with a command by hand and the pane updates by itself.
- **Mods that aren't installed** get no switches, just one line at the bottom: "Not installed: command-guard". The band's columns need usage-band 0.4, which added the `/band` command.
- **Narrow pane** — long labels are cut to the pane's width instead of wrapping to a second line.

**Commands:** `/mods` opens the pane. **Reads** the list of Claude Code commands (to see which mods are installed) and the mods' own values: whether "Next" and the safety net are on, which band columns are hidden, where the roadmap is. **Runs** only those mods' commands — `/next`, `/guard`, `/band`, `/roadmap`. **No network**, stores nothing.

Installation: see the [main README](../../README.md#installation).
