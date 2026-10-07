/** A column of the usage-band band: `/band hide|show <column>`. */
export type ModSwitchBandColumn = 'context' | 'memory' | 'limits' | 'speed' | 'cache'

/** Where the roadmap shows: as a side pane or as a band under the chat (`/roadmap pane|band`). */
export type ModSwitchPlacement = 'pane' | 'band'

/**
 * The pane has no values of its own: it only reads other mods' values, and the owning
 * mod changes them with its own command. These are exactly the keys the pane reads,
 * as their owners declare them.
 */
declare module 'claude-code' {
  interface PluginState {
    'next-steps': { isOff: boolean }
    'command-guard': { isOff: boolean }
    'usage-band': { hidden: ModSwitchBandColumn[] }
    roadmap: { placement: ModSwitchPlacement }
  }
}
