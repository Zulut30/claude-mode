/** The model's response speed for the SPEED column. */
export type Speed = {
  /** Tokens per second: a live estimate while it answers, or the turn's average after. */
  rate: number
  /** Whether a reply is streaming right now (then `rate` is an estimate). */
  isLive: boolean
  /** Tokens for the turn and seconds of generation — from the API's exact counts. */
  tokens: number
  seconds: number
  /** Speed of the turn's recent steps, for the mini chart. */
  history: number[]
}

/** Prompt-cache lifetime: 5 minutes or an hour. */
export type CacheTtl = '5m' | '1h'

/** The main model's prompt cache for the CACHE column. */
export type PromptCache = {
  /** When the main model's last request finished (ms). */
  at: number
  /** Lifetime from the API's usage; missing — replies didn't name it, so it's guessed from the plan. */
  ttl?: CacheTtl
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { speed: Speed | null; cache: PromptCache | null }
  }
}
