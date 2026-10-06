export type Branch = {
  name: string
  upstream: string
  ahead: number
  behind: number
  /** Ветка на сервере удалена. */
  isGone: boolean
  hash: string
  /** Время коммита, секунды Unix. */
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
  /** owner/repo, когда origin смотрит на GitHub; иначе пусто. */
  slug: string
  changes: Changes
  branches: Branch[]
  remotes: RemoteBranch[]
  commits: Commit[]
  prs: PullRequest[]
  /** Почему PR не показаны (нет gh, не вошли); пусто, если всё в порядке. */
  prsNote: string
  /** Когда снимок сделан, миллисекунды `$.clock.now()`. */
  loadedAt: number
}

export type SectionId = 'local' | 'prs' | 'remote' | 'commits'

declare module 'claude-code' {
  interface PluginState {
    'git-branches': { snapshot: GitSnapshot | null; isLoading: boolean; expanded: SectionId[] }
  }
}
