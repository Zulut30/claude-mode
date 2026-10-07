import { describe, expect, mock, test } from 'claude-code/testing'

import {
  taskStatus,
  isPersonPrompt,
  taskTitle,
  describeCommand,
  isContinuation,
  summarize,
  addTask,
  applyTodos,
  classify,
  closeTurn,
  emptyMap,
  finishStep,
  formatDuration,
  normalize,
  startStep,
  updateTask,
  visibleStages,
} from './register'

const PANE = {
  component: 'Pane',
  requestId: 'roadmap',
  props: {
    title: 'Дорожная карта',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const NO_PROJECT = { isGit: false, hasChecks: false, hasTests: false, hasDeploy: false }

describe('classify', () => {
  test('инструменты и команды раскладываются по стадиям', () => {
    expect(classify({ tool: 'Read', file_path: 'C:/p/src/app.ts' })).toEqual({ stage: 'context', last: 'чтение app.ts', file: 'app.ts' })
    expect(classify({ tool: 'Grep', pattern: 'foo' })?.stage).toBe('context')
    expect(classify({ tool: 'Edit', file_path: '/p/a.tsx' })?.stage).toBe('work')
    expect(classify({ tool: 'Bash', command: 'npm install zod' })?.stage).toBe('work')
    expect(classify({ tool: 'Bash', command: 'git status' })?.stage).toBe('context')
    expect(classify({ tool: 'Bash', command: 'cat register.test.tsx' })?.stage).toBe('context')
    expect(classify({ tool: 'Bash', command: 'npx tsc --noEmit' })?.stage).toBe('check')
    expect(classify({ tool: 'Bash', command: 'claude plugin validate .' })?.stage).toBe('check')
    expect(classify({ tool: 'Bash', command: 'npm test' })?.stage).toBe('test')
    expect(classify({ tool: 'PowerShell', command: 'pytest -q' })?.stage).toBe('test')
    expect(classify({ tool: 'Bash', command: 'git commit -m "x"' })?.stage).toBe('push')
    expect(classify({ tool: 'Bash', command: 'vercel --prod' })?.stage).toBe('deploy')
    expect(classify({ tool: 'mcp__abc__deploy_edge_function' })?.stage).toBe('deploy')
    expect(classify({ tool: 'Skill', skill: 'verification-before-completion' })?.stage).toBe('check')
    expect(classify({ tool: 'TodoWrite' })).toBeNull()
  })
})

describe('переходы стадий', () => {
  test('новая стадия закрывает прошлую, время считается, ошибка теста — красная', () => {
    let map = startStep(emptyMap(), { stage: 'context', last: 'чтение a.ts', file: 'a.ts' }, 0)
    expect(map.stages.context.status).toBe('active')
    expect(map.startedAt).toBe(0)

    map = startStep(map, { stage: 'work', last: 'правка a.ts', file: 'a.ts' }, 120_000)
    expect(map.stages.context).toMatchObject({ status: 'done', startedAt: 0, endedAt: 120_000 })
    expect(map.stages.work.status).toBe('active')

    const test = { stage: 'test', last: 'npm test' } as const
    map = finishStep(startStep(map, test, 200_000), test, true, 210_000)
    expect(map.stages.work.status).toBe('done')
    expect(map.stages.test.status).toBe('failed')

    map = finishStep(startStep(map, test, 220_000), test, false, 230_000)
    expect(map.stages.test.status).toBe('done')
  })

  test('коммит без пуша оставляет «Пуш» в процессе', () => {
    const commit = { stage: 'push', last: 'git commit -m "x"' } as const
    let map = finishStep(startStep(emptyMap(), commit, 0), commit, false, 1)
    expect(map.stages.push.status).toBe('active')
    map = closeTurn(startStep(map, { stage: 'context', last: 'чтение b.ts' }, 2), 3)
    expect(map.stages.push.status).toBe('active')
    expect(map.stages.context.status).toBe('done')

    const push = { stage: 'push', last: 'git push' } as const
    map = finishStep(startStep(map, push, 4), push, false, 5)
    expect(map.stages.push.status).toBe('done')
  })

  test('значение старой версии без плана дополняется', () => {
    const old = { task: 'x', stages: emptyMap().stages } as never
    expect(normalize(old).plan).toEqual([])
  })
})

describe('адаптивность', () => {
  test('стадии проекта: без git нет пуша, без конфигов деплоя нет деплоя', () => {
    const ids = (project: typeof NO_PROJECT) => visibleStages(emptyMap(), project).map(stage => stage.id)
    expect(ids(NO_PROJECT)).toEqual(['context', 'work'])
    expect(ids({ ...NO_PROJECT, isGit: true, hasTests: true })).toEqual(['context', 'work', 'test', 'push'])

    const deployed = startStep(emptyMap(), { stage: 'deploy', last: 'vercel' }, 0)
    expect(visibleStages(deployed, NO_PROJECT).map(stage => stage.id)).toEqual(['context', 'work', 'deploy'])
  })

  test('план Claude: TodoWrite, TaskCreate и TaskUpdate', () => {
    let map = applyTodos(emptyMap(), [
      { content: 'Типы', status: 'completed' },
      { content: 'Панель', status: 'in_progress' },
    ])
    expect(map.plan.map(item => item.title)).toEqual(['Типы', 'Панель'])

    map = addTask(map, '7', 'Тесты')
    map = updateTask(map, '7', { status: 'in_progress' })
    expect(map.plan.at(-1)).toEqual({ id: '7', title: 'Тесты', status: 'in_progress' })
    map = updateTask(map, '7', { status: 'deleted' })
    expect(map.plan).toHaveLength(2)
  })

  test('длительность', () => {
    expect(formatDuration(30_000)).toBe('<1 мин')
    expect(formatDuration(5 * 60_000)).toBe('5 мин')
    expect(formatDuration(65 * 60_000)).toBe('1 ч 5 мин')
  })
})

describe('новые задачи и подписи', () => {
  test('команда коротко, без путей и переменных', () => {
    expect(describeCommand('S="C:/Users/x/scratch"; D="C:/mods"\nTS_LIB="C:/ts.js" node "$S/typecheck.cjs" "$D/a"', /typecheck/)).toBe('node typecheck.cjs')
    expect(describeCommand('M="C:/mods/roadmap"; claude plugin test "$M" 2>&1 | tail -8', /plugin\s+test/)).toBe('claude plugin test')
    expect(describeCommand('cd app && npm test -- --watch=false', /npm\s+test/)).toBe('npm test -- --watch=false')
    expect(describeCommand('git commit -m "fix: x"')).toBe('git commit -m')
    expect(classify({ tool: 'Bash', command: 'M="C:/m"; claude plugin validate "$M" 2>&1 | grep ok' })).toEqual({
      stage: 'check',
      last: 'claude plugin validate',
    })
  })

  test('«да / давай» продолжает задачу, остальное — новая', () => {
    expect(isContinuation('давай')).toBe(true)
    expect(isContinuation('давай только сделай аккуратно')).toBe(true)
    expect(isContinuation('Да, продолжай')).toBe(true)
    expect(isContinuation('убери кнопки с этой панели откати')).toBe(false)
    expect(isContinuation('дорожная карта работает плохо')).toBe(false)
  })

  test('итог задачи для «Ранее»', () => {
    let map = startStep({ ...emptyMap(), task: 'X' }, { stage: 'context', last: 'чтение a' }, 0)
    map = closeTurn(startStep(map, { stage: 'work', last: 'правка a' }, 60_000), 180_000)
    expect(summarize(map, NO_PROJECT, 200_000)).toEqual({ task: 'X', done: 2, total: 2, isFailed: false, durationMs: 180_000 })
  })
})

const PROMPT = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never

test('панель: стадии, план, новая задача по новому запросу, «Ранее»', async ($, on) => {
  mock.clock(on, { now: 0 })
  const call = $.tool.call as unknown as (args: { tool: string; [key: string]: unknown }) => Promise<unknown>
  on('tool.call', (_, e) =>
    e.tool === 'Bash' && e.command.includes('npm test')
      ? { isError: true, result: 'Exit code 1', text: 'Exit code 1' }
      : e.tool === 'TodoWrite'
        ? { result: { oldTodos: [], newTodos: e.todos } }
        : { result: 'ok', text: 'ok' },
  )
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))

  await $.prompt.submit(PROMPT('сделай страницу входа'))
  await $.turn.start({ text: 'сделай страницу входа', turnId: 't1' })
  await call({ tool: 'Read', file_path: 'C:/p/src/app.ts' })
  await call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Собрать типы', status: 'completed', activeForm: 'Собираю типы' },
      { content: 'Нарисовать панель', status: 'in_progress', activeForm: 'Рисую панель' },
    ],
  })
  await call({ tool: 'Edit', file_path: 'C:/p/src/app.ts', old_string: 'a', new_string: 'b' })
  await call({ tool: 'Bash', command: 'X="C:/p"; cd "$X" && npm test' })
  await $.prompt.submit(PROMPT('давай'))
  await $.prompt.submit({ text: '<agent-message from="a1"> [Subagent hand-back] отчёт', wait: false, origin: { kind: 'peer' } } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'roadmap', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: 'сделай страницу входа' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Claude работает' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /прочитано 1 файл/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 файл: app.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Нарисовать панель' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'npm test — ошибка' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Пуш' })).toBeUndefined()
    if (surface === 'terminal') {
      expect((await ui.find({ type: 'Text', text: '✗' }))?.props.color).toBe('#f85149')
    } else {
      expect((await ui.findAll({ type: 'Svg' })).some(svg => svg.props.alt === 'ошибка')).toBe(true)
    }
    await ui.unmount()
  }

  // Новый запрос — новая задача, прошлая уходит в «Ранее».
  await $.prompt.submit(PROMPT('теперь добавь тёмную тему'))
  const ui = await $.ui.mount({ plugin: 'roadmap', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'теперь добавь тёмную тему' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /npm test/ })).toBeUndefined()
  await ui.press({ key: 'toggle-past' })
  expect(await ui.find({ type: 'Text', text: 'сделай страницу входа' })).toBeDefined()

  await ui.press({ key: 'reset' })
  expect(await ui.find({ type: 'Text', text: 'Появится с вашим следующим запросом' })).toBeDefined()
  await ui.unmount()
})

describe('точность', () => {
  test('сообщения агентов и служебные вставки — не задачи', () => {
    expect(isPersonPrompt('composer', 'сделай панель')).toBe(true)
    expect(isPersonPrompt('sdk', 'сделай панель')).toBe(true)
    expect(isPersonPrompt('peer', 'сделай панель')).toBe(false)
    expect(isPersonPrompt('composer', '<agent-message from="a1"> отчёт')).toBe(false)
    expect(isPersonPrompt('composer', '/roadmap')).toBe(false)
  })

  test('название задачи — первая строка, не длиннее ~90 символов', () => {
    expect(taskTitle('сделай панель\nи ещё вторую строку')).toBe('сделай панель')
    const long = taskTitle('сделай чтобы задачи в этой панели были более адаптивные и также сделай мод похожий на расширение git lens')
    expect(long.length).toBeLessThanOrEqual(91)
    expect(long.endsWith('…')).toBe(true)
  })

  test('коммит со словом deploy в тексте — это пуш, а не деплой', () => {
    const script = 'git add -A && git commit -q -F - <<\'EOF\'\nAdd mods\n- roadmap: deploy stage\nEOF\ngit push -u origin main'
    expect(classify({ tool: 'Bash', command: script })?.stage).toBe('push')
    expect(classify({ tool: 'Bash', command: 'git commit -m "prepare deploy to vercel"' })?.stage).toBe('push')
    expect(classify({ tool: 'Bash', command: 'npx vercel --prod' })?.stage).toBe('deploy')
    expect(classify({ tool: 'Bash', command: 'npm run deploy' })?.stage).toBe('deploy')
    // «git add && git commit && git push» — это пуш целиком, а не «только коммит».
    const both = classify({ tool: 'Bash', command: 'git add -A && git commit -m "x" && git push origin main' })
    expect(both).toEqual({ stage: 'push', last: 'git push origin main' })
    expect(finishStep(startStep(emptyMap(), both!, 0), both!, false, 1).stages.push.status).toBe('done')
  })

  test('команды чтения — подготовка контекста', () => {
    expect(classify({ tool: 'Bash', command: 'gh repo view Zulut30/claude-mode --json name' })?.stage).toBe('context')
    expect(classify({ tool: 'Bash', command: 'cat vercel.json' })?.stage).toBe('context')
    expect(classify({ tool: 'Bash', command: 'cd app && git status --short && ls -la | head -5' })?.stage).toBe('context')
    expect(classify({ tool: 'Bash', command: 'mkdir -p out && cp a b' })?.stage).toBe('work')
  })
})

describe('статус задачи', () => {
  test('работает / ошибка / готово / пусто', () => {
    expect(taskStatus(emptyMap(), NO_PROJECT, false)).toBeNull()
    const map = startStep({ ...emptyMap(), task: 'X' }, { stage: 'work', last: 'правка a' }, 0)
    expect(taskStatus(map, NO_PROJECT, true)?.text).toBe('Claude работает')
    expect(taskStatus(closeTurn(map, 1), NO_PROJECT, false)?.text).toBe('Готово · ждёт вас')
    const test = { stage: 'test', last: 'npm test' } as const
    expect(taskStatus(finishStep(startStep(map, test, 2), test, true, 3), NO_PROJECT, false)?.text).toBe('Есть ошибка')
  })
})

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

test('карта переносится под чат и обратно; соседняя полоса не пропадает', async ($, on) => {
  mock.clock(on, { now: 0 })
  const call = $.tool.call as unknown as (args: { tool: string; [key: string]: unknown }) => Promise<unknown>
  const panes: string[] = []
  on('ui.open', (_, e) => (panes.push(`open:${e.id}`), { value: { isPlaced: true } }))
  on('ui.close', (_, e) => (panes.push(`close:${e.id}`), { value: undefined }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>полоса лимитов</Text>
  })

  await $.prompt.submit(PROMPT('сделай страницу входа'))
  await call({ tool: 'Read', file_path: 'C:/p/a.ts' })
  await call({ tool: 'Edit', file_path: 'C:/p/a.ts', old_string: 'a', new_string: 'b' })

  // Пока карта в панели, полоса показывает только соседа.
  let band = await $.ui.mount({ plugin: 'roadmap', surface: 'desktop', ...BAND })
  expect(await band.find({ type: 'Text', text: 'Выполнение' })).toBeUndefined()
  await band.unmount()

  const pane = await $.ui.mount({ plugin: 'roadmap', surface: 'desktop', ...PANE })
  await pane.press({ key: 'to-band' })
  await pane.unmount()
  expect(panes).toContain('close:roadmap')

  for (const surface of ['terminal', 'desktop'] as const) {
    const view = await $.ui.mount({ plugin: 'roadmap', surface, ...BAND })
    expect(await view.find({ type: 'Text', text: 'сделай страницу входа' })).toBeDefined()
    expect(await view.find({ type: 'Text', text: 'Контекст' })).toBeDefined()
    expect(await view.find({ type: 'Text', text: /^Выполнение/ })).toBeDefined()
    expect(await view.find({ type: 'Text', text: 'полоса лимитов' })).toBeDefined()
    await view.unmount()
  }

  band = await $.ui.mount({ plugin: 'roadmap', surface: 'desktop', ...BAND })
  await band.press({ key: 'to-pane' })
  expect(await band.find({ type: 'Text', text: 'сделай страницу входа' })).toBeUndefined()
  await band.unmount()
  expect(panes.at(-1)).toBe('open:roadmap')

  const reply = await $.command.run({ command: 'roadmap', args: 'band', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(reply.text).toBe('Дорожная карта теперь под чатом, над полем ввода.')
})

const sleep = (ms: number) =>
  new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, ms))

const TURN_DONE = (agentId?: string) =>
  ({ answer: 'ok', durationMs: 1, isAborted: false, turnId: agentId ? 'sub-1' : 't1', reason: 'answer', ...(agentId ? { agentId } : {}) }) as const

test('«Claude работает» — с начала хода основного потока; конец хода субагента карту не трогает', async ($, on) => {
  mock.clock(on, { now: 0 })
  const call = $.tool.call as unknown as (args: { tool: string; [key: string]: unknown }) => Promise<unknown>
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  /** Строка статуса и то, идёт ли «Выполнение задачи», — с новой отрисовки панели. */
  const look = async () => {
    const ui = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', ...PANE })
    const status = (await ui.find({ type: 'Text', text: /^(Claude работает|Готово · ждёт вас|Есть ошибка)/ }))?.text
    const isWorkActive = (await ui.find({ type: 'Text', text: /^Выполнение задачи$/ }))?.props.bold === true
    await ui.unmount()

    return { status, isWorkActive }
  }

  await $.prompt.submit(PROMPT('сделай страницу входа'))
  await call({ tool: 'Read', file_path: 'C:/p/a.ts' })
  // Запрос ещё не начал ход — «работает» не горит.
  expect((await look()).status).toMatch(/^Готово · ждёт вас/)

  await $.turn.start({ text: 'сделай страницу входа', turnId: 't1' })
  await call({ tool: 'Edit', file_path: 'C:/p/a.ts', old_string: 'a', new_string: 'b' })
  expect(await look()).toEqual({ status: expect.stringMatching(/^Claude работает( · |$)/), isWorkActive: true })

  // Субагент закончил свой ход — основной ещё идёт: этап открыт, Claude работает.
  await $.turn.complete(TURN_DONE('agent-1'))
  expect(await look()).toEqual({ status: expect.stringMatching(/^Claude работает( · |$)/), isWorkActive: true })

  await $.turn.complete(TURN_DONE())
  expect(await look()).toEqual({ status: expect.stringMatching(/^Готово · ждёт вас/), isWorkActive: false })
})

test(
  'название задачи — цель сессии из «Дальше», если она есть; «Ранее» — по запросу',
  {
    plugins: [
      {
        name: 'next-steps',
        register(on) {
          on('command.run', { command: 'set-goal' }, async ($, e) => {
            await $.state.set({ plugin: 'next-steps', key: 'goal' } as const, e.args)

            return { text: 'ok' }
          })
        },
      },
    ],
  },
  async ($, on) => {
    mock.clock(on, { now: 0 })
    const call = $.tool.call as unknown as (args: { tool: string; [key: string]: unknown }) => Promise<unknown>
    on('tool.call', () => ({ result: 'ok', text: 'ok' }))
    on('prompt.submit', (_, e) => ({ text: e.text }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', () => ({ value: undefined }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Box } = $.ui.resolve(e)

      return <Box />
    })
    const setGoal = (goal: string) =>
      $.command.run({ command: 'set-goal', args: goal, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

    await $.prompt.submit(PROMPT('сделай страницу входа'))
    await call({ tool: 'Read', file_path: 'C:/p/a.ts' })

    const pane = await $.ui.mount({ plugin: 'roadmap', surface: 'desktop', ...PANE })
    expect(await pane.find({ type: 'Text', text: /^сделай страницу входа$/ })).toBeDefined()

    // Цель появилась — открытая панель перерисовывается сама.
    await setGoal('Моды для Claude Code')
    await sleep(20)
    expect(await pane.find({ type: 'Text', text: /^Моды для Claude Code$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^сделай страницу входа$/ })).toBeUndefined()

    // В «Ранее» — название по запросу, а не цель.
    await $.prompt.submit(PROMPT('теперь добавь тёмную тему'))
    await sleep(20)
    await pane.press({ key: 'toggle-past' })
    expect(await pane.find({ type: 'Text', text: /^сделай страницу входа$/ })).toBeDefined()
    expect(await pane.findAll({ type: 'Text', text: /^Моды для Claude Code$/ })).toHaveLength(1)

    // Полоса под чатом — тоже с целью.
    await pane.press({ key: 'to-band' })
    await pane.unmount()
    const band = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', ...BAND })
    expect(await band.find({ type: 'Text', text: /^Моды для Claude Code$/ })).toBeDefined()
    await band.unmount()

    // Цель пустая — снова название по запросу.
    await setGoal('')
    const view = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', ...BAND })
    expect(await view.find({ type: 'Text', text: /^теперь добавь тёмную тему$/ })).toBeDefined()
    await view.unmount()
  },
)
