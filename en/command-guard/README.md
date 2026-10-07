# 🛡️ command-guard — a safety net for dangerous commands

Before Claude runs a command that would lose something for good, the mod stops it, shows exactly what would be lost, and asks you.

```
Safety net
Claude wants to run: rm -rf build node_modules
• build — folder: 214 files, 3.8 MB
• node_modules — folder: ≥ 2,000 files, ≥ 96 MB (not fully counted)

  1. Run
  2. Cancel
```

- **What it catches** — recursive deletes (`rm -r`/`-rf`/`--recursive`, `Remove-Item -Recurse`, `rmdir /s`, `rd /s`, `del /s`), `git push --force`/`-f`/`+branch`/`--force-with-lease`, `git reset --hard`, `git clean -f`, `git checkout -- .`/`git restore .`, `git branch -D`, `git stash drop`/`clear`. A plain `rm file.txt` without `-r` is not worth asking about.
- **Reads the command, not the text** — `echo "rm -rf /"`, a commit message, a heredoc body and comments don't count. Chains (`&&`, `;`, `|`), `sudo`/`xargs`, `bash -c`, `cmd /c`, `$(…)` and PowerShell blocks are taken apart; `cd folder && …` and `git -C folder` are taken into account.
- **What would be lost:**
  - deletes — per path: file or folder, how many files and how much space; ⚠ when it is a drive root, your whole home folder or the folder holding your project. A path with a variable or a glob (`$TMP/x`, `*.log`) is "can't count in advance";
  - force push — remote commits you don't have (the count and the first three); for `--force-with-lease` it notes that this is the safer form;
  - `reset --hard`, `checkout -- .`, `restore .` — the files with uncommitted changes and how many lines go;
  - `clean -f` — what it would delete, from a `git clean -n` dry run with the same flags;
  - `branch -D` — the commits that are on no remote and not in the current branch;
  - `stash drop`/`clear` — which stash entries go.
- **Run** — the command goes ahead as usual. **Cancel** — it does not run, and Claude gets the reason ("Cancelled: …") so it does not retry blindly; you can also answer in your own words and Claude gets your answer. A toast in the top right says the command was not run.
- **No one to ask** (`claude -p`, the question dismissed) — the command does not run: the safe default.
- **Stays out of the way** — counting takes at most 5 seconds and 2,000 entries / 6 folder levels; harmless commands pass with no question and no delay. Bash calls made by other mods are left alone — only Claude's own commands and its subagents' are guarded.

**Commands:** `/guard` shows the status, `/guard off` turns it off (remembered across restarts), `/guard on` turns it back on.

**Reads** the sizes of the files and folders a command would delete. **Runs** read-only git only — `git log`, `git status`, `git diff --shortstat`, `git clean -n`, `git stash list` (without taking the index lock, 5 s timeout). **Uses the network** never — a force push is compared with what git knows since your last fetch. **Stores** only the "off" flag in Claude Code's store.

Installation — see the [main README](../../README.md#installation).
