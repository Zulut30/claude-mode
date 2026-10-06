import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { CacheTtl, PromptCache, Speed } from '../types'

/** The model's response speed: the SPEED column reads it from here. */
export const speed = atom({ plugin: 'usage-band', key: 'speed' } as const, null as Speed | null)

/** The main model's last request and its cache lifetime: the CACHE column reads them from here. */
export const cache = atom({ plugin: 'usage-band', key: 'cache' } as const, null as PromptCache | null)

/** How long the prompt cache lives after the last request. */
export const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

/** The API reports the cache-write lifetime in the reply's usage; the engine's types lack this field. */
type CacheWrite = { cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } }

export const ttlOf = (usage: unknown): CacheTtl | undefined => {
  const written = (usage as CacheWrite | undefined)?.cache_creation

  return Number(written?.ephemeral_1h_input_tokens) > 0 ? '1h' : Number(written?.ephemeral_5m_input_tokens) > 0 ? '5m' : undefined
}

/** How often to refresh the live speed during a reply: once a second reads calmly and doesn't flood redraws. */
const SHOW_EVERY_MS = 1000

/** The live speed covers the reply's last seconds, not everything since it started. */
const WINDOW_MS = 2000

/** How long to wait after the first chunk before showing the speed: it jumps around at the start. */
const WARMUP_MS = 400

/** Characters per token for the live estimate; refined from the exact counts of replies without thinking. */
const START_CHARS_PER_TOKEN = 3.2

/** A step shorter than this stays out of the chart: over a dozen tokens the speed is noise. */
const MIN_STEP_TOKENS = 40

/** A number with thousands separators: 1240 → "1,240". */
export const formatCount = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export const formatRate = (tokensPerSecond: number) =>
  tokensPerSecond >= 10 ? formatCount(tokensPerSecond) : tokensPerSecond.toFixed(1)

/** A new "characters per token" estimate: smoothed, and only from replies whose whole text was visible. */
export const calibrate = (ratio: number, chars: number, tokens: number, hadThinking: boolean) => {
  if (hadThinking || chars < 200 || tokens < 50) {
    return ratio
  }

  return Math.max(1.5, Math.min(5, ratio * 0.7 + (chars / tokens) * 0.3))
}

/** Speed over a sliding window: the characters of the last WINDOW_MS. */
export const windowRate = (samples: { at: number; chars: number }[], now: number, charsPerToken: number) => {
  const recent = samples.filter(sample => now - sample.at <= WINDOW_MS)
  if (recent.length < 2) {
    return undefined
  }
  const span = (now - (recent[0]?.at ?? now)) / 1000
  const chars = recent.slice(1).reduce((sum, sample) => sum + sample.chars, 0)

  return span > 0.2 ? chars / charsPerToken / span : undefined
}

/** Watches the main model's reply stream and writes the speed into state. */
export const watchSpeed = (on: On) => {
  let charsPerToken = START_CHARS_PER_TOKEN
  let turnId = ''
  let turnTokens = 0
  let turnMs = 0
  let history: number[] = []
  /** A redraw the moment the cache goes cold; the minutes before that are refreshed by the band's minute timer. */
  let expiry: { cancel: () => void } | undefined

  on('turn.step', async function* ($, e, next) {
    const stream = next(e)

    // Subagent steps run in parallel — only the main reply counts.
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
        // Time counts from the reply's first chunk: the wait before it is latency, not speed.
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

      // Every request extends the conversation's cache by its lifetime.
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
      // The reply was interrupted or failed: don't leave a live estimate behind; show the turn's total if there is one.
      if (!isDone && shownAt > 0) {
        await update($, speed, total)
      }
    }
  })
}
