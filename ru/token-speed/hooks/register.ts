import type { Register } from 'claude-code'

/** Как часто обновлять строку под полем ввода во время ответа. */
const SHOW_EVERY_MS = 250

/** Живая скорость считается по последним секундам ответа, а не от его начала. */
const WINDOW_MS = 2000

/** Сколько ждать после первого куска, прежде чем показывать скорость: в начале она скачет. */
const WARMUP_MS = 400

/** Символов на токен для живой оценки; уточняется по точному счёту ответов без размышлений. */
const START_CHARS_PER_TOKEN = 3.2

/** Шаг короче этого не попадает в график: на десятке токенов скорость случайна. */
const MIN_STEP_TOKENS = 40

const SPARK = '▁▂▃▄▅▆▇█'

/** Число с пробелами между разрядами: 1240 → «1 240». */
export const formatCount = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

export const formatRate = (tokensPerSecond: number) =>
  tokensPerSecond >= 10 ? formatCount(tokensPerSecond) : tokensPerSecond.toFixed(1)

export const formatSeconds = (seconds: number) => {
  if (seconds < 10) {
    return `${seconds.toFixed(1)} с`
  }
  if (seconds < 60) {
    return `${Math.round(seconds)} с`
  }
  const minutes = Math.floor(seconds / 60)

  return `${minutes} мин ${Math.round(seconds % 60)} с`
}

/** Мини-график скоростей шагов: ▂▄▆▅▇, от меньшей к большей в пределах ряда. */
export const sparkline = (values: number[]) => {
  if (values.length < 2) {
    return ''
  }
  const min = Math.min(...values)
  const max = Math.max(...values)

  return values
    .map(value => SPARK[max === min ? 3 : Math.round(((value - min) / (max - min)) * (SPARK.length - 1))] ?? '')
    .join('')
}

/** Строка во время ответа: оценка по символам, поэтому «≈». */
export const liveLine = (tokensPerSecond: number, history: number[] = []) => {
  const spark = sparkline(history)

  return `⚡ ≈${formatRate(tokensPerSecond)} ток/с${spark ? ` ${spark}` : ''}`
}

/** Строка после шага: средняя скорость за ход по точному счёту токенов от API. */
export const finalLine = (tokens: number, seconds: number, history: number[] = []) => {
  const spark = sparkline(history)

  return `⚡ ${formatRate(tokens / seconds)} ток/с${spark ? ` ${spark}` : ''} · ${formatCount(tokens)} ток за ${formatSeconds(seconds)}`
}

/** Новая оценка «символов на токен»: плавно и только по ответам, где весь текст был виден. */
export const calibrate = (ratio: number, chars: number, tokens: number, hadThinking: boolean) => {
  if (hadThinking || chars < 200 || tokens < 50) {
    return ratio
  }
  const next = ratio * 0.7 + (chars / tokens) * 0.3

  // Разумные пределы: код и английский ~3–4 символа на токен, русский ~2–3.
  return Math.max(1.5, Math.min(5, next))
}

/** Скорость по скользящему окну: символы последних WINDOW_MS. */
export const windowRate = (samples: { at: number; chars: number }[], now: number, charsPerToken: number) => {
  const recent = samples.filter(sample => now - sample.at <= WINDOW_MS)
  if (recent.length < 2) {
    return undefined
  }
  const first = recent[0]
  const span = (now - (first?.at ?? now)) / 1000
  const chars = recent.slice(1).reduce((sum, sample) => sum + sample.chars, 0)

  return span > 0.2 ? chars / charsPerToken / span : undefined
}

export const register: Register = on => {
  let charsPerToken = START_CHARS_PER_TOKEN

  // Ход: токены и время генерации по всем его шагам, и скорости шагов для графика.
  let turnId = ''
  let turnTokens = 0
  let turnMs = 0
  let history: number[] = []

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
            $.ui.status(liveLine(rate, history))
          }
        }

        yield chunk
        step = await stream.next()
      }

      const result = step.value ?? (await stream.result)
      const tokens = result.usage?.output_tokens ?? 0
      if (firstAt !== undefined && tokens > 0) {
        const ms = Math.max(100, (lastAt || (await $.clock.now())) - firstAt)
        turnTokens += tokens
        turnMs += ms
        if (tokens >= MIN_STEP_TOKENS) {
          history = [...history, tokens / (ms / 1000)].slice(-10)
        }
        charsPerToken = calibrate(charsPerToken, chars, tokens, hadThinking)
        $.ui.status(finalLine(turnTokens, turnMs / 1000, history))
        isDone = true
      }

      return result
    } finally {
      // Ответ прервали или он упал: не оставляем «≈» висеть, показываем итог хода, если он есть.
      if (!isDone && shownAt > 0) {
        $.ui.status(turnTokens > 0 ? finalLine(turnTokens, turnMs / 1000, history) : undefined)
      }
    }
  })
}
