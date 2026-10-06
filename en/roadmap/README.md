# 🗺️ roadmap — the task roadmap

A **Roadmap** pane: the stages of the current task from top to bottom, ticked off automatically from what Claude does.

```
TASK                                 ● Claude is working · 6m
build the login page
━━━━━━━━━━━━──────────  2 of 4

✓ Context                                                1m
  read 6 files · 14 actions
● Implementation                                         4m
  3 files: login.tsx, api.ts, styles.css
  ✓ Lay out the form
  ● Wire up the API
○ Tests
○ Push
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

- **New task** — every new prompt of yours. Short confirmations like `yes`, `ok`, `go ahead`, `continue` keep the current one. Past tasks move to "Earlier".
- **Stages adapt to the project:** Push only in a git repository, Deploy only when deploy config exists, Checks and Tests only when the project has them. A stage that actually happened always shows.
- **Claude's plan:** when Claude keeps a todo list, it appears under Implementation with checkmarks.
- **Status in the header:** "Claude is working", "Done · waiting for you" or "Something failed".

**Commands:** `/roadmap` opens it, `/roadmap reset` starts a new task. The pane opens by itself when a session starts.

**Reads:** your prompts (for the task title) and the session's tool calls; checks whether files like `package.json` exist in the project. **Runs:** `git rev-parse`. **Network:** none.

Installation: see the [main README](../../README.md#install).
