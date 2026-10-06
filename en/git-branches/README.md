# 🌿 git-branches — GitLens-style branches

A **Branches** pane for the repository the session is open in.

```
acme/site  ⎇ main                                      ↻ ⇣
↑2 unpushed  ✎ 3 changes  updated just now

⎇ BRANCHES                                               3
  feature/login                         ↓5 #12 ✓      2d
  old                               gone on remote    2y
  wip                                   local only  10 min

⇄ PULL REQUESTS                                          1
  #12 Login page                            approved ✓

◉ COMMITS                                                8
● a1b2c3d fix: header                              IV   3h
○ f0f0f0f init                                     AN   1d

◌ ON REMOTE                                              1
  Show 1
```

- **Header:** the repository and the current branch; under them status chips — whether the branch is in sync with the remote (↑ unpushed, ↓ to pull, not published) and how many changes the working tree has — and when it was updated. **↻** refreshes, **⇣** runs `git fetch`.
- **Branches:** the other local branches with ahead/behind, "gone on remote", "local only", the PR number with its check status, and the age of the last commit.
- **Pull requests:** open PRs with draft, review and check status. Needs the [GitHub CLI](https://cli.github.com/) signed in (`gh auth login`).
- **Commits:** the latest commits on the current branch as a graph with the HEAD node on top, author avatars and age. PR numbers and commit hashes link to GitHub.
- **On remote:** branches you don't have locally; collapsed until you press "Show N".
- Each section shows 6 rows and a "More N" button. When there is nothing to show — one quiet line ("No commits yet · no open PRs") instead of empty cards.
- **Light on resources:** background git runs only while the pane is open, the PR list is cached for 5 minutes, status reads don't lock the index (`GIT_OPTIONAL_LOCKS=0`). If the session folder is not a repository, the pane finds one in a subfolder.

**Commands:** `/branches` opens it, `/branches fetch` runs `git fetch` and refreshes. In a git project the pane opens by itself. Refreshes after every Claude turn and every 3 minutes while it is open.

**Runs:** `git` (`rev-parse`, `for-each-ref`, `status`, `log`, `remote`) and, if installed, `gh pr list`; `git fetch --all --prune` only on **⇣** or `/branches fetch`. Changes nothing else in the repository. **Network:** only `gh` (calls GitHub as your account) and `fetch` (talks to your remote).

Installation — see the [main README](../../README.md#installation).
