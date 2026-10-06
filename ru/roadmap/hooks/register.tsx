import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PastTask, PlanItem, Project, Roadmap, Stage, StageId, StageStatus } from '../types'

const PANE = 'roadmap'
const TITLE = 'Дорожная карта'

/** Стадии сверху вниз; `needs` — при чём стадия показывается, пока её не было. */
export const STAGES: { id: StageId; title: string; needs?: keyof Project }[] = [
  { id: 'context', title: 'Подготовка контекста' },
  { id: 'work', title: 'Выполнение задачи' },
  { id: 'check', title: 'Проверка', needs: 'hasChecks' },
  { id: 'test', title: 'Тест', needs: 'hasTests' },
  { id: 'push', title: 'Пуш', needs: 'isGit' },
  { id: 'deploy', title: 'Деплой', needs: 'hasDeploy' },
]

// Стадии, которые закрываются только результатом команды, а не концом хода.
const RESULT_STAGES: StageId[] = ['check', 'test', 'push', 'deploy']

const GREEN = '#3fb950'
const BLUE = '#58a6ff'
const RED = '#f85149'
const GRAY = '#8b949e'
const TRACK = '#8b949e55'

const HISTORY_LIMIT = 8

const emptyStage = (): Stage => ({ status: 'pending', count: 0, last: '', files: [] })

export const emptyMap = (): Roadmap => ({
  task: '',
  stages: {
    context: emptyStage(),
    work: emptyStage(),
    check: emptyStage(),
    test: emptyStage(),
    push: emptyStage(),
    deploy: emptyStage(),
  },
  plan: [],
})

const NO_PROJECT: Project = { isGit: false, hasChecks: false, hasTests: false, hasDeploy: false }

const map = atom({ plugin: 'roadmap', key: 'map' } as const, emptyMap())
const project = atom({ plugin: 'roadmap', key: 'project' } as const, NO_PROJECT)
const isDetailed = atom({ plugin: 'roadmap', key: 'isDetailed' } as const, false)
const history = atom({ plugin: 'roadmap', key: 'history' } as const, [] as PastTask[])
const isHistoryOpen = atom({ plugin: 'roadmap', key: 'isHistoryOpen' } as const, false)

/** Значение из прошлой версии мода могло не иметь новых полей. */
export const normalize = (value: Partial<Roadmap> | null | undefined): Roadmap => {
  const base = emptyMap()

  return { ...base, ...value, stages: { ...base.stages, ...value?.stages }, plan: value?.plan ?? [] }
}

const edit = ($: EngineInterface, fn: (current: Roadmap) => Roadmap) => update($, map, current => fn(normalize(current)))

// ── Разбор вызовов инструментов ──────────────────────────────────────────

const CONTEXT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'ToolSearch', 'LSP'])
const WORK_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const CHECK_SKILLS = new Set(['verification-before-completion', 'code-review', 'requesting-code-review', 'security-review'])

const DEPLOY_RE =
  /\b(deploy|vercel|netlify|wrangler|railway\s+up|kubectl\s+apply|helm\s+(upgrade|install)|docker\s+push|gh\s+workflow\s+run)\b/i
const PUSH_RE = /\bgit\s+(push|commit)\b|\bgh\s+pr\s+create\b/i
const TEST_RE =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(go|cargo|dotnet|deno|bun|make)\s+test\b|\bplugin\s+test\b|\b(pytest|jest|vitest|mocha|phpunit|playwright|cypress)\b/i
const CHECK_RE =
  /\b(tsc|eslint|biome|ruff|mypy|flake8|pylint|clippy|phpcs|stylelint|typecheck|type-check|lint|validate)\b|\bprettier\s+--check\b|\bcargo\s+check\b|\bgo\s+vet\b|\bphp\s+-l\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\bgit\s+diff\b/i
const READ_RE = /^\s*(ls|dir|cat|head|tail|less|find|grep|rg|pwd|wc|tree|Get-ChildItem|Get-Content|git\s+(status|log|show|branch|remote))\b/i

const field = (e: object, name: string) => {
  const value = (e as Record<string, unknown>)[name]

  return typeof value === 'string' ? value : ''
}

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

const short = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Команда коротко, без путей и переменных: из скрипта берётся строка, ради
 * которой он запущен (`pattern`), и из неё — первые слова.
 * `S="C:/…"; claude plugin test "$M"` → `claude plugin test`.
 */
export const describeCommand = (command: string, pattern?: RegExp) => {
  const segments = command
    .split(/\r?\n|&&|\|\||;|\|/)
    .map(segment => segment.trim())
    .filter(segment => segment && !/^(cd|export|set|echo|do|done|then|fi|for|if)\b/.test(segment))
    .map(segment => segment.replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s*)+/, '').trim())
    .filter(Boolean)
  const segment = (pattern && segments.find(one => pattern.test(one))) ?? segments[0] ?? ''

  const words: string[] = []
  for (const token of segment.split(/\s+/)) {
    const bare = token.replace(/^["']|["']$/g, '')
    if (words.length >= 4 || /^\d?>/.test(bare)) {
      break
    }
    if (/[\\/]/.test(bare)) {
      const name = basename(bare)
      if (!name.startsWith('$')) {
        words.push(name)
      }
      break
    }
    if (bare.startsWith('$') || bare === '' || /^["']/.test(token)) {
      break
    }
    words.push(bare)
  }

  return words.join(' ') || short(segment, 40)
}

export type Step = { stage: StageId; last: string; file?: string }

/** К какой стадии относится вызов инструмента; null — не влияет на карту. */
export const classify = (e: { tool: string; [key: string]: unknown }): Step | null => {
  const { tool } = e

  if (SHELL_TOOLS.has(tool)) {
    const command = field(e, 'command')
    const rules: [StageId, RegExp | undefined][] = [
      ['deploy', DEPLOY_RE],
      ['push', PUSH_RE],
      ['test', TEST_RE],
      ['check', CHECK_RE],
    ]
    const [stage, pattern] = rules.find(([, re]) => re?.test(command)) ?? [READ_RE.test(command) ? 'context' : 'work', undefined]

    return { stage, last: describeCommand(command, pattern) }
  }

  if (WORK_TOOLS.has(tool)) {
    const file = basename(field(e, 'file_path') || field(e, 'notebook_path'))

    return { stage: 'work', last: `правка ${file}`, file }
  }

  if (tool === 'Skill') {
    const skill = field(e, 'skill')

    return { stage: CHECK_SKILLS.has(skill) ? 'check' : 'context', last: `скилл ${skill}` }
  }

  if (CONTEXT_TOOLS.has(tool)) {
    if (tool === 'Read') {
      const file = basename(field(e, 'file_path'))

      return { stage: 'context', last: `чтение ${file}`, file }
    }

    const what = field(e, 'pattern') || field(e, 'query') || field(e, 'description') || field(e, 'url')

    return { stage: 'context', last: short(`${tool} ${what}`, 48) }
  }

  if (tool.startsWith('mcp__') && /deploy/i.test(tool)) {
    return { stage: 'deploy', last: short(tool.split('__').pop() ?? tool, 48) }
  }

  return null
}

// ── Переходы стадий ──────────────────────────────────────────────────────

const isCommitPending = (stage: Stage) => stage.status === 'active' && stage.last.startsWith('коммит')

/** Начало шага: стадия становится текущей, прошлая текущая — выполненной. */
export const startStep = (current: Roadmap, step: Step, now: number): Roadmap => {
  const stages = { ...current.stages }
  for (const { id } of STAGES) {
    if (id !== step.stage && stages[id].status === 'active' && !isCommitPending(stages[id])) {
      stages[id] = { ...stages[id], status: 'done', endedAt: now }
    }
  }

  const stage = stages[step.stage]
  const files = step.file && !stage.files.includes(step.file) ? [...stage.files, step.file].slice(-50) : stage.files
  stages[step.stage] = {
    ...stage,
    status: 'active',
    count: stage.count + 1,
    last: step.last,
    files,
    startedAt: stage.startedAt ?? now,
    endedAt: undefined,
  }

  return { ...current, startedAt: current.startedAt ?? now, stages }
}

/** Конец шага: у проверки, теста, пуша и деплоя статус берётся из результата команды. */
export const finishStep = (current: Roadmap, step: Step, isError: boolean, now: number): Roadmap => {
  if (!RESULT_STAGES.includes(step.stage)) {
    return current
  }

  const stage = current.stages[step.stage]
  const isCommitOnly = step.stage === 'push' && /\bgit\s+commit\b/i.test(step.last) && !/\bgit\s+push\b/i.test(step.last)
  const status: StageStatus = isError ? 'failed' : isCommitOnly ? 'active' : 'done'
  const last = isCommitOnly && !isError ? 'коммит создан, пуша ещё не было' : step.last

  return {
    ...current,
    stages: { ...current.stages, [step.stage]: { ...stage, status, last, endedAt: status === 'active' ? undefined : now } },
  }
}

/** Конец хода: подготовка и выполнение больше не «идут». */
export const closeTurn = (current: Roadmap, now: number): Roadmap => {
  const stages = { ...current.stages }
  for (const id of ['context', 'work'] as const) {
    if (stages[id].status === 'active') {
      stages[id] = { ...stages[id], status: 'done', endedAt: now }
    }
  }

  return { ...current, stages }
}

// ── Новая задача ─────────────────────────────────────────────────────────

const CONTINUE_RE =
  /^(да|ага|угу|ок|окей|ok|okay|yes|yep|давай|продолжай|продолжи|дальше|го|go|верно|согласен|подтверждаю|поехали|запускай|можно)([\s,.!]|$)/i

/** Короткое «да / давай / продолжай» продолжает текущую задачу, всё остальное — новая. */
export const isContinuation = (text: string) => {
  const line = text.trim()

  return line.length <= 60 && CONTINUE_RE.test(line)
}

const hasActivity = (current: Roadmap) => STAGES.some(({ id }) => current.stages[id].status !== 'pending') || current.plan.length > 0

/** Итог задачи для «Ранее». */
export const summarize = (current: Roadmap, found: Project, now: number): PastTask => {
  const stages = visibleStages(current, found)
  const ends = stages.map(({ id }) => current.stages[id].endedAt ?? 0)
  const endedAt = Math.max(...ends, 0) || now

  return {
    task: current.task || 'Без названия',
    done: stages.filter(({ id }) => current.stages[id].status === 'done').length,
    total: stages.length,
    isFailed: stages.some(({ id }) => current.stages[id].status === 'failed'),
    durationMs: current.startedAt === undefined ? 0 : Math.max(0, endedAt - current.startedAt),
  }
}

const startNewTask = async ($: EngineInterface, task: string) => {
  const current = normalize(await read($, map))
  if (hasActivity(current)) {
    const found = await read($, project)
    const now = await $.clock.now()
    const past = summarize(closeTurn(current, now), found, now)
    await update($, history, list => [past, ...list].slice(0, HISTORY_LIMIT))
  }

  await update($, map, () => ({ ...emptyMap(), task }))
}

// ── План, который ведёт сам Claude ───────────────────────────────────────

type Todo = { content: string; status: PlanItem['status'] }

export const applyTodos = (current: Roadmap, todos: readonly Todo[]): Roadmap => ({
  ...current,
  plan: todos.map((todo, index) => ({ id: `todo-${index}`, title: todo.content, status: todo.status })),
})

export const addTask = (current: Roadmap, id: string, title: string): Roadmap => ({
  ...current,
  plan: [...current.plan.filter(item => item.id !== id), { id, title, status: 'pending' }],
})

export const updateTask = (
  current: Roadmap,
  id: string,
  patch: { status?: PlanItem['status'] | 'deleted'; subject?: string },
): Roadmap => {
  const { status, subject } = patch
  if (status === 'deleted') {
    return { ...current, plan: current.plan.filter(item => item.id !== id) }
  }

  return {
    ...current,
    plan: current.plan.map(item =>
      item.id === id ? { ...item, title: subject ?? item.title, status: status ?? item.status } : item,
    ),
  }
}

// ── Что есть в проекте ──────────────────────────────────────────────────

const CHECK_FILES = ['tsconfig.json', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'composer.json', 'biome.json', 'eslint.config.js', 'eslint.config.mjs', '.eslintrc.json']
const TEST_FILES = ['pytest.ini', 'tests', 'test', '__tests__', 'spec', 'vitest.config.ts', 'jest.config.js', 'phpunit.xml', 'Cargo.toml', 'go.mod']
const DEPLOY_FILES = ['vercel.json', 'netlify.toml', 'wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'fly.toml', 'Dockerfile', 'firebase.json', 'railway.json', 'app.yaml', 'Procfile', '.github/workflows']

const detectProject = async ($: EngineInterface): Promise<Project> => {
  const cwd = (await $.session.cwd()).replace(/[\\/]+$/, '')
  const has = (name: string) => $.fs.exists(`${cwd}/${name}`).catch(() => false)
  const any = async (names: string[]) => (await Promise.all(names.map(has))).some(Boolean)

  const isGit = await $.process
    .run(['git', 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 5000 })
    .then(r => r.exitCode === 0 && r.stdout.trim() === 'true')
    .catch(() => false)

  let hasTestScript = false
  if (await has('package.json')) {
    const text = await $.fs.read(`${cwd}/package.json`).catch(() => '')
    try {
      const test = (JSON.parse(typeof text === 'string' ? text : '{}') as { scripts?: { test?: string } }).scripts?.test
      hasTestScript = Boolean(test) && !/no test specified/.test(test ?? '')
    } catch {
      hasTestScript = false
    }
  }

  return {
    isGit,
    hasChecks: await any(CHECK_FILES),
    hasTests: hasTestScript || (await any(TEST_FILES)),
    hasDeploy: await any(DEPLOY_FILES),
  }
}

const refreshProject = async ($: EngineInterface) => {
  const found = await detectProject($)
  await update($, project, () => found)
}

// ── Отрисовка ────────────────────────────────────────────────────────────

export const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) {
    return one
  }

  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many
}

export const formatDuration = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) {
    return '<1 мин'
  }

  return minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
}

/** Какие стадии показывать: были в работе или подходят проекту. */
export function visibleStages(current: Roadmap, found: Project) {
  return STAGES.filter(stage => !stage.needs || found[stage.needs] || current.stages[stage.id].status !== 'pending')
}

type Mark = 'done' | 'active' | 'failed' | 'pending' | 'skipped'

const MARKS: Record<Mark, { glyph: string; color?: string; alt: string }> = {
  done: { glyph: '✓', color: GREEN, alt: 'готово' },
  active: { glyph: '●', color: BLUE, alt: 'идёт' },
  failed: { glyph: '✗', color: RED, alt: 'ошибка' },
  pending: { glyph: '○', alt: 'впереди' },
  skipped: { glyph: '–', alt: 'пропущено' },
}

const PLAN_MARK: Record<PlanItem['status'], Mark> = { completed: 'done', in_progress: 'active', pending: 'pending' }

/** Значок шага в духе GitHub Actions, для десктопа. */
const iconSvg = (mark: Mark, size: number) => {
  const body: Record<Mark, string> = {
    done:
      `<circle cx="8" cy="8" r="8" fill="${GREEN}"/>` +
      `<path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
    active: `<circle cx="8" cy="8" r="6.6" fill="none" stroke="${BLUE}" stroke-width="2"/><circle cx="8" cy="8" r="3" fill="${BLUE}"/>`,
    failed:
      `<circle cx="8" cy="8" r="8" fill="${RED}"/>` +
      `<path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`,
    pending: `<circle cx="8" cy="8" r="6.6" fill="none" stroke="${GRAY}" stroke-opacity=".7" stroke-width="1.6"/>`,
    skipped:
      `<circle cx="8" cy="8" r="6.6" fill="none" stroke="${GRAY}" stroke-opacity=".5" stroke-width="1.6"/>` +
      `<path d="M5.5 8h5" stroke="${GRAY}" stroke-opacity=".7" stroke-width="1.6" stroke-linecap="round"/>`,
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16">${body[mark]}</svg>`
}

const progressSvg = (part: number, width: number) => {
  const fill = Math.round(width * Math.max(0, Math.min(1, part)))

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6">` +
    `<rect width="${width}" height="6" rx="3" fill="${TRACK}"/>` +
    (fill > 0 ? `<rect width="${Math.max(fill, 6)}" height="6" rx="3" fill="${GREEN}"/>` : '') +
    `</svg>`
  )
}

type Line = { text: string; color?: string; isDim?: boolean; mark?: Mark }

const stageLines = (id: StageId, stage: Stage, plan: PlanItem[], isSkipped: boolean, detailed: boolean, narrow: boolean): Line[] => {
  if (isSkipped || (stage.status === 'pending' && !(id === 'work' && plan.length > 0))) {
    return []
  }

  const lines: Line[] = []

  if (id === 'context') {
    const files = stage.files.length
    lines.push({
      text: files
        ? `прочитано ${files} ${plural(files, 'файл', 'файла', 'файлов')} · ${stage.count} ${plural(stage.count, 'действие', 'действия', 'действий')}`
        : `${stage.count} ${plural(stage.count, 'действие', 'действия', 'действий')} · ${stage.last}`,
      isDim: true,
    })
  }

  if (id === 'work') {
    if (stage.files.length > 0) {
      const names = detailed ? stage.files.join(', ') : stage.files.slice(-3).join(', ')
      const more = !detailed && stage.files.length > 3 ? ` +${stage.files.length - 3}` : ''
      lines.push({ text: `${stage.files.length} ${plural(stage.files.length, 'файл', 'файла', 'файлов')}: ${names}${more}`, isDim: true })
    } else if (stage.count > 0) {
      lines.push({ text: stage.last, isDim: true })
    }

    if (plan.length > 0 && !narrow) {
      const limit = detailed ? plan.length : 5
      const firstOpen = plan.findIndex(item => item.status !== 'completed')
      const start = Math.max(0, Math.min(firstOpen === -1 ? plan.length : firstOpen, plan.length - limit))
      if (start > 0) {
        lines.push({ text: `ещё ${start} ${plural(start, 'шаг', 'шага', 'шагов')} выполнено`, isDim: true, mark: 'done' })
      }
      for (const item of plan.slice(start, start + limit)) {
        lines.push({ text: item.title, mark: PLAN_MARK[item.status], isDim: item.status === 'completed' })
      }
      if (start + limit < plan.length) {
        lines.push({ text: `и ещё ${plan.length - start - limit}`, isDim: true })
      }
    }
  }

  if (RESULT_STAGES.includes(id)) {
    const runs = stage.count > 1 ? ` · ${stage.count} ${plural(stage.count, 'запуск', 'запуска', 'запусков')}` : ''
    lines.push(
      stage.status === 'failed' ? { text: `${stage.last} — ошибка${runs}`, color: RED } : { text: `${stage.last}${runs}`, isDim: true },
    )
  }

  return narrow ? lines.slice(0, 1) : lines
}

const timeLabel = (stage: Stage, now: number) => {
  if (stage.status === 'active' && stage.startedAt !== undefined) {
    return formatDuration(now - stage.startedAt)
  }

  if ((stage.status === 'done' || stage.status === 'failed') && stage.startedAt !== undefined && stage.endedAt !== undefined) {
    return formatDuration(stage.endedAt - stage.startedAt)
  }

  return ''
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'roadmap',
      description: 'Открыть дорожную карту задачи (`/roadmap reset` — начать заново)',
    })
    // Раз в 30 с — чтобы время текущего шага шло.
    $.clock.every(30_000, () => $.ui.invalidate('ui.render'))
    await refreshProject($).catch(() => undefined)
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'roadmap' }, async ($, e) => {
    const isReset = e.args.trim() === 'reset'
    if (isReset) {
      await startNewTask($, '')
    }

    await $.ui.open({ id: PANE, title: TITLE })

    return { text: isReset ? 'Дорожная карта: новая задача.' : 'Дорожная карта открыта.' }
  })

  // Каждый новый запрос — новая задача; «да», «давай», «продолжай» — продолжение текущей.
  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()
    const isPerson = e.origin.kind !== 'task-notification' && e.origin.kind !== 'scheduled-trigger'
    if (isPerson && text && !text.startsWith('/')) {
      const current = normalize(await read($, map))
      if (!current.task && !hasActivity(current)) {
        await update($, map, () => ({ ...current, task: short(text, 140) }))
      } else if (!isContinuation(text)) {
        await startNewTask($, short(text, 140))
      }
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const isMain = !('agentId' in e && e.agentId)

    // План Claude: TodoWrite целиком, TaskCreate/TaskUpdate по одному шагу.
    if (isMain && e.tool === 'TodoWrite') {
      const result = await next(e)
      if (!result.isError && result.deny === undefined) {
        await edit($, current => applyTodos(current, e.todos))
      }

      return result
    }

    if (isMain && e.tool === 'TaskCreate') {
      const result = await next(e)
      const id = (result.result as { task?: { id?: string } } | undefined)?.task?.id
      if (id) {
        await edit($, current => addTask(current, id, e.subject))
      }

      return result
    }

    if (isMain && e.tool === 'TaskUpdate') {
      const result = await next(e)
      if (!result.isError && result.deny === undefined) {
        await edit($, current => updateTask(current, e.taskId, { status: e.status, subject: e.subject }))
      }

      return result
    }

    const step = classify(e)
    if (!step) {
      return next(e)
    }

    const startedAt = await $.clock.now()
    await edit($, current => startStep(current, step, startedAt))
    const result = await next(e)
    const isError = result.deny !== undefined || result.isError === true
    const endedAt = await $.clock.now()
    await edit($, current => finishStep(current, step, isError, endedAt))

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    await edit($, current => closeTurn(current, now))
    await refreshProject($).catch(() => undefined)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined

    const current = normalize(await read($, map))
    const found = await read($, project)
    const detailed = await read($, isDetailed)
    const past = await read($, history)
    const showPast = await read($, isHistoryOpen)
    const now = await $.clock.now()

    const columns = e.props.bodyColumns
    const narrow = columns < 36
    const stages = visibleStages(current, found)
    const lastStarted = stages.reduce((at, { id }, index) => (current.stages[id].status === 'pending' ? at : index), -1)
    const doneCount = stages.filter(({ id }) => current.stages[id].status === 'done').length
    const total = current.startedAt === undefined ? '' : formatDuration(now - current.startedAt)
    const barCells = Math.max(8, Math.min(24, columns - 16))
    const filledCells = Math.round((barCells * doneCount) / Math.max(1, stages.length))

    // Значок: на десктопе SVG-кружок, в терминале — цветной символ. Ширина одна для всех строк.
    const icon = (mark: Mark, size = 16) =>
      Svg ? (
        <Svg source={iconSvg(mark, size)} alt={MARKS[mark].alt} width={size} height={size} />
      ) : (
        <Text color={MARKS[mark].color} dimColor={!MARKS[mark].color} bold>
          {MARKS[mark].glyph}
        </Text>
      )
    const indent = (size = 16) =>
      Svg ? (
        <Svg source={`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="1"></svg>`} alt="" width={size} height={1} />
      ) : (
        <Text> </Text>
      )

    return (
      <Box flexDirection="column">
        <Box key="head" flexDirection="column" marginBottom={1}>
          <Box key="head-row" flexDirection="row" justifyContent="space-between">
            <Text dimColor bold>
              ЗАДАЧА
            </Text>
            {total ? <Text dimColor>{total}</Text> : null}
          </Box>
          <Text bold={Boolean(current.task)} dimColor={!current.task} wrap="wrap">
            {current.task || 'Появится с вашим следующим запросом'}
          </Text>
          <Box key="progress" flexDirection="row" alignItems="center" columnGap={1}>
            {Svg ? (
              <Svg source={progressSvg(doneCount / Math.max(1, stages.length), 120)} alt={`${doneCount} из ${stages.length}`} width={120} height={6} />
            ) : (
              <Box key="bar" flexDirection="row">
                <Text color={GREEN}>{'━'.repeat(filledCells)}</Text>
                <Text dimColor>{'─'.repeat(barCells - filledCells)}</Text>
              </Box>
            )}
            <Text dimColor>
              {doneCount} из {stages.length}
            </Text>
          </Box>
        </Box>

        <Box key="steps" flexDirection="column" rowGap={1}>
          {stages.map(({ id, title }, index) => {
            const stage = current.stages[id]
            const isSkipped = stage.status === 'pending' && index < lastStarted
            const mark: Mark = isSkipped ? 'skipped' : stage.status
            const lines = stageLines(id, stage, current.plan, isSkipped, detailed, narrow)
            const time = narrow ? '' : timeLabel(stage, now)

            return (
              <Box key={id} flexDirection="column">
                <Box key={`${id}-title`} flexDirection="row" alignItems="center" columnGap={1}>
                  {icon(mark)}
                  <Box key={`${id}-name`} flexGrow={1} flexShrink={1}>
                    <Text bold={stage.status === 'active'} dimColor={stage.status === 'pending'} wrap="truncate-end">
                      {title}
                      {isSkipped ? ' · пропущено' : ''}
                    </Text>
                  </Box>
                  {time ? (
                    <Text color={stage.status === 'active' ? BLUE : undefined} dimColor={stage.status !== 'active'}>
                      {time}
                    </Text>
                  ) : null}
                </Box>
                {lines.map(line => (
                  <Box flexDirection="row" alignItems="center" columnGap={1}>
                    {indent()}
                    {line.mark ? icon(line.mark, 12) : null}
                    <Text color={line.color} dimColor={line.isDim} wrap="truncate-end">
                      {line.text}
                    </Text>
                  </Box>
                ))}
              </Box>
            )
          })}
        </Box>

        <Box key="actions" flexDirection="row" columnGap={1} marginTop={1}>
          <Button key="details" label={detailed ? 'Кратко' : 'Подробно'} onPress={() => update($, isDetailed, value => !value)} />
          <Button key="reset" label="Новая задача" onPress={() => startNewTask($, '')} />
        </Box>

        {past.length === 0 ? null : (
          <Box key="past" flexDirection="column" marginTop={1}>
            <Button
              key="toggle-past"
              plain
              dimColor
              label={`${showPast ? '▾' : '▸'} Ранее · ${past.length}`}
              onPress={() => update($, isHistoryOpen, value => !value)}
            />
            {showPast
              ? past.map((item, index) => (
                  <Box key={`past-${index}`} flexDirection="row" alignItems="center" columnGap={1}>
                    {icon(item.isFailed ? 'failed' : item.done === item.total ? 'done' : 'skipped', 12)}
                    <Box key={`past-${index}-name`} flexGrow={1} flexShrink={1}>
                      <Text dimColor wrap="truncate-end">
                        {item.task}
                      </Text>
                    </Box>
                    {narrow ? null : (
                      <Text dimColor>
                        {item.done}/{item.total} · {formatDuration(item.durationMs)}
                      </Text>
                    )}
                  </Box>
                ))
              : null}
          </Box>
        )}
      </Box>
    )
  })
}
