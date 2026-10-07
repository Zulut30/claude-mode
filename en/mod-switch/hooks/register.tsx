import type { CommandInfo, EngineInterface, Register } from 'claude-code'

import type { ModSwitchBandColumn, ModSwitchPlacement } from '../types'

const PANE = 'mod-switch'
const TITLE = 'Mods'
/** Its own command: opens the pane. */
const SELF = 'mods'

const GREEN = '#3fb950'
const AMBER = '#d29922'
const BLUE = '#58a6ff'
const PURPLE = '#bc8cff'
const GRAY = '#8b949e'

/** Line height of text on desktop: icons line up with the text by it. */
const LINE_PX = 20

/** Indent of the rows under the card's header text: the icon and the gap. */
const INDENT = 2

/** Card background on desktop. */
const CARD = '#8b949e14'

// ── Other mods' values: read only ────────────────────────────────────────
// Each mod owns its settings: the pane reads them and changes them only through the mod's command.
// The keys are literals so `claude plugin validate` sees them.

const NEXT_OFF = { plugin: 'next-steps', key: 'isOff' } as const
const GUARD_OFF = { plugin: 'command-guard', key: 'isOff' } as const
const BAND_HIDDEN = { plugin: 'usage-band', key: 'hidden' } as const
const ROADMAP_PLACEMENT = { plugin: 'roadmap', key: 'placement' } as const

/** What the mods have right now: a snapshot of their own values. */
export type Snapshot = {
  nextOff: boolean
  guardOff: boolean
  hidden: readonly ModSwitchBandColumn[]
  placement: ModSwitchPlacement
}

const readSnapshot = async ($: EngineInterface): Promise<Snapshot> => {
  const [next, guard, band, roadmap] = await Promise.all([
    $.state.get(NEXT_OFF),
    $.state.get(GUARD_OFF),
    $.state.get(BAND_HIDDEN),
    $.state.get(ROADMAP_PLACEMENT),
  ])

  return {
    nextOff: next.value === true,
    guardOff: guard.value === true,
    hidden: Array.isArray(band.value) ? band.value : [],
    placement: roadmap.value === 'band' ? 'band' : 'pane',
  }
}

// ── Catalog ──────────────────────────────────────────────────────────────

/** A mod with switches: its command in the engine's list tells that it's installed. */
type Mod = { plugin: string; command: string }

const MODS = {
  next: { plugin: 'next-steps', command: 'next' },
  guard: { plugin: 'command-guard', command: 'guard' },
  band: { plugin: 'usage-band', command: 'band' },
  roadmap: { plugin: 'roadmap', command: 'roadmap' },
} satisfies Record<string, Mod>

export type ModId = keyof typeof MODS

const MOD_IDS = Object.keys(MODS) as ModId[]

/** How a state is shown: the mark, its color and the button's label. */
type StateLook = { mark: string; color: string; text: string; isDim?: boolean }

const ON: StateLook = { mark: '●', color: GREEN, text: 'On' }
const OFF: StateLook = { mark: '○', color: GRAY, text: 'Off', isDim: true }

/** One switch: the button, its label, a why-line and how to read it and flip it with the mod's command. */
export type Switch = {
  key: string
  mod: ModId
  label: string
  why?: string
  /** Whether it's on now — by the mod's values. */
  isOn: (now: Snapshot) => boolean
  /** The mod command's arguments that put it into this state. */
  args: (isOn: boolean) => string
  /** The labels of the two states, when they aren't On/Off. */
  looks?: { on: StateLook; off: StateLook }
}

/** How a card's header looks: title, color, terminal mark (`glyph`) and desktop icon (`icon`). */
type Card = { id: string; title: string; color: string; glyph: string; icon: string; switches: Switch[] }

const onOff = (isOn: boolean) => (isOn ? 'on' : 'off')

const COLUMNS: [ModSwitchBandColumn, string][] = [
  ['context', 'Context'],
  ['memory', 'Memory'],
  ['limits', 'Limits'],
  ['speed', 'Speed'],
  ['cache', 'Cache'],
]

/** Icons on a 16×16 grid (C is the color). */
const CARDS: Card[] = [
  {
    id: 'hints',
    title: 'SUGGESTIONS & SAFETY',
    color: AMBER,
    glyph: '◈',
    icon: '<path d="M8 1.8 L13.5 4 V8 C13.5 11 11.2 13.2 8 14.4 C4.8 13.2 2.5 11 2.5 8 V4 Z" fill="none" stroke="C" stroke-width="1.6" stroke-linejoin="round"/><path d="M5.6 8.1 L7.3 9.8 L10.5 6.4" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    switches: [
      {
        key: 'toggle-next',
        mod: 'next',
        label: 'Next',
        why: 'after a reply — the goal and 2–3 next prompts; one Haiku call',
        isOn: now => !now.nextOff,
        args: onOff,
      },
      {
        key: 'toggle-guard',
        mod: 'guard',
        label: 'Safety net',
        why: 'asks before rm -r, push --force, reset --hard',
        isOn: now => !now.guardOff,
        args: onOff,
      },
    ],
  },
  {
    id: 'band',
    title: 'BAND ABOVE THE PROMPT',
    color: BLUE,
    glyph: '▤',
    icon: '<rect x="2" y="2.5" width="12" height="6" rx="1.5" fill="none" stroke="C" stroke-width="1.6"/><path d="M2.8 12.5 H13.2" stroke="C" stroke-width="1.6" stroke-linecap="round"/>',
    switches: COLUMNS.map(([id, label]) => ({
      key: `toggle-col-${id}`,
      mod: 'band' as const,
      label,
      isOn: (now: Snapshot) => !now.hidden.includes(id),
      args: (isOn: boolean) => `${isOn ? 'show' : 'hide'} ${id}`,
    })),
  },
  {
    id: 'roadmap',
    title: 'ROADMAP',
    color: PURPLE,
    glyph: '◇',
    icon: '<circle cx="4" cy="12" r="1.8" fill="C"/><circle cx="12" cy="4" r="1.8" fill="C"/><path d="M4 9.8 V8.5 C4 7.4 4.9 6.5 6 6.5 H10 C11.1 6.5 12 5.6 12 4.5" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="1.6 1.8"/>',
    switches: [
      {
        key: 'toggle-roadmap',
        mod: 'roadmap',
        label: 'Where to show',
        why: 'in a pane — a side tab; under the chat — a band above the prompt',
        isOn: now => now.placement === 'pane',
        args: isOn => (isOn ? 'pane' : 'band'),
        looks: { on: { mark: '▣', color: BLUE, text: 'In a pane' }, off: { mark: '▬', color: PURPLE, text: 'Under the chat' } },
      },
    ],
  },
]

/** A mod's command in the engine's list: its name or `<plugin>:<name>`; none — the mod isn't installed. */
export const findModCommand = (list: readonly CommandInfo[], mod: Mod) =>
  list.find(command => command.plugin === mod.plugin && (command.name === mod.command || command.name.endsWith(`:${mod.command}`))) ??
  list.find(command => command.plugin === undefined && command.source === 'plugin' && command.name === mod.command)

/** Which mods are installed: each one's command name, `undefined` for the missing ones. */
export const installedMods = (list: readonly CommandInfo[]) =>
  Object.fromEntries(MOD_IDS.map(id => [id, findModCommand(list, MODS[id])?.name])) as Record<ModId, string | undefined>

// ── Switching ────────────────────────────────────────────────────────────

export const short = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, Math.max(1, max - 1))}…` : line
}

/**
 * Flips it with the mod's own command (`$.command.run`, as if typed): the mod
 * changes and remembers its value itself. The command's reply shows in the chat;
 * a toast only when the command didn't run or the value didn't change.
 */
export const toggle = async ($: EngineInterface, command: string, item: Switch) => {
  const isOn = !item.isOn(await readSnapshot($))
  const args = item.args(isOn)
  try {
    const reply = await $.command.run({ command, args })
    if (item.isOn(await readSnapshot($)) !== isOn) {
      $.ui.toast(`/${command} ${args}: ${short(reply.text || 'nothing changed', 120)}`)
    }
  } catch (error) {
    $.ui.toast(`Couldn't run /${command} ${args}: ${short(error instanceof Error ? error.message : String(error), 120)}`)
  }
}

// ── Drawing ──────────────────────────────────────────────────────────────

const iconSvg = (body: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="${LINE_PX}" viewBox="0 ${(16 - (LINE_PX * 16) / 12) / 2} 16 ${(LINE_PX * 16) / 12}">` +
  body.replace(/"C"/g, `"${color}"`) +
  `</svg>`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The name is taken by another plugin — no command then, but the rest of the session start must go on.
    await $.command
      .register({ name: SELF, description: 'Open the Mods pane: turn suggestions, the safety net, band columns and the roadmap placement on and off' })
      .catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: SELF }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return {
      text: opened.isPlaced ? 'The Mods pane is open.' : 'The Mods pane will appear once there is room: widen the window.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined

    const list = await $.command.list().catch(() => [] as CommandInfo[])
    const commands = installedMods(list)
    // Reading while drawing subscribes the pane: when a mod changes its value, the pane redraws by itself.
    const now = await readSnapshot($)

    const columns = e.props.bodyColumns
    // The card's padding on desktop (a cell on each side) and the rows' indent under the header.
    const room = Math.max(8, columns - INDENT - (Svg ? 2 : 0))

    const mark = (card: Card) =>
      Svg ? <Svg source={iconSvg(card.icon, card.color)} alt="icon" width={12} height={LINE_PX} /> : <Text color={card.color}>{card.glyph}</Text>

    const row = (item: Switch, command: string) => {
      const look = item.isOn(now) ? (item.looks?.on ?? ON) : (item.looks?.off ?? OFF)
      // On the right: the mark, a gap and the button; the desktop's native button is wider than its label.
      const right = 2 + look.text.length + (Svg ? 4 : 0)

      return (
        <Box key={`row-${item.key}`} flexDirection="column" paddingLeft={INDENT}>
          <Box key={`row-${item.key}-line`} flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
            <Text>{short(item.label, Math.max(4, room - 1 - right))}</Text>
            <Box key={`row-${item.key}-state`} flexDirection="row" alignItems="center" columnGap={1}>
              <Text color={look.color}>{look.mark}</Text>
              <Button key={item.key} plain dimColor={look.isDim} label={look.text} onPress={() => toggle($, command, item)} />
            </Box>
          </Box>
          {item.why ? <Text dimColor>{short(item.why, room)}</Text> : null}
        </Box>
      )
    }

    /** A card: the icon and title in the card's color, the installed mods' switches below. */
    const card = (one: Card, isFirst: boolean) => (
      <Box
        key={`card-${one.id}`}
        flexDirection="column"
        marginTop={isFirst ? 0 : 1}
        {...(Svg ? { backgroundColor: CARD, paddingX: 1, paddingY: 1 } : {})}
      >
        <Box key={`card-${one.id}-title`} flexDirection="row" alignItems="center" columnGap={1}>
          {mark(one)}
          <Text bold color={one.color}>
            {short(one.title, Math.max(8, columns - 4))}
          </Text>
        </Box>
        {one.switches.flatMap(item => {
          const command = commands[item.mod]

          return command ? [row(item, command)] : []
        })}
      </Box>
    )

    const shown = CARDS.filter(one => one.switches.some(item => commands[item.mod]))
    const absent = MOD_IDS.filter(id => !commands[id])

    return (
      <Box flexDirection="column">
        {shown.map((one, index) => card(one, index === 0))}
        {absent.length > 0 ? (
          <Box key="absent" marginTop={shown.length > 0 ? 1 : 0}>
            <Text dimColor>{short(`Not installed: ${absent.map(id => MODS[id].plugin).join(', ')}`, Math.max(8, columns))}</Text>
          </Box>
        ) : null}
      </Box>
    )
  })
}
