export type CategoryKind = 'used' | 'free' | 'buffer' | 'deferred'

/** One row of the window breakdown, as /context counts it. */
export type CategoryUsage = { name: string; tokens: number; kind: CategoryKind }

/** An MCP server: how many tools it has, how many of them are in the window now and how much they weigh. */
export type ServerUsage = {
  name: string
  tools: number
  loaded: number
  /** Tokens of the loaded tools — what actually takes up the window. */
  tokens: number
  /** Tokens of all tools, including the ones loaded on demand. */
  allTokens: number
  /** A sample tool — to recognize a server with an obscure name. */
  example: string
}

export type NamedTokens = { name: string; tokens: number; note?: string }

/** A snapshot of the context breakdown, trimmed to what the pane draws. */
export type Inspection = {
  /** When it was taken, in `$.clock.now()` milliseconds. */
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
