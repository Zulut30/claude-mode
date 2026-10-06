# 🗺️ roadmap — the task roadmap

A **Roadmap** pane: the stages of the current task as a timeline, ticked off automatically from what Claude does, with Claude's own plan underneath.

```
build the login page                                ↺ ⤓
Claude is working · stage 2 of 4 · 6 min

◉ STAGES                                            1/4
  ✓ Context                                       1 min
    read 6 files · 14 actions
  ● Implementation                                4 min
    3 files: login.tsx, api.ts, styles.css
  ○ Tests
  ○ Push

☰ PLAN                                              3/8
  ✓ 3 steps done
  ● Wire up the API
  ○ Add validation
  ○ Error states
  ○ Write tests
  ○ Update the docs
  3 more

◷ EARLIER                                             2
  Show 2
```

**How stages are detected:**

| Stage | What marks it |
| --- | --- |
| Context | Reading files, searching, web, agents, read-only commands (`git status`, `ls`, `gh pr view`…) |
| Implementation | Editing files and other commands |
| Checks | `tsc`, linters, `validate`, `build`, `git diff` |
| Tests | `npm test`, `pytest`, `jest`, `vitest`, `claude plugin test`… — turns red when they fail |
| Push | `git commit` (in progress), then `git push` (done) |
| Deploy | `vercel`, `netlify`, `wrangler`, `firebase deploy`, `npm run deploy`, `docker push`… |

- **Header:** the task title, one dim status line — "Claude is working · stage 2 of 4 · 6 min", "Done · waiting for you" or "Something failed" — and two icon buttons: ↺ starts a new task, ⤓ moves the roadmap under the chat.
- **STAGES:** a vertical timeline. Done stages are green, the running one is highlighted, a failed one is red; a stage that was jumped over is marked skipped. Each stage shows its time on the right and one dim line on what happened: files read, files changed, the command and how many runs. A long file list expands with "N more files".
- **Stages adapt to the project:** Push only in a git repository, Deploy only when deploy config exists, Checks and Tests only when the project has them. A stage that actually happened always shows.
- **PLAN:** Claude's todo list, when Claude keeps one. A long plan shows a window of 5 steps around the current one, with the finished steps before it folded into "N steps done"; "N more" expands the whole list.
- **EARLIER:** past tasks with their outcome and duration, collapsed until you press "Show N".
- **New task** — every new prompt of yours. Short confirmations like `yes`, `ok`, `go ahead`, `continue` keep the current one. Past tasks move to Earlier.
- **Under the chat:** ⤓ or `/roadmap band` turns the roadmap into one row above the prompt — status, task, the stage chain and the total time. When the row gets narrow, passed and upcoming stages shrink to icons (the running and failed ones keep their names); in a very narrow window only the task stays. ⤢ or `/roadmap pane` puts it back in the side pane.

**Commands:** `/roadmap` opens it, `/roadmap reset` starts a new task, `/roadmap band` / `/roadmap pane` move it under the chat or back to the pane. The pane opens by itself when a session starts, unless the roadmap lives under the chat.

**Reads:** your prompts (for the task title) and the session's tool calls; checks whether files like `package.json` exist in the project. **Runs:** `git rev-parse`. **Network:** none.

Installation — see the [main README](../../README.md#installation).
