import type { Register } from 'claude-code'

/** Как часто обновлять строку под полем ввода во время ответа. */
const SHOW_EVERY_MS = 250

/** Сколько ждать после первого куска, прежде чем показывать скорость: в начале она скачет. */
const WARMUP_MS = 400

/** Символов на токен для живой оценки; уточняется по точному счёту после каждого ответа. */
const START_CHARS_PER_TOKEN = 3.2

/** Число с пробелами между разрядами: 1240 → «1 240». */
export const formatCount = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

export const formatRate = (tokensPerSecond: number) =>
  tokensPerSecond >= 10 ? formatCount(tokensPerSecond) : tokensPerSecond.toFixed(1)

/** Строка во время ответа: оценка по символам, поэтому «≈». */
export const liveLine = (tokensPerSecond: number) => `⚡ ≈${formatRate(tokensPerSecond)} ток/с`

/** Строка после ответа: точный счёт токенов от API. */
export const finalLine = (tokens: number, seconds: number) =>
  `⚡ ${formatRate(tokens / seconds)} ток/с · ${formatCount(tokens)} ток за ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} с`

/** Новая оценка «символов на токен»: плавно, чтобы один необычный ответ не сбил её. */
export const calibrate = (ratio: number, chars: number, tokens: number) => {
  if (chars < 200 || tokens < 50) {
    return ratio
  }

  return ratio * 0.7 + (chars / tokens) * 0.3
}

export const register: Register = on => {
  let charsPerToken = START_CHARS_PER_TOKEN

  on('turn.step', async function* ($, e, next) {
    const stream = next(e)

    // Шаги субагентов идут параллельно — считаем только основной ответ.
    if (e.agentId) {
      return yield* stream
    }

    let firstAt: number | undefined
    let shownAt = 0
    let chars = 0

    let step = await stream.next()
    while (!step.done) {
      const chunk = step.value
      const now = await $.clock.now()
      // Время считаем с первого куска ответа: ожидание до него — это задержка, а не скорость.
      firstAt ??= now

      if (chunk.kind === 'text' || chunk.kind === 'thinking') {
        chars += chunk.text.length
      } else if (chunk.kind === 'input') {
        chars += chunk.json.length
      }

      const elapsed = now - firstAt
      if (chars > 0 && elapsed >= WARMUP_MS && now - shownAt >= SHOW_EVERY_MS) {
        shownAt = now
        $.ui.status(liveLine(chars / charsPerToken / (elapsed / 1000)))
      }

      yield chunk
      step = await stream.next()
    }

    const result = step.value ?? (await stream.result)
    const tokens = result.usage?.output_tokens ?? 0
    if (firstAt !== undefined && tokens > 0) {
      const seconds = Math.max(0.1, ((await $.clock.now()) - firstAt) / 1000)
      $.ui.status(finalLine(tokens, seconds))
      charsPerToken = calibrate(charsPerToken, chars, tokens)
    }

    return result
  })
}
