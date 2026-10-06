import { describe, expect, test } from 'claude-code/testing'

import { arrange, parseSteps } from './register'

const ANSWER = 'Done: added a password check to login.ts and a test to login.test.ts, all tests pass.'
const MODEL_TEXT = '1. Rerun the login tests\n- "Add the same check to signup.ts"\nOpen a draft PR.\nA fourth one too many'
const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

/** The test runner's timer: the mod's environment doesn't have it, so the types don't either. */
const sleep = (ms: number) =>
  new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, ms))

/** The mod's background work (the model call after a turn) gets time to finish. */
const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await sleep(5)
  }
}

describe('parsing and layout', () => {
  test('model lines: no numbers, bullets, quotes or trailing period; three at most; NONE — empty', () => {
    expect(parseSteps(MODEL_TEXT)).toEqual(['Rerun the login tests', 'Add the same check to signup.ts', 'Open a draft PR'])
    expect(parseSteps('NONE')).toEqual([])
    expect(parseSteps('Here are some options:\nRun the linter')).toEqual(['Run the linter'])
  })

  test('one line if it fits; otherwise a column; too few rows — trim evenly', () => {
    const labels = ['1 · Rerun the login tests', '2 · Add the same check to signup.ts', '3 · Open a draft PR']
    expect(arrange(labels, 160, 0, 10).isRow).toBe(true)
    expect(arrange(labels, 80, 0, 10)).toEqual({ isRow: false, room: 78 })
    const tight = arrange(labels, 80, 0, 2)
    expect(tight.isRow).toBe(true)
    expect(tight.room).toBeLessThan(24)
  })
})

test('after a reply — suggestions above the input; a click drafts one, 0 hides them', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('store.get', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'add a password check', toolUses: [] }] }))
  const asked: string[] = []
  on('model.complete', (_, e) => {
    asked.push(e.model)

    return { value: { isAnswered: true, text: MODEL_TEXT, usage: USAGE } }
  })
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>neighbour mod</Text>
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ turnId: 't1', answer: ANSWER, reason: 'answer', durationMs: 1000, isAborted: false })
  await settle()
  expect(asked).toEqual(['haiku'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'next-steps', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /^neighbour mod$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^NEXT$/ })).toBeDefined()
    expect((await ui.find({ key: 'step-1' }))?.text).toBe('1 · Rerun the login tests')
    expect((await ui.find({ key: 'step-3' }))?.text).toBe('3 · Open a draft PR')

    filled.length = 0
    await ui.press({ key: 'step-2' })
    expect(filled).toEqual(['Add the same check to signup.ts'])
    await ui.unmount()
  }

  // While Claude is working, the suggestions band is hidden.
  const busy = await $.ui.mount({ plugin: 'next-steps', surface: 'desktop', ...BAND, props: { ...BAND.props, isWorking: true } })
  expect(await busy.find({ key: 'step-1' })).toBeUndefined()
  await busy.unmount()

  const ui = await $.ui.mount({ plugin: 'next-steps', surface: 'terminal', ...BAND })
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ key: 'step-1' })).toBeUndefined()
  await ui.unmount()
})

test('short reply, subagent turn and /next off — no model call', async ($, on) => {
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

    return { value: { isAnswered: true, text: 'Run the tests', usage: USAGE } }
  })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ turnId: 't1', answer: 'OK.', reason: 'answer', durationMs: 10, isAborted: false })
  await $.turn.complete({ turnId: 't2', answer: ANSWER, reason: 'answer', durationMs: 10, isAborted: false, agentId: 'a1' })
  await settle()
  expect(calls).toBe(0)

  const reply = await $.command.run({ command: 'next', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(reply.text).toMatch(/suggestions are off/)
  expect(saved).toEqual([true])
  await $.turn.complete({ turnId: 't3', answer: ANSWER, reason: 'answer', durationMs: 10, isAborted: false })
  await settle()
  expect(calls).toBe(0)

  await $.command.run({ command: 'next', args: 'on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await $.turn.complete({ turnId: 't4', answer: ANSWER, reason: 'answer', durationMs: 10, isAborted: false })
  await settle()
  expect(calls).toBe(1)
})
