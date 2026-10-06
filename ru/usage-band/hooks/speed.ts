import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { CacheTtl, PromptCache, Speed } from '../types'

/** Скорость ответа модели: колонка «СКОРОСТЬ» читает её отсюда. */
export const speed = atom({ plugin: 'usage-band', key: 'speed' } as const, null as Speed | null)

/** Последний запрос основной модели и срок её кэша: колонка «КЭШ» читает их отсюда. */
export const cache = atom({ plugin: 'usage-band', key: 'cache' } as const, null as PromptCache | null)

/** Сколько живёт кэш промпта после последнего запроса. */
export const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

/** Срок записи в кэш API отдаёт в счёте ответа; в типах движка этого поля нет. */
type CacheWrite = { cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } }

export const ttlOf = (usage: unknown): CacheTtl | undefined => {
  const written = (usage as CacheWrite | undefined)?.cache_creation

  return Number(written?.ephemeral_1h_input_tokens) > 0 ? '1h' : Number(written?.ephemeral_5m_input_tokens) > 0 ? '5m' : undefined
}

/** Как часто обновлять живую скорость во время ответа: раз в секунду читается спокойно и не грузит перерисовкой. */
const SHOW_EVERY_MS = 1000

/** Живая скорость считается по последним секундам ответа, а не от его начала. */
const WINDOW_MS = 2000

/** Сколько ждать после первого куска, прежде чем показывать скорость: в начале она скачет. */
const WARMUP_MS = 400

/** Символов на токен для живой оценки; уточняется по точному счёту ответов без размышлений. */
const START_CHARS_PER_TOKEN = 3.2

/** Шаг короче этого не попадает в диаграмму: на десятке токенов скорость случайна. */
const MIN_STEP_TOKENS = 40

/** Число с пробелами между разрядами: 1240 → «1 240». */
export const formatCount = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

export const formatRate = (tokensPerSecond: number) =>
  tokensPerSecond >= 10 ? formatCount(tokensPerSecond) : tokensPerSecond.toFixed(1)

/** Новая оценка «символов на токен»: плавно и только по ответам, где весь текст был виден. */
export const calibrate = (ratio: number, chars: number, tokens: number, hadThinking: boolean) => {
  if (hadThinking || chars < 200 || tokens < 50) {
    return ratio
  }

  return Math.max(1.5, Math.min(5, ratio * 0.7 + (chars / tokens) * 0.3))
}

/** Скорость по скользящему окну: символы последних WINDOW_MS. */
export const windowRate = (samples: { at: number; chars: number }[], now: number, charsPerToken: number) => {
  const recent = samples.filter(sample => now - sample.at <= WINDOW_MS)
  if (recent.length < 2) {
    return undefined
  }
  const span = (now - (recent[0]?.at ?? now)) / 1000
  const chars = recent.slice(1).reduce((sum, sample) => sum + sample.chars, 0)

  return span > 0.2 ? chars / charsPerToken / span : undefined
}

/** Следит за потоком ответа основной модели и пишет скорость в состояние. */
export const watchSpeed = (on: On) => {
  let charsPerToken = START_CHARS_PER_TOKEN
  let turnId = ''
  let turnTokens = 0
  let turnMs = 0
  let history: number[] = []
  /** Перерисовка в миг, когда кэш остывает; минуты до него обновляет минутный таймер полосы. */
  let expiry: { cancel: () => void } | undefined

  on('turn.step', async function* ($, e, next) {
    const stream = next(e)

    // Шаги субагентов идут параллельно — считаем только основной ответ.
    if (e.agentId) {
      return yield* stream
    }

    if (e.turnId !== turnId) {
      turnId = e.turnId
      turnTokens = 0
      turnMs = 0
      history = []
    }

    const total = (): Speed | null =>
      turnTokens > 0 ? { rate: turnTokens / (turnMs / 1000), isLive: false, tokens: turnTokens, seconds: turnMs / 1000, history } : null

    let firstAt: number | undefined
    let lastAt = 0
    let shownAt = 0
    let chars = 0
    let hadThinking = false
    let isDone = false
    const samples: { at: number; chars: number }[] = []

    try {
      let step = await stream.next()
      while (!step.done) {
        const chunk = step.value
        const now = await $.clock.now()
        // Время считаем с первого куска ответа: ожидание до него — задержка, а не скорость.
        firstAt ??= now
        lastAt = now

        const size =
          chunk.kind === 'text' || chunk.kind === 'thinking' ? chunk.text.length : chunk.kind === 'input' ? chunk.json.length : 0
        hadThinking ||= chunk.kind === 'thinking'
        if (size > 0) {
          chars += size
          samples.push({ at: now, chars: size })
          while (samples.length > 0 && now - (samples[0]?.at ?? now) > WINDOW_MS) {
            samples.shift()
          }
        }

        if (now - firstAt >= WARMUP_MS && now - shownAt >= SHOW_EVERY_MS) {
          const rate = windowRate(samples, now, charsPerToken)
          if (rate !== undefined) {
            shownAt = now
            await update($, speed, () => ({
              rate,
              isLive: true,
              tokens: turnTokens,
              seconds: turnMs / 1000,
              history,
            }))
          }
        }

        yield chunk
        step = await stream.next()
      }

      const result = step.value ?? (await stream.result)

      // Каждый запрос продлевает кэш переписки на его срок.
      const at = await $.clock.now()
      const ttl = ttlOf(result.usage)
      const previous = await read($, cache)
      const life = ttl ?? previous?.ttl
      await update($, cache, () => ({ at, ...(life ? { ttl: life } : {}) }))
      expiry?.cancel()
      expiry = $.clock.after(TTL_MS[life ?? '5m'] + 500, () => $.ui.invalidate('ui.render'))

      const tokens = result.usage?.output_tokens ?? 0
      if (firstAt !== undefined && tokens > 0) {
        const ms = Math.max(100, (lastAt || (await $.clock.now())) - firstAt)
        turnTokens += tokens
        turnMs += ms
        if (tokens >= MIN_STEP_TOKENS) {
          history = [...history, tokens / (ms / 1000)].slice(-12)
        }
        charsPerToken = calibrate(charsPerToken, chars, tokens, hadThinking)
        await update($, speed, total)
        isDone = true
      }

      return result
    } finally {
      // Ответ прервали или он упал: не оставляем живую оценку, показываем итог хода, если он есть.
      if (!isDone && shownAt > 0) {
        await update($, speed, total)
      }
    }
  })
}
