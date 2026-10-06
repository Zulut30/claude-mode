import type { Register, RenderChildren, SessionRateLimit } from 'claude-code'

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

  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
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
  // Once-a-minute tick: keeps the countdown to limit resets fresh.
  on('session.start', async ($, e, next) => {
    $.clock.every(60_000, () => $.ui.invalidate('ui.render'))

    return next(e)
  })

  // The engine itself reports when the context or a limit has moved.
  on('session.measure', ($, e, next) => {
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

    const usage = await $.session.usage({ breakdown: 'summary' })
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

    // Even columns, like stat cards: title on top, value below.
    const count = 2 + Math.max(1, rateLimits.length)
    const perRow = Math.min(count, e.props.bodyColumns >= 80 ? 4 : 2)
    const width = `${Math.floor(100 / perRow)}%`

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
          {column('context', 'CONTEXT', [
            percentText(context.percent),
            bar('context-bar', context.percent, `Context: ${context.percent ?? 0}%`),
            <Text dimColor>
              {context.tokens === undefined
                ? 'after the first answer'
                : `${formatTokens(context.tokens)}/${formatTokens(context.window)}`}
            </Text>,
          ])}
          {column(
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
          )}
          {rateLimits.length === 0
            ? column('limits', 'SUBSCRIPTION', [<Text dimColor>after the first answer</Text>])
            : rateLimits.map((limit: SessionRateLimit) => {
                const left = formatLeft(limit.resetsAt, now)

                return column(`limit-${limit.kind}`, LIMIT_LABELS[limit.kind] ?? limit.kind.toUpperCase(), [
                  percentText(limit.percentUsed),
                  bar(`limit-${limit.kind}-bar`, limit.percentUsed, `${limit.kind}: ${limit.percentUsed}%`),
                  left ? <Text dimColor>↻ {left}</Text> : null,
                ])
              })}
        </Box>
        {others}
      </Box>
    )
  })
}
