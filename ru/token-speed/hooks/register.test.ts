import { expect, mock, test } from 'claude-code/testing'

import { calibrate, finalLine, formatCount, formatRate, formatSeconds, liveLine, sparkline } from './register'

const usage = (output_tokens: number) => ({ input_tokens: 10, output_tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' })
const result = (tokens: number) => ({ turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: usage(tokens) })

type Plan = { chunks: number; size: number; gap: number; tokens: number; fail?: boolean }

/** План шага → куски потока: перед каждым куском часы сдвигаются на `advance` мс. */
const script = (step: Plan) => [
  ...Array.from({ length: step.chunks }, (_, i) => ({ advance: i > 0 ? step.gap : 0, chunk: { kind: 'text' as const, index: 0, text: 'x'.repeat(step.size) } })),
  ...(step.fail ? [] : [{ advance: step.gap, chunk: { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: usage(step.tokens) } }]),
]

const drain = async (stream: AsyncGenerator<unknown, unknown>) => {
  let step = await stream.next()
  while (!step.done) {
    step = await stream.next()
  }

  return step.value
}

test('форматирование, график и калибровка', () => {
  expect(formatCount(1240)).toBe('1 240')
  expect(formatRate(52.4)).toBe('52')
  expect(formatRate(7.25)).toBe('7.3')
  expect(formatSeconds(2.5)).toBe('2.5 с')
  expect(formatSeconds(65)).toBe('1 мин 5 с')
  expect(sparkline([10])).toBe('')
  expect(sparkline([10, 20, 30])).toBe('▁▅█')
  expect(liveLine(48.2)).toBe('⚡ ≈48 ток/с')
  expect(finalLine(1240, 24, [40, 60])).toBe('⚡ 52 ток/с ▁█ · 1 240 ток за 24 с')
  expect(calibrate(3.2, 100, 10, false)).toBe(3.2)
  expect(Math.round(calibrate(3, 4000, 1000, false) * 100) / 100).toBe(3.3)
  // Шаг с размышлениями не трогает калибровку: в потоке был не весь текст.
  expect(calibrate(3, 400, 1000, true)).toBe(3)
})

test('живая скорость по последним секундам, итог — средняя за весь ход с графиком шагов', async ($, on) => {
  const time = { now: 0 }
  on('clock.now', () => ({ value: time.now }))
  const lines: (string | undefined)[] = []
  on('ui.status', (_, e) => (lines.push(e.text), { value: undefined }))
  const plan: Plan[] = [
      // 10 кусков по 320 символов раз в 0,5 с: 100 токенов / 0,5 с = 200 ток/с; всего 1000 токенов за 5 с.
      { chunks: 10, size: 320, gap: 500, tokens: 1000 },
      // Второй шаг быстрее: 400 токенов за 1 с.
      { chunks: 2, size: 640, gap: 500, tokens: 400 },
    ]
  let index = 0
  on('turn.step', async function* (_, e) {
    const step = plan[index++]
    if (!step) {
      return { ...result(0), turnId: e.turnId, index: e.index }
    }
    for (const { advance, chunk } of script(step)) {
      time.now += advance
      yield chunk
    }
    if (step.fail) {
      throw new Error('interrupted')
    }

    // Итог шага повторяет turnId и index запроса.
    return { ...result(step.tokens), turnId: e.turnId, index: e.index }
  })

  await drain($.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 }))
  expect(lines[0]).toBe('⚡ ≈200 ток/с')
  expect(lines.at(-1)).toBe('⚡ 200 ток/с · 1 000 ток за 5.0 с')

  await drain($.turn.step({ turnId: 't1', index: 1, model: 'm', messageCount: 2 }))
  // 1400 токенов за 6 с за ход; график: 200 → 400 ток/с.
  expect(lines.at(-1)).toBe('⚡ 233 ток/с ▁█ · 1 400 ток за 6.0 с')
})

test('новый ход начинает счёт заново; прерванный ответ не оставляет «≈»', async ($, on) => {
  const time = { now: 0 }
  on('clock.now', () => ({ value: time.now }))
  const lines: (string | undefined)[] = []
  on('ui.status', (_, e) => (lines.push(e.text), { value: undefined }))
  const plan: Plan[] = [
      { chunks: 4, size: 320, gap: 500, tokens: 400 },
      { chunks: 4, size: 320, gap: 500, tokens: 0, fail: true },
    ]
  let index = 0
  on('turn.step', async function* (_, e) {
    const step = plan[index++]
    if (!step) {
      return { ...result(0), turnId: e.turnId, index: e.index }
    }
    for (const { advance, chunk } of script(step)) {
      time.now += advance
      yield chunk
    }
    if (step.fail) {
      throw new Error('interrupted')
    }

    // Итог шага повторяет turnId и index запроса.
    return { ...result(step.tokens), turnId: e.turnId, index: e.index }
  })

  await drain($.turn.step({ turnId: 'a', index: 0, model: 'm', messageCount: 1 }))
  expect(lines.at(-1)).toBe('⚡ 200 ток/с · 400 ток за 2.0 с')

  await drain($.turn.step({ turnId: 'b', index: 0, model: 'm', messageCount: 1 })).catch(() => undefined)
  // В новом ходе итога ещё нет — живая строка убрана, а не зависла.
  expect(lines.at(-1)).toBeUndefined()
})

test('шаги субагентов не трогают строку', async ($, on) => {
  mock.clock(on, { now: 0 })
  const lines: (string | undefined)[] = []
  on('ui.status', (_, e) => (lines.push(e.text), { value: undefined }))
  on('turn.step', async function* () {
    yield { kind: 'text' as const, index: 0, text: 'x'.repeat(400) }

    return result(100)
  })

  await drain($.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId: 'sub-1' }))
  expect(lines).toEqual([])
})
