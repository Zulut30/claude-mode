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
    title: 'Roadmap',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const NO_PROJECT = { isGit: false, hasChecks: false, hasTests: false, hasDeploy: false }

describe('classify', () => {
  test('tools and commands map to stages', () => {
    expect(classify({ tool: 'Read', file_path: 'C:/p/src/app.ts' })).toEqual({ stage: 'context', last: 'reading app.ts', file: 'app.ts' })
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

describe('stage transitions', () => {
  test('a new stage closes the previous one, time is tracked, a failed test turns red', () => {
    let map = startStep(emptyMap(), { stage: 'context', last: 'reading a.ts', file: 'a.ts' }, 0)
    expect(map.stages.context.status).toBe('active')
    expect(map.startedAt).toBe(0)

    map = startStep(map, { stage: 'work', last: 'editing a.ts', file: 'a.ts' }, 120_000)
    expect(map.stages.context).toMatchObject({ status: 'done', startedAt: 0, endedAt: 120_000 })
    expect(map.stages.work.status).toBe('active')

    const test = { stage: 'test', last: 'npm test' } as const
    map = finishStep(startStep(map, test, 200_000), test, true, 210_000)
    expect(map.stages.work.status).toBe('done')
    expect(map.stages.test.status).toBe('failed')

    map = finishStep(startStep(map, test, 220_000), test, false, 230_000)
    expect(map.stages.test.status).toBe('done')
  })

  test('a commit without a push keeps "Push" running', () => {
    const commit = { stage: 'push', last: 'git commit -m "x"' } as const
    let map = finishStep(startStep(emptyMap(), commit, 0), commit, false, 1)
    expect(map.stages.push.status).toBe('active')
    map = closeTurn(startStep(map, { stage: 'context', last: 'reading b.ts' }, 2), 3)
    expect(map.stages.push.status).toBe('active')
    expect(map.stages.context.status).toBe('done')

    const push = { stage: 'push', last: 'git push' } as const
    map = finishStep(startStep(map, push, 4), push, false, 5)
    expect(map.stages.push.status).toBe('done')
  })

  test('a value from an older version without a plan is filled in', () => {
    const old = { task: 'x', stages: emptyMap().stages } as never
    expect(normalize(old).plan).toEqual([])
  })
})

describe('adaptivity', () => {
  test('project stages: no git means no push, no deploy configs means no deploy', () => {
    const ids = (project: typeof NO_PROJECT) => visibleStages(emptyMap(), project).map(stage => stage.id)
    expect(ids(NO_PROJECT)).toEqual(['context', 'work'])
    expect(ids({ ...NO_PROJECT, isGit: true, hasTests: true })).toEqual(['context', 'work', 'test', 'push'])

    const deployed = startStep(emptyMap(), { stage: 'deploy', last: 'vercel' }, 0)
    expect(visibleStages(deployed, NO_PROJECT).map(stage => stage.id)).toEqual(['context', 'work', 'deploy'])
  })

  test("Claude's plan: TodoWrite, TaskCreate and TaskUpdate", () => {
    let map = applyTodos(emptyMap(), [
      { content: 'Types', status: 'completed' },
      { content: 'Pane', status: 'in_progress' },
    ])
    expect(map.plan.map(item => item.title)).toEqual(['Types', 'Pane'])

    map = addTask(map, '7', 'Tests')
    map = updateTask(map, '7', { status: 'in_progress' })
    expect(map.plan.at(-1)).toEqual({ id: '7', title: 'Tests', status: 'in_progress' })
    map = updateTask(map, '7', { status: 'deleted' })
    expect(map.plan).toHaveLength(2)
  })

  test('duration', () => {
    expect(formatDuration(30_000)).toBe('<1m')
    expect(formatDuration(5 * 60_000)).toBe('5m')
    expect(formatDuration(65 * 60_000)).toBe('1h 5m')
  })
})

describe('new tasks and labels', () => {
  test('a command in brief, without paths or variables', () => {
    expect(describeCommand('S="C:/Users/x/scratch"; D="C:/mods"\nTS_LIB="C:/ts.js" node "$S/typecheck.cjs" "$D/a"', /typecheck/)).toBe('node typecheck.cjs')
    expect(describeCommand('M="C:/mods/roadmap"; claude plugin test "$M" 2>&1 | tail -8', /plugin\s+test/)).toBe('claude plugin test')
    expect(describeCommand('cd app && npm test -- --watch=false', /npm\s+test/)).toBe('npm test -- --watch=false')
    expect(describeCommand('git commit -m "fix: x"')).toBe('git commit -m')
    expect(classify({ tool: 'Bash', command: 'M="C:/m"; claude plugin validate "$M" 2>&1 | grep ok' })).toEqual({
      stage: 'check',
      last: 'claude plugin validate',
    })
  })

  test('"yes / go ahead" continues the task, anything else starts a new one', () => {
    expect(isContinuation('go ahead')).toBe(true)
    expect(isContinuation('go ahead, but be careful')).toBe(true)
    expect(isContinuation('Yes, continue')).toBe(true)
    expect(isContinuation('remove the buttons from this panel')).toBe(false)
    expect(isContinuation('the roadmap works badly')).toBe(false)
  })

  test('task summary for "Earlier"', () => {
    let map = startStep({ ...emptyMap(), task: 'X' }, { stage: 'context', last: 'reading a' }, 0)
    map = closeTurn(startStep(map, { stage: 'work', last: 'editing a' }, 60_000), 180_000)
    expect(summarize(map, NO_PROJECT, 200_000)).toEqual({ task: 'X', done: 2, total: 2, isFailed: false, durationMs: 180_000 })
  })
})

const PROMPT = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never

test('pane: stages, plan, a new task on a new prompt, "Earlier"', async ($, on) => {
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

  await $.prompt.submit(PROMPT('build the login page'))
  await call({ tool: 'Read', file_path: 'C:/p/src/app.ts' })
  await call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Collect the types', status: 'completed', activeForm: 'Collecting the types' },
      { content: 'Draw the pane', status: 'in_progress', activeForm: 'Drawing the pane' },
    ],
  })
  await call({ tool: 'Edit', file_path: 'C:/p/src/app.ts', old_string: 'a', new_string: 'b' })
  await call({ tool: 'Bash', command: 'X="C:/p"; cd "$X" && npm test' })
  await $.prompt.submit(PROMPT('ok'))
  await $.prompt.submit({ text: '<agent-message from="a1"> [Subagent hand-back] report', wait: false, origin: { kind: 'peer' } } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'roadmap', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: 'build the login page' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Claude is working' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /read 1 file/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 file: app.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Draw the pane' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'npm test — failed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Push' })).toBeUndefined()
    if (surface === 'terminal') {
      expect((await ui.find({ type: 'Text', text: '✗' }))?.props.color).toBe('#f85149')
    } else {
      expect((await ui.findAll({ type: 'Svg' })).some(svg => svg.props.alt === 'failed')).toBe(true)
    }
    await ui.unmount()
  }

  // A new prompt is a new task; the previous one moves to "Earlier".
  await $.prompt.submit(PROMPT('now add a dark theme'))
  const ui = await $.ui.mount({ plugin: 'roadmap', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'now add a dark theme' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /npm test/ })).toBeUndefined()
  await ui.press({ key: 'toggle-past' })
  expect(await ui.find({ type: 'Text', text: 'build the login page' })).toBeDefined()

  await ui.press({ key: 'reset' })
  expect(await ui.find({ type: 'Text', text: 'Appears with your next request' })).toBeDefined()
  await ui.unmount()
})

describe('accuracy', () => {
  test('agent messages and service inserts are not tasks', () => {
    expect(isPersonPrompt('composer', 'make the pane')).toBe(true)
    expect(isPersonPrompt('sdk', 'make the pane')).toBe(true)
    expect(isPersonPrompt('peer', 'make the pane')).toBe(false)
    expect(isPersonPrompt('composer', '<agent-message from="a1"> report')).toBe(false)
    expect(isPersonPrompt('composer', '/roadmap')).toBe(false)
  })

  test('the task title is the first line, no longer than ~90 characters', () => {
    expect(taskTitle('make the pane\nand a second line too')).toBe('make the pane')
    const long = taskTitle('make the tasks in this pane more adaptive and also make a mod similar to the git lens extension')
    expect(long.length).toBeLessThanOrEqual(91)
    expect(long.endsWith('…')).toBe(true)
  })

  test('a commit with the word deploy in its text is a push, not a deploy', () => {
    const script = 'git add -A && git commit -q -F - <<\'EOF\'\nAdd mods\n- roadmap: deploy stage\nEOF\ngit push -u origin main'
    expect(classify({ tool: 'Bash', command: script })?.stage).toBe('push')
    expect(classify({ tool: 'Bash', command: 'git commit -m "prepare deploy to vercel"' })?.stage).toBe('push')
    expect(classify({ tool: 'Bash', command: 'npx vercel --prod' })?.stage).toBe('deploy')
    expect(classify({ tool: 'Bash', command: 'npm run deploy' })?.stage).toBe('deploy')
  })

  test('read-only commands are context gathering', () => {
    expect(classify({ tool: 'Bash', command: 'gh repo view Zulut30/claude-mode --json name' })?.stage).toBe('context')
    expect(classify({ tool: 'Bash', command: 'cat vercel.json' })?.stage).toBe('context')
    expect(classify({ tool: 'Bash', command: 'cd app && git status --short && ls -la | head -5' })?.stage).toBe('context')
    expect(classify({ tool: 'Bash', command: 'mkdir -p out && cp a b' })?.stage).toBe('work')
  })
})

describe('task status', () => {
  test('working / failed / done / empty', () => {
    expect(taskStatus(emptyMap(), NO_PROJECT, false)).toBeNull()
    const map = startStep({ ...emptyMap(), task: 'X' }, { stage: 'work', last: 'editing a' }, 0)
    expect(taskStatus(map, NO_PROJECT, true)?.text).toBe('Claude is working')
    expect(taskStatus(closeTurn(map, 1), NO_PROJECT, false)?.text).toBe('Done · waiting for you')
    const test = { stage: 'test', last: 'npm test' } as const
    expect(taskStatus(finishStep(startStep(map, test, 2), test, true, 3), NO_PROJECT, false)?.text).toBe('Something failed')
  })
})

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

test('the roadmap moves under the chat and back; the neighbouring band stays', async ($, on) => {
  mock.clock(on, { now: 0 })
  const call = $.tool.call as unknown as (args: { tool: string; [key: string]: unknown }) => Promise<unknown>
  const panes: string[] = []
  on('ui.open', (_, e) => (panes.push(`open:${e.id}`), { value: { isPlaced: true } }))
  on('ui.close', (_, e) => (panes.push(`close:${e.id}`), { value: undefined }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>usage band</Text>
  })

  await $.prompt.submit(PROMPT('build the login page'))
  await call({ tool: 'Read', file_path: 'C:/p/a.ts' })
  await call({ tool: 'Edit', file_path: 'C:/p/a.ts', old_string: 'a', new_string: 'b' })

  // While the roadmap is in its pane, the band shows only the neighbour.
  let band = await $.ui.mount({ plugin: 'roadmap', surface: 'desktop', ...BAND })
  expect(await band.find({ type: 'Text', text: 'Implementation' })).toBeUndefined()
  await band.unmount()

  const pane = await $.ui.mount({ plugin: 'roadmap', surface: 'desktop', ...PANE })
  await pane.press({ key: 'to-band' })
  await pane.unmount()
  expect(panes).toContain('close:roadmap')

  for (const surface of ['terminal', 'desktop'] as const) {
    const view = await $.ui.mount({ plugin: 'roadmap', surface, ...BAND })
    expect(await view.find({ type: 'Text', text: 'build the login page' })).toBeDefined()
    expect(await view.find({ type: 'Text', text: 'Context' })).toBeDefined()
    expect(await view.find({ type: 'Text', text: /^Implementation/ })).toBeDefined()
    expect(await view.find({ type: 'Text', text: 'usage band' })).toBeDefined()
    await view.unmount()
  }

  band = await $.ui.mount({ plugin: 'roadmap', surface: 'desktop', ...BAND })
  await band.press({ key: 'to-pane' })
  expect(await band.find({ type: 'Text', text: 'build the login page' })).toBeUndefined()
  await band.unmount()
  expect(panes.at(-1)).toBe('open:roadmap')

  const reply = await $.command.run({ command: 'roadmap', args: 'band', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(reply.text).toBe('The roadmap is now under the chat, above the prompt.')
})
