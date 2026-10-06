/** Suggestions after a reply: which turn they belong to and the prompts themselves. */
export type NextSteps = {
  /** The turn they were suggested after: a new prompt or turn clears them. */
  turnId: string
  /** 2–3 prompts, each a ready draft. */
  items: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'next-steps': { steps: NextSteps | null; isOff: boolean }
  }
}
