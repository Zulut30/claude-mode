export type StageId = 'context' | 'work' | 'check' | 'test' | 'push' | 'deploy'

export type StageStatus = 'pending' | 'active' | 'done' | 'failed'

export type Stage = {
  status: StageStatus
  /** How many of Claude's actions were assigned to this stage. */
  count: number
  /** The latest action in brief: a file, a search, or a command without paths. */
  last: string
  /** Files touched in this stage (read or edited), without duplicates. */
  files: string[]
  /** When the stage started and ended, in `$.clock.now()` milliseconds. */
  startedAt?: number
  endedAt?: number
}

/** A plan step that Claude tracks itself (TodoWrite, TaskCreate/TaskUpdate). */
export type PlanItem = {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type Roadmap = {
  task: string
  startedAt?: number
  stages: { [K in StageId]: Stage }
  plan: PlanItem[]
}

/** A task moved to "Earlier" when a new one arrived. */
export type PastTask = {
  task: string
  done: number
  total: number
  isFailed: boolean
  durationMs: number
}

/** What the project has: decides which stages are shown at all. */
export type Project = {
  isGit: boolean
  hasChecks: boolean
  hasTests: boolean
  hasDeploy: boolean
}

declare module 'claude-code' {
  interface PluginState {
    roadmap: {
      map: Roadmap
      project: Project
      isDetailed: boolean
      history: PastTask[]
      isHistoryOpen: boolean
      /** Whether Claude's turn is running right now. */
      isWorking: boolean
      /** Where to show the roadmap: as a side pane or as a band under the chat, above the prompt. */
      placement: 'pane' | 'band'
    }
    /** The next-steps mod: the roadmap only reads its session goal and uses it as the task title. */
    'next-steps': { goal: string }
  }
}
