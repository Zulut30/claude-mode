import type { Register } from 'claude-code'

/** How often to refresh the line under the prompt while the model answers. */
const SHOW_EVERY_MS = 250

/** The live speed covers the last seconds of the answer, not everything since it started. */
const WINDOW_MS = 2000

/** How long to wait after the first chunk before showing the speed: it jumps around at the start. */
const WARMUP_MS = 400

/** Characters per token for the live estimate; refined from the exact count of answers without thinking. */
const START_CHARS_PER_TOKEN = 3.2

/** Steps shorter than this stay out of the chart: over a few dozen tokens the speed is noise. */
const MIN_STEP_TOKENS = 40

const SPARK = '▁▂▃▄▅▆▇█'

/** Number with commas between thousands: 1240 → "1,240". */
export const formatCount = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export const formatRate = (tokensPerSecond: number) =>
  tokensPerSecond >= 10 ? formatCount(tokensPerSecond) : tokensPerSecond.toFixed(1)

export const formatSeconds = (seconds: number) => {
  if (seconds < 10) {
    return `${seconds.toFixed(1)} s`
  }
  if (seconds < 60) {
    return `${Math.round(seconds)} s`
  }
  const minutes = Math.floor(seconds / 60)

  return `${minutes} min ${Math.round(seconds % 60)} s`
}

/** Mini chart of step speeds: ▂▄▆▅▇, lowest to highest within the series. */
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

/** Line while answering: estimated from characters, hence "≈". */
export const liveLine = (tokensPerSecond: number, history: number[] = []) => {
  const spark = sparkline(history)

  return `⚡ ≈${formatRate(tokensPerSecond)} tok/s${spark ? ` ${spark}` : ''}`
}

/** Line after a step: average speed over the turn from the exact API token count. */
export const finalLine = (tokens: number, seconds: number, history: number[] = []) => {
  const spark = sparkline(history)

  return `⚡ ${formatRate(tokens / seconds)} tok/s${spark ? ` ${spark}` : ''} · ${formatCount(tokens)} tokens in ${formatSeconds(seconds)}`
}

/** New "characters per token" estimate: smoothed, and only from answers whose whole text was visible. */
export const calibrate = (ratio: number, chars: number, tokens: number, hadThinking: boolean) => {
  if (hadThinking || chars < 200 || tokens < 50) {
    return ratio
  }
  const next = ratio * 0.7 + (chars / tokens) * 0.3

  // Sane bounds: code and English run ~3–4 characters per token, Cyrillic text ~2–3.
  return Math.max(1.5, Math.min(5, next))
}

/** Speed over a sliding window: characters from the last WINDOW_MS. */
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

  // Turn: tokens and generation time across all its steps, plus step speeds for the chart.
  let turnId = ''
  let turnTokens = 0
  let turnMs = 0
  let history: number[] = []

  on('turn.step', async function* ($, e, next) {
    const stream = next(e)

    // Subagent steps run in parallel — only count the main answer.
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
        // Time starts at the first chunk: waiting before it is latency, not speed.
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
      // The answer was interrupted or failed: don't leave "≈" hanging; show the turn total if there is one.
      if (!isDone && shownAt > 0) {
        $.ui.status(turnTokens > 0 ? finalLine(turnTokens, turnMs / 1000, history) : undefined)
      }
    }
  })
}
