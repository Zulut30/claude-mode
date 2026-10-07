/** Скорость ответа модели для колонки «СКОРОСТЬ». */
export type Speed = {
  /** Токены в секунду: живая оценка во время ответа или средняя за ход после. */
  rate: number
  /** Идёт ли ответ прямо сейчас (тогда `rate` — оценка). */
  isLive: boolean
  /** Токенов за ход и секунд генерации — по точному счёту API. */
  tokens: number
  seconds: number
  /** Скорость последних шагов хода, для мини-диаграммы. */
  history: number[]
}

/** Срок кэша промпта: 5 минут или час. */
export type CacheTtl = '5m' | '1h'

/** Кэш промпта основной модели для колонки «КЭШ». */
export type PromptCache = {
  /** Когда закончился последний запрос основной модели (мс). */
  at: number
  /** Срок из счёта API; нет — ответы его не называли, срок угадывается по тарифу. */
  ttl?: CacheTtl
}

/** Колонка полосы: `limits` — все колонки лимитов подписки разом (5 часов, неделя). */
export type BandColumn = 'context' | 'memory' | 'limits' | 'speed' | 'cache'

declare module 'claude-code' {
  interface PluginState {
    /** `hidden` — колонки, скрытые командой `/band hide`; хранится между сессиями. */
    'usage-band': { speed: Speed | null; cache: PromptCache | null; hidden: BandColumn[] }
  }
}
