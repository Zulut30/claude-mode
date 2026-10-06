import { expect, mock, test } from 'claude-code/testing'

import { calibrate, finalLine, formatCount, formatRate, formatSeconds, liveLine, sparkline } from './register'

const usage = (output_tokens: number) => ({ input_tokens: 10, output_tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' })
const result = (tokens: number) => ({ turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: usage(tokens) })

type Plan = { chunks: number; size: number; gap: number; tokens: number; fail?: boolean }

/** Step plan → stream chunks: before each chunk the clock moves forward by `advance` ms. */
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

test('formatting, chart and calibration', () => {
  expect(formatCount(1240)).toBe('1,240')
  expect(formatRate(52.4)).toBe('52')
  expect(formatRate(7.25)).toBe('7.3')
  expect(formatSeconds(2.5)).toBe('2.5 s')
  expect(formatSeconds(24)).toBe('24 s')
  expect(formatSeconds(65)).toBe('1 min 5 s')
  expect(sparkline([10])).toBe('')
  expect(sparkline([10, 20, 30])).toBe('▁▅█')
  expect(liveLine(48.2)).toBe('⚡ ≈48 tok/s')
  expect(liveLine(48.2, [10, 20, 30])).toBe('⚡ ≈48 tok/s ▁▅█')
  expect(finalLine(1240, 24, [40, 60])).toBe('⚡ 52 tok/s ▁█ · 1,240 tokens in 24 s')
  expect(calibrate(3.2, 100, 10, false)).toBe(3.2)
  expect(Math.round(calibrate(3, 4000, 1000, false) * 100) / 100).toBe(3.3)
  // A step with thinking leaves calibration alone: the stream didn't carry all of the text.
  expect(calibrate(3, 400, 1000, true)).toBe(3)
})

test('live speed over the last seconds, total is the turn average with a chart of steps', async ($, on) => {
  const time = { now: 0 }
  on('clock.now', () => ({ value: time.now }))
  const lines: (string | undefined)[] = []
  on('ui.status', (_, e) => (lines.push(e.text), { value: undefined }))
  const plan: Plan[] = [
      // 10 chunks of 320 characters every 0.5 s: 100 tokens / 0.5 s = 200 tok/s; 1000 tokens in 5 s overall.
      { chunks: 10, size: 320, gap: 500, tokens: 1000 },
      // The second step is faster: 400 tokens in 1 s.
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

    // The step result echoes the request's turnId and index.
    return { ...result(step.tokens), turnId: e.turnId, index: e.index }
  })

  await drain($.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 }))
  expect(lines[0]).toBe('⚡ ≈200 tok/s')
  expect(lines.at(-1)).toBe('⚡ 200 tok/s · 1,000 tokens in 5.0 s')

  await drain($.turn.step({ turnId: 't1', index: 1, model: 'm', messageCount: 2 }))
  // 1400 tokens in 6 s for the turn; chart: 200 → 400 tok/s.
  expect(lines.at(-1)).toBe('⚡ 233 tok/s ▁█ · 1,400 tokens in 6.0 s')
})

test('a new turn starts the count over; an interrupted answer leaves no "≈"', async ($, on) => {
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

    // The step result echoes the request's turnId and index.
    return { ...result(step.tokens), turnId: e.turnId, index: e.index }
  })

  await drain($.turn.step({ turnId: 'a', index: 0, model: 'm', messageCount: 1 }))
  expect(lines.at(-1)).toBe('⚡ 200 tok/s · 400 tokens in 2.0 s')

  await drain($.turn.step({ turnId: 'b', index: 0, model: 'm', messageCount: 1 })).catch(() => undefined)
  // The new turn has no total yet — the live line is cleared, not stuck.
  expect(lines.at(-1)).toBeUndefined()
})

test('subagent steps leave the line alone', async ($, on) => {
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
