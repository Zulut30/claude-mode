import { expect, mock, test } from 'claude-code/testing'

import { calibrate, finalLine, formatCount, formatRate, liveLine } from './register'

const USAGE = { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
const STEP = { turnId: 't', index: 0, model: 'm', messageCount: 1 }

test('форматирование', () => {
  expect(formatCount(1240)).toBe('1 240')
  expect(formatCount(999)).toBe('999')
  expect(formatRate(52.4)).toBe('52')
  expect(formatRate(7.25)).toBe('7.3')
  expect(liveLine(48.2)).toBe('⚡ ≈48 ток/с')
  expect(finalLine(1240, 24)).toBe('⚡ 52 ток/с · 1 240 ток за 24 с')
  expect(finalLine(300, 2.5)).toBe('⚡ 120 ток/с · 300 ток за 2.5 с')
  expect(calibrate(3.2, 100, 10)).toBe(3.2)
  expect(Math.round(calibrate(3, 4000, 1000) * 100) / 100).toBe(3.3)
})

test('живая оценка во время ответа, точная скорость после; поток не меняется', async ($, on) => {
  // Время шага задаём сами: ответ на `$.clock.now()` — текущее значение `time`.
  let time = 0
  on('clock.now', () => ({ value: time }))
  const lines: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    lines.push(e.text)

    return { value: undefined }
  })
  on('turn.step', async function* () {
    for (let i = 0; i < 10; i++) {
      time = i * 500
      yield { kind: 'text' as const, index: 0, text: 'x'.repeat(320) }
    }
    time = 5000
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: USAGE }

    return { turnId: 't', index: 0, answer: 'x'.repeat(3200), toolUses: [], stopReason: 'end_turn' as const, usage: USAGE }
  })

  const stream = $.turn.step(STEP)
  let chunks = 0
  let step = await stream.next()
  while (!step.done) {
    chunks += 1
    expect(step.value.kind === 'text' || step.value.kind === 'stop').toBe(true)
    step = await stream.next()
  }
  const result = step.value

  expect(chunks).toBe(11)
  expect(result.usage?.output_tokens).toBe(1000)
  // 640 символов за 0,5 с при 3,2 символа на токен — 400 ток/с.
  expect(lines[0]).toBe('⚡ ≈400 ток/с')
  expect(lines.at(-1)).toBe('⚡ 200 ток/с · 1 000 ток за 5.0 с')
})

test('шаги субагентов не трогают строку', async ($, on) => {
  mock.clock(on, { now: 0 })
  const lines: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    lines.push(e.text)

    return { value: undefined }
  })
  on('turn.step', async function* () {
    yield { kind: 'text' as const, index: 0, text: 'x'.repeat(400) }

    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: USAGE }
  })

  const stream = $.turn.step({ ...STEP, agentId: 'sub-1' })
  for await (const _ of stream) {
    // читаем поток до конца
  }
  await stream.result
  expect(lines).toEqual([])
})
