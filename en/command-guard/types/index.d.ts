/** The safety net's state: `isOff` — turned off with `/guard off` (kept across sessions in the mod's store). */
export type CommandGuardState = { isOff: boolean }

declare module 'claude-code' {
  interface PluginState {
    'command-guard': { isOff: boolean }
  }
}
