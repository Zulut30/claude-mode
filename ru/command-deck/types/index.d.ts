/** Секция панели «Команды»; `rest` — «Все остальные». */
export type CommandDeckSection = 'context' | 'project' | 'session' | 'panels' | 'rest'

declare module 'claude-code' {
  interface PluginState {
    'command-deck': { expanded: CommandDeckSection[] }
  }
}
