import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionContextBreakdown } from 'claude-code'

import type { CategoryUsage, Inspection, NamedTokens, SectionId, ServerUsage } from '../types'

const PANE = 'context-inspector'
const TITLE = 'Контекст'

const GREEN = '#3fb950'
const AMBER = '#d29922'
const RED = '#f85149'
const BLUE = '#58a6ff'
const PURPLE = '#bc8cff'
const GRAY = '#8b949e'
/** Доп. цвета только для категорий: их больше, чем цветов в палитре. */
const TEAL = '#39c5cf'
const PINK = '#f778ba'
const TRACK = '#8b949e40'

/** Постоянный цвет категории: тот же в полосе, в составе и у значка её секции. */
const CATEGORY_COLORS: Record<string, string> = {
  Messages: BLUE,
  'System tools': GRAY,
  'System prompt': '#6e7681',
  'MCP tools': PURPLE,
  Skills: GREEN,
  'Memory files': TEAL,
  'Custom agents': PINK,
  'Slash commands': '#a5d6ff',
}
const EXTRA_COLORS = ['#ffa657', '#d2a8ff', '#7ee787']

/** Высота строки текста на десктопе: по ней значки встают вровень с текстом. */
const LINE_PX = 20

/** Сколько строк показывать в секции, пока её не развернули. */
const SECTION_LIMIT = 5

/** Отступ строк под текстом заголовка: значок и зазор. */
const INDENT = 2

/** Фон карточки секции на десктопе. */
const CARD = '#8b949e14'

/** Мини-полоска доли на десктопе: ширина в пикселях и сколько примерно колонок она занимает. */
const MINI_PX = 36
const MINI_COLS = 5

/** Толщина полосы заполнения на десктопе. */
const BAR_PX = 8

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
  Skills: 'Навыки',
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

/** Части через « · », пока влезают в ширину; первая — всегда, при нужде обрезанная. */
const fit = (parts: string[], max: number) => {
  let line = short(parts[0] ?? '', max)
  for (const part of parts.slice(1)) {
    const next = `${line} · ${part}`
    if (next.length > max) {
      break
    }
    line = next
  }

  return line
}

/** Перенос по словам в строки заданной ширины; «—» держится за предыдущим словом; лишнее — в «…». */
const wrapLines = (text: string, max: number, maxLines = 3) => {
  const words = text.replace(/\s+/g, ' ').trim().replace(/ —/g, ' —').split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (current && next.length > max) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) {
    lines.push(current)
  }
  const kept = lines.length > maxLines ? [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(' ')] : lines

  return kept.map(one => short(one, max))
}

/** «только что», «5 мин назад», «3 ч назад», «2 д назад». */
const ago = (ms: number) => {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) {
    return 'только что'
  }

  return minutes < 60 ? `${minutes} мин назад` : minutes < 1440 ? `${Math.floor(minutes / 60)} ч назад` : `${Math.floor(minutes / 1440)} д назад`
}

/** Цвет заполнения: зелёный до 70%, жёлтый до 90%, дальше красный. */
const levelColor = (percent: number) => (percent >= 90 ? RED : percent >= 70 ? AMBER : GREEN)

/** Цвет категории: постоянный для известных, для новых — стабильный из запасных. */
const categoryColor = (name: string) =>
  CATEGORY_COLORS[name] ?? EXTRA_COLORS[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % EXTRA_COLORS.length] ?? GRAY

/** Как выглядит заголовок секции: название, цвет, значок в терминале (`glyph`) и на десктопе (`icon`). */
type Look = { title: string; color: string; glyph: string; icon: string }

/** Значки в сетке 16×16 (C — цвет). */
const LOOKS: Record<Exclude<SectionId, 'categories'>, Look> = {
  servers: {
    title: 'MCP-СЕРВЕРЫ',
    color: PURPLE,
    glyph: '◆',
    icon: '<rect x="2.5" y="2.5" width="11" height="4.6" rx="1.4" fill="none" stroke="C" stroke-width="1.5"/><rect x="2.5" y="8.9" width="11" height="4.6" rx="1.4" fill="none" stroke="C" stroke-width="1.5"/><circle cx="5.3" cy="4.8" r="0.95" fill="C"/><circle cx="5.3" cy="11.2" r="0.95" fill="C"/>',
  },
  skills: {
    title: 'НАВЫКИ',
    color: GREEN,
    glyph: '✦',
    icon: '<path d="M8 1.8 L9.7 6.3 L14.2 8 L9.7 9.7 L8 14.2 L6.3 9.7 L1.8 8 L6.3 6.3 Z" fill="C"/>',
  },
  memory: {
    title: 'ПАМЯТЬ',
    color: TEAL,
    glyph: '◫',
    icon: '<path d="M4 2 H9.6 L12.5 4.9 V14 H4 Z" fill="none" stroke="C" stroke-width="1.5" stroke-linejoin="round"/><path d="M6.3 8 H10.2 M6.3 10.8 H10.2" stroke="C" stroke-width="1.4" stroke-linecap="round"/>',
  },
  agents: {
    title: 'АГЕНТЫ',
    color: PINK,
    glyph: '◎',
    icon: '<circle cx="8" cy="5.4" r="2.7" fill="none" stroke="C" stroke-width="1.5"/><path d="M3 14 C3 10.9 5.2 9.3 8 9.3 C10.8 9.3 13 10.9 13 14" fill="none" stroke="C" stroke-width="1.5" stroke-linecap="round"/>',
  },
}

/** Значок состава: три полоски цветами трёх самых больших категорий. */
const stackIcon = (colors: string[]) =>
  [12, 8.5, 5]
    .map((w, i) => `<rect x="2" y="${3 + i * 3.7}" width="${w}" height="2.6" rx="1.3" fill="${colors[i] ?? colors[0] ?? GRAY}"/>`)
    .join('')

const TIP_ICONS = {
  warn: '<path d="M8 2.2 L14.3 13.3 H1.7 Z" fill="none" stroke="C" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.6 V9.3" stroke="C" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.3" r="0.9" fill="C"/>',
  info: '<circle cx="8" cy="8" r="6" fill="none" stroke="C" stroke-width="1.5"/><path d="M8 7.3 V11" stroke="C" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="5" r="0.9" fill="C"/>',
  good: '<path d="M3.2 8.4 L6.6 11.6 L12.8 4.6" fill="none" stroke="C" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
}
const TIP_GLYPHS = { warn: '⚠', info: '•', good: '✓' }

const iconSvg = (body: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="${LINE_PX}" viewBox="0 ${(16 - (LINE_PX * 16) / 12) / 2} 16 ${(LINE_PX * 16) / 12}">` +
  body.replace(/"C"/g, `"${color}"`) +
  `</svg>`

/** Метка категории: в окне — точка, свободно и резерв — кольцо, вне окна — пунктирное кольцо. */
type DotKind = 'fill' | 'ring' | 'dashed'

const DOTS: Record<DotKind, string> = {
  fill: '<circle cx="8" cy="8" r="5" fill="C"/>',
  ring: '<circle cx="8" cy="8" r="4.6" fill="none" stroke="C" stroke-width="1.6"/>',
  dashed: '<circle cx="8" cy="8" r="4.6" fill="none" stroke="C" stroke-width="1.6" stroke-dasharray="2.2 1.7"/>',
}
const DOT_GLYPHS: Record<DotKind, string> = { fill: '●', ring: '○', dashed: '◌' }

/** Мини-полоска доли: тонкая дорожка и заливка цветом секции. */
const miniSvg = (share: number, color: string) => {
  const y = (LINE_PX - 4) / 2
  const w = share > 0 ? Math.max(4, Math.min(1, share) * MINI_PX) : 0

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MINI_PX}" height="${LINE_PX}" viewBox="0 0 ${MINI_PX} ${LINE_PX}">` +
    `<rect y="${y}" width="${MINI_PX}" height="4" rx="2" fill="${TRACK}"/>` +
    (w > 0 ? `<rect y="${y}" width="${w.toFixed(1)}" height="4" rx="2" fill="${color}"/>` : '') +
    `</svg>`
  )
}

/** Полоса заполнения: категории слева с зазором в 1px, резерв автосжатия — штриховкой справа, свободное — дорожкой. */
const stackSvg = (segments: { tokens: number; color: string }[], reserve: number, total: number, width: number) => {
  const y = (LINE_PX - BAR_PX) / 2
  const px = (tokens: number) => (tokens / Math.max(1, total)) * width
  let x = 0
  const rects = segments
    .filter(segment => segment.tokens > 0)
    .map(segment => {
      const w = Math.min(width - x, Math.max(2, px(segment.tokens)))
      const rect = w > 0 ? `<rect x="${x.toFixed(1)}" y="${y}" width="${Math.max(1, w - 1).toFixed(1)}" height="${BAR_PX}" fill="${segment.color}"/>` : ''
      x += Math.max(0, w)

      return rect
    })
    .join('')
  const rw = Math.max(0, Math.min(width - x, px(reserve)))

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LINE_PX}" viewBox="0 0 ${width} ${LINE_PX}">` +
    `<defs><clipPath id="ci-bar"><rect y="${y}" width="${width}" height="${BAR_PX}" rx="${BAR_PX / 2}"/></clipPath>` +
    `<pattern id="ci-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="4" height="4" fill="${AMBER}33"/><rect width="1.5" height="4" fill="${AMBER}a6"/></pattern></defs>` +
    `<g clip-path="url(#ci-bar)"><rect y="${y}" width="${width}" height="${BAR_PX}" fill="${TRACK}"/>${rects}` +
    (rw > 0 ? `<rect x="${(width - rw).toFixed(1)}" y="${y}" width="${rw.toFixed(1)}" height="${BAR_PX}" fill="url(#ci-hatch)"/>` : '') +
    `</g></svg>`
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Имя занято другим плагином — команды не будет, но остальной старт сессии должен пройти.
    await $.command.register({ name: 'inspector', description: 'Открыть инспектор контекста: из чего состоит окно и что можно освободить' }).catch(() => undefined)
    await refresh($).catch(() => undefined)
    void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

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
    const now = await $.clock.now()

    const columns = e.props.bodyColumns
    // Ширина внутри карточки (на десктопе поля по 1 с каждой стороны) и строки под заголовком секции.
    const inner = Math.max(12, columns - (Svg ? 2 : 0))
    const rowRoom = inner - INDENT
    // Шапка: справа тихая кнопка ↻ (на десктопе родная, чуть шире).
    const headRoom = Math.max(8, columns - (Svg ? 5 : 2))

    const refreshButton = <Button key="refresh" plain dimColor label="↻" onPress={() => refresh($)} />

    const head = (title: RenderChildren, subtitle: string) => (
      <Box key="head" flexDirection="row" justifyContent="space-between" alignItems="flex-start" columnGap={1}>
        <Box key="head-text" flexDirection="column">
          {title}
          <Text dimColor>{subtitle}</Text>
        </Box>
        {refreshButton}
      </Box>
    )

    if (!data) {
      return (
        <Box flexDirection="column">
          {head(<Text bold>Контекст</Text>, fit([loading ? 'обновляю…' : 'Разбивки контекста пока нет', 'появится после первого ответа'], headRoom))}
        </Box>
      )
    }

    const used = data.categories.filter(category => category.kind === 'used').sort((a, b) => b.tokens - a.tokens)
    const free = data.categories.filter(category => category.kind === 'free')
    const buffer = data.categories.filter(category => category.kind === 'buffer')
    const reserve = buffer.reduce((sum, category) => sum + category.tokens, 0)
    // Список в том же порядке, что полоса: занятое, свободное, резерв; вне окна — в конце.
    const ordered: CategoryUsage[] = [...used, ...free, ...buffer, ...data.categories.filter(category => category.kind === 'deferred')]

    const mark = (look: Look) =>
      Svg ? <Svg source={iconSvg(look.icon, look.color)} alt="значок" width={12} height={LINE_PX} /> : <Text color={look.color}>{look.glyph}</Text>

    const dot = (color: string, kind: DotKind) =>
      Svg ? <Svg source={iconSvg(DOTS[kind], color)} alt="метка" width={12} height={LINE_PX} /> : <Text color={color}>{DOT_GLYPHS[kind]}</Text>

    const toggle = (id: SectionId) => update($, expanded, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))

    /** Строка: метка и имя, тихая пометка; справа токены и на десктопе мини-полоска доли. Всё обрезано под ширину. */
    const line = (key: string, name: string, right: string, opts: { mark?: RenderChildren; note?: string; dim?: boolean; share?: number; color?: string } = {}) => {
      const hasMini = Svg !== undefined && opts.share !== undefined
      const nameRoom = Math.max(6, rowRoom - right.length - 1 - (hasMini ? MINI_COLS + 1 : 0) - (opts.mark ? 2 : 0) - 1)
      const label = short(name, nameRoom)
      const noteRoom = nameRoom - label.length - 1
      const note = opts.note && noteRoom >= 6 ? short(`· ${opts.note}`, noteRoom) : ''

      return (
        <Box key={key} flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1} paddingLeft={INDENT}>
          <Box key={`${key}-name`} flexDirection="row" alignItems="center" columnGap={1}>
            {opts.mark ?? null}
            <Text dimColor={opts.dim}>{label}</Text>
            {note ? <Text dimColor>{note}</Text> : null}
          </Box>
          <Box key={`${key}-value`} flexDirection="row" alignItems="center" columnGap={1}>
            <Text dimColor>{right}</Text>
            {hasMini && Svg ? (
              <Svg source={miniSvg(opts.share ?? 0, opts.color ?? GRAY)} alt={`доля ${Math.round((opts.share ?? 0) * 100)}%`} width={MINI_PX} height={LINE_PX} />
            ) : null}
          </Box>
        </Box>
      )
    }

    /** Секция-карточка: значок и название цветом секции, сводка справа, строки под названием, «Ещё N». */
    const section = (id: SectionId, look: Look, summary: string[], rows: RenderChildren[]) => {
      const isOpen = open.includes(id)
      const hidden = rows.length - SECTION_LIMIT
      const title = short(look.title, Math.max(6, inner - 3))
      const rightRoom = inner - 2 - title.length - 2
      const right = rightRoom >= 3 ? fit(summary, rightRoom) : ''

      return (
        <Box key={`section-${id}`} flexDirection="column" marginTop={1} {...(Svg ? { backgroundColor: CARD, paddingX: 1, paddingY: 1 } : {})}>
          <Box key={`section-${id}-head`} flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
            <Box key={`section-${id}-title`} flexDirection="row" alignItems="center" columnGap={1}>
              {mark(look)}
              <Text bold color={look.color}>
                {title}
              </Text>
            </Box>
            {right ? <Text dimColor>{right}</Text> : null}
          </Box>
          {isOpen ? rows : rows.slice(0, SECTION_LIMIT)}
          {hidden > 0 ? (
            <Box key={`more-${id}-row`} flexDirection="row" paddingLeft={INDENT}>
              <Button key={`more-${id}`} plain dimColor label={isOpen ? 'Свернуть' : `Ещё ${hidden}`} onPress={() => toggle(id)} />
            </Box>
          ) : null}
        </Box>
      )
    }

    const percentOf = (tokens: number) => {
      const value = (tokens / Math.max(1, data.maxTokens)) * 100

      return value >= 10 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`
    }
    const approx = (tokens: number) => `~${formatTokens(tokens)} ток.`
    const shareOf = (tokens: number, all: { tokens: number }[]) => tokens / Math.max(1, ...all.map(one => one.tokens))

    // ── Шапка: процент цветом уровня, объём и время, полоса заполнения.

    const level = levelColor(data.percentage)
    const subtitle = fit(
      [`${formatTokens(data.totalTokens)} из ${formatTokens(data.maxTokens)} токенов`, loading ? 'обновляю…' : `обновлено ${ago(now - data.at)}`],
      headRoom,
    )

    // Терминал: занятое цветными блоками слева, резерв автосжатия жёлтой штриховкой справа, между ними свободное.
    const cells = Math.max(10, columns - 1)
    const toCells = (tokens: number) => Math.round((tokens / Math.max(1, data.maxTokens)) * cells)
    let filled = 0
    const cellParts = used.map(category => {
      const take = Math.min(toCells(category.tokens), cells - filled)
      filled += take

      return { color: categoryColor(category.name), cells: take }
    })
    const reserveCells = Math.min(toCells(reserve), cells - filled)
    const freeCells = cells - filled - reserveCells

    const barPx = Math.round(Math.min(480, Math.max(160, columns * 6.5)))
    const bar = Svg ? (
      <Svg
        source={stackSvg(
          used.map(category => ({ tokens: category.tokens, color: categoryColor(category.name) })),
          reserve,
          data.maxTokens,
          barPx,
        )}
        alt={`Занято ${data.percentage}%`}
        width={barPx}
        height={LINE_PX}
      />
    ) : (
      <Box key="bar-cells" flexDirection="row">
        {cellParts.filter(part => part.cells > 0).map(part => (
          <Text color={part.color}>{'█'.repeat(part.cells)}</Text>
        ))}
        {freeCells > 0 ? <Text dimColor>{'░'.repeat(freeCells)}</Text> : null}
        {reserveCells > 0 ? (
          <Text color={AMBER} dimColor>
            {'░'.repeat(reserveCells)}
          </Text>
        ) : null}
      </Box>
    )

    // ── Советы: одна карточка, тон — по самому важному.

    const tipList = tips(data)
    const isUrgent = tipList.some(tip => tip.level === 'warn')
    const warnColor = data.percentage >= 90 ? RED : AMBER
    const tipColors = { warn: warnColor, info: BLUE, good: GREEN }
    const tipRoom = Math.max(8, inner - 2 - 1)

    // ── Секции.

    const top = used.slice(0, 3).map(category => categoryColor(category.name))
    const compositionLook: Look = { title: 'СОСТАВ', color: top[0] ?? GRAY, glyph: '▤', icon: stackIcon(top) }

    const serverTokens = data.servers.reduce((sum, server) => sum + server.tokens, 0)
    const memoryTokens = data.memory.reduce((sum, file) => sum + file.tokens, 0)

    return (
      <Box flexDirection="column">
        {head(
          <Text bold color={level}>
            {`Контекст ${data.percentage}%`}
          </Text>,
          subtitle,
        )}
        <Box key="bar">{bar}</Box>
        {data.isAutoCompactEnabled && data.autoCompactAt !== undefined ? (
          <Text dimColor>{short(`автосжатие при ${formatTokens(data.autoCompactAt)}`, columns - 1)}</Text>
        ) : null}

        <Box
          key="tips"
          flexDirection="column"
          marginTop={1}
          {...(Svg ? { backgroundColor: isUrgent ? `${warnColor}1a` : CARD, paddingX: 1, paddingY: 1 } : {})}
        >
          {tipList.map((tip, index) => (
            <Box key={`tip-${index}`} flexDirection="row" alignItems="flex-start" columnGap={1}>
              {Svg ? (
                <Svg source={iconSvg(TIP_ICONS[tip.level], tipColors[tip.level])} alt="значок" width={12} height={LINE_PX} />
              ) : (
                <Text color={tipColors[tip.level]}>{TIP_GLYPHS[tip.level]}</Text>
              )}
              <Box key={`tip-${index}-text`} flexDirection="column">
                {wrapLines(tip.text, tipRoom).map(text => (
                  <Text>{text}</Text>
                ))}
              </Box>
            </Box>
          ))}
        </Box>

        {section(
          'categories',
          compositionLook,
          [approx(data.totalTokens)],
          ordered.map(category => {
            const isUsed = category.kind === 'used'
            const color = isUsed ? categoryColor(category.name) : category.kind === 'buffer' ? AMBER : GRAY
            const kind: DotKind = isUsed ? 'fill' : category.kind === 'deferred' ? 'dashed' : 'ring'
            const right =
              category.kind === 'deferred' ? `${formatTokens(category.tokens)} · вне окна` : `${formatTokens(category.tokens)} · ${percentOf(category.tokens)}`

            return line(`cat-${category.name}`, categoryName(category.name), right, { mark: dot(color, kind), dim: !isUsed })
          }),
        )}

        {data.servers.length > 0
          ? section(
              'servers',
              LOOKS.servers,
              [String(data.servers.length), approx(serverTokens)],
              data.servers.map(server => {
                const label = serverLabel(server.name)
                const right = server.loaded > 0 ? `${server.loaded} инстр. · ${formatTokens(server.tokens)}` : `${server.tools} по запросу`

                return line(`srv-${server.name}`, label, right, {
                  dim: server.loaded === 0,
                  note: label.endsWith('…') ? server.example : undefined,
                  share: shareOf(server.tokens, data.servers),
                  color: LOOKS.servers.color,
                })
              }),
            )
          : null}

        {data.skills.total > 0
          ? section(
              'skills',
              LOOKS.skills,
              [
                data.skills.included < data.skills.total ? `${data.skills.included} из ${data.skills.total}` : String(data.skills.total),
                approx(data.skills.tokens),
              ],
              data.skills.top.map(skill =>
                line(`skill-${skill.name}`, skill.name, formatTokens(skill.tokens), { share: shareOf(skill.tokens, data.skills.top), color: LOOKS.skills.color }),
              ),
            )
          : null}

        {data.memory.length > 0
          ? section(
              'memory',
              LOOKS.memory,
              [String(data.memory.length), approx(memoryTokens)],
              data.memory.map((file, index) =>
                line(`mem-${index}`, file.name, formatTokens(file.tokens), { note: file.note, share: shareOf(file.tokens, data.memory), color: LOOKS.memory.color }),
              ),
            )
          : null}

        {data.agents.count > 0
          ? section(
              'agents',
              LOOKS.agents,
              [String(data.agents.count), approx(data.agents.tokens)],
              data.agents.top.map(agent =>
                line(`agent-${agent.name}`, agent.name, formatTokens(agent.tokens), { share: shareOf(agent.tokens, data.agents.top), color: LOOKS.agents.color }),
              ),
            )
          : null}
      </Box>
    )
  })
}
