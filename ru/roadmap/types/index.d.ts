export type StageId = 'context' | 'work' | 'check' | 'test' | 'push' | 'deploy'

export type StageStatus = 'pending' | 'active' | 'done' | 'failed'

export type Stage = {
  status: StageStatus
  /** Сколько действий Claude отнесено к стадии. */
  count: number
  /** Последнее действие коротко: файл, поиск или команда без путей. */
  last: string
  /** Файлы стадии (прочитанные или изменённые), без повторов. */
  files: string[]
  /** Когда стадия началась и когда закрылась, в миллисекундах `$.clock.now()`. */
  startedAt?: number
  endedAt?: number
}

/** Шаг плана, который Claude ведёт сам (TodoWrite, TaskCreate/TaskUpdate). */
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

/** Задача, ушедшая в «Ранее», когда пришла новая. */
export type PastTask = {
  task: string
  done: number
  total: number
  isFailed: boolean
  durationMs: number
}

/** Что есть в проекте: по этому решаем, какие стадии вообще показывать. */
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
    }
  }
}
