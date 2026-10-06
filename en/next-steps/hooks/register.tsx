// "Next": after Claude replies, 2–3 likely next prompts above the input.
// A click on a prompt or its digit 1–3 in an empty input drafts it (it's never sent by itself), 0 hides them.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NextSteps } from '../types'

const MODEL = 'haiku'
const MAX_ITEMS = 3
/** The length we ask the model for; a line longer than MAX_KEPT is dropped, not cut: a truncated draft is half a request. */
const MAX_CHARS = 60
const MAX_KEPT = 120
/** A shorter reply isn't worth a model call. */
const MIN_ANSWER = 40
/** Key in the mod's store: whether suggestions are off (survives restarts). */
const OFF_KEY = 'isOff'

const BLUE = '#58a6ff'

const steps = atom({ plugin: 'next-steps', key: 'steps' } as const, null as NextSteps | null)
const isOff = atom({ plugin: 'next-steps', key: 'isOff' } as const, false)

export const register: Register = on => {
  // The turn the suggestions still belong to: a new prompt or turn moves it.
  let latest = ''
  let submits = 0
  // A survey above the input answers digits itself — don't get in its way.
  let hasSurvey = false

  on('session.start', async ($, e, next) => {
    // The name is taken by another plugin — no command then, but the rest of session start must go through.
    await $.command
      .register({ name: 'next', description: '"Next" suggestions: `/next off` turns them off (no Haiku calls), `/next on` turns them on' })
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

      return { text: off ? '"Next" suggestions are off; Haiku is no longer called. Turn on: /next on' : '"Next" suggestions are on.' }
    }

    return {
      text: (await read($, isOff))
        ? '"Next" suggestions are off. Turn on: /next on'
        : '"Next" suggestions are on: after a reply, 2–3 next prompts; a click or 1–3 drafts one, 0 hides them. Turn off: /next off',
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
    // A subagent's turn isn't a reply to the person.
    if (e.agentId) {
      return result
    }
    latest = e.turnId
    if (e.reason !== 'answer' || e.answer.trim().length < MIN_ANSWER || (await read($, isOff))) {
      return result
    }
    // In the background: the turn ends right away, suggestions show up a second or two later.
    void suggest($, e.turnId, e.answer, () => latest).catch(() => undefined)

    return result
  })

  // A digit in an empty input picks a suggestion instead of being typed. A paste has no key — a pasted "1" stays "1".
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
    // Whatever other mods and Claude Code itself render stays; suggestions go below it all, closest to the input.
    const rest = await next(e)
    hasSurvey = e.props.hasSurvey
    const current = await read($, steps)
    if (e.props.hasSurvey || e.props.isWorking || !current || current.items.length === 0) {
      return rest
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const items = current.items.map((text, i) => `${i + 1} · ${text}`)
    // A native desktop button is about 4 cells wider than its label.
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
    const dismiss = <Button key="dismiss" plain dimColor label="0 · hide" onPress={() => update($, steps, () => null)} />
    const title = (
      <Text key="title" color={BLUE} bold>
        NEXT
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
 * Layout: everything on one line if it fits; otherwise one prompt per line if the band has the rows;
 * otherwise one line with every prompt trimmed evenly. `room` is how many cells a prompt's label gets.
 */
export const arrange = (labels: readonly string[], columns: number, pad: number, maxRows: number) => {
  const fixed = width('NEXT') + width('0 · hide') + pad + 2 * (labels.length + 1)
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
  // While background agents are running, Claude will carry on by itself — too early to suggest.
  const agents = await $.agent.list().catch(() => [])
  if (agents.some(agent => agent.status === 'running')) {
    return
  }

  const all = (await $.session.messages().catch(() => [])).filter(message => message.text.trim() !== '')
  // The latest reply goes separately below.
  if (all.at(-1)?.role === 'assistant') {
    all.pop()
  }
  const recent = all.slice(-6)
  const reply = await $.model.complete({
    model: MODEL,
    maxTokens: 200,
    timeoutMs: 20_000,
    system:
      'You guess what a person will write to their coding assistant next, from an excerpt of their session. ' +
      `Give 2 or 3 short, concrete prompts — each an instruction in the imperative, no longer than ${MAX_CHARS} characters, ` +
      'about what just happened (name the file, test or function). Write them in the same language the person writes in. ' +
      'No numbering, quotes or explanations: one per line and nothing else. If there is no sensible next step, reply with the single word NONE.\n' +
      'Example reply:\nRerun the login tests\nAdd the same check to signup.ts\nOpen a draft PR',
    prompt: [
      `<transcript>\n${recent.map(message => `[${message.role === 'user' ? 'person' : 'assistant'}] ${message.text.slice(0, 800)}`).join('\n')}\n</transcript>`,
      `<latest_reply>\n${answer.slice(0, 2000)}\n</latest_reply>`,
      'Write the prompts the person is most likely to send next: only the lines, not a reply to the conversation.',
    ].join('\n\n'),
  })
  if (!reply.isAnswered) {
    return
  }
  const items = parseSteps(reply.text)
  // The check is inside the write: a new prompt or turn that arrived meanwhile always wins.
  await update($, steps, before => (current() !== turnId ? before : items.length > 0 ? { turnId, items } : null))
}

/** The model's lines, stripped of bullets, numbers and quotes; three at most. Preambles and "nothing to add" are dropped. */
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
    // English and Russian preambles: the model replies in the person's language.
    if (/^(none|no$|nothing|here are|here's|sure|of course|нет$|ничего|вот |конечно)/i.test(clean)) {
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
