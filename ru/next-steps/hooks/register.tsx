// «Дальше»: после ответа Claude — 2–3 вероятных следующих запроса над полем ввода.
// Клик по запросу или цифра 1–3 в пустом поле вставляет его черновиком (сам он не отправляется), 0 скрывает.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NextSteps } from '../types'

const MODEL = 'haiku'
const MAX_ITEMS = 3
/** Длину просим у модели такую; строку длиннее MAX_KEPT выбрасываем, а не режем: обрезанный черновик — полпросьбы. */
const MAX_CHARS = 45
const MAX_KEPT = 120
/** Длиннее на кнопке не показываем; черновиком вставляется полный текст. */
const MAX_LABEL = 48
/** Цель и «ждёт вас» — коротко, в одну строку. */
const MAX_GOAL = 60
const MAX_WAITING = 70

const BLUE = '#58a6ff'
const AMBER = '#d29922'
/** Ответ короче — не повод тратить вызов модели. */
const MIN_ANSWER = 40
/** Ключ в хранилище мода: выключены ли подсказки (переживает перезапуск). */
const OFF_KEY = 'isOff'

const steps = atom({ plugin: 'next-steps', key: 'steps' } as const, null as NextSteps | null)
const isOff = atom({ plugin: 'next-steps', key: 'isOff' } as const, false)
const goal = atom({ plugin: 'next-steps', key: 'goal' } as const, '')

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
    if (e.props.hasSurvey || e.props.isWorking || !current || (current.items.length === 0 && !current.waiting)) {
      return rest
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const room = chipRoom(current.items.length, columns)
    const dismiss = <Button key="dismiss" plain dimColor label="✕" onPress={() => update($, steps, () => null)} />

    // Цель и «ждёт вас» — одной строкой над подсказками: где мы и чей ход.
    const goalRoom = Math.max(12, current.waiting ? Math.floor(columns * 0.4) : columns - 4)
    const goalWidth = current.goal ? Math.min([...current.goal].length, goalRoom) + 5 : 0
    const recap =
      current.goal || current.waiting ? (
        <Box key="next-steps-recap" flexDirection="row" alignItems="center" columnGap={3}>
          {current.goal ? (
            <Box key="goal" flexDirection="row" columnGap={1}>
              <Text color={BLUE}>◆</Text>
              <Text>{short(current.goal, goalRoom)}</Text>
            </Box>
          ) : null}
          {current.waiting ? (
            <Box key="waiting" flexDirection="row" columnGap={1}>
              <Text color={AMBER}>⏳</Text>
              <Text color={AMBER}>{`ждёт вас: ${short(current.waiting, Math.max(12, columns - goalWidth - 14))}`}</Text>
            </Box>
          ) : null}
          {current.items.length === 0 ? dismiss : null}
        </Box>
      ) : null

    // Подсказки: тихий заголовок, настоящие кнопки (видно, что жмутся), ✕ в конце.
    // Не влезают в ширину — переносятся, а не встают столбиком на всю полосу.
    return (
      <Box flexDirection="column">
        {rest}
        {recap}
        {current.items.length > 0 ? (
          <Box key="next-steps" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
            <Text key="title" dimColor bold>
              ДАЛЬШЕ
            </Text>
            {current.items.map((text, i) => (
              <Button
                key={`step-${i + 1}`}
                label={`${i + 1} · ${short(text, room)}`}
                onPress={() => void $.prompt.fill({ text }).catch(() => undefined)}
              />
            ))}
            {dismiss}
          </Box>
        ) : null}
      </Box>
    )
  })
}

export const short = (text: string, max: number) => {
  const chars = [...text.replace(/\s+/g, ' ').trim()]

  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : chars.join('')
}

/**
 * Сколько клеток на текст подсказки: поровну, чтобы все встали в одну строку с заголовком и ✕;
 * если так выходит меньше 20 — кнопки переносятся, и каждой даётся до MAX_LABEL.
 * Рамка кнопки и «1 · » — около 8 клеток.
 */
export const chipRoom = (count: number, columns: number) => {
  const shared = Math.floor((columns - 'ДАЛЬШЕ'.length - 3 - (count + 1)) / Math.max(1, count)) - 8

  return Math.min(MAX_LABEL, shared >= 20 ? shared : Math.max(12, columns - 12))
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
  const previous = await read($, goal)
  // Один вызов на всё: цель, «ждёт вас» и подсказки — лишних запросов к модели нет.
  const reply = await $.model.complete({
    model: MODEL,
    maxTokens: 300,
    timeoutMs: 20_000,
    system:
      'Ты помогаешь человеку не терять нить сессии с ассистентом-программистом. По выдержке из сессии ответь только JSON вида ' +
      '{"goal": "...", "waiting": "...", "steps": ["...", "..."]}. ' +
      'goal — общая цель сессии в 3–8 словах; если прежняя цель явно не сменилась, повтори её. ' +
      `waiting — чего ассистент ждёт от человека прямо сейчас (ответа на вопрос, подтверждения, проверки руками), не длиннее ${MAX_WAITING} символов; ничего не ждёт — пустая строка. ` +
      `steps — 2 или 3 запроса, которые человек вероятнее всего напишет следующими: от его лица, поручение в повелительном наклонении, не длиннее ${MAX_CHARS} символов. ` +
      'Правила для steps. 1) Если ответ ассистента кончается вопросом или предложением («Сделать?», «Скажите, если…»), первый — согласие с конкретикой («Да, удали папку token-speed»). ' +
      '2) Не предлагай то, что ассистент уже сделал в этом ответе. ' +
      '3) Называй конкретное: файл, тест, функцию, команду; без общих слов вроде «продолжи» или «улучши код». ' +
      'Всё пиши на том же языке, на котором пишет человек. Разумного продолжения нет — steps: [].\n' +
      'Пример: {"goal": "Страница входа с проверкой пароля", "waiting": "подтвердить удаление token-speed", "steps": ["Да, удали папку token-speed", "Запусти тесты логина ещё раз"]}',
    prompt: [
      `Прежняя цель: ${previous || 'нет'}`,
      `<transcript>\n${recent.map(message => `[${message.role === 'user' ? 'человек' : 'ассистент'}] ${message.text.slice(0, 800)}`).join('\n')}\n</transcript>`,
      `<latest_reply>\n${answer.slice(0, 2000)}\n</latest_reply>`,
      'Ответь JSON по образцу, без пояснений.',
    ].join('\n\n'),
  })
  if (!reply.isAnswered) {
    return
  }
  const found = parseReply(reply.text)
  // Проверка внутри записи: новый запрос или ход, пришедший за это время, всегда важнее.
  await update($, steps, before =>
    current() !== turnId ? before : found.items.length > 0 || found.waiting ? { turnId, ...found } : null,
  )
  if (found.goal) {
    await update($, goal, () => found.goal ?? '')
  }
}

/** Одна строка без кавычек и точки в конце; длиннее `max` — режем по слову. */
export const clip = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').replace(/^["'«]+|["'»]+$/g, '').replace(/\.$/, '').trim()
  if ([...line].length <= max) {
    return line
  }
  const cut = line.slice(0, max - 1)
  // Режем по последнему целому слову (если оно не слишком далеко) и без висящей запятой перед «…».
  const space = line[max - 1] === ' ' ? cut.length : cut.lastIndexOf(' ')
  const word = space > max / 2 ? cut.slice(0, space) : cut

  return `${word.replace(/[\s,;:—-]+$/, '')}…`
}

/** JSON модели → цель, «ждёт вас» и подсказки; не JSON — читаем подсказки построчно. */
export function parseReply(text: string): { items: string[]; goal?: string; waiting?: string } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const data = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
      const field = (key: string, max: number) => (typeof data[key] === 'string' ? clip(data[key] as string, max) : '')
      const list = Array.isArray(data.steps) ? data.steps.filter((one): one is string => typeof one === 'string') : []
      const goalText = field('goal', MAX_GOAL)
      const waitingText = field('waiting', MAX_WAITING)

      return { items: parseSteps(list.join('\n')), ...(goalText ? { goal: goalText } : {}), ...(waitingText ? { waiting: waitingText } : {}) }
    } catch {
      // Не JSON — ниже читаем строками.
    }
  }

  return { items: parseSteps(text) }
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
