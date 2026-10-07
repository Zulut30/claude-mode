// "Next": after Claude replies, 2–3 likely next prompts above the input.
// A click on a prompt or its digit 1–3 in an empty input drafts it (it's never sent by itself), 0 hides them.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NextStep, NextSteps } from '../types'

const MODEL = 'haiku'
const MAX_ITEMS = 3
/** The prompt length we ask the model for; a line longer than MAX_KEPT is dropped, not cut: a truncated draft is half a request. */
const MAX_PROMPT = 90
const MAX_KEPT = 120
/** The button caption: 2–4 words. The full prompt goes in as the draft. */
const MAX_LABEL = 28
/** The goal and "waiting on you" stay short, on one line. */
const MAX_GOAL = 45
const MAX_WAITING = 60
/** Characters per column on desktop: the font is proportional, almost two characters fit in a column. */
const DESKTOP_CHARS = 1.8

const BLUE = '#58a6ff'
const AMBER = '#d29922'
/** A shorter reply isn't worth a model call. */
const MIN_ANSWER = 40
/** Key in the mod's store: whether suggestions are off (survives restarts). */
const OFF_KEY = 'isOff'

const steps = atom({ plugin: 'next-steps', key: 'steps' } as const, null as NextSteps | null)
const isOff = atom({ plugin: 'next-steps', key: 'isOff' } as const, false)
const goal = atom({ plugin: 'next-steps', key: 'goal' } as const, '')

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

    return pick ? next({ ...e, inputText: pick.prompt }) : next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Whatever other mods and Claude Code itself render stays; suggestions go below it all, closest to the input.
    const rest = await next(e)
    hasSurvey = e.props.hasSurvey
    const current = await read($, steps)
    if (e.props.hasSurvey || e.props.isWorking || !current || (current.items.length === 0 && !current.waiting)) {
      return rest
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const room = chipRoom(current.items.length, e.props.bodyColumns, e.surface !== 'terminal')
    const dismiss = <Button key="dismiss" plain dimColor label="✕" onPress={() => update($, steps, () => null)} />
    const hasItems = current.items.length > 0

    // Two even rows, ✕ always on the right:
    //   ◆ goal            waiting on you  what the person needs to do
    //   NEXT  [1 · …]  [2 · …]  [3 · …]                              ✕
    // The renderer itself truncates the goal and "waiting on you" to the real width; button captions are short and never wrap.
    const recap =
      current.goal || current.waiting ? (
        <Box key="next-steps-recap" flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={2}>
          <Box key="next-steps-recap-text" flexDirection="row" alignItems="center" columnGap={3} flexShrink={1} overflow="hidden">
            {current.goal ? (
              <Box key="goal" flexDirection="row" columnGap={1} flexShrink={1}>
                <Text color={BLUE}>◆</Text>
                <Text bold wrap="truncate-end">
                  {current.goal}
                </Text>
              </Box>
            ) : null}
            {current.waiting ? (
              <Box key="waiting" flexDirection="row" columnGap={1} flexShrink={1}>
                <Text color={AMBER} bold>
                  waiting on you
                </Text>
                <Text wrap="truncate-end">{current.waiting}</Text>
              </Box>
            ) : null}
          </Box>
          {hasItems ? null : dismiss}
        </Box>
      ) : null

    return (
      <Box flexDirection="column">
        {rest}
        {recap}
        {hasItems ? (
          <Box key="next-steps" flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={2}>
            <Box key="next-steps-chips" flexDirection="row" alignItems="center" columnGap={1} flexShrink={1} overflow="hidden">
              <Text key="title" dimColor bold>
                NEXT
              </Text>
              {current.items.map((step, i) => (
                <Button
                  key={`step-${i + 1}`}
                  label={`${i + 1} · ${clip(step.label, room)}`}
                  onPress={() => void $.prompt.fill({ text: step.prompt }).catch(() => undefined)}
                />
              ))}
            </Box>
            {dismiss}
          </Box>
        ) : null}
      </Box>
    )
  })
}

/**
 * How many caption characters fit on a button so all buttons sit on one line with the title and ✕.
 * The button frame and "1 · " take about 7 characters.
 */
export const chipRoom = (count: number, columns: number, isDesktop: boolean) => {
  const width = Math.floor(columns * (isDesktop ? DESKTOP_CHARS : 1))
  const shared = Math.floor((width - 'NEXT'.length - 4 - 2 * (count + 1)) / Math.max(1, count)) - 7

  return Math.max(10, Math.min(MAX_LABEL, shared))
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
  const previous = await read($, goal)
  // One call for everything: the goal, "waiting on you" and the suggestions — no extra model calls.
  const reply = await $.model.complete({
    model: MODEL,
    maxTokens: 300,
    timeoutMs: 20_000,
    system:
      'You help a person keep track of their session with a coding assistant. From an excerpt of the session, reply with JSON only, shaped ' +
      '{"goal": "...", "waiting": "...", "steps": [{"label": "...", "prompt": "..."}]}. ' +
      `goal: the overall aim of the session in 3–6 words, no longer than ${MAX_GOAL} characters; if the previous goal clearly did not change, repeat it. ` +
      `waiting: what the assistant is waiting on from the person right now (an answer, a confirmation, a manual check), briefly, no longer than ${MAX_WAITING} characters; an empty string if nothing. ` +
      'steps: 2 or 3 prompts the person is most likely to send next. ' +
      `label: the button caption, 2–4 words starting with a verb, no longer than ${MAX_LABEL} characters. ` +
      `prompt: the request itself in the person's own voice, as they would write it, no longer than ${MAX_PROMPT} characters. ` +
      'Rules for steps. 1) If the assistant\'s reply ends with a question or an offer ("Shall I?", "Tell me if…"), the first one agrees with specifics. ' +
      '2) Never suggest what the assistant already did in this reply. ' +
      '3) Name concrete things: a file, test, function or command; no vague "continue" or "improve the code". ' +
      'Write everything in the same language the person writes in. No sensible next step — steps: [].\n' +
      'Example: {"goal": "Mods for Claude Code", "waiting": "pick what to do next", "steps": [' +
      '{"label": "Check the look", "prompt": "Looks good, sync the new band to the repo"}, ' +
      '{"label": "One-step install", "prompt": "Add one-command install via a plugin marketplace"}]}',
    prompt: [
      `Previous goal: ${previous || 'none'}`,
      `<transcript>\n${recent.map(message => `[${message.role === 'user' ? 'person' : 'assistant'}] ${message.text.slice(0, 800)}`).join('\n')}\n</transcript>`,
      `<latest_reply>\n${answer.slice(0, 2000)}\n</latest_reply>`,
      'Reply with the JSON as shown, no explanations.',
    ].join('\n\n'),
  })
  if (!reply.isAnswered) {
    return
  }
  const found = parseReply(reply.text)
  // The check is inside the write: a new prompt or turn that arrived meanwhile always wins.
  await update($, steps, before =>
    current() !== turnId ? before : found.items.length > 0 || found.waiting ? { turnId, ...found } : null,
  )
  if (found.goal) {
    await update($, goal, () => found.goal ?? '')
  }
}

/** One line without quotes or a trailing period; longer than `max` — cut at a word. */
export const clip = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').replace(/^["'«“]+|["'»”]+$/g, '').replace(/\.$/, '').trim()
  if ([...line].length <= max) {
    return line
  }
  const cut = line.slice(0, max - 1)
  // Cut at the last whole word (unless it's too far back), with no dangling comma before the "…".
  const space = line[max - 1] === ' ' ? cut.length : cut.lastIndexOf(' ')
  const word = space > max / 2 ? cut.slice(0, space) : cut

  return `${word.replace(/[\s,;:—-]+$/, '')}…`
}

/** The model's JSON → goal, "waiting on you" and suggestions; not JSON — read the suggestions line by line. */
export function parseReply(text: string): { items: NextStep[]; goal?: string; waiting?: string } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const data = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
      const field = (key: string, max: number) => (typeof data[key] === 'string' ? clip(data[key] as string, max) : '')
      const goalText = field('goal', MAX_GOAL)
      const waitingText = field('waiting', MAX_WAITING)

      return {
        items: toSteps(Array.isArray(data.steps) ? data.steps : []),
        ...(goalText ? { goal: goalText } : {}),
        ...(waitingText ? { waiting: waitingText } : {}),
      }
    } catch {
      // Not JSON — read it line by line below.
    }
  }

  return { items: toSteps(text.replace(/```[a-z]*\n?/gi, '').split('\n')) }
}

/** Suggestions from the model's reply: a string or `{ label, prompt }`; no label — the label comes from the start of the prompt. Three at most, no repeats. */
const toSteps = (raw: readonly unknown[]): NextStep[] => {
  const out: NextStep[] = []
  for (const one of raw) {
    const record = typeof one === 'string' ? { prompt: one } : typeof one === 'object' && one !== null ? (one as Record<string, unknown>) : {}
    const text = (key: string) => (typeof record[key] === 'string' ? cleanLine(record[key] as string) : '')
    const prompt = text('prompt') || text('label')
    if (!prompt || out.some(step => step.prompt.toLowerCase() === prompt.toLowerCase())) {
      continue
    }
    out.push({ label: clip(text('label') || prompt, MAX_LABEL), prompt })
    if (out.length === MAX_ITEMS) {
      break
    }
  }

  return out
}

/** A line of the model's reply without bullets, numbers, quotes or a trailing period; a preamble, "nothing to add" or too long — empty. */
const cleanLine = (line: string) => {
  const clean = line
    .replace(/\*\*/g, '')
    .replace(/^\s*(?:[-*•]|\d+[.):])\s*/, '')
    .replace(/^["'`«]+|["'`»,]+$/g, '')
    .replace(/\.$/, '')
    .trim()

  // English and Russian preambles: the model replies in the person's language.
  return clean.endsWith(':') || clean.length > MAX_KEPT || /^(none|no$|nothing|here are|here's|sure|of course|нет$|ничего|вот |конечно)/i.test(clean)
    ? ''
    : clean
}

/** Prompts from the model's lines — the same as suggestions, without labels. */
export const parseSteps = (text: string) => toSteps(text.split('\n')).map(step => step.prompt)
