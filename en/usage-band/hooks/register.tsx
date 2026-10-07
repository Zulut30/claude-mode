import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionRateLimit } from 'claude-code'

import type { BandColumn, PromptCache, Speed } from '../types'
import { formatCount, formatRate, TTL_MS, watchSpeed } from './speed'

/** The same state speed.ts writes: the engine wants whatever a file reads declared in that file. */
const speed = atom({ plugin: 'usage-band', key: 'speed' } as const, null as Speed | null)
const cache = atom({ plugin: 'usage-band', key: 'cache' } as const, null as PromptCache | null)

/** Hidden columns: `/band` writes them, the band reads them; kept across sessions in `$.store`. */
const hidden = atom({ plugin: 'usage-band', key: 'hidden' } as const, [] as BandColumn[])
const HIDDEN_KEY = 'hidden'

/** The columns in band order: the label for replies and the names `/band` knows them by. */
export const COLUMNS: readonly { id: BandColumn; label: string; names: readonly string[] }[] = [
  { id: 'context', label: 'Context', names: [] },
  { id: 'memory', label: 'Memory', names: [] },
  { id: 'limits', label: 'Limits', names: ['limit', 'subscription'] },
  { id: 'speed', label: 'Speed', names: [] },
  { id: 'cache', label: 'Cache', names: [] },
]

/** A column by the word in the command: `cache` or `Cache`, case doesn't matter. */
export const columnOf = (word: string): BandColumn | undefined => {
  const name = word.trim().toLowerCase()

  return COLUMNS.find(one => one.id === name || one.names.includes(name))?.id
}

const labelOf = (id: BandColumn) => COLUMNS.find(one => one.id === id)?.label ?? id

const COLUMN_NAMES = 'context, memory, limits, speed, cache'

/** The reply to a bare `/band`: what's shown, what's hidden and how to switch. */
export const bandStatus = (off: readonly BandColumn[]) => {
  const list = (ids: BandColumn[]) => (ids.length === 0 ? 'none' : ids.map(labelOf).join(', '))
  const ids = COLUMNS.map(one => one.id)

  return (
    `Band above the prompt: shown — ${list(ids.filter(id => !off.includes(id)))}; hidden — ${list(ids.filter(id => off.includes(id)))}. ` +
    `Hide: /band hide <column>, bring back: /band show <column> (${COLUMN_NAMES}).`
  )
}

/** How long the cache has left: "4 min", "1h". */
export const formatCacheLeft = (ms: number) => {
  const minutes = Math.ceil(ms / 60_000)

  return minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes} min`
}

const BLUE = '#58a6ff'

/** Mini chart of step speeds: bars on desktop. */
const speedBarsSvg = (values: number[], color: string) => {
  const width = values.length * 4 - 1
  const max = Math.max(...values, 1)
  const bars = values
    .map((value, index) => {
      const h = Math.max(2, Math.round((value / max) * 12))

      return `<rect x="${index * 4}" y="${12 - h}" width="3" height="${h}" rx="1" fill="${color}" fill-opacity="${index === values.length - 1 ? 1 : 0.55}"/>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="12" viewBox="0 0 ${width} 12">${bars}</svg>`
}

/** The same chart in characters for the terminal. */
const speedBarsText = (values: number[]) => {
  const blocks = '▁▂▃▄▅▆▇█'
  const max = Math.max(...values, 1)

  return values.map(value => blocks[Math.min(7, Math.round((value / max) * 7))] ?? '').join('')
}

const GREEN = '#3fb950'
const AMBER = '#d29922'
const RED = '#f85149'
const TRACK = '#8b949e55'

const BAR_CELLS = 8
const BAR_WIDTH = 40
const BAR_HEIGHT = 6

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5 HOURS',
  seven_day: 'WEEK',
  spend_limit: 'SPEND',
}

export const formatTokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n)

export const formatLeft = (resetsAt: string | undefined, now: number) => {
  const ms = resetsAt ? Date.parse(resetsAt) - now : NaN
  if (!(ms > 0)) {
    return ''
  }

  const minutes = Math.ceil(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60

  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins} min` : `${mins} min`
}

export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

const levelColor = (percent: number) => (percent >= 90 ? RED : percent >= 70 ? AMBER : GREEN)

const clamp = (percent: number) => Math.max(0, Math.min(100, percent))

const barSvg = (percent: number) => {
  const width = Math.round((BAR_WIDTH * clamp(percent)) / 100)
  const r = BAR_HEIGHT / 2

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_WIDTH}" height="${BAR_HEIGHT}" viewBox="0 0 ${BAR_WIDTH} ${BAR_HEIGHT}">` +
    `<rect width="${BAR_WIDTH}" height="${BAR_HEIGHT}" rx="${r}" fill="${TRACK}"/>` +
    (width > 0
      ? `<rect width="${Math.max(width, BAR_HEIGHT)}" height="${BAR_HEIGHT}" rx="${r}" fill="${levelColor(percent)}"/>`
      : '') +
    `</svg>`
  )
}

export const register: Register = on => {
  // The model's response speed: the reply stream → the SPEED column.
  watchSpeed(on)

  // Once-a-minute tick: the countdown to limit resets. And the `/band` command with the hidden columns.
  on('session.start', async ($, e, next) => {
    $.clock.every(60_000, () => $.ui.invalidate('ui.render'))
    // The name is taken by another plugin — no command then, but the rest of the session start must go on.
    await $.command
      .register({
        name: 'band',
        description: 'Columns of the band above the prompt: `/band` shows which are on, `/band hide cache` hides one, `/band show cache` brings it back',
        argumentHint: '[hide|show <column>]',
        immediate: true,
      })
      .catch(() => undefined)
    const saved = await $.store.get(HIDDEN_KEY).catch(() => undefined)
    const ids = Array.isArray(saved) ? COLUMNS.map(one => one.id).filter(id => saved.includes(id)) : []
    await update($, hidden, () => ids)

    return next(e)
  })

  on('command.run', { command: 'band' }, async ($, e) => {
    const [verb = '', ...words] = e.args.trim().toLowerCase().split(/\s+/)
    if (verb === 'hide' || verb === 'show') {
      const id = columnOf(words.join(' '))
      if (!id) {
        return { text: `No such column: "${words.join(' ')}". Columns: ${COLUMN_NAMES}.` }
      }
      const off = await update($, hidden, ids => {
        const rest = ids.filter(one => one !== id)

        return verb === 'hide' ? [...rest, id] : rest
      })
      await $.store.set(HIDDEN_KEY, off).catch(() => undefined)

      return {
        text: verb === 'hide' ? `The ${labelOf(id)} column is hidden. Bring it back: /band show ${id}` : `The ${labelOf(id)} column is back on the band.`,
      }
    }
    if (verb !== '') {
      return { text: `Didn't get "${e.args.trim()}". ${bandStatus(await read($, hidden))}` }
    }

    return { text: bandStatus(await read($, hidden)) }
  })

  /**
   * The last `session.usage` answer. The live speed redraws the band often,
   * but usage only changes on a measurement — so wait for that instead of asking every time.
   */
  let usageCache: ReturnType<EngineInterface['session']['usage']> | undefined

  // The engine itself reports when the context or a limit has moved.
  on('session.measure', ($, e, next) => {
    usageCache = undefined
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined

    usageCache ??= $.session.usage({ breakdown: 'summary' }).catch(error => {
      usageCache = undefined
      throw error
    })
    const usage = await usageCache
    const now = await $.clock.now()
    const { context, rateLimits } = usage
    const memoryFiles = context.breakdown?.memoryFiles ?? []
    const memoryTokens = memoryFiles.reduce((sum, file) => sum + file.tokens, 0)

    // Bar: a rounded SVG on desktop, a line of characters in the terminal.
    const bar = (key: string, percent: number | undefined, alt: string) => {
      const value = percent ?? 0
      if (Svg) {
        return <Svg key={key} source={barSvg(value)} alt={alt} width={BAR_WIDTH} height={BAR_HEIGHT} />
      }

      const filled = Math.round((BAR_CELLS * clamp(value)) / 100)

      return (
        <Box key={key} flexDirection="row">
          <Text color={levelColor(value)}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'─'.repeat(BAR_CELLS - filled)}</Text>
        </Box>
      )
    }

    const percentText = (percent: number | undefined) =>
      percent === undefined ? (
        <Text dimColor>—</Text>
      ) : (
        <Text color={levelColor(percent)} bold>
          {Math.round(percent)}%
        </Text>
      )

    const pace = await read($, speed)
    const warm = await read($, cache)
    const off = await read($, hidden)
    const isShown = (id: BandColumn) => !off.includes(id)

    // Even columns, like stat cards: title on top, value below.
    // As many per row as fit (~20 cells per column); if not all fit, rows are split evenly, not 5 + 1.
    // Columns hidden by `/band hide` don't count; "limits" is as many columns as the subscription has limits.
    const count = COLUMNS.reduce(
      (sum, one) => sum + (isShown(one.id) ? (one.id === 'limits' ? Math.max(1, rateLimits.length) : 1) : 0),
      0,
    )
    if (count === 0) {
      return next(e)
    }
    const fit = Math.max(2, Math.floor(e.props.bodyColumns / 20))
    const perRow = count <= fit ? count : Math.ceil(count / Math.ceil(count / fit))
    const width = `${Math.floor(100 / perRow)}%`

    // Prompt cache: while it's warm, the next message is cheaper on limits; once cold, the conversation is processed anew.
    const cacheValue = (): RenderChildren[] => {
      if (warm === null) {
        return [<Text dimColor>after a reply</Text>]
      }
      // Replies didn't name the lifetime — go by the plan: an hour on a subscription, five minutes with an API key.
      const life = TTL_MS[warm.ttl ?? (rateLimits.length > 0 ? '1h' : '5m')]
      const left = warm.at + life - now
      if (left <= 0) {
        return [
          <Text color={AMBER} bold>
            cold
          </Text>,
          <Text dimColor>{context.tokens === undefined ? 'all anew' : `${formatTokens(context.tokens)} anew`}</Text>,
        ]
      }
      const used = (100 * (life - left)) / life

      return [
        <Text color={levelColor(used)} bold>
          {formatCacheLeft(left)}
        </Text>,
        bar('cache-bar', used, `Cache: ${formatCacheLeft(left)} left`),
        <Text dimColor>of {formatCacheLeft(life)}</Text>,
      ]
    }

    const column = (key: string, title: string, value: RenderChildren) => (
      <Box key={key} flexDirection="column" width={width}>
        <Text dimColor bold>
          {title}
        </Text>
        <Box key={`${key}-value`} flexDirection="row" alignItems="center" columnGap={1}>
          {value}
        </Box>
      </Box>
    )

    // The band shares the space above the prompt with other mods: their render (`next`) goes below.
    const others = await next(e)

    return (
      <Box flexDirection="column">
        <Box key="usage" flexDirection="row" flexWrap="wrap" rowGap={1}>
          {isShown('context')
            ? column('context', 'CONTEXT', [
                percentText(context.percent),
                bar('context-bar', context.percent, `Context: ${context.percent ?? 0}%`),
                <Text dimColor>
                  {context.tokens === undefined
                    ? 'after the first reply'
                    : `${formatTokens(context.tokens)}/${formatTokens(context.window)}`}
                </Text>,
              ])
            : null}
          {isShown('memory')
            ? column(
                'memory',
                'MEMORY',
                memoryFiles.length === 0
                  ? [<Text dimColor>none</Text>]
                  : [
                      <Text>
                        {memoryFiles.length} {plural(memoryFiles.length, 'file', 'files')}
                      </Text>,
                      <Text dimColor>~{formatTokens(memoryTokens)} tok.</Text>,
                    ],
              )
            : null}
          {!isShown('limits')
            ? null
            : rateLimits.length === 0
              ? column('limits', 'SUBSCRIPTION', [<Text dimColor>after the first reply</Text>])
              : rateLimits.map((limit: SessionRateLimit) => {
                  const left = formatLeft(limit.resetsAt, now)

                  return column(`limit-${limit.kind}`, LIMIT_LABELS[limit.kind] ?? limit.kind.toUpperCase(), [
                    percentText(limit.percentUsed),
                    bar(`limit-${limit.kind}-bar`, limit.percentUsed, `${limit.kind}: ${limit.percentUsed}%`),
                    left ? <Text dimColor>↻ {left}</Text> : null,
                  ])
                })}
          {isShown('speed') ? column(
            'speed',
            'SPEED',
            pace === null
              ? [<Text dimColor>after a reply</Text>]
              : [
                  <Text bold color={pace.isLive ? BLUE : undefined}>
                    {pace.isLive ? '≈' : ''}
                    {formatRate(pace.rate)} tok/s
                  </Text>,
                  pace.history.length >= 2 ? (
                    Svg ? (
                      <Svg
                        key="speed-bars"
                        source={speedBarsSvg(pace.history, BLUE)}
                        alt={`Step speeds: ${pace.history.map(value => Math.round(value)).join(', ')} tok/s`}
                        width={pace.history.length * 4 - 1}
                        height={12}
                      />
                    ) : (
                      <Text color={BLUE}>{speedBarsText(pace.history)}</Text>
                    )
                  ) : null,
                  <Text dimColor>{pace.isLive ? 'replying' : `${formatCount(pace.tokens)} tok`}</Text>,
                ],
          ) : null}
          {isShown('cache') ? column('cache', 'CACHE', cacheValue()) : null}
        </Box>
        {others}
      </Box>
    )
  })
}
