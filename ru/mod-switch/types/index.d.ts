/** Колонка полосы usage-band: `/band hide|show <колонка>`. */
export type ModSwitchBandColumn = 'context' | 'memory' | 'limits' | 'speed' | 'cache'

/** Где дорожная карта: боковой панелью или полосой под чатом (`/roadmap pane|band`). */
export type ModSwitchPlacement = 'pane' | 'band'

/**
 * Своих значений у панели нет: она только читает чужие, а меняет их сам мод-владелец
 * своей командой. Здесь — ровно те ключи, что панель читает, как их объявляют владельцы.
 */
declare module 'claude-code' {
  interface PluginState {
    'next-steps': { isOff: boolean }
    'command-guard': { isOff: boolean }
    'usage-band': { hidden: ModSwitchBandColumn[] }
    roadmap: { placement: ModSwitchPlacement }
  }
}
