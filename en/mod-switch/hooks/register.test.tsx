import { describe, expect, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import type { CommandInfo } from 'claude-code'

import type { ModSwitchBandColumn } from '../types'
import { findModCommand, installedMods } from './register'

const ALL: CommandInfo[] = [
  { name: 'compact', description: 'Clear conversation history but keep a summary in context', source: 'builtin' },
  { name: 'next', description: '"Next" suggestions', source: 'plugin', plugin: 'next-steps' },
  { name: 'guard', description: 'Command safety net', source: 'plugin', plugin: 'command-guard' },
  { name: 'band', description: 'Band columns', source: 'plugin', plugin: 'usage-band' },
  { name: 'roadmap', description: 'Roadmap', source: 'plugin', plugin: 'roadmap' },
  { name: 'mods', description: 'The Mods pane', source: 'plugin', plugin: 'mod-switch' },
]

/** Without the safety net and without usage-band. */
const SOME = ALL.filter(command => command.plugin !== 'command-guard' && command.plugin !== 'usage-band')

const PANE = {
  component: 'Pane',
  requestId: 'mod-switch',
  props: { title: 'Mods', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const RUN = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

/**
 * Owner mods, like the real ones: each keeps its own value and changes it only
 * with its own command. The pane only reads their values.
 */
const OWNERS: Plugin[] = [
  {
    name: 'next-steps',
    register(on) {
      on('command.run', { command: 'next' }, async ($, e) => {
        await $.state.set({ plugin: 'next-steps', key: 'isOff' } as const, e.args === 'off')

        return { text: e.args === 'off' ? '"Next" suggestions are off.' : '"Next" suggestions are on.' }
      })
    },
  },
  {
    name: 'command-guard',
    register(on) {
      on('command.run', { command: 'guard' }, async ($, e) => {
        await $.state.set({ plugin: 'command-guard', key: 'isOff' } as const, e.args === 'off')

        return { text: 'Safety net switched.' }
      })
    },
  },
  {
    name: 'usage-band',
    register(on) {
      on('command.run', { command: 'band' }, async ($, e) => {
        const ref = { plugin: 'usage-band', key: 'hidden' } as const
        const [verb, id] = e.args.split(' ') as [string, ModSwitchBandColumn]
        const { value = [] } = await $.state.get(ref)
        const rest = value.filter(one => one !== id)
        await $.state.set(ref, verb === 'hide' ? [...rest, id] : rest)

        return { text: 'Column switched.' }
      })
    },
  },
  {
    name: 'roadmap',
    register(on) {
      on('command.run', { command: 'roadmap' }, async ($, e) => {
        await $.state.set({ plugin: 'roadmap', key: 'placement' } as const, e.args === 'band' ? 'band' : 'pane')

        return { text: 'Roadmap moved.' }
      })
    },
  },
]

describe('catalog', () => {
  test('a mod is installed when its command is there: by plugin, with a prefix or without', () => {
    const mod = { plugin: 'next-steps', command: 'next' }
    expect(findModCommand(ALL, mod)?.name).toBe('next')
    expect(findModCommand([{ name: 'next-steps:next', description: '', source: 'plugin', plugin: 'next-steps' }], mod)?.name).toBe('next-steps:next')
    expect(findModCommand([{ name: 'next', description: '', source: 'plugin', plugin: 'other' }], mod)).toBeUndefined()
    expect(installedMods(SOME)).toEqual({ next: 'next', guard: undefined, band: undefined, roadmap: 'roadmap' })
  })
})

test("the pane doesn't open by itself at start; /mods opens it", async ($, on) => {
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  const registered: string[] = []
  on('command.register', ($, e) => {
    registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['mods'])
  expect(opened).toEqual([])

  const reply = await $.command.run({ command: 'mods', ...RUN })
  expect(reply.text).toBe('The Mods pane is open.')
  expect(opened).toEqual(['mod-switch'])
})

test("pane: the state is read from the mods' own values, on both surfaces", { plugins: OWNERS }, async ($, on) => {
  on('command.list', () => ({ value: ALL }))
  await $.command.run({ command: 'next', ...RUN, args: 'off' })
  await $.command.run({ command: 'band', ...RUN, args: 'hide speed' })
  await $.command.run({ command: 'roadmap', ...RUN, args: 'band' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mod-switch', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^SUGGESTIONS & SAFETY$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^BAND ABOVE THE PROMPT$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ROADMAP$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Next$/ })).toBeDefined()
    // A why-line longer than the pane's row is cut, not wrapped.
    expect(await ui.find({ type: 'Text', text: /^after a reply — the goal and 2–3 next prompts; .*…$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^asks before rm -r, push --force, reset --hard$/ })).toBeDefined()
    // The state marks are colored: on in green, off in gray.
    expect(await ui.findAll({ type: 'Text', text: /^●$/ })).toHaveLength(5)
    expect(await ui.findAll({ type: 'Text', text: /^○$/ })).toHaveLength(2)
    expect((await ui.find({ type: 'Text', text: /^●$/ }))?.props.color).toBe('#3fb950')
    expect((await ui.find({ type: 'Text', text: /^○$/ }))?.props.color).toBe('#8b949e')
    expect((await ui.find({ key: 'toggle-next' }))?.text).toBe('Off')
    expect((await ui.find({ key: 'toggle-guard' }))?.text).toBe('On')
    expect((await ui.find({ key: 'toggle-col-context' }))?.text).toBe('On')
    expect((await ui.find({ key: 'toggle-col-speed' }))?.text).toBe('Off')
    expect((await ui.find({ key: 'toggle-roadmap' }))?.text).toBe('Under the chat')
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(8)
    expect(await ui.find({ type: 'Text', text: /^Not installed/ })).toBeUndefined()
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(surface === 'desktop' ? 3 : 0)
    await ui.unmount()
  }
})

/**
 * Each value is changed only by its mod's own command (`/next off`, `/band hide cache`, …):
 * the pane redraws by itself — reading while drawing subscribed it to the other mod's value.
 */
test("a press runs the mod's command, the pane redraws from its value, no toasts", { plugins: OWNERS }, async ($, on) => {
  on('command.list', () => ({ value: ALL }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mod-switch', surface, ...PANE })

    expect((await ui.find({ key: 'toggle-next' }))?.text).toBe('On')
    await ui.press({ key: 'toggle-next' })
    expect((await ui.find({ key: 'toggle-next' }))?.text).toBe('Off')
    await ui.press({ key: 'toggle-next' })
    expect((await ui.find({ key: 'toggle-next' }))?.text).toBe('On')

    expect((await ui.find({ key: 'toggle-col-cache' }))?.text).toBe('On')
    await ui.press({ key: 'toggle-col-cache' })
    expect((await ui.find({ key: 'toggle-col-cache' }))?.text).toBe('Off')
    await ui.press({ key: 'toggle-col-cache' })
    expect((await ui.find({ key: 'toggle-col-cache' }))?.text).toBe('On')

    expect((await ui.find({ key: 'toggle-roadmap' }))?.text).toBe('In a pane')
    await ui.press({ key: 'toggle-roadmap' })
    expect((await ui.find({ key: 'toggle-roadmap' }))?.text).toBe('Under the chat')
    await ui.press({ key: 'toggle-roadmap' })
    expect((await ui.find({ key: 'toggle-roadmap' }))?.text).toBe('In a pane')

    await ui.press({ key: 'toggle-guard' })
    expect((await ui.find({ key: 'toggle-guard' }))?.text).toBe('Off')
    await ui.press({ key: 'toggle-guard' })
    await ui.unmount()
  }

  // The commands' replies show in the chat; a toast only on an error.
  expect(toasts).toEqual([])
})

test("the command didn't run or the value didn't change — a toast with the reply", async ($, on) => {
  on('command.list', () => ({ value: ALL }))
  // "Next" replies but changes nothing; nobody answers /guard.
  on('command.run', { command: 'next' }, () => ({ text: 'Suggestions are unavailable right now.' }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    toasts.length = 0
    const ui = await $.ui.mount({ plugin: 'mod-switch', surface, ...PANE })
    await ui.press({ key: 'toggle-guard' })
    await ui.press({ key: 'toggle-next' })
    expect(toasts).toHaveLength(2)
    expect(toasts[0]).toMatch(/^Couldn't run \/guard off: /)
    expect(toasts[1]).toBe('/next off: Suggestions are unavailable right now.')
    expect((await ui.find({ key: 'toggle-next' }))?.text).toBe('On')
    await ui.unmount()
  }
})

test('mods that are not installed: no switches, one line at the bottom', async ($, on) => {
  on('command.list', () => ({ value: SOME }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mod-switch', surface, ...PANE })
    expect(await ui.find({ key: 'toggle-next' })).toBeDefined()
    expect(await ui.find({ key: 'toggle-guard' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^asks before/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^BAND ABOVE THE PROMPT$/ })).toBeUndefined()
    expect(await ui.find({ key: 'toggle-col-cache' })).toBeUndefined()
    expect(await ui.find({ key: 'toggle-roadmap' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Not installed: command-guard, usage-band$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('no mods at all — no cards, no buttons, just the "Not installed" line', async ($, on) => {
  on('command.list', () => ({ value: [] }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mod-switch', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^Not installed: next-steps, command-guard, usage-band, ro.*$/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    expect(await ui.find({ type: 'Text', text: /^ROADMAP$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a narrow pane: why-lines are cut to its width, not wrapped', async ($, on) => {
  on('command.list', () => ({ value: ALL }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mod-switch', surface, ...PANE, props: { ...PANE.props, bodyColumns: 30 } })
    const why = await ui.find({ type: 'Text', text: /^after a reply/ })
    expect(why?.text.endsWith('…')).toBe(true)
    expect(why?.text.length).toBeLessThanOrEqual(30 - 2)
    await ui.unmount()
  }
})
