import { describe, expect, test } from 'claude-code/testing'

import { chipRoom, clip, parseReply, parseSteps } from './register'

const ANSWER = 'Готово: добавил проверку пароля в login.ts и тест в login.test.ts, все тесты проходят.'
const MODEL_TEXT = '1. Запусти тесты логина ещё раз\n- «Добавь ту же проверку в signup.ts»\nОткрой черновой PR.\nЧетвёртый лишний'
/** Ответ модели целиком: цель, «ждёт вас» и подсказки, в обёртке, как модели любят. */
const MODEL_JSON = [
  '```json',
  JSON.stringify({
    goal: 'Страница входа с проверкой пароля.',
    waiting: 'подтвердить удаление token-speed',
    steps: ['Запусти тесты логина ещё раз', '«Добавь ту же проверку в signup.ts»', 'Открой черновой PR.', 'Четвёртый лишний'],
  }),
  '```',
].join('\n')
const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

/** Таймер тестового запуска: в окружении мода его нет, поэтому и в типах тоже. */
const sleep = (ms: number) =>
  new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, ms))

/** Фоновая работа мода (вызов модели после хода) успевает закончиться. */
const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await sleep(5)
  }
}

describe('разбор и раскладка', () => {
  test('строки модели: без номеров, маркеров, кавычек и точки; не больше трёх; NONE — пусто', () => {
    expect(parseSteps(MODEL_TEXT)).toEqual(['Запусти тесты логина ещё раз', 'Добавь ту же проверку в signup.ts', 'Открой черновой PR'])
    expect(parseSteps('NONE')).toEqual([])
    expect(parseSteps('Вот варианты:\nЗапусти линтер')).toEqual(['Запусти линтер'])
  })

  test('JSON модели: цель и «ждёт вас» очищены, подсказки как построчно; не JSON — только подсказки', () => {
    expect(parseReply(MODEL_JSON)).toEqual({
      goal: 'Страница входа с проверкой пароля',
      waiting: 'подтвердить удаление token-speed',
      items: ['Запусти тесты логина ещё раз', 'Добавь ту же проверку в signup.ts', 'Открой черновой PR'],
    })
    expect(parseReply('{"goal": "", "waiting": "", "steps": []}')).toEqual({ items: [] })
    expect(parseReply(MODEL_TEXT)).toEqual({ items: ['Запусти тесты логина ещё раз', 'Добавь ту же проверку в signup.ts', 'Открой черновой PR'] })
    expect(clip('«Очень длинная цель, которая никак не помещается»', 20)).toBe('Очень длинная цель…')
    expect(clip('Страница входа', 20)).toBe('Страница входа')
  })

  test('место на подсказку: поровну в одну строку; тесно — перенос с полной длиной, но не длиннее 48', () => {
    expect(chipRoom(3, 160)).toBe(41)
    expect(chipRoom(3, 80)).toBe(48)
    expect(chipRoom(3, 30)).toBe(18)
    expect(chipRoom(2, 200)).toBe(48)
  })
})

test('после ответа — подсказки над полем ввода; клик вставляет черновик, 0 скрывает', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('store.get', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'добавь проверку пароля', toolUses: [] }] }))
  const asked: string[] = []
  const prompts: string[] = []
  on('model.complete', (_, e) => {
    asked.push(e.model)
    prompts.push(e.prompt)

    return { value: { isAnswered: true, text: MODEL_JSON, usage: USAGE } }
  })
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>соседний мод</Text>
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ turnId: 't1', answer: ANSWER, reason: 'answer', durationMs: 1000, isAborted: false })
  await settle()
  expect(asked).toEqual(['haiku'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'next-steps', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: 'соседний мод' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ДАЛЬШЕ$/ })).toBeDefined()
    // Над подсказками — цель и чего ждёт ассистент.
    expect(await ui.find({ type: 'Text', text: /^Страница входа с проверкой пароля$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^ждёт вас: подтвердить удаление token-speed$/ }))?.props.color).toBe('#d29922')
    expect((await ui.find({ key: 'step-1' }))?.text).toBe('1 · Запусти тесты логина ещё раз')
    // Подсказки — кнопки с рамкой (видно, что жмутся), «скрыть» — тихий ✕.
    expect((await ui.find({ key: 'step-1' }))?.props.plain).toBeUndefined()
    expect((await ui.find({ key: 'dismiss' }))?.text).toBe('✕')
    expect((await ui.find({ key: 'step-3' }))?.text).toBe('3 · Открой черновой PR')

    filled.length = 0
    await ui.press({ key: 'step-2' })
    expect(filled).toEqual(['Добавь ту же проверку в signup.ts'])
    await ui.unmount()
  }

  // Цель держится между ходами: следующий запрос к модели её получает.
  expect(prompts[0]).toMatch(/^Прежняя цель: нет/)
  await $.turn.complete({ turnId: 't2', answer: ANSWER, reason: 'answer', durationMs: 1000, isAborted: false })
  await settle()
  expect(prompts[1]).toMatch(/^Прежняя цель: Страница входа с проверкой пароля/)

  // Пока Claude работает, полоса подсказок не видна.
  const busy = await $.ui.mount({ plugin: 'next-steps', surface: 'desktop', ...BAND, props: { ...BAND.props, isWorking: true } })
  expect(await busy.find({ key: 'step-1' })).toBeUndefined()
  await busy.unmount()

  const ui = await $.ui.mount({ plugin: 'next-steps', surface: 'terminal', ...BAND })
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ key: 'step-1' })).toBeUndefined()
  await ui.unmount()
})

test('короткий ответ, ход субагента и /next off — без вызова модели', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('store.get', () => ({ value: undefined }))
  const saved: unknown[] = []
  on('store.set', (_, e) => {
    saved.push(e.value)

    return { value: undefined }
  })
  on('agent.list', () => ({ value: [] }))
  on('session.messages', () => ({ value: [] }))
  let calls = 0
  on('model.complete', () => {
    calls += 1

    return { value: { isAnswered: true, text: 'Запусти тесты', usage: USAGE } }
  })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ turnId: 't1', answer: 'Ок.', reason: 'answer', durationMs: 10, isAborted: false })
  await $.turn.complete({ turnId: 't2', answer: ANSWER, reason: 'answer', durationMs: 10, isAborted: false, agentId: 'a1' })
  await settle()
  expect(calls).toBe(0)

  const reply = await $.command.run({ command: 'next', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(reply.text).toMatch(/выключены/)
  expect(saved).toEqual([true])
  await $.turn.complete({ turnId: 't3', answer: ANSWER, reason: 'answer', durationMs: 10, isAborted: false })
  await settle()
  expect(calls).toBe(0)

  await $.command.run({ command: 'next', args: 'on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await $.turn.complete({ turnId: 't4', answer: ANSWER, reason: 'answer', durationMs: 10, isAborted: false })
  await settle()
  expect(calls).toBe(1)
})
