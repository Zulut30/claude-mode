import { atom, read, update } from 'claude-code'
import type { CommandInfo, EngineInterface, Register } from 'claude-code'

import type { CommandDeckSection } from '../types'

const PANE = 'command-deck'
const TITLE = 'Commands'
/** Our own command: the pane does not list it. */
const SELF = 'deck'

const GREEN = '#3fb950'
const AMBER = '#d29922'
const GRAY = '#8b949e'

/** Desktop text line height: icons use it to line up with the text. */
const LINE_PX = 20

/** How many rows a section shows until it is expanded. */
const SECTION_LIMIT = 6

/** Indent of the rows under the header text: the icon and the gap. */
const INDENT = 2

/** Section card background on desktop. */
const CARD = '#8b949e14'

const expanded = atom({ plugin: 'command-deck', key: 'expanded' } as const, [] as CommandDeckSection[])

// ── Catalog ──────────────────────────────────────────────────────────────

/** Ask via `$.ui.ask` before running: the question and the "yes" label. */
export type Confirm = { question: string; yes: string }

export type DeckEntry = { name: string; why: string; confirm?: Confirm }

type GroupId = Exclude<CommandDeckSection, 'rest'>

/** What a section header looks like: title, color, terminal icon (`glyph`) and desktop icon (`icon`). */
type Look = { title: string; color: string; glyph: string; icon: string }

type Group = Look & { id: GroupId; entries: DeckEntry[] }

const CONFIRM: Record<string, Confirm> = {
  clear: { question: 'Clear the conversation and start fresh?', yes: 'Yes, clear' },
  exit: { question: 'Quit the Claude Code session?', yes: 'Yes, quit' },
  quit: { question: 'Quit the Claude Code session?', yes: 'Yes, quit' },
}

/**
 * Commands that have nothing to do without arguments and open no picker:
 * a button can't run them. /model, /resume, /export, /memory without arguments
 * open their own picker — they stay.
 */
const NEEDS_ARGS = new Set(['add-dir', 'btw', 'loop'])

/** Icons on a 16×16 grid (C is the color). */
const GROUPS: Group[] = [
  {
    id: 'context',
    title: 'CONTEXT & MEMORY',
    color: '#58a6ff',
    glyph: '◐',
    icon: '<circle cx="8" cy="8" r="6" fill="none" stroke="C" stroke-width="1.6"/><path d="M8 2 A6 6 0 0 1 8 14 Z" fill="C"/>',
    entries: [
      { name: 'compact', why: 'Condense the conversation to free up context' },
      { name: 'clear', why: 'Start over: the conversation is cleared', confirm: CONFIRM.clear },
      { name: 'context', why: 'What fills the context window' },
      { name: 'memory', why: 'Open the memory files (CLAUDE.md)' },
    ],
  },
  {
    id: 'project',
    title: 'PROJECT & CODE',
    color: GREEN,
    glyph: '◇',
    icon: '<path d="M5.5 4 L2 8 L5.5 12 M10.5 4 L14 8 L10.5 12" fill="none" stroke="C" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    entries: [
      { name: 'init', why: 'Create a CLAUDE.md that describes the project' },
      { name: 'review', why: 'Review a pull request or changes' },
      { name: 'code-review', why: 'Review the current changes for bugs' },
      { name: 'security-review', why: 'Check the changes for vulnerabilities' },
    ],
  },
  {
    id: 'session',
    title: 'SESSION',
    color: AMBER,
    glyph: '◷',
    icon: '<circle cx="8" cy="8" r="6" fill="none" stroke="C" stroke-width="1.6"/><path d="M8 4.5 V8 L10.5 9.5" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    entries: [
      { name: 'cost', why: 'How much this session has spent' },
      { name: 'usage', why: 'Plan limits: used and left' },
      { name: 'resume', why: 'Go back to a past session' },
      { name: 'export', why: 'Save the conversation to a file' },
      { name: 'model', why: 'Pick the model that answers' },
    ],
  },
  {
    id: 'panels',
    title: 'OUR PANES',
    color: '#bc8cff',
    glyph: '▣',
    icon: '<rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="C" stroke-width="1.6"/><path d="M9.5 3 V13" stroke="C" stroke-width="1.6"/>',
    entries: [
      { name: 'roadmap', why: 'Roadmap: the stages of the task' },
      { name: 'branches', why: 'Git branches, changes and PRs' },
      { name: 'inspector', why: 'What makes up the context' },
    ],
  },
]

const REST = {
  title: 'EVERYTHING ELSE',
  color: GRAY,
  glyph: '/',
  icon: '<path d="M10.5 2.5 L5.5 13.5" stroke="C" stroke-width="1.8" stroke-linecap="round"/>',
}

/** A pane row: the command, how to run it, and the explanation. */
export type DeckRow = { name: string; text: string; confirm?: Confirm }

export type Deck = { groups: { id: GroupId; rows: DeckRow[] }[]; rest: DeckRow[] }

/** A command from the list by name: an exact match, otherwise a plugin one `<plugin>:<name>`. */
export const findCommand = (list: readonly CommandInfo[], name: string) =>
  list.find(command => command.name === name) ?? list.find(command => command.name.endsWith(`:${name}`))

const isSelf = (command: CommandInfo) => command.name === SELF || command.plugin === 'command-deck'

/** Engine list → pane sections: only what exists; the rest goes alphabetically into "Everything else". */
export const buildDeck = (list: readonly CommandInfo[]): Deck => {
  const unique = new Map<string, CommandInfo>()
  for (const command of list) {
    if (!isSelf(command) && !NEEDS_ARGS.has(command.name) && !unique.has(command.name)) {
      unique.set(command.name, command)
    }
  }
  const available = [...unique.values()]
  const taken = new Set<string>()

  const groups = GROUPS.map(group => ({
    id: group.id,
    rows: group.entries.flatMap(entry => {
      const found = findCommand(available, entry.name)
      if (!found || taken.has(found.name)) {
        return []
      }
      taken.add(found.name)

      return [{ name: found.name, text: entry.why, confirm: entry.confirm }]
    }),
  }))

  const rest = available
    .filter(command => !taken.has(command.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(command => ({ name: command.name, text: command.description, confirm: CONFIRM[command.name] }))

  return { groups, rest }
}

// ── Running ──────────────────────────────────────────────────────────────

export const short = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, Math.max(1, max - 1))}…` : line
}

/**
 * Runs go through `$.command.run`: the same path as typing `/name` in the input
 * (the `command.run` event, waits for the session to be idle, lines in the transcript), and
 * it sorts out local commands, panes and prompt commands by itself (/init, /review start
 * a model turn). `$.prompt.submit` won't do: that is a model prompt on the plugin's behalf,
 * not a typed slash command.
 */
export const runCommand = async ($: EngineInterface, row: DeckRow) => {
  if (row.confirm) {
    const answer = await $.ui
      .ask(row.confirm.question, { header: 'Confirm', options: [row.confirm.yes, 'Cancel'] })
      .catch(() => undefined)
    if (answer !== row.confirm.yes) {
      return
    }
  }

  // What the command did shows in the chat; a toast only if it replied with something or failed to start.
  try {
    const reply = await $.command.run({ command: row.name })
    if (reply.text) {
      $.ui.toast(`/${row.name}: ${short(reply.text, 120)}`)
    }
  } catch (error) {
    $.ui.toast(`Couldn't run /${row.name}: ${short(error instanceof Error ? error.message : String(error), 120)}`)
  }
}

// ── Rendering ────────────────────────────────────────────────────────────

const iconSvg = (body: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="${LINE_PX}" viewBox="0 ${(16 - (LINE_PX * 16) / 12) / 2} 16 ${(LINE_PX * 16) / 12}">` +
  body.replace(/"C"/g, `"${color}"`) +
  `</svg>`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The name is taken by another plugin — no command then, but the rest of the session start must go through.
    await $.command.register({
      name: SELF,
      description: 'Open the Commands pane: the main commands with a short why and one-click run',
    }).catch(() => undefined)
    // Opens by itself, as a tab next to the other panes.
    void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: SELF }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return {
      text: opened.isPlaced ? 'The Commands pane is open.' : 'The Commands pane will appear once there is room: widen the window.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined

    const list = await $.command.list().catch(() => [] as CommandInfo[])
    const deck = buildDeck(list)
    const open = await read($, expanded)

    const columns = e.props.bodyColumns
    // Rows sit under the header text (INDENT), with ▶ on the right; on desktop also the card margins and the native button.
    const textRoom = Math.max(8, columns - INDENT - 1 - (Svg ? 2 + 5 : 1))

    const mark = (look: Look) =>
      Svg ? <Svg source={iconSvg(look.icon, look.color)} alt="icon" width={12} height={LINE_PX} /> : <Text color={look.color}>{look.glyph}</Text>

    const toggle = (id: CommandDeckSection) =>
      update($, expanded, ids => (ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id]))

    const row = (item: DeckRow) => (
      <Box key={`row-${item.name}`} flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1} paddingLeft={INDENT}>
        <Box key={`row-${item.name}-lines`} flexDirection="column">
          <Text bold>{short(`/${item.name}`, textRoom)}</Text>
          {item.text ? <Text dimColor>{short(item.text, textRoom)}</Text> : null}
        </Box>
        <Button key={`run-${item.name}`} plain label="▶" onPress={() => runCommand($, item)} />
      </Box>
    )

    /** A section card: icon and title in the group's color, the count on the right, rows under the title; `isCollapsed` keeps it folded until opened. */
    const section = (id: CommandDeckSection, look: Look, items: DeckRow[], isFirst: boolean, isCollapsed = false) => {
      const isOpen = open.includes(id)
      const limit = isCollapsed ? 0 : SECTION_LIMIT
      const hidden = items.length - limit

      return (
        <Box
          key={`section-${id}`}
          flexDirection="column"
          marginTop={isFirst ? 0 : 1}
          {...(Svg ? { backgroundColor: CARD, paddingX: 1, paddingY: 1 } : {})}
        >
          <Box key={`section-${id}-head`} flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
            <Box key={`section-${id}-title`} flexDirection="row" alignItems="center" columnGap={1}>
              {mark(look)}
              <Text bold color={look.color}>
                {short(look.title, Math.max(8, columns - 8))}
              </Text>
            </Box>
            <Text dimColor>{String(items.length)}</Text>
          </Box>
          {(isOpen ? items : items.slice(0, limit)).map(row)}
          {hidden > 0 ? (
            <Box key={`more-${id}-row`} flexDirection="row" paddingLeft={INDENT}>
              <Button
                key={`more-${id}`}
                plain
                dimColor
                label={isOpen ? 'Collapse' : isCollapsed ? `Show ${items.length}` : `${hidden} more`}
                onPress={() => toggle(id)}
              />
            </Box>
          ) : null}
        </Box>
      )
    }

    const sections = [
      ...GROUPS.map(group => ({ id: group.id as CommandDeckSection, look: group as Look, items: deck.groups.find(one => one.id === group.id)?.rows ?? [], isCollapsed: false })),
      { id: 'rest' as CommandDeckSection, look: REST, items: deck.rest, isCollapsed: true },
    ].filter(one => one.items.length > 0)

    return (
      <Box flexDirection="column">
        {sections.length === 0 ? (
          <Text key="empty" dimColor>
            The command list is empty so far.
          </Text>
        ) : (
          sections.map((one, index) => section(one.id, one.look, one.items, index === 0, one.isCollapsed))
        )}
      </Box>
    )
  })
}
