import { describe, expect, test } from 'claude-code/testing'
import type { CommandInfo } from 'claude-code'

import { buildDeck, findCommand } from './register'

const COMMANDS: CommandInfo[] = [
  { name: 'compact', description: 'Clear conversation history but keep a summary in context', source: 'builtin' },
  { name: 'clear', description: 'Clear conversation history and free up context', source: 'builtin' },
  { name: 'context', description: 'Visualize current context usage as a colored grid', source: 'builtin' },
  { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation', source: 'builtin' },
  { name: 'engineering:code-review', description: 'Review code changes', source: 'plugin', plugin: 'engineering' },
  { name: 'model', description: 'Set the AI model for Claude Code', source: 'builtin' },
  { name: 'inspector', description: 'Открыть инспектор контекста', source: 'plugin', plugin: 'context-inspector' },
  { name: 'deck', description: 'Открыть панель «Команды»', source: 'plugin', plugin: 'command-deck' },
  { name: 'add-dir', description: 'Add a new working directory', source: 'builtin' },
  { name: 'doctor', description: 'Diagnose and verify your Claude Code installation and settings', source: 'builtin' },
  { name: 'agents', description: 'Manage agent configurations', source: 'builtin' },
]

const PANE = {
  component: 'Pane',
  requestId: 'command-deck',
  props: { title: 'Команды', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const RUN = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

describe('каталог', () => {
  test('только существующие команды, плагинные по суффиксу, без /deck и команд с обязательными аргументами', () => {
    expect(findCommand(COMMANDS, 'code-review')?.name).toBe('engineering:code-review')
    expect(findCommand(COMMANDS, 'memory')).toBeUndefined()

    const deck = buildDeck(COMMANDS)
    const names = (id: string) => deck.groups.find(group => group.id === id)?.rows.map(row => row.name)
    expect(names('context')).toEqual(['compact', 'clear', 'context'])
    expect(names('project')).toEqual(['init', 'engineering:code-review'])
    expect(names('session')).toEqual(['model'])
    expect(names('panels')).toEqual(['inspector'])
    expect(deck.groups.find(group => group.id === 'context')?.rows[1]?.confirm?.yes).toBe('Да, очистить')
    // «Все остальные»: по алфавиту, со своим описанием, без /deck и /add-dir.
    expect(deck.rest.map(row => row.name)).toEqual(['agents', 'doctor'])
    expect(deck.rest[1]?.text).toBe('Diagnose and verify your Claude Code installation and settings')
  })
})

test('панель открывается сама при старте сессии и по /deck', async ($, on) => {
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('command.list', () => ({ value: COMMANDS }))

  const registered: string[] = []
  on('command.register', ($, e) => {
    registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['deck'])
  // Панель открывается сама при старте сессии, вкладкой рядом с остальными.
  expect(opened).toEqual(['command-deck'])

  const reply = await $.command.run({ command: 'deck', ...RUN })
  expect(reply.text).toBe('Панель «Команды» открыта.')
  expect(opened).toEqual(['command-deck', 'command-deck'])
})

test('панель: секции, пояснения и свёрнутые «Все остальные» на обоих видах', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.list', () => ({ value: COMMANDS }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'command-deck', surface, ...PANE })
    // Секция: название и число отдельно; подсказки «▶ запускает…» над списком больше нет.
    expect(await ui.find({ type: 'Text', text: 'КОНТЕКСТ И ПАМЯТЬ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /запускает команду/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '/compact' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Сжать переписку, освободить контекст' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '/engineering:code-review' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'НАШИ ПАНЕЛИ' })).toBeDefined()
    expect((await ui.find({ key: 'run-compact' }))?.text).toBe('▶')
    // Чего нет в списке — нет и на панели; /deck и /add-dir не показываются.
    expect(await ui.find({ type: 'Text', text: '/memory' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '/roadmap' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '/deck' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '/add-dir' })).toBeUndefined()
    // «Все остальные» свёрнуты, пока их не раскроют.
    expect(await ui.find({ type: 'Text', text: 'ВСЕ ОСТАЛЬНЫЕ' })).toBeDefined()
    expect((await ui.find({ key: 'more-rest' }))?.text).toBe('Показать 2')
    expect(await ui.find({ type: 'Text', text: '/doctor' })).toBeUndefined()
    await ui.press({ key: 'more-rest' })
    expect(await ui.find({ type: 'Text', text: '/doctor' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Diagnose and verify/ })).toBeDefined()
    await ui.press({ key: 'more-rest' })
    expect(await ui.find({ type: 'Text', text: '/doctor' })).toBeUndefined()
    await ui.unmount()
  }
})

test('▶ у /compact запускает команду через command.run, ответ — всплывашкой, не строкой на панели', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.list', () => ({ value: COMMANDS }))
  const runs: string[] = []
  on('command.run', ($, e) => {
    runs.push(e.command)

    return { text: 'Переписка сжата' }
  })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    runs.length = 0
    toasts.length = 0
    const ui = await $.ui.mount({ plugin: 'command-deck', surface, ...PANE })
    await ui.press({ key: 'run-compact' })
    expect(runs).toEqual(['compact'])
    expect(toasts).toEqual(['/compact: Переписка сжата'])
    expect(await ui.find({ type: 'Text', text: /^\/compact · / })).toBeUndefined()
    await ui.unmount()
  }
})

test('▶ у /clear сначала спрашивает и при отказе ничего не запускает', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.list', () => ({ value: COMMANDS }))
  const runs: string[] = []
  on('command.run', ($, e) => {
    runs.push(e.command)

    return {}
  })
  const asked: string[] = []
  let answer = 'Отмена'
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]?.question ?? ''
    asked.push(question)

    return { result: { questions: e.questions, answers: { [question]: answer } } }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    runs.length = 0
    asked.length = 0
    const ui = await $.ui.mount({ plugin: 'command-deck', surface, ...PANE })

    answer = 'Отмена'
    await ui.press({ key: 'run-clear' })
    expect(asked).toEqual(['Очистить переписку и начать с чистого листа?'])
    expect(runs).toEqual([])

    answer = 'Да, очистить'
    await ui.press({ key: 'run-clear' })
    expect(asked.length).toBe(2)
    expect(runs).toEqual(['clear'])
    await ui.unmount()
  }
})
