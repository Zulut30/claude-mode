# 🌿 git-branches — GitLens-style branches

A **Branches** pane for the repository the session is open in.

```
acme/site                            [ ↻ Refresh ] [ ⇣ Fetch ]
updated 1m ago · open on GitHub

● main                                            ↑2 to push
  ✎ 2 modified · 1 untracked

BRANCHES · 3
○ feature/login                                ↓5  #12   2d
  b2c3d4e feat: login
PULL REQUESTS · 1
✓ Login page                                            #12
  feature/login · checks passed · approved
COMMITS · main · 8
│ a1b2c3d fix: header                                    3h
```

- **Current branch:** whether it is in sync with the remote (↑ to push, ↓ to pull, not published) and what changed in the working tree.
- **Branches:** ahead/behind, "not on remote", "local only", the PR number with its check status, the last commit.
- **Pull requests:** open PRs with check and review status. Needs the [GitHub CLI](https://cli.github.com/) signed in (`gh auth login`).
- **On remote:** branches you don't have locally. **Commits:** the latest commits on the current branch.
- Each section shows 5 rows and a "More N" button. Branch names, PRs and commit hashes link to GitHub.

**Commands:** `/branches` opens it, `/branches fetch` runs `git fetch` and refreshes. In a git project the pane opens by itself. Refreshes after every Claude turn and every 3 minutes.

**Runs:** `git for-each-ref`, `git status`, `git log`, `git remote`, `gh pr list`; `git fetch --all --prune` only when you press **Fetch**. Changes nothing else in the repository. **Network:** `gh` calls GitHub as your account; `fetch` talks to your remote.

Installation: see the [main README](../../README.md#install).
