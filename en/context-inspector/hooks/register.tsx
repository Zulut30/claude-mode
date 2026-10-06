import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionContextBreakdown } from 'claude-code'

import type { CategoryUsage, Inspection, NamedTokens, SectionId, ServerUsage } from '../types'

const PANE = 'context-inspector'
const TITLE = 'Context'

const GREEN = '#3fb950'
const AMBER = '#d29922'
const RED = '#f85149'
const GRAY = '#8b949e'
const TRACK = '#8b949e40'

/** Category colors, in order of decreasing size. */
const PALETTE = ['#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#f778ba', '#39c5cf', '#ff7b72', '#a5d6ff']

/** Desktop text line height: icons use it to line up with the text. */
const LINE_PX = 20

/** How many rows a section shows until it is expanded. */
const SECTION_LIMIT = 5

const inspection = atom({ plugin: 'context-inspector', key: 'inspection' } as const, null)
const isLoading = atom({ plugin: 'context-inspector', key: 'isLoading' } as const, false)
const expanded = atom({ plugin: 'context-inspector', key: 'expanded' } as const, [] as SectionId[])

// ── Parsing ──────────────────────────────────────────────────────────────

const MEMORY_KINDS: Record<string, string> = {
  User: 'global',
  Project: 'project',
  Local: 'local',
  Managed: 'organization',
  AutoMem: 'auto-memory',
}

/** Category name as the engine reports it; 'MCP tools (deferred)' → 'MCP tools (on demand)'. */
export const categoryName = (name: string) => {
  const match = /^(.*?)\s*\((.*)\)$/.exec(name)
  const base = match?.[1] ?? name
  const note = match?.[2]

  return note ? `${base} (${note === 'deferred' ? 'on demand' : note})` : base
}

/** A shorter server name: a long connector UUID → its first 8 characters. */
export const serverLabel = (name: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name) ? `${name.slice(0, 8)}…` : name.replace(/^plugin:/, '')

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** Engine breakdown → what the pane draws: servers grouped, lists sorted. */
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

// ── Tips ─────────────────────────────────────────────────────────────────

export type Tip = { level: 'warn' | 'info' | 'good'; text: string }

export const formatTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** What you can do: from urgent to useful, four at most. */
export const tips = (data: Inspection): Tip[] => {
  const list: Tip[] = []
  const used = data.categories.filter(category => category.kind === 'used').reduce((sum, category) => sum + category.tokens, 0)

  if (data.percentage >= 85) {
    list.push({ level: 'warn', text: `The window is ${data.percentage}% full — run /compact or auto-compact will kick in soon` })
  } else if (data.percentage >= 60) {
    list.push({ level: 'info', text: `Using ${data.percentage}% — start a big new task with /clear` })
  }

  if (!data.isAutoCompactEnabled) {
    list.push({ level: 'info', text: 'Auto-compact is off — watch the fill yourself' })
  } else if (data.autoCompactAt !== undefined) {
    const left = data.autoCompactAt - data.totalTokens
    if (left > 0 && left < data.maxTokens * 0.2) {
      list.push({ level: 'warn', text: `~${formatTokens(left)} tokens left before auto-compact` })
    }
  }

  const heavy = data.servers.find(server => server.tokens >= Math.max(5000, data.maxTokens * 0.03))
  if (heavy) {
    list.push({
      level: 'info',
      text: `MCP server “${serverLabel(heavy.name)}” takes ${formatTokens(heavy.tokens)} (${heavy.loaded} ${plural(heavy.loaded, 'tool', 'tools')}) — disable it in /mcp if you don't need it`,
    })
  }

  const memory = data.memory.reduce((sum, file) => sum + file.tokens, 0)
  if (memory >= 8000) {
    list.push({ level: 'info', text: `Memory files weigh ${formatTokens(memory)} — trim CLAUDE.md if it has stale parts` })
  }

  if (data.skills.tokens >= 5000) {
    list.push({
      level: 'info',
      text: `The list of ${data.skills.total} ${plural(data.skills.total, 'skill', 'skills')} takes ${formatTokens(data.skills.tokens)} — disable plugins you don't use`,
    })
  }

  const messages = data.categories.find(category => category.name === 'Messages')
  if (messages && used > 0 && messages.tokens / used >= 0.7 && data.percentage >= 40) {
    list.push({ level: 'info', text: 'Conversation takes most of the space — /compact will condense it' })
  }

  const deferred = data.servers.reduce((sum, server) => sum + (server.tools - server.loaded), 0)
  if (deferred > 0) {
    list.push({
      level: 'good',
      text: `${deferred} MCP ${plural(deferred, "tool loads on demand and doesn't", "tools load on demand and don't")} use the window`,
    })
  }

  if (list.length === 0) {
    list.push({ level: 'good', text: 'All good: the window has room and nothing heavy is loaded' })
  }

  return list.slice(0, 4)
}

// ── Snapshot ─────────────────────────────────────────────────────────────

let inflight: Promise<void> | null = null

/** Recount the breakdown (a local estimate, no API calls); concurrent calls wait for one. */
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

// ── Rendering ────────────────────────────────────────────────────────────

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

/** Breakdown bar: colored category segments, the buffer in amber, free space in gray. */
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
    await $.command.register({ name: 'inspector', description: 'Open the context inspector: what fills the window and what you can free up' })
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
        ? `Context: ${formatTokens(data.totalTokens)} of ${formatTokens(data.maxTokens)} (${data.percentage}%).`
        : 'The context breakdown appears after the first answer.',
    }
  })

  // The engine reports that the fill has moved; recount only while the pane is open.
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

    const refreshButton = <Button key="refresh" label={loading ? 'Counting…' : '↻ Refresh'} onPress={() => refresh($)} />

    if (!data) {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text bold>No context breakdown yet</Text>
          <Text dimColor wrap="wrap">
            It appears after the model's first answer in this session.
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
        <Svg source={dotSvg(color, isHollow)} alt={isHollow ? 'ring' : 'dot'} width={12} height={LINE_PX} />
      ) : (
        <Text color={color}>{isHollow ? '◌' : '●'}</Text>
      )

    const toggle = (id: SectionId) => update($, expanded, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))

    /** A 'mark · name … tokens' row; the name is cut to the remaining width. */
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
            <Button key={`more-${id}`} plain dimColor label={isOpen ? 'Collapse' : `More ${rows.length - SECTION_LIMIT}`} onPress={() => toggle(id)} />
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
              CONTEXT{narrow ? '' : ` · ${short(data.model, 24)}`}
            </Text>
            <Text bold color={levelColor(data.percentage)}>
              {formatTokens(data.totalTokens)} of {formatTokens(data.maxTokens)} · {data.percentage}%
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
              alt={`${data.percentage}% used`}
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
          <Text dimColor>auto-compact at {formatTokens(data.autoCompactAt)}</Text>
        ) : null}

        <Box
          key="tips"
          flexDirection="column"
          marginTop={1}
          {...(Svg ? { backgroundColor: tipList[0]?.level === 'warn' ? '#d299221f' : '#8b949e1a', paddingX: 1 } : {})}
        >
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
          'WHAT FILLS IT',
          ordered.map(category => {
            const isUsed = category.kind === 'used'
            const color = colorOf.get(category.name) ?? (category.kind === 'buffer' ? AMBER : GRAY)
            const note = category.kind === 'deferred' ? 'outside the window' : undefined
            const right = category.kind === 'deferred' ? formatTokens(category.tokens) : `${formatTokens(category.tokens)} · ${percentOf(category.tokens)}`

            return line(`cat-${category.name}`, dot(color, !isUsed), categoryName(category.name), right, { dim: !isUsed, note })
          }),
        )}

        {data.servers.length > 0
          ? section(
              'servers',
              `MCP SERVERS · ${data.servers.length}`,
              data.servers.map(server => {
                const label = serverLabel(server.name)
                const note = label.endsWith('…') ? server.example : undefined
                const right =
                  server.loaded > 0
                    ? `${server.loaded} ${plural(server.loaded, 'tool', 'tools')} · ${formatTokens(server.tokens)}`
                    : `${server.tools} on demand`

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
              `SKILLS · ${data.skills.included} of ${data.skills.total} listed · ${formatTokens(data.skills.tokens)}`,
              data.skills.top.map(skill => line(`skill-${skill.name}`, dot(GRAY, true), skill.name, formatTokens(skill.tokens))),
            )
          : null}

        {data.memory.length > 0
          ? section(
              'memory',
              `MEMORY · ${data.memory.length} ${plural(data.memory.length, 'file', 'files')}`,
              data.memory.map((file, index) => line(`mem-${index}`, dot(GRAY, true), file.name, formatTokens(file.tokens), { note: file.note })),
            )
          : null}

        {data.agents.count > 0
          ? section(
              'agents',
              `AGENTS · ${data.agents.count} · ${formatTokens(data.agents.tokens)}`,
              data.agents.top.map(agent => line(`agent-${agent.name}`, dot(GRAY, true), agent.name, formatTokens(agent.tokens))),
            )
          : null}
      </Box>
    )
  })
}
