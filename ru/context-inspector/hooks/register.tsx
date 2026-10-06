import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionContextBreakdown } from 'claude-code'

import type { CategoryUsage, Inspection, NamedTokens, SectionId, ServerUsage } from '../types'

const PANE = 'context-inspector'
const TITLE = 'Контекст'

const GREEN = '#3fb950'
const AMBER = '#d29922'
const RED = '#f85149'
const GRAY = '#8b949e'
const TRACK = '#8b949e40'

/** Цвета категорий по порядку убывания размера. */
const PALETTE = ['#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#f778ba', '#39c5cf', '#ff7b72', '#a5d6ff']

/** Высота строки текста на десктопе: по ней значки встают вровень с текстом. */
const LINE_PX = 20

/** Сколько строк показывать в секции, пока её не развернули. */
const SECTION_LIMIT = 5

const inspection = atom({ plugin: 'context-inspector', key: 'inspection' } as const, null)
const isLoading = atom({ plugin: 'context-inspector', key: 'isLoading' } as const, false)
const expanded = atom({ plugin: 'context-inspector', key: 'expanded' } as const, [] as SectionId[])

// ── Разбор ───────────────────────────────────────────────────────────────

const CATEGORY_NAMES: Record<string, string> = {
  'System prompt': 'Системный промпт',
  'System tools': 'Системные инструменты',
  'MCP tools': 'MCP-инструменты',
  'Custom agents': 'Агенты',
  'Memory files': 'Файлы памяти',
  Skills: 'Скиллы',
  'Slash commands': 'Команды',
  Messages: 'Сообщения',
  'Free space': 'Свободно',
  'Autocompact buffer': 'Резерв автосжатия',
}

const MEMORY_KINDS: Record<string, string> = {
  User: 'глобальная',
  Project: 'проекта',
  Local: 'локальная',
  Managed: 'организации',
  AutoMem: 'автопамять',
}

/** Название категории по-русски; «MCP tools (deferred)» → «MCP-инструменты (по запросу)». */
export const categoryName = (name: string) => {
  const match = /^(.*?)\s*\((.*)\)$/.exec(name)
  const base = match?.[1] ?? name
  const note = match?.[2]
  const translated = CATEGORY_NAMES[base] ?? base

  return note ? `${translated} (${note === 'deferred' ? 'по запросу' : note})` : translated
}

/** Имя сервера покороче: длинный UUID коннектора → первые 8 символов. */
export const serverLabel = (name: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name) ? `${name.slice(0, 8)}…` : name.replace(/^plugin:/, '')

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** Разбивка от движка → то, что рисует панель: серверы сгруппированы, списки отсортированы. */
export const summarize = (breakdown: SessionContextBreakdown, at: number): Inspection => {
  const servers = new Map<string, ServerUsage>()
  for (const tool of breakdown.mcpTools) {
    const server = servers.get(tool.serverName) ?? {
      name: tool.serverName,
      tools: 0,
      loaded: 0,
      tokens: 0,
      allTokens: 0,
      example: tool.name.split('__').pop() ?? tool.name,
    }
    server.tools += 1
    server.allTokens += tool.tokens
    if (tool.isLoaded) {
      server.loaded += 1
      server.tokens += tool.tokens
    }
    servers.set(tool.serverName, server)
  }

  const byTokens = <T extends { tokens: number }>(list: T[]) => [...list].sort((a, b) => b.tokens - a.tokens)

  return {
    at,
    model: breakdown.model,
    totalTokens: breakdown.totalTokens,
    maxTokens: breakdown.rawMaxTokens || breakdown.maxTokens,
    percentage: breakdown.percentage,
    categories: breakdown.categories.map(category => ({ name: category.name, tokens: category.tokens, kind: category.kind })),
    servers: [...servers.values()].sort((a, b) => b.tokens - a.tokens || b.allTokens - a.allTokens),
    skills: {
      total: breakdown.skills?.totalSkills ?? 0,
      included: breakdown.skills?.includedSkills ?? 0,
      tokens: breakdown.skills?.tokens ?? 0,
      top: byTokens(breakdown.skills?.skillFrontmatter ?? []).map(skill => ({
        name: skill.pluginName ? `${skill.pluginName}:${skill.name}` : skill.name,
        tokens: skill.tokens,
      })),
    },
    memory: byTokens(breakdown.memoryFiles).map(file => ({
      name: basename(file.path),
      tokens: file.tokens,
      note: MEMORY_KINDS[file.type] ?? file.type,
    })),
    agents: {
      count: breakdown.agents.length,
      tokens: breakdown.agents.reduce((sum, agent) => sum + agent.tokens, 0),
      top: byTokens(breakdown.agents).map(agent => ({ name: agent.agentType, tokens: agent.tokens })),
    },
    autoCompactAt: breakdown.autoCompactThreshold,
    isAutoCompactEnabled: breakdown.isAutoCompactEnabled,
  }
}

// ── Советы ───────────────────────────────────────────────────────────────

export type Tip = { level: 'warn' | 'info' | 'good'; text: string }

export const formatTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) {
    return one
  }

  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many
}

/** Что можно сделать: от срочного к полезному, не больше четырёх. */
export const tips = (data: Inspection): Tip[] => {
  const list: Tip[] = []
  const used = data.categories.filter(category => category.kind === 'used').reduce((sum, category) => sum + category.tokens, 0)

  if (data.percentage >= 85) {
    list.push({ level: 'warn', text: `Окно заполнено на ${data.percentage}% — сделайте /compact, иначе скоро сработает автосжатие` })
  } else if (data.percentage >= 60) {
    list.push({ level: 'info', text: `Занято ${data.percentage}% — для новой большой задачи лучше начать с /clear` })
  }

  if (!data.isAutoCompactEnabled) {
    list.push({ level: 'info', text: 'Автосжатие выключено — при переполнении следите сами' })
  } else if (data.autoCompactAt !== undefined) {
    const left = data.autoCompactAt - data.totalTokens
    if (left > 0 && left < data.maxTokens * 0.2) {
      list.push({ level: 'warn', text: `До автосжатия осталось ~${formatTokens(left)} токенов` })
    }
  }

  const heavy = data.servers.find(server => server.tokens >= Math.max(5000, data.maxTokens * 0.03))
  if (heavy) {
    list.push({
      level: 'info',
      text: `MCP-сервер «${serverLabel(heavy.name)}» занимает ${formatTokens(heavy.tokens)} (${heavy.loaded} ${plural(heavy.loaded, 'инструмент', 'инструмента', 'инструментов')}) — если не нужен, отключите в /mcp`,
    })
  }

  const memory = data.memory.reduce((sum, file) => sum + file.tokens, 0)
  if (memory >= 8000) {
    list.push({ level: 'info', text: `Файлы памяти весят ${formatTokens(memory)} — сократите CLAUDE.md, если там лишнее` })
  }

  if (data.skills.tokens >= 5000) {
    list.push({
      level: 'info',
      text: `Список ${data.skills.total} ${plural(data.skills.total, 'скилла', 'скиллов', 'скиллов')} занимает ${formatTokens(data.skills.tokens)} — отключите неиспользуемые плагины`,
    })
  }

  const messages = data.categories.find(category => category.name === 'Messages')
  if (messages && used > 0 && messages.tokens / used >= 0.7 && data.percentage >= 40) {
    list.push({ level: 'info', text: 'Больше всего места занимает переписка — /compact сожмёт её' })
  }

  const deferred = data.servers.reduce((sum, server) => sum + (server.tools - server.loaded), 0)
  if (deferred > 0) {
    list.push({ level: 'good', text: `${deferred} MCP-${plural(deferred, 'инструмент подгружается', 'инструмента подгружаются', 'инструментов подгружаются')} по запросу и не занимают окно` })
  }

  if (list.length === 0) {
    list.push({ level: 'good', text: 'Всё в порядке: окно свободно, тяжёлых источников нет' })
  }

  return list.slice(0, 4)
}

// ── Снимок ───────────────────────────────────────────────────────────────

let inflight: Promise<void> | null = null

/** Пересчитать разбивку (локальная оценка, без запросов к API); параллельные вызовы ждут один. */
const refresh = ($: EngineInterface) => {
  inflight ??= (async () => {
    await update($, isLoading, () => true)
    try {
      const usage = await $.session.usage({ breakdown: 'summary' })
      const breakdown = usage.context.breakdown
      if (breakdown) {
        const at = await $.clock.now()
        await update($, inspection, () => summarize(breakdown, at))
      }
    } finally {
      await update($, isLoading, () => false)
      inflight = null
    }
  })()

  return inflight
}

const isPaneOpen = async ($: EngineInterface) => (await $.ui.panes()).some(pane => pane.id === PANE)

// ── Отрисовка ────────────────────────────────────────────────────────────

const short = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, Math.max(1, max - 1))}…` : line
}

const levelColor = (percent: number) => (percent >= 85 ? RED : percent >= 60 ? AMBER : GREEN)

const dotSvg = (color: string, isHollow = false) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="${LINE_PX}" viewBox="0 ${(16 - (LINE_PX * 16) / 12) / 2} 16 ${(LINE_PX * 16) / 12}">` +
  (isHollow
    ? `<circle cx="8" cy="8" r="5.6" fill="none" stroke="${color}" stroke-width="1.8" stroke-dasharray="2.4 1.8"/>`
    : `<circle cx="8" cy="8" r="6" fill="${color}"/>`) +
  `</svg>`

/** Полоса состава: цветные отрезки категорий, резерв — жёлтым, свободное место — серым. */
const stackSvg = (segments: { tokens: number; color: string }[], total: number, width: number) => {
  let x = 0
  const rects = segments
    .filter(segment => segment.tokens > 0)
    .map(segment => {
      const w = Math.max(1, (segment.tokens / total) * width)
      const rect = `<rect x="${x.toFixed(1)}" width="${w.toFixed(1)}" height="10" fill="${segment.color}"/>`
      x += w

      return rect
    })
    .join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10" viewBox="0 0 ${width} 10">` +
    `<clipPath id="r"><rect width="${width}" height="10" rx="5"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${width}" height="10" fill="${TRACK}"/>${rects}</g></svg>`
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'inspector', description: 'Открыть инспектор контекста: из чего состоит окно и что можно освободить' })
    await refresh($).catch(() => undefined)
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'inspector' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($).catch(() => undefined)
    const data = await read($, inspection)

    return {
      text: data
        ? `Контекст: ${formatTokens(data.totalTokens)} из ${formatTokens(data.maxTokens)} (${data.percentage}%).`
        : 'Разбивка контекста появится после первого ответа.',
    }
  })

  // Движок сообщает, что заполнение сдвинулось; пересчитываем, только пока панель открыта.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') && (await isPaneOpen($).catch(() => false))) {
      await refresh($).catch(() => undefined)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined

    const data = await read($, inspection)
    const loading = await read($, isLoading)
    const open = await read($, expanded)

    const columns = e.props.bodyColumns
    const narrow = columns < 40
    const room = Math.max(16, columns - 4)

    const refreshButton = <Button key="refresh" label={loading ? 'Считаю…' : '↻ Обновить'} onPress={() => refresh($)} />

    if (!data) {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text bold>Разбивки контекста пока нет</Text>
          <Text dimColor wrap="wrap">
            Она появится после первого ответа модели в этой сессии.
          </Text>
          {refreshButton}
        </Box>
      )
    }

    const used = data.categories.filter(category => category.kind === 'used').sort((a, b) => b.tokens - a.tokens)
    const colorOf = new Map(used.map((category, index) => [category.name, PALETTE[index % PALETTE.length] ?? GRAY]))
    const buffer = data.categories.filter(category => category.kind === 'buffer')
    const ordered: CategoryUsage[] = [
      ...used,
      ...buffer,
      ...data.categories.filter(category => category.kind === 'free'),
      ...data.categories.filter(category => category.kind === 'deferred'),
    ]

    const dot = (color: string, isHollow = false) =>
      Svg ? (
        <Svg source={dotSvg(color, isHollow)} alt={isHollow ? 'кольцо' : 'точка'} width={12} height={LINE_PX} />
      ) : (
        <Text color={color}>{isHollow ? '◌' : '●'}</Text>
      )

    const toggle = (id: SectionId) => update($, expanded, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))

    /** Строка «значок · название … токены»; название режется по оставшейся ширине. */
    const line = (key: string, mark: RenderChildren, name: string, right: string, opts: { dim?: boolean; note?: string } = {}) => {
      const label = short(opts.note ? `${name} · ${opts.note}` : name, room - right.length - 3)

      return (
        <Box key={key} flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Box key={`${key}-name`} flexDirection="row" alignItems="center" columnGap={1}>
            {mark}
            <Text dimColor={opts.dim}>{label}</Text>
          </Box>
          <Text dimColor>{right}</Text>
        </Box>
      )
    }

    const section = (id: SectionId, title: string, rows: RenderChildren[]) => {
      const isOpen = open.includes(id)

      return (
        <Box key={`section-${id}`} flexDirection="column" marginTop={1}>
          <Text dimColor bold>
            {title}
          </Text>
          {isOpen ? rows : rows.slice(0, SECTION_LIMIT)}
          {rows.length > SECTION_LIMIT ? (
            <Button key={`more-${id}`} plain dimColor label={isOpen ? 'Свернуть' : `Ещё ${rows.length - SECTION_LIMIT}`} onPress={() => toggle(id)} />
          ) : null}
        </Box>
      )
    }

    const percentOf = (tokens: number) => {
      const value = (tokens / Math.max(1, data.maxTokens)) * 100

      return value >= 10 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`
    }

    const barCells = Math.max(10, Math.min(40, columns - 6))
    const terminalBar = (() => {
      let filled = 0
      const parts = [...used, ...buffer].map(category => {
        const cells = Math.round((category.tokens / Math.max(1, data.maxTokens)) * barCells)
        const take = Math.min(cells, barCells - filled)
        filled += take

        return { color: colorOf.get(category.name) ?? AMBER, cells: take }
      })

      return { parts, free: Math.max(0, barCells - filled) }
    })()

    const tipList = tips(data)
    const tipColor = { warn: AMBER, info: undefined, good: GREEN }
    const tipMark = { warn: '⚠', info: '•', good: '✓' }

    return (
      <Box flexDirection="column">
        <Box key="head" flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
          <Box key="head-text" flexDirection="column">
            <Text dimColor bold>
              КОНТЕКСТ{narrow ? '' : ` · ${short(data.model, 24)}`}
            </Text>
            <Text bold color={levelColor(data.percentage)}>
              {formatTokens(data.totalTokens)} из {formatTokens(data.maxTokens)} · {data.percentage}%
            </Text>
          </Box>
          {refreshButton}
        </Box>

        <Box key="bar" marginTop={1}>
          {Svg ? (
            <Svg
              source={stackSvg(
                [...used.map(category => ({ tokens: category.tokens, color: colorOf.get(category.name) ?? GRAY })), ...buffer.map(category => ({ tokens: category.tokens, color: `${AMBER}66` }))],
                data.maxTokens,
                Math.min(320, Math.max(160, columns * 6)),
              )}
              alt={`Занято ${data.percentage}%`}
              width={Math.min(320, Math.max(160, columns * 6))}
              height={10}
            />
          ) : (
            <Box key="bar-cells" flexDirection="row">
              {terminalBar.parts.map(part => (
                <Text color={part.color}>{'█'.repeat(part.cells)}</Text>
              ))}
              <Text dimColor>{'░'.repeat(terminalBar.free)}</Text>
            </Box>
          )}
        </Box>
        {data.isAutoCompactEnabled && data.autoCompactAt !== undefined ? (
          <Text dimColor>автосжатие при {formatTokens(data.autoCompactAt)}</Text>
        ) : null}

        <Box key="tips" flexDirection="column" marginTop={1}>
          {tipList.map((tip, index) => (
            <Box key={`tip-${index}`} flexDirection="row" columnGap={1}>
              <Text color={tipColor[tip.level]}>{tipMark[tip.level]}</Text>
              <Text color={tipColor[tip.level]} wrap="wrap">
                {tip.text}
              </Text>
            </Box>
          ))}
        </Box>

        {section(
          'categories',
          'ИЗ ЧЕГО СОСТОИТ',
          ordered.map(category => {
            const isUsed = category.kind === 'used'
            const color = colorOf.get(category.name) ?? (category.kind === 'buffer' ? AMBER : GRAY)
            const note = category.kind === 'deferred' ? 'вне окна' : undefined
            const right = category.kind === 'deferred' ? formatTokens(category.tokens) : `${formatTokens(category.tokens)} · ${percentOf(category.tokens)}`

            return line(`cat-${category.name}`, dot(color, !isUsed), categoryName(category.name), right, { dim: !isUsed, note })
          }),
        )}

        {data.servers.length > 0
          ? section(
              'servers',
              `MCP-СЕРВЕРЫ · ${data.servers.length}`,
              data.servers.map(server => {
                const label = serverLabel(server.name)
                const note = label.endsWith('…') ? server.example : undefined
                const right =
                  server.loaded > 0
                    ? `${server.loaded} инстр. · ${formatTokens(server.tokens)}`
                    : `${server.tools} по запросу`

                return line(`srv-${server.name}`, dot(server.loaded > 0 ? '#58a6ff' : GRAY, server.loaded === 0), label, right, {
                  dim: server.loaded === 0,
                  note,
                })
              }),
            )
          : null}

        {data.skills.total > 0
          ? section(
              'skills',
              `СКИЛЛЫ · ${data.skills.included} из ${data.skills.total} в списке · ${formatTokens(data.skills.tokens)}`,
              data.skills.top.map(skill => line(`skill-${skill.name}`, dot(GRAY, true), skill.name, formatTokens(skill.tokens))),
            )
          : null}

        {data.memory.length > 0
          ? section(
              'memory',
              `ПАМЯТЬ · ${data.memory.length} ${plural(data.memory.length, 'файл', 'файла', 'файлов')}`,
              data.memory.map((file, index) => line(`mem-${index}`, dot(GRAY, true), file.name, formatTokens(file.tokens), { note: file.note })),
            )
          : null}

        {data.agents.count > 0
          ? section(
              'agents',
              `АГЕНТЫ · ${data.agents.count} · ${formatTokens(data.agents.tokens)}`,
              data.agents.top.map(agent => line(`agent-${agent.name}`, dot(GRAY, true), agent.name, formatTokens(agent.tokens))),
            )
          : null}
      </Box>
    )
  })
}
