import { expect, mock, test } from 'claude-code/testing'
import type { SessionUsage } from 'claude-code'

import { formatLeft, formatTokens, plural } from './register'

const NOW = Date.parse('2026-10-06T12:00:00Z')

const USAGE: SessionUsage = {
  startedAt: NOW,
  context: {
    tokens: 84_000,
    window: 200_000,
    percent: 42,
    breakdown: {
      categories: [],
      totalTokens: 84_000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      autocompactSource: 'model-default',
      percentage: 42,
      gridRows: [],
      model: 'claude-opus-5-5',
      memoryFiles: [
        { path: 'C:/u/.claude/CLAUDE.md', type: 'User', tokens: 1200 },
        { path: 'C:/u/.claude/memory/MEMORY.md', type: 'AutoMem', tokens: 800 },
      ],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: true,
      apiUsage: null,
    },
  },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-06T14:15:00Z' },
    { kind: 'seven_day', percentUsed: 91, resetsAt: '2026-10-09T16:00:00Z' },
  ],
}

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

test('formatting', () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(84_000)).toBe('84k')
  expect(formatTokens(1_000_000)).toBe('1.0M')
  expect(formatLeft('2026-10-06T14:15:00Z', NOW)).toBe('2h 15m')
  expect(formatLeft('2026-10-09T16:00:00Z', NOW)).toBe('3d 4h')
  expect(formatLeft('2026-10-06T12:15:00Z', NOW)).toBe('15m')
  expect(formatLeft('2026-10-06T11:00:00Z', NOW)).toBe('')
  expect(formatLeft(undefined, NOW)).toBe('')
  expect([1, 2, 5, 11, 21].map(n => plural(n, 'file', 'files'))).toEqual(['file', 'files', 'files', 'files', 'files'])
})

test('band: context, memory and limits on terminal and desktop', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.usage', () => ({ value: USAGE }))
  // A "neighbour mod" renders below the band: its line must stay visible.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>neighbour mod</Text>
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: '42%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '84k/200k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 files' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '~2k tok.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '24%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5 HOURS' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '↻ 2h 15m' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '91%' }))?.props.color).toBe('#f85149')
    expect(await ui.find({ type: 'Text', text: 'neighbour mod' })).toBeDefined()
    const bars =
      surface === 'desktop' ? await ui.findAll({ type: 'Svg' }) : await ui.findAll({ type: 'Text', text: /━/ })
    expect(bars).toHaveLength(3)
    await ui.unmount()
  }
})

test('before the first reply: clear placeholders', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  // A "neighbour mod" renders below the band: its line must stay visible.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>neighbour mod</Text>
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: 'SUBSCRIPTION' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'none' })).toBeDefined()
    await ui.unmount()
  }
})
