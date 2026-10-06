/** Suggestions after a reply: which turn they belong to, the prompts, the session goal and what the assistant waits on. */
export type NextSteps = {
  /** The turn they were suggested after: a new prompt or turn clears them. */
  turnId: string
  /** 0–3 prompts, each a ready draft. */
  items: string[]
  /** The overall aim of the session in a few words. */
  goal?: string
  /** What the assistant is waiting on from the person right now; absent — nothing. */
  waiting?: string
}

declare module 'claude-code' {
  interface PluginState {
    /** `goal` — the last known goal: kept across turns and passed into the next model request. */
    'next-steps': { steps: NextSteps | null; isOff: boolean; goal: string }
  }
}
