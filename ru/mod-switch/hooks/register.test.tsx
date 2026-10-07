import { describe, expect, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import type { CommandInfo } from 'claude-code'

import type { ModSwitchBandColumn } from '../types'
import { findModCommand, installedMods } from './register'

const ALL: CommandInfo[] = [
  { name: 'compact', description: 'Clear conversation history but keep a summary in context', source: 'builtin' },
  { name: 'next', description: 'Подсказки «Дальше»', source: 'plugin', plugin: 'next-steps' },
  { name: 'guard', description: 'Страховка команд', source: 'plugin', plugin: 'command-guard' },
  { name: 'band', description: 'Колонки полосы', source: 'plugin', plugin: 'usage-band' },
  { name: 'roadmap', description: 'Дорожная карта', source: 'plugin', plugin: 'roadmap' },
  { name: 'mods', description: 'Панель «Моды»', source: 'plugin', plugin: 'mod-switch' },
]

/** Без страховки и без usage-band. */
const SOME = ALL.filter(command => command.plugin !== 'command-guard' && command.plugin !== 'usage-band')

const PANE = {
  component: 'Pane',
  requestId: 'mod-switch',
  props: { title: 'Моды', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const RUN = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

/**
 * Моды-владельцы, как настоящие: каждый сам хранит своё значение и меняет его
 * только своей командой. Панель их значения лишь читает.
 */
const OWNERS: Plugin[] = [
  {
    name: 'next-steps',
    register(on) {
      on('command.run', { command: 'next' }, async ($, e) => {
        await $.state.set({ plugin: 'next-steps', key: 'isOff' } as const, e.args === 'off')

        return { text: e.args === 'off' ? 'Подсказки «Дальше» выключены.' : 'Подсказки «Дальше» включены.' }
      })
    },
  },
  {
    name: 'command-guard',
    register(on) {
      on('command.run', { command: 'guard' }, async ($, e) => {
        await $.state.set({ plugin: 'command-guard', key: 'isOff' } as const, e.args === 'off')

        return { text: 'Страховка переключена.' }
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

        return { text: 'Колонка переключена.' }
      })
    },
  },
  {
    name: 'roadmap',
    register(on) {
      on('command.run', { command: 'roadmap' }, async ($, e) => {
        await $.state.set({ plugin: 'roadmap', key: 'placement' } as const, e.args === 'band' ? 'band' : 'pane')

        return { text: 'Дорожная карта перенесена.' }
      })
    },
  },
]

describe('каталог', () => {
  test('мод установлен, если есть его команда: по плагину, с префиксом или без', () => {
    const mod = { plugin: 'next-steps', command: 'next' }
    expect(findModCommand(ALL, mod)?.name).toBe('next')
    expect(findModCommand([{ name: 'next-steps:next', description: '', source: 'plugin', plugin: 'next-steps' }], mod)?.name).toBe('next-steps:next')
    expect(findModCommand([{ name: 'next', description: '', source: 'plugin', plugin: 'other' }], mod)).toBeUndefined()
    expect(installedMods(SOME)).toEqual({ next: 'next', guard: undefined, band: undefined, roadmap: 'roadmap' })
  })
})

test('панель не открывается сама при старте, открывается по /mods', async ($, on) => {
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
  expect(reply.text).toBe('Панель «Моды» открыта.')
  expect(opened).toEqual(['mod-switch'])
})

test('панель: состояние читается из значений самих модов, на обоих видах', { plugins: OWNERS }, async ($, on) => {
  on('command.list', () => ({ value: ALL }))
  await $.command.run({ command: 'next', ...RUN, args: 'off' })
  await $.command.run({ command: 'band', ...RUN, args: 'hide speed' })
  await $.command.run({ command: 'roadmap', ...RUN, args: 'band' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mod-switch', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^ПОДСКАЗКИ И ЗАЩИТА$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ПОЛОСА НАД ВВОДОМ$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ДОРОЖНАЯ КАРТА$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Дальше$/ })).toBeDefined()
    // Пояснение длиннее строки панели — обрезано, а не перенесено.
    expect(await ui.find({ type: 'Text', text: /^после ответа — цель и 2–3 следующих запроса; .*…$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^спрашивает перед rm -r, push --force, reset --hard$/ })).toBeDefined()
    // Значки состояния — цветом: включено зелёным, выключено серым.
    expect(await ui.findAll({ type: 'Text', text: /^●$/ })).toHaveLength(5)
    expect(await ui.findAll({ type: 'Text', text: /^○$/ })).toHaveLength(2)
    expect((await ui.find({ type: 'Text', text: /^●$/ }))?.props.color).toBe('#3fb950')
    expect((await ui.find({ type: 'Text', text: /^○$/ }))?.props.color).toBe('#8b949e')
    expect((await ui.find({ key: 'toggle-next' }))?.text).toBe('Выкл')
    expect((await ui.find({ key: 'toggle-guard' }))?.text).toBe('Вкл')
    expect((await ui.find({ key: 'toggle-col-context' }))?.text).toBe('Вкл')
    expect((await ui.find({ key: 'toggle-col-speed' }))?.text).toBe('Выкл')
    expect((await ui.find({ key: 'toggle-roadmap' }))?.text).toBe('Под чатом')
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(8)
    expect(await ui.find({ type: 'Text', text: /^Не установлены/ })).toBeUndefined()
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(surface === 'desktop' ? 3 : 0)
    await ui.unmount()
  }
})

/**
 * Каждое значение меняет только его мод своей командой (`/next off`, `/band hide cache`, …):
 * панель перерисовывается сама — чтение при отрисовке подписало её на чужое значение.
 */
test('нажатие запускает команду мода, панель перерисовывается по его значению, всплывашек нет', { plugins: OWNERS }, async ($, on) => {
  on('command.list', () => ({ value: ALL }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mod-switch', surface, ...PANE })

    expect((await ui.find({ key: 'toggle-next' }))?.text).toBe('Вкл')
    await ui.press({ key: 'toggle-next' })
    expect((await ui.find({ key: 'toggle-next' }))?.text).toBe('Выкл')
    await ui.press({ key: 'toggle-next' })
    expect((await ui.find({ key: 'toggle-next' }))?.text).toBe('Вкл')

    expect((await ui.find({ key: 'toggle-col-cache' }))?.text).toBe('Вкл')
    await ui.press({ key: 'toggle-col-cache' })
    expect((await ui.find({ key: 'toggle-col-cache' }))?.text).toBe('Выкл')
    await ui.press({ key: 'toggle-col-cache' })
    expect((await ui.find({ key: 'toggle-col-cache' }))?.text).toBe('Вкл')

    expect((await ui.find({ key: 'toggle-roadmap' }))?.text).toBe('В панели')
    await ui.press({ key: 'toggle-roadmap' })
    expect((await ui.find({ key: 'toggle-roadmap' }))?.text).toBe('Под чатом')
    await ui.press({ key: 'toggle-roadmap' })
    expect((await ui.find({ key: 'toggle-roadmap' }))?.text).toBe('В панели')

    await ui.press({ key: 'toggle-guard' })
    expect((await ui.find({ key: 'toggle-guard' }))?.text).toBe('Выкл')
    await ui.press({ key: 'toggle-guard' })
    await ui.unmount()
  }

  // Ответы команд видны в чате; всплывашки — только при ошибке.
  expect(toasts).toEqual([])
})

test('команда не запустилась или значение не сменилось — всплывашка с ответом', async ($, on) => {
  on('command.list', () => ({ value: ALL }))
  // «Дальше» отвечает, но ничего не меняет; на /guard не отвечает никто.
  on('command.run', { command: 'next' }, () => ({ text: 'Подсказки сейчас недоступны.' }))
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
    expect(toasts[0]).toMatch(/^Не удалось выполнить \/guard off: /)
    expect(toasts[1]).toBe('/next off: Подсказки сейчас недоступны.')
    expect((await ui.find({ key: 'toggle-next' }))?.text).toBe('Вкл')
    await ui.unmount()
  }
})

test('не установленные моды: без переключателей, одной строкой внизу', async ($, on) => {
  on('command.list', () => ({ value: SOME }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mod-switch', surface, ...PANE })
    expect(await ui.find({ key: 'toggle-next' })).toBeDefined()
    expect(await ui.find({ key: 'toggle-guard' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^спрашивает перед/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^ПОЛОСА НАД ВВОДОМ$/ })).toBeUndefined()
    expect(await ui.find({ key: 'toggle-col-cache' })).toBeUndefined()
    expect(await ui.find({ key: 'toggle-roadmap' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Не установлены: command-guard, usage-band$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('ни одного мода — ни карточек, ни кнопок, только строка «Не установлены»', async ($, on) => {
  on('command.list', () => ({ value: [] }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mod-switch', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^Не установлены: next-steps, command-guard, usage-band, ro.*$/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    expect(await ui.find({ type: 'Text', text: /^ДОРОЖНАЯ КАРТА$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('узкая панель: пояснения обрезаны по ширине, а не переносятся', async ($, on) => {
  on('command.list', () => ({ value: ALL }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mod-switch', surface, ...PANE, props: { ...PANE.props, bodyColumns: 30 } })
    const why = await ui.find({ type: 'Text', text: /^после ответа/ })
    expect(why?.text.endsWith('…')).toBe(true)
    expect(why?.text.length).toBeLessThanOrEqual(30 - 2)
    await ui.unmount()
  }
})
