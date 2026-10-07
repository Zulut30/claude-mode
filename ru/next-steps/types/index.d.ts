/** Одна подсказка: короткая подпись на кнопку и полный запрос, который вставляется черновиком. */
export type NextStep = {
  label: string
  prompt: string
}

/** Подсказки после ответа: к какому ходу они, сами запросы, цель сессии и чего ассистент ждёт. */
export type NextSteps = {
  /** Ход, после которого предложены: новый запрос или ход их убирает. */
  turnId: string
  /** 0–3 подсказки. */
  items: NextStep[]
  /** Общая цель сессии в нескольких словах. */
  goal?: string
  /** Чего ассистент ждёт от человека прямо сейчас; нет — ничего не ждёт. */
  waiting?: string
}

declare module 'claude-code' {
  interface PluginState {
    /** `goal` — последняя известная цель: держится между ходами и уходит в следующий запрос к модели. */
    'next-steps': { steps: NextSteps | null; isOff: boolean; goal: string }
  }
}
