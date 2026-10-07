import { expect, mock, test } from 'claude-code/testing'
import type { SessionUsage } from 'claude-code'

import { columnOf, formatCacheLeft, formatLeft, formatTokens, plural } from './register'
import { formatCount, ttlOf } from './speed'

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
  expect(formatLeft('2026-10-06T14:15:00Z', NOW)).toBe('2h 15 min')
  expect(formatLeft('2026-10-09T16:00:00Z', NOW)).toBe('3d 4h')
  expect(formatLeft('2026-10-06T11:00:00Z', NOW)).toBe('')
  expect(formatLeft(undefined, NOW)).toBe('')
  expect(formatCacheLeft(60 * 60_000)).toBe('1h')
  expect(formatCacheLeft(90_000)).toBe('2 min')
  expect(formatCount(1240)).toBe('1,240')
  expect(ttlOf({ cache_creation: { ephemeral_1h_input_tokens: 1538, ephemeral_5m_input_tokens: 0 } })).toBe('1h')
  expect(ttlOf({ cache_creation: { ephemeral_5m_input_tokens: 20 } })).toBe('5m')
  expect(ttlOf({ input_tokens: 1 })).toBeUndefined()
  expect([0, 1, 2, 5, 11, 21].map(n => plural(n, 'file', 'files'))).toEqual(['files', 'file', 'files', 'files', 'files', 'files'])
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
    expect(await ui.find({ type: 'Text', text: /^42%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^84k\/200k$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^2 files$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^24%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^5 HOURS$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^↻ 3d 4h$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^91%$/ }))?.props.color).toBe('#f85149')
    expect(await ui.find({ type: 'Text', text: /^neighbour mod$/ })).toBeDefined()
    const bars =
      surface === 'desktop' ? await ui.findAll({ type: 'Svg' }) : await ui.findAll({ type: 'Text', text: /━/ })
    expect(bars).toHaveLength(3)
    await ui.unmount()
  }
})

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

test('/band: hidden columns — from the store at start, hide and show by id or name', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['hidden', ['speed', 'not a column']]])
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('session.usage', () => ({ value: USAGE }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>neighbour mod</Text>
  })
  const registered: string[] = []
  on('command.register', ($, e) => {
    registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['band'])

  expect(columnOf('CACHE')).toBe('cache')
  expect(columnOf('Limits')).toBe('limits')
  expect(columnOf('lim')).toBeUndefined()

  // What was saved is read at start: Speed is hidden, junk dropped.
  expect((await $.command.run({ command: 'band', args: '', ...RUN })).text).toMatch(/hidden — Speed\./)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /^SPEED$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^CACHE$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^5 HOURS$/ })).toBeDefined()
    await ui.unmount()
  }

  expect((await $.command.run({ command: 'band', args: 'hide Cache', ...RUN })).text).toBe('The Cache column is hidden. Bring it back: /band show cache')
  expect((await $.command.run({ command: 'band', args: 'hide limits', ...RUN })).text).toMatch(/^The Limits column is hidden/)
  expect((await $.command.run({ command: 'band', args: 'show speed', ...RUN })).text).toBe('The Speed column is back on the band.')
  expect((await $.command.run({ command: 'band', args: 'hide something', ...RUN })).text).toMatch(/^No such column/)
  expect(store.get('hidden')).toEqual(['cache', 'limits'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /^CACHE$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^5 HOURS$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^WEEK$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^SPEED$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^CONTEXT$/ })).toBeDefined()
    // Three columns fit in one row — a third of the width each.
    expect((await ui.find({ key: 'context' }))?.props.width).toBe('33%')
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
    expect(await ui.find({ type: 'Text', text: /^SUBSCRIPTION$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^none$/ })).toBeDefined()
    await ui.unmount()
  }
})

const STEP_USAGE = { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }

/** A reply that wrote the cache for 5 minutes: this happens on a subscription too — after going over the limit. */
const CACHED_5M = { ...STEP_USAGE, cache_creation: { ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 } }

test('CACHE column: lifetime from the reply, countdown, yellow near the end and "cold"', async ($, on) => {
  const time = { now: NOW }
  on('clock.now', () => ({ value: time.now }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>neighbour mod</Text>
  })
  on('turn.step', async function* (_, e) {
    yield { kind: 'text' as const, index: 0, text: 'done' }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: CACHED_5M }
  })

  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
  let step = await stream.next()
  while (!step.done) {
    step = await stream.next()
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    time.now = NOW
    let band = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await band.find({ type: 'Text', text: /^CACHE$/ })).toBeDefined()
    // The lifetime from the reply (5 min) beats the guess from the plan (an hour on a subscription).
    expect(await band.find({ type: 'Text', text: /^5 min$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^of 5 min$/ })).toBeDefined()
    await band.unmount()

    time.now = NOW + 3.5 * 60_000
    band = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect((await band.find({ type: 'Text', text: /^2 min$/ }))?.props.color).toBe('#d29922')
    await band.unmount()

    time.now = NOW + 6 * 60_000
    band = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await band.find({ type: 'Text', text: /^cold$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^84k anew$/ })).toBeDefined()
    await band.unmount()
  }
})

test('SPEED column: empty before a reply, live estimate during, turn average after', async ($, on) => {
  const time = { now: 0 }
  on('clock.now', () => ({ value: time.now }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>neighbour mod</Text>
  })
  let release: () => void = () => undefined
  const paused = new Promise<void>(resolve => {
    release = resolve
  })
  // 10 chunks of 320 characters every 0.5 s: live estimate 200 tok/s; total — 1000 tokens in 5 s.
  on('turn.step', async function* (_, e) {
    for (let i = 0; i < 10; i++) {
      time.now = i * 500
      yield { kind: 'text' as const, index: 0, text: 'x'.repeat(320) }
      if (i === 4) {
        await paused
      }
    }
    time.now = 5000
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: STEP_USAGE }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: STEP_USAGE }
  })

  let band = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  expect(await band.find({ type: 'Text', text: /^SPEED$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^after a reply$/ })).toBeDefined()
  await band.unmount()

  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
  for (let i = 0; i < 5; i++) {
    await stream.next()
  }
  band = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  expect(await band.find({ type: 'Text', text: /^≈200 tok\/s$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^replying$/ })).toBeDefined()
  await band.unmount()

  release()
  let step = await stream.next()
  while (!step.done) {
    step = await stream.next()
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const view = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await view.find({ type: 'Text', text: /^200 tok\/s$/ })).toBeDefined()
    expect(await view.find({ type: 'Text', text: /^1,000 tok$/ })).toBeDefined()
    await view.unmount()
  }
})
