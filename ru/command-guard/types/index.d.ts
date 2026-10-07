/** Состояние страховки: `isOff` — выключена командой `/guard off` (держится между сессиями через хранилище мода). */
export type CommandGuardState = { isOff: boolean }

declare module 'claude-code' {
  interface PluginState {
    'command-guard': { isOff: boolean }
  }
}
