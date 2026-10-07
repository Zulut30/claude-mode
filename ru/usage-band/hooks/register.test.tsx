import { expect, mock, test } from 'claude-code/testing'
import type { SessionUsage } from 'claude-code'

import { columnOf, formatCacheLeft, formatLeft, formatTokens, plural } from './register'
import { ttlOf } from './speed'

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
  expect(formatCacheLeft(60 * 60_000)).toBe('1 ч')
  expect(formatCacheLeft(90_000)).toBe('2 мин')
  expect(ttlOf({ cache_creation: { ephemeral_1h_input_tokens: 1538, ephemeral_5m_input_tokens: 0 } })).toBe('1h')
  expect(ttlOf({ cache_creation: { ephemeral_5m_input_tokens: 20 } })).toBe('5m')
  expect(ttlOf({ input_tokens: 1 })).toBeUndefined()
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

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

test('/band: скрытые колонки — из хранилища при старте, hide и show по-английски и по-русски', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['hidden', ['speed', 'не колонка']]])
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('session.usage', () => ({ value: USAGE }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>соседний мод</Text>
  })
  const registered: string[] = []
  on('command.register', ($, e) => {
    registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['band'])

  expect(columnOf('КЭШ')).toBe('cache')
  expect(columnOf('limits')).toBe('limits')
  expect(columnOf('лимит')).toBeUndefined()

  // Сохранённое прочитано при старте: «Скорость» скрыта, мусор отброшен.
  expect((await $.command.run({ command: 'band', args: '', ...RUN })).text).toMatch(/скрыты — Скорость\./)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /^СКОРОСТЬ$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^КЭШ$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^5 ЧАСОВ$/ })).toBeDefined()
    await ui.unmount()
  }

  expect((await $.command.run({ command: 'band', args: 'hide кэш', ...RUN })).text).toBe('Колонка «Кэш» скрыта. Вернуть: /band show cache')
  expect((await $.command.run({ command: 'band', args: 'hide limits', ...RUN })).text).toMatch(/^Колонка «Лимиты» скрыта/)
  expect((await $.command.run({ command: 'band', args: 'show speed', ...RUN })).text).toBe('Колонка «Скорость» снова на полосе.')
  expect((await $.command.run({ command: 'band', args: 'hide что-то', ...RUN })).text).toMatch(/^Нет такой колонки/)
  expect(store.get('hidden')).toEqual(['cache', 'limits'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /^КЭШ$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^5 ЧАСОВ$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^НЕДЕЛЯ$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^СКОРОСТЬ$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^КОНТЕКСТ$/ })).toBeDefined()
    // Три колонки влезают в один ряд — каждая по трети ширины.
    expect((await ui.find({ key: 'context' }))?.props.width).toBe('33%')
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

const STEP_USAGE = { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }

/** Ответ, записавший кэш на 5 минут: так бывает и у подписки — после перерасхода. */
const CACHED_5M = { ...STEP_USAGE, cache_creation: { ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 } }

test('колонка «КЭШ»: срок из ответа, отсчёт, жёлтый под конец и «остыл»', async ($, on) => {
  const time = { now: NOW }
  on('clock.now', () => ({ value: time.now }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>соседний мод</Text>
  })
  on('turn.step', async function* (_, e) {
    yield { kind: 'text' as const, index: 0, text: 'готово' }

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
    expect(await band.find({ type: 'Text', text: /^КЭШ$/ })).toBeDefined()
    // Срок из ответа (5 мин) важнее догадки по тарифу (у подписки — час).
    expect(await band.find({ type: 'Text', text: /^5 мин$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^из 5 мин$/ })).toBeDefined()
    await band.unmount()

    time.now = NOW + 3.5 * 60_000
    band = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect((await band.find({ type: 'Text', text: /^2 мин$/ }))?.props.color).toBe('#d29922')
    await band.unmount()

    time.now = NOW + 6 * 60_000
    band = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await band.find({ type: 'Text', text: /^остыл$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^84k заново$/ })).toBeDefined()
    await band.unmount()
  }
})

test('колонка «СКОРОСТЬ»: пусто до ответа, живая оценка во время, средняя за ход после', async ($, on) => {
  const time = { now: 0 }
  on('clock.now', () => ({ value: time.now }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>соседний мод</Text>
  })
  let release: () => void = () => undefined
  const paused = new Promise<void>(resolve => {
    release = resolve
  })
  // 10 кусков по 320 символов раз в 0,5 с: живая оценка 200 ток/с; итог — 1000 токенов за 5 с.
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
  expect(await band.find({ type: 'Text', text: 'СКОРОСТЬ' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'после ответа' })).toBeDefined()
  await band.unmount()

  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
  for (let i = 0; i < 5; i++) {
    await stream.next()
  }
  band = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  expect(await band.find({ type: 'Text', text: '≈200 ток/с' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'идёт ответ' })).toBeDefined()
  await band.unmount()

  release()
  let step = await stream.next()
  while (!step.done) {
    step = await stream.next()
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const view = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await view.find({ type: 'Text', text: '200 ток/с' })).toBeDefined()
    expect(await view.find({ type: 'Text', text: '1 000 ток' })).toBeDefined()
    await view.unmount()
  }
})
