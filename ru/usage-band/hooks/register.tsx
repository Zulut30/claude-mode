import type { Register, RenderChildren, SessionRateLimit } from 'claude-code'

const GREEN = '#3fb950'
const AMBER = '#d29922'
const RED = '#f85149'
const TRACK = '#8b949e55'

const BAR_CELLS = 8
const BAR_WIDTH = 40
const BAR_HEIGHT = 6

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5 ЧАСОВ',
  seven_day: 'НЕДЕЛЯ',
  spend_limit: 'РАСХОДЫ',
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

  return days > 0 ? `${days} д ${hours} ч` : hours > 0 ? `${hours} ч ${mins} мин` : `${mins} мин`
}

export const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) {
    return one
  }

  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many
}

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
  // Таймер раз в минуту: обратный отсчёт до сброса лимитов.
  on('session.start', async ($, e, next) => {
    $.clock.every(60_000, () => $.ui.invalidate('ui.render'))

    return next(e)
  })

  // Движок сам сообщает, когда сдвинулся контекст или лимит.
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

    // Полоска: на десктопе — SVG со скруглением, в терминале — линия из символов.
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

    // Ровные колонки, как карточки статистики: подпись сверху, значение снизу.
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

    // Полоса делит место над полем ввода с другими модами: их рисунок (`next`) идёт ниже.
    const others = await next(e)

    return (
      <Box flexDirection="column">
        <Box key="usage" flexDirection="row" flexWrap="wrap" rowGap={1}>
          {column('context', 'КОНТЕКСТ', [
            percentText(context.percent),
            bar('context-bar', context.percent, `Контекст: ${context.percent ?? 0}%`),
            <Text dimColor>
              {context.tokens === undefined
                ? 'после первого ответа'
                : `${formatTokens(context.tokens)}/${formatTokens(context.window)}`}
            </Text>,
          ])}
          {column(
            'memory',
            'ПАМЯТЬ',
            memoryFiles.length === 0
              ? [<Text dimColor>нет</Text>]
              : [
                  <Text>
                    {memoryFiles.length} {plural(memoryFiles.length, 'файл', 'файла', 'файлов')}
                  </Text>,
                  <Text dimColor>~{formatTokens(memoryTokens)} ток.</Text>,
                ],
          )}
          {rateLimits.length === 0
            ? column('limits', 'ПОДПИСКА', [<Text dimColor>после первого ответа</Text>])
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
