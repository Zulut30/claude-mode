export type CategoryKind = 'used' | 'free' | 'buffer' | 'deferred'

/** Строка состава окна, как её считает /context. */
export type CategoryUsage = { name: string; tokens: number; kind: CategoryKind }

/** MCP-сервер: сколько у него инструментов, сколько из них сейчас в окне и сколько они весят. */
export type ServerUsage = {
  name: string
  tools: number
  loaded: number
  /** Токены загруженных инструментов — то, что реально занимает окно. */
  tokens: number
  /** Токены всех инструментов, включая подгружаемые по запросу. */
  allTokens: number
  /** Пример инструмента — чтобы узнать сервер с непонятным именем. */
  example: string
}

export type NamedTokens = { name: string; tokens: number; note?: string }

/** Снимок разбивки контекста, ужатый до того, что рисует панель. */
export type Inspection = {
  /** Когда снят, миллисекунды `$.clock.now()`. */
  at: number
  model: string
  totalTokens: number
  maxTokens: number
  percentage: number
  categories: CategoryUsage[]
  servers: ServerUsage[]
  skills: { total: number; included: number; tokens: number; top: NamedTokens[] }
  memory: NamedTokens[]
  agents: { count: number; tokens: number; top: NamedTokens[] }
  autoCompactAt?: number
  isAutoCompactEnabled: boolean
}

export type SectionId = 'categories' | 'servers' | 'skills' | 'memory' | 'agents'

declare module 'claude-code' {
  interface PluginState {
    'context-inspector': { inspection: Inspection | null; isLoading: boolean; expanded: SectionId[] }
  }
}
