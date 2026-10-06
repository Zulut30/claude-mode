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
  props: { title: 'Context', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

describe('parsing', () => {
  test('servers grouped, lists sorted, names kept', () => {
    const data = summarize(BREAKDOWN, 0)
    expect(data.servers.map(server => [server.name, server.tools, server.loaded, server.tokens])).toEqual([
      ['supabase', 2, 2, 10_000],
      [UUID, 1, 1, 2000],
      ['vercel', 2, 0, 0],
    ])
    expect(data.servers[1]?.example).toBe('agents_create')
    expect(data.skills.top[0]).toEqual({ name: 'handoff', tokens: 500 })
    expect(data.skills.top[1]?.name).toBe('anthropic-skills:pdf')
    expect(data.memory[0]).toEqual({ name: 'CLAUDE.md', tokens: 1200, note: 'global' })

    expect(categoryName('Messages')).toBe('Messages')
    expect(categoryName('MCP tools (deferred)')).toBe('MCP tools (on demand)')
    expect(categoryName('Something new')).toBe('Something new')
    expect(serverLabel(UUID)).toBe('23eb0007…')
    expect(serverLabel('plugin:data:amplitude')).toBe('data:amplitude')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(2100)).toBe('2.1k')
    expect(formatTokens(84_000)).toBe('84k')
  })
})

describe('tips', () => {
  test('heavy server and on-demand loading', () => {
    const list = tips(summarize(BREAKDOWN, 0))
    expect(list.some(tip => tip.text.includes('MCP server “supabase” takes 10k (2 tools)'))).toBe(true)
    expect(list.some(tip => tip.level === 'good' && tip.text.startsWith('2 MCP tools load on demand'))).toBe(true)
  })

  test('nearly full window — /compact and auto-compact warnings', () => {
    const list = tips(summarize({ ...BREAKDOWN, totalTokens: 160_000, percentage: 88 }, 0))
    expect(list[0]).toEqual({ level: 'warn', text: 'The window is 88% full — run /compact or auto-compact will kick in soon' })
    expect(list.some(tip => tip.text === '~7.0k tokens left before auto-compact')).toBe(true)
  })

  test('clean window — "All good"', () => {
    const clean = { ...BREAKDOWN, mcpTools: [], percentage: 10, totalTokens: 20_000 }
    expect(tips(summarize(clean, 0))).toEqual([{ level: 'good', text: 'All good: the window has room and nothing heavy is loaded' }])
  })
})

test('pane: fill, breakdown, servers and "More N" on both surfaces', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 84_000, window: 200_000, percent: 42, breakdown: BREAKDOWN }, rateLimits: [] } }))

  const reply = await $.command.run({ command: 'inspector', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(reply.text).toBe('Context: 84k of 200k (42%).')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-inspector', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: '84k of 200k · 42%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Messages' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '55k · 28%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'MCP SERVERS · 3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 tools · 10k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '23eb0007… · agents_create' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 on demand' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'auto-compact at 167k' })).toBeDefined()
    // The breakdown has 7 rows: the first 5 and a "More 2" button.
    expect(await ui.find({ type: 'Text', text: 'MCP tools (on demand) · outside the window' })).toBeUndefined()
    await ui.press({ key: 'more-categories' })
    expect(await ui.find({ type: 'Text', text: 'MCP tools (on demand) · outside the window' })).toBeDefined()
    await ui.press({ key: 'more-categories' })
    await ui.unmount()
  }
})

test('before the first answer — a clear placeholder', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))

  await $.command.run({ command: 'inspector', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ plugin: 'context-inspector', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'No context breakdown yet' })).toBeDefined()
  await ui.unmount()
})
