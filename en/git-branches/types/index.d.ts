export type Branch = {
  name: string
  upstream: string
  ahead: number
  behind: number
  /** The branch was deleted on the remote. */
  isGone: boolean
  hash: string
  /** Commit time, Unix seconds. */
  time: number
  author: string
  subject: string
  isCurrent: boolean
}

export type RemoteBranch = {
  name: string
  hash: string
  time: number
  author: string
  subject: string
}

export type Commit = {
  hash: string
  time: number
  author: string
  subject: string
}

export type Checks = 'passing' | 'failing' | 'pending' | 'none'

export type PullRequest = {
  number: number
  title: string
  branch: string
  isDraft: boolean
  url: string
  checks: Checks
  review: string
}

export type Changes = { staged: number; unstaged: number; untracked: number }

export type GitSnapshot = {
  isRepo: boolean
  root: string
  current: string
  /** owner/repo when origin points at GitHub; empty otherwise. */
  slug: string
  changes: Changes
  branches: Branch[]
  remotes: RemoteBranch[]
  commits: Commit[]
  prs: PullRequest[]
  /** Why PRs are not shown (no gh, not signed in); empty when all is well. */
  prsNote: string
  /** When the snapshot was taken, `$.clock.now()` milliseconds. */
  loadedAt: number
}

export type SectionId = 'local' | 'prs' | 'remote' | 'commits'

declare module 'claude-code' {
  interface PluginState {
    'git-branches': { snapshot: GitSnapshot | null; isLoading: boolean; collapsed: SectionId[] }
  }
}
