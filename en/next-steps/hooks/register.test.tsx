import { describe, expect, test } from 'claude-code/testing'

import { chipRoom, clip, parseReply, parseSteps } from './register'

const ANSWER = 'Done: added a password check to login.ts and a test to login.test.ts, all tests pass.'
const MODEL_TEXT = '1. Rerun the login tests\n- "Add the same check to signup.ts"\nOpen a draft PR.\nA fourth one too many'
/** The model's whole reply: goal, "waiting on you" and suggestions, in a fence, as models like to. */
const MODEL_JSON = [
  '```json',
  JSON.stringify({
    goal: 'Login page with password checks.',
    waiting: 'confirm deleting token-speed',
    steps: ['Rerun the login tests', '"Add the same check to signup.ts"', 'Open a draft PR.', 'A fourth one too many'],
  }),
  '```',
].join('\n')
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

  test('model JSON: goal and "waiting on you" cleaned, suggestions as line by line; not JSON — suggestions only', () => {
    expect(parseReply(MODEL_JSON)).toEqual({
      goal: 'Login page with password checks',
      waiting: 'confirm deleting token-speed',
      items: ['Rerun the login tests', 'Add the same check to signup.ts', 'Open a draft PR'],
    })
    expect(parseReply('{"goal": "", "waiting": "", "steps": []}')).toEqual({ items: [] })
    expect(parseReply(MODEL_TEXT)).toEqual({ items: ['Rerun the login tests', 'Add the same check to signup.ts', 'Open a draft PR'] })
    expect(clip('"A very long goal, which never fits at all"', 20)).toBe('A very long goal…')
    expect(clip('Login page', 20)).toBe('Login page')
  })

  test('room per suggestion: shared evenly on one line; when tight — wrap at full length, but no longer than 48', () => {
    expect(chipRoom(3, 160)).toBe(41)
    expect(chipRoom(3, 80)).toBe(48)
    expect(chipRoom(3, 30)).toBe(18)
    expect(chipRoom(2, 200)).toBe(48)
  })
})

test('after a reply — suggestions above the input; a click drafts one, 0 hides them', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('store.get', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'add a password check', toolUses: [] }] }))
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
    // Above the suggestions: the goal and what the assistant is waiting on.
    expect(await ui.find({ type: 'Text', text: /^Login page with password checks$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^waiting on you: confirm deleting token-speed$/ }))?.props.color).toBe('#d29922')
    expect((await ui.find({ key: 'step-1' }))?.text).toBe('1 · Rerun the login tests')
    // Suggestions are framed buttons (clearly clickable); "hide" is a quiet ✕.
    expect((await ui.find({ key: 'step-1' }))?.props.plain).toBeUndefined()
    expect((await ui.find({ key: 'dismiss' }))?.text).toBe('✕')
    expect((await ui.find({ key: 'step-3' }))?.text).toBe('3 · Open a draft PR')

    filled.length = 0
    await ui.press({ key: 'step-2' })
    expect(filled).toEqual(['Add the same check to signup.ts'])
    await ui.unmount()
  }

  // The goal carries across turns: the next model request gets it.
  expect(prompts[0]).toMatch(/^Previous goal: none/)
  await $.turn.complete({ turnId: 't2', answer: ANSWER, reason: 'answer', durationMs: 1000, isAborted: false })
  await settle()
  expect(prompts[1]).toMatch(/^Previous goal: Login page with password checks/)

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
