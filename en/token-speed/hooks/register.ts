import type { Register } from 'claude-code'

/** How often to refresh the line under the prompt while the model answers. */
const SHOW_EVERY_MS = 250

/** How long to wait after the first chunk before showing the speed: it jumps around at the start. */
const WARMUP_MS = 400

/** Characters per token for the live estimate; refined from the exact count after each answer. */
const START_CHARS_PER_TOKEN = 3.2

/** Number with commas between thousands: 1240 → "1,240". */
export const formatCount = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export const formatRate = (tokensPerSecond: number) =>
  tokensPerSecond >= 10 ? formatCount(tokensPerSecond) : tokensPerSecond.toFixed(1)

/** Line while answering: estimated from characters, hence "≈". */
export const liveLine = (tokensPerSecond: number) => `⚡ ≈${formatRate(tokensPerSecond)} tok/s`

/** Line after the answer: exact token count from the API. */
export const finalLine = (tokens: number, seconds: number) =>
  `⚡ ${formatRate(tokens / seconds)} tok/s · ${formatCount(tokens)} tokens in ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`

/** New "characters per token" estimate: smoothed so one unusual answer doesn't throw it off. */
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

    // Subagent steps run in parallel — only count the main answer.
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
      // Time starts at the first chunk: waiting before it is latency, not speed.
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
