/** Подсказки после ответа: к какому ходу они и сами запросы. */
export type NextSteps = {
  /** Ход, после которого предложены: новый запрос или ход их убирает. */
  turnId: string
  /** 2–3 запроса, каждый — готовый черновик. */
  items: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'next-steps': { steps: NextSteps | null; isOff: boolean }
  }
}
