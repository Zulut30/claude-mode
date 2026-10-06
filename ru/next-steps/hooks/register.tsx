// «Дальше»: после ответа Claude — 2–3 вероятных следующих запроса над полем ввода.
// Клик по запросу или цифра 1–3 в пустом поле вставляет его черновиком (сам он не отправляется), 0 скрывает.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NextSteps } from '../types'

const MODEL = 'haiku'
const MAX_ITEMS = 3
/** Длину просим у модели такую; строку длиннее MAX_KEPT выбрасываем, а не режем: обрезанный черновик — полпросьбы. */
const MAX_CHARS = 60
const MAX_KEPT = 120
/** Ответ короче — не повод тратить вызов модели. */
const MIN_ANSWER = 40
/** Ключ в хранилище мода: выключены ли подсказки (переживает перезапуск). */
const OFF_KEY = 'isOff'

const BLUE = '#58a6ff'

const steps = atom({ plugin: 'next-steps', key: 'steps' } as const, null as NextSteps | null)
const isOff = atom({ plugin: 'next-steps', key: 'isOff' } as const, false)

export const register: Register = on => {
  // Ход, к которому ещё относятся подсказки: новый запрос или ход сдвигают его.
  let latest = ''
  let submits = 0
  // Опрос над полем ввода сам отвечает на цифры — не мешаем ему.
  let hasSurvey = false

  on('session.start', async ($, e, next) => {
    // Имя занято другим плагином — команды не будет, но остальной старт сессии должен пройти.
    await $.command
      .register({ name: 'next', description: 'Подсказки «Дальше»: `/next off` — выключить (Haiku не вызывается), `/next on` — включить' })
      .catch(() => undefined)
    const saved = await $.store.get(OFF_KEY).catch(() => undefined)
    await update($, isOff, () => saved === true)

    return next(e)
  })

  on('command.run', { command: 'next' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      const off = arg === 'off'
      await update($, isOff, () => off)
      if (off) {
        await update($, steps, () => null)
      }
      await $.store.set(OFF_KEY, off).catch(() => undefined)

      return { text: off ? 'Подсказки «Дальше» выключены, Haiku больше не вызывается. Включить: /next on' : 'Подсказки «Дальше» включены.' }
    }

    return {
      text: (await read($, isOff))
        ? 'Подсказки «Дальше» выключены. Включить: /next on'
        : 'Подсказки «Дальше» включены: после ответа — 2–3 следующих запроса; клик или 1–3 вставляет черновик, 0 скрывает. Выключить: /next off',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    latest = `submit-${++submits}`
    await update($, steps, () => null)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    latest = e.turnId
    await update($, steps, () => null)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Ход субагента — не ответ человеку.
    if (e.agentId) {
      return result
    }
    latest = e.turnId
    if (e.reason !== 'answer' || e.answer.trim().length < MIN_ANSWER || (await read($, isOff))) {
      return result
    }
    // В фоне: ход заканчивается сразу, подсказки появляются через секунду-две.
    void suggest($, e.turnId, e.answer, () => latest).catch(() => undefined)

    return result
  })

  // Цифра в пустом поле выбирает подсказку, а не печатается. У вставки нет клавиши — вставленная «1» остаётся «1».
  on('prompt.edit', async ($, e, next) => {
    if (hasSurvey || !e.key || e.key.ctrl || e.key.meta || e.text !== '' || e.start !== 0 || e.end !== 0 || !/^[0-9]$/.test(e.inputText)) {
      return next(e)
    }
    const current = await read($, steps)
    if (!current) {
      return next(e)
    }
    if (e.inputText === '0') {
      await update($, steps, () => null)

      return { text: '', cursor: 0 }
    }
    const pick = current.items[Number(e.inputText) - 1]

    return pick ? next({ ...e, inputText: pick }) : next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Что рисуют другие моды и сам Claude Code, остаётся; подсказки — ниже всего, ближе к полю ввода.
    const rest = await next(e)
    hasSurvey = e.props.hasSurvey
    const current = await read($, steps)
    if (e.props.hasSurvey || e.props.isWorking || !current || current.items.length === 0) {
      return rest
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const items = current.items.map((text, i) => `${i + 1} · ${text}`)
    // Родная кнопка десктопа шире своей подписи примерно на 4 клетки.
    const pad = e.surface === 'terminal' ? 0 : 4
    const layout = arrange(items, columns, pad, e.props.maxRows)

    const pick = (label: string, i: number) => (
      <Button
        key={`step-${i + 1}`}
        plain
        label={short(label, layout.room)}
        onPress={() => void $.prompt.fill({ text: current.items[i] ?? '' }).catch(() => undefined)}
      />
    )
    const dismiss = <Button key="dismiss" plain dimColor label="0 · скрыть" onPress={() => update($, steps, () => null)} />
    const title = (
      <Text key="title" color={BLUE} bold>
        ДАЛЬШЕ
      </Text>
    )

    return (
      <Box flexDirection="column">
        {rest}
        {layout.isRow ? (
          <Box key="next-steps" flexDirection="row" alignItems="center" columnGap={2}>
            {title}
            {items.map(pick)}
            {dismiss}
          </Box>
        ) : (
          <Box key="next-steps" flexDirection="column">
            <Box key="next-steps-head" flexDirection="row" justifyContent="space-between" alignItems="center">
              {title}
              {dismiss}
            </Box>
            {items.map((label, i) => (
              <Box key={`step-row-${i + 1}`} flexDirection="row" paddingLeft={2}>
                {pick(label, i)}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}

const width = (text: string) => [...text].length

export const short = (text: string, max: number) => {
  const chars = [...text.replace(/\s+/g, ' ').trim()]

  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : chars.join('')
}

/**
 * Раскладка: всё в одну строку, если влезает; иначе по запросу на строку, если полосе хватает строк;
 * иначе одна строка, где каждый запрос обрезан поровну. `room` — сколько клеток на подпись запроса.
 */
export const arrange = (labels: readonly string[], columns: number, pad: number, maxRows: number) => {
  const fixed = width('ДАЛЬШЕ') + width('0 · скрыть') + pad + 2 * (labels.length + 1)
  const natural = fixed + labels.reduce((sum, label) => sum + width(label) + pad, 0)
  if (natural <= columns) {
    return { isRow: true, room: Math.max(...labels.map(width)) }
  }
  if (maxRows >= labels.length + 1) {
    return { isRow: false, room: Math.max(8, columns - 2 - pad) }
  }

  return { isRow: true, room: Math.max(8, Math.floor((columns - fixed) / labels.length) - pad) }
}

async function suggest($: EngineInterface, turnId: string, answer: string, current: () => string) {
  // Пока работают фоновые агенты, Claude ещё продолжит сам — подсказывать рано.
  const agents = await $.agent.list().catch(() => [])
  if (agents.some(agent => agent.status === 'running')) {
    return
  }

  const all = (await $.session.messages().catch(() => [])).filter(message => message.text.trim() !== '')
  // Последний ответ идёт ниже отдельно.
  if (all.at(-1)?.role === 'assistant') {
    all.pop()
  }
  const recent = all.slice(-6)
  const reply = await $.model.complete({
    model: MODEL,
    maxTokens: 200,
    timeoutMs: 20_000,
    system:
      'Ты угадываешь, что человек напишет своему ассистенту-программисту следующим, по выдержке из их сессии. ' +
      `Дай 2 или 3 коротких конкретных запроса — каждый поручение в повелительном наклонении, не длиннее ${MAX_CHARS} символов, ` +
      'про то, что только что произошло (назови файл, тест или функцию). Пиши на том же языке, на котором пишет человек. ' +
      'Без нумерации, кавычек и пояснений: по одному на строку и больше ничего. Если разумного продолжения нет — ответь одним словом NONE.\n' +
      'Пример ответа:\nЗапусти тесты логина ещё раз\nДобавь ту же проверку в signup.ts\nОткрой черновой PR',
    prompt: [
      `<transcript>\n${recent.map(message => `[${message.role === 'user' ? 'человек' : 'ассистент'}] ${message.text.slice(0, 800)}`).join('\n')}\n</transcript>`,
      `<latest_reply>\n${answer.slice(0, 2000)}\n</latest_reply>`,
      'Напиши запросы, которые человек вероятнее всего отправит следующими: только строки, не ответ на переписку.',
    ].join('\n\n'),
  })
  if (!reply.isAnswered) {
    return
  }
  const items = parseSteps(reply.text)
  // Проверка внутри записи: новый запрос или ход, пришедший за это время, всегда важнее.
  await update($, steps, before => (current() !== turnId ? before : items.length > 0 ? { turnId, items } : null))
}

/** Строки ответа модели, очищенные от маркеров, номеров и кавычек; не больше трёх. Вступления и «нечего добавить» выбрасываются. */
export function parseSteps(text: string): string[] {
  const out: string[] = []
  for (const line of text.replace(/```[a-z]*\n?/gi, '').split('\n')) {
    const clean = line
      .replace(/\*\*/g, '')
      .replace(/^\s*(?:[-*•]|\d+[.):])\s*/, '')
      .replace(/^["'`«]+|["'`»,]+$/g, '')
      .replace(/\.$/, '')
      .trim()
    if (clean === '' || clean.endsWith(':') || clean.length > MAX_KEPT) {
      continue
    }
    if (/^(none|нет$|ничего|вот |конечно|here are|sure)/i.test(clean)) {
      continue
    }
    if (!out.some(one => one.toLowerCase() === clean.toLowerCase())) {
      out.push(clean)
    }
    if (out.length === MAX_ITEMS) {
      break
    }
  }

  return out
}
