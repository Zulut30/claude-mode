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

test('форматирование', () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(84_000)).toBe('84k')
  expect(formatTokens(1_000_000)).toBe('1.0M')
  expect(formatLeft('2026-10-06T14:15:00Z', NOW)).toBe('2 ч 15 мин')
  expect(formatLeft('2026-10-09T16:00:00Z', NOW)).toBe('3 д 4 ч')
  expect(formatLeft('2026-10-06T11:00:00Z', NOW)).toBe('')
  expect(formatLeft(undefined, NOW)).toBe('')
  expect([1, 2, 5, 11, 21, 22].map(n => plural(n, 'файл', 'файла', 'файлов'))).toEqual([
    'файл',
    'файла',
    'файлов',
    'файлов',
    'файл',
    'файла',
  ])
})

test('полоса: контекст, память и лимиты на terminal и desktop', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.usage', () => ({ value: USAGE }))
  // Под полосой рисует «соседний мод»: его строка должна остаться видна.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>соседний мод</Text>
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: '42%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '84k/200k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 файла' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '24%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5 ЧАСОВ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '↻ 3 д 4 ч' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '91%' }))?.props.color).toBe('#f85149')
    expect(await ui.find({ type: 'Text', text: 'соседний мод' })).toBeDefined()
    const bars =
      surface === 'desktop' ? await ui.findAll({ type: 'Svg' }) : await ui.findAll({ type: 'Text', text: /━/ })
    expect(bars).toHaveLength(3)
    await ui.unmount()
  }
})

test('до первого ответа — понятные заглушки', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  // Под полосой рисует «соседний мод»: его строка должна остаться видна.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>соседний мод</Text>
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: 'ПОДПИСКА' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'нет' })).toBeDefined()
    await ui.unmount()
  }
})
