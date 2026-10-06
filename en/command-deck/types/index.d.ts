/** A section of the Commands pane; `rest` is "Everything else". */
export type CommandDeckSection = 'context' | 'project' | 'session' | 'panels' | 'rest'

declare module 'claude-code' {
  interface PluginState {
    'command-deck': { expanded: CommandDeckSection[] }
  }
}
