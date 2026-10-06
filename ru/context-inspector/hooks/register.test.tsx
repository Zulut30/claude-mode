import { describe, expect, mock, test } from 'claude-code/testing'
import type { SessionContextBreakdown } from 'claude-code'

import { categoryName, formatTokens, serverLabel, summarize, tips } from './register'

const UUID = '23eb0007-54d4-44b7-81d6-f3671f38dc49'

const tool = (serverName: string, name: string, tokens: number, isLoaded = true) => ({ name: `mcp__${serverName}__${name}`, serverName, tokens, isLoaded })

const BREAKDOWN: SessionContextBreakdown = {
  categories: [
    { name: 'System prompt', tokens: 3000, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'System tools', tokens: 14_000, color: 'inactive', isDeferred: false, kind: 'used' },
    { name: 'MCP tools', tokens: 12_000, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 55_000, color: 'text', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 83_000, color: 'inactive', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 33_000, color: 'warning', isDeferred: false, kind: 'buffer' },
    { name: 'MCP tools (deferred)', tokens: 40_000, color: 'inactive', isDeferred: true, kind: 'deferred' },
  ],
  totalTokens: 84_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  autocompactSource: 'model-default',
  percentage: 42,
  gridRows: [],
  model: 'claude-opus-5-5',
  memoryFiles: [
    { path: 'C:/u/.claude/CLAUDE.md', type: 'User', tokens: 1200 },
    { path: 'C:/p/CLAUDE.md', type: 'Project', tokens: 900 },
  ],
  mcpTools: [
    tool('supabase', 'execute_sql', 6000),
    tool('supabase', 'list_tables', 4000),
    tool(UUID, 'agents_create', 2000),
    tool('vercel', 'list_deployments', 30_000, false),
    tool('vercel', 'get_project', 10_000, false),
  ],
  agents: [{ agentType: 'Explore', source: 'builtIn', tokens: 300 }],
  skills: {
    totalSkills: 3,
    includedSkills: 3,
    tokens: 900,
    skillFrontmatter: [
      { name: 'pdf', source: 'plugin', pluginName: 'anthropic-skills', tokens: 200 },
      { name: 'handoff', source: 'user', tokens: 500 },
      { name: 'docx', source: 'plugin', tokens: 200 },
    ],
  },
  autoCompactThreshold: 167_000,
  isAutoCompactEnabled: true,
  apiUsage: null,
}

const PANE = {
  component: 'Pane',
  requestId: 'context-inspector',
  props: { title: 'Контекст', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

describe('разбор', () => {
  test('серверы сгруппированы, списки отсортированы, имена переведены', () => {
    const data = summarize(BREAKDOWN, 0)
    expect(data.servers.map(server => [server.name, server.tools, server.loaded, server.tokens])).toEqual([
      ['supabase', 2, 2, 10_000],
      [UUID, 1, 1, 2000],
      ['vercel', 2, 0, 0],
    ])
    expect(data.servers[1]?.example).toBe('agents_create')
    expect(data.skills.top[0]).toEqual({ name: 'handoff', tokens: 500 })
    expect(data.skills.top[1]?.name).toBe('anthropic-skills:pdf')
    expect(data.memory[0]).toEqual({ name: 'CLAUDE.md', tokens: 1200, note: 'глобальная' })

    expect(categoryName('Messages')).toBe('Сообщения')
    expect(categoryName('MCP tools (deferred)')).toBe('MCP-инструменты (по запросу)')
    expect(categoryName('Something new')).toBe('Something new')
    expect(serverLabel(UUID)).toBe('23eb0007…')
    expect(serverLabel('plugin:data:amplitude')).toBe('data:amplitude')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(2100)).toBe('2.1k')
    expect(formatTokens(84_000)).toBe('84k')
  })
})

describe('советы', () => {
  test('тяжёлый сервер и подгрузка по запросу', () => {
    const list = tips(summarize(BREAKDOWN, 0))
    expect(list.some(tip => tip.text.includes('MCP-сервер «supabase» занимает 10k (2 инструмента)'))).toBe(true)
    expect(list.some(tip => tip.level === 'good' && tip.text.startsWith('2 MCP-инструмента подгружаются'))).toBe(true)
  })

  test('почти полное окно — предупреждение о /compact и автосжатии', () => {
    const list = tips(summarize({ ...BREAKDOWN, totalTokens: 160_000, percentage: 88 }, 0))
    expect(list[0]).toEqual({ level: 'warn', text: 'Окно заполнено на 88% — сделайте /compact, иначе скоро сработает автосжатие' })
    expect(list.some(tip => tip.text === 'До автосжатия осталось ~7.0k токенов')).toBe(true)
  })

  test('чистое окно — «всё в порядке»', () => {
    const clean = { ...BREAKDOWN, mcpTools: [], percentage: 10, totalTokens: 20_000 }
    expect(tips(summarize(clean, 0))).toEqual([{ level: 'good', text: 'Всё в порядке: окно свободно, тяжёлых источников нет' }])
  })
})

test('панель: заполнение, состав, серверы и «Ещё N» на обоих видах', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 84_000, window: 200_000, percent: 42, breakdown: BREAKDOWN }, rateLimits: [] } }))

  const reply = await $.command.run({ command: 'inspector', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(reply.text).toBe('Контекст: 84k из 200k (42%).')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-inspector', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: 'Контекст 42%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '84k из 200k токенов · обновлено только что' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'СОСТАВ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Сообщения' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '55k · 28%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'MCP-СЕРВЕРЫ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3 · ~12k ток.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 инстр. · 10k' })).toBeDefined()
    // Сервер с UUID вместо имени узнаётся по примеру инструмента.
    expect(await ui.find({ type: 'Text', text: '23eb0007…' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '· agents_create' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 по запросу' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'НАВЫКИ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'автосжатие при 167k' })).toBeDefined()
    // В составе 7 строк: первые 5 и кнопка «Ещё 2».
    expect(await ui.find({ type: 'Text', text: 'MCP-инструменты (по запросу)' })).toBeUndefined()
    await ui.press({ key: 'more-categories' })
    expect(await ui.find({ type: 'Text', text: 'MCP-инструменты (по запросу)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '40k · вне окна' })).toBeDefined()
    await ui.press({ key: 'more-categories' })
    await ui.unmount()
  }
})

test('до первого ответа — понятная заглушка', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))

  await $.command.run({ command: 'inspector', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ plugin: 'context-inspector', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^Разбивки контекста пока нет/ })).toBeDefined()
  await ui.unmount()
})
