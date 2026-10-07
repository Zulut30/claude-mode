import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

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
const PURPLE = '#bc8cff'
const GRAY = '#8b949e'

const HISTORY_LIMIT = 8

/** Высота строки текста на десктопе, в пикселях: по ней значки встают вровень с текстом. */
const LINE_PX = 20

/** Отступ строк карточки под текстом заголовка: значок и зазор. */
const INDENT = 2

/** Фон карточки секции на десктопе. */
const CARD = '#8b949e14'

/** Сколько шагов плана видно, пока план не развернули. */
const PLAN_LIMIT = 5

/** Сколько изменённых файлов видно в строке выполнения, пока не развернули. */
const FILES_LIMIT = 3

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
const isWorking = atom({ plugin: 'roadmap', key: 'isWorking' } as const, false)
const placement = atom({ plugin: 'roadmap', key: 'placement' } as const, 'pane' as 'pane' | 'band')

/** Цель сессии из мода «Дальше» (next-steps): только чтение; мода нет — значения нет. */
const NEXT_STEPS_GOAL = { plugin: 'next-steps', key: 'goal' } as const

/** Цель из «Дальше»; чтение во время отрисовки подписывает её: новая цель перерисует карту. */
const readGoal = async ($: EngineInterface) => (await $.state.get(NEXT_STEPS_GOAL).catch(() => ({ value: undefined }))).value

/** Короткие названия этапов для полосы под чатом. */
const SHORT_TITLES: Record<StageId, string> = {
  context: 'Контекст',
  work: 'Выполнение',
  check: 'Проверка',
  test: 'Тест',
  push: 'Пуш',
  deploy: 'Деплой',
}

/** Перенести карту: в боковую панель или полосой под чат. */
const moveTo = async ($: EngineInterface, where: 'pane' | 'band') => {
  await update($, placement, () => where)
  if (where === 'pane') {
    await $.ui.open({ id: PANE, title: TITLE })
  } else {
    await $.ui.close({ id: PANE })
  }
}

/** Статус задачи для шапки: работает, готово или есть ошибка. */
export const taskStatus = (current: Roadmap, found: Project, working: boolean) => {
  const stages = visibleStages(current, found)
  if (!current.task && !hasActivity(current)) {
    return null
  }
  if (working) {
    return { mark: 'active' as const, text: 'Claude работает', color: BLUE }
  }
  if (stages.some(({ id }) => current.stages[id].status === 'failed')) {
    return { mark: 'failed' as const, text: 'Есть ошибка', color: RED }
  }

  return { mark: 'done' as const, text: 'Готово · ждёт вас', color: GREEN }
}

/** Значение из прошлой версии мода могло не иметь новых полей. */
export const normalize = (value: Partial<Roadmap> | null | undefined): Roadmap => {
  const base = emptyMap()

  const task = value?.task && !isServiceText(value.task) ? value.task : ''

  return { ...base, ...value, task, stages: { ...base.stages, ...value?.stages }, plan: value?.plan ?? [] }
}

/** Служебные вставки (`<agent-message …>`, `<task-notification>`) — не запросы человека. */
export function isServiceText(text: string) {
  return /^\s*<[a-z][\w-]*[\s>]/i.test(text)
}

const edit = ($: EngineInterface, fn: (current: Roadmap) => Roadmap) => update($, map, current => fn(normalize(current)))

// ── Разбор вызовов инструментов ──────────────────────────────────────────

const CONTEXT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'ToolSearch', 'LSP'])
const WORK_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const CHECK_SKILLS = new Set(['verification-before-completion', 'code-review', 'requesting-code-review', 'security-review'])

// Деплой — только настоящие команды деплоя, а не слово «deploy» где-то в тексте.
const DEPLOY_RE =
  /\b(vercel|netlify|wrangler|flyctl|railway|serverless|heroku|kamal|dokku|surge)\b(?![.\w-])|\b(firebase|fly|cdk|sam|amplify|eb)\s+deploy\b|\bgcloud\s+(app|run|functions)\s+deploy\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?deploy\b|\bdocker\s+push\b|\bkubectl\s+apply\b|\bhelm\s+(upgrade|install)\b|\bgh\s+workflow\s+run\b|\bdeploy\.(sh|ps1)\b/i
const PUSH_RE = /\bgit\s+(push|commit)\b|\bgh\s+pr\s+create\b/i
const TEST_RE =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(go|cargo|dotnet|deno|bun|make)\s+test\b|\bplugin\s+test\b|\b(pytest|jest|vitest|mocha|phpunit|playwright|cypress)\b/i
const CHECK_RE =
  /\b(tsc|eslint|biome|ruff|mypy|flake8|pylint|clippy|phpcs|stylelint|typecheck|type-check|lint|validate)\b|\bprettier\s+--check\b|\bcargo\s+check\b|\bgo\s+vet\b|\bphp\s+-l\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\bgit\s+diff\b/i
// Команды, которые только читают: если весь скрипт из них, это подготовка контекста.
const READ_RE =
  /^(ls|dir|cat|head|tail|less|more|find|grep|rg|pwd|wc|tree|stat|file|which|where|type|echo|printf|sort|uniq|cut|jq|sleep|true|Get-ChildItem|Get-Content|Get-Item|Select-String|Test-Path|Resolve-Path|sed\s+-n|git\s+(status|log|show|diff|branch|remote|ls-files|rev-parse|blame|config\s+--get)|gh\s+(repo\s+view|pr\s+(list|view|status|checks|diff)|issue\s+(list|view)|run\s+(list|view)|api|auth\s+status|search))\b/i
const SKIP_SEGMENT_RE = /^(cd|export|set|do|done|then|fi|for|if|else|while)\b/

/** Строки в кавычках пустеют: «deploy» в сообщении коммита — не деплой. */
export const unquoted = (command: string) => command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')

/** Скрипт без тел heredoc (`<<EOF … EOF`): текст коммита и файлов — не команды. */
export const withoutHeredocs = (command: string) =>
  command.replace(/<<-?\s*['"]?(\w+)['"]?([^\n]*)\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g, '$2')

/** Команды скрипта по отдельности, без присваиваний переменных и `cd`. */
const commandSegments = (command: string) =>
  command
    .split(/\r?\n|&&|\|\||;|\|/)
    .map(segment => segment.trim().replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s*)+/, '').trim())
    .filter(segment => segment && !SKIP_SEGMENT_RE.test(segment))

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
  const segments = commandSegments(withoutHeredocs(command)).filter(segment => !/^echo\b/.test(segment))
  const segment =
    (pattern && (segments.find(one => pattern.test(unquoted(one))) ?? segments.find(one => pattern.test(one)))) ??
    segments[0] ??
    ''

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
    const script = withoutHeredocs(command)
    const bare = unquoted(script)
    const rules: [StageId, RegExp][] = [
      ['deploy', DEPLOY_RE],
      ['push', PUSH_RE],
      ['test', TEST_RE],
      ['check', CHECK_RE],
    ]
    // Деплой и пуш — только по самим командам; тест и проверку можно узнать и по файлу в кавычках.
    const found = rules.find(([, re]) => re.test(bare)) ?? rules.slice(2).find(([, re]) => re.test(script))
    if (found) {
      // В «git add && git commit && git push» подписью берём сам пуш, иначе этап считался бы «только коммитом».
      const pattern = found[0] === 'push' && /\bgit\s+push\b/i.test(bare) ? /\bgit\s+push\b/i : found[1]

      return { stage: found[0], last: describeCommand(command, pattern) }
    }

    const segments = commandSegments(bare)
    const isReadOnly = segments.length > 0 && segments.every(segment => READ_RE.test(segment))

    return { stage: isReadOnly ? 'context' : 'work', last: describeCommand(command) }
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

// Запросы человека: из поля ввода, с телефона, из десктопа. Сообщения агентов (`peer`) и уведомления — нет.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

export const isPersonPrompt = (origin: string, text: string) =>
  PERSON_ORIGINS.has(origin) && text.trim() !== '' && !text.trim().startsWith('/') && !isServiceText(text)

/** Название задачи: первая содержательная строка запроса, до ~90 символов по границе слова. */
export const taskTitle = (text: string) => {
  const line = text.split(/\r?\n/).map(one => one.trim()).find(Boolean) ?? ''
  if (line.length <= 90) {
    return line
  }

  const cut = line.slice(0, 90)
  const space = cut.lastIndexOf(' ')

  return `${(space > 50 ? cut.slice(0, space) : cut).replace(/[\s,.;:—-]+$/, '')}…`
}

/** Короткое «да / давай / продолжай» продолжает текущую задачу, всё остальное — новая. */
export const isContinuation = (text: string) => {
  const line = text.trim()

  return line.length <= 60 && CONTINUE_RE.test(line)
}

const hasActivity = (current: Roadmap) => STAGES.some(({ id }) => current.stages[id].status !== 'pending') || current.plan.length > 0

/** Название задачи в шапке и полосе: цель сессии из «Дальше», если она есть, иначе — по запросу. */
export const headTitle = (current: Roadmap, goal: unknown) => {
  const text = typeof goal === 'string' ? goal.trim() : ''

  return text && (current.task || hasActivity(current)) ? text : current.task
}

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

/** Линия ленты этапов: `passed` — работа уже прошла этот отрезок, `ahead` — ещё впереди. */
type Rail = 'passed' | 'ahead'

const railPath = (from: number, to: number, rail: Rail) =>
  `<path d="M8 ${from}V${to}" stroke="${rail === 'passed' ? GREEN : GRAY}" ` +
  `stroke-opacity="${rail === 'passed' ? '.6' : '.35'}" stroke-width="1.5"/>`

/**
 * Значок шага в духе GitHub Actions, для десктопа: кружок `size` пикселей по
 * центру строки. `rails` — линия ленты над и под кружком, до краёв строки:
 * у соседних строк она смыкается в одну вертикаль.
 */
const iconSvg = (mark: Mark, size: number, rails: { top?: Rail; bottom?: Rail } = {}) => {
  const body: Record<Mark, string> = {
    done:
      `<circle cx="8" cy="8" r="6.5" fill="${GREEN}"/>` +
      `<path d="M5.2 8.2l1.9 1.9 3.8-4" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
    active: `<circle cx="8" cy="8" r="5.6" fill="none" stroke="${BLUE}" stroke-width="1.8"/><circle cx="8" cy="8" r="2.6" fill="${BLUE}"/>`,
    failed:
      `<circle cx="8" cy="8" r="6.5" fill="${RED}"/>` +
      `<path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`,
    pending: `<circle cx="8" cy="8" r="5.7" fill="none" stroke="${GRAY}" stroke-opacity=".7" stroke-width="1.6"/>`,
    skipped:
      `<circle cx="8" cy="8" r="5.7" fill="none" stroke="${GRAY}" stroke-opacity=".5" stroke-width="1.6"/>` +
      `<path d="M5.5 8h5" stroke="${GRAY}" stroke-opacity=".7" stroke-width="1.6" stroke-linecap="round"/>`,
  }

  // Рамка высотой в строку текста, в единицах значка (16 единиц = `size` пикселей).
  const unitsHigh = (LINE_PX * 16) / size
  const top = (16 - unitsHigh) / 2
  // Кружок — от 1.5 до 14.5; линия не доходит до него на единицу.
  const lines = (rails.top ? railPath(top, 0.5, rails.top) : '') + (rails.bottom ? railPath(15.5, top + unitsHigh, rails.bottom) : '')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${LINE_PX}" ` +
    `viewBox="0 ${top} 16 ${unitsHigh}">${lines}${body[mark]}</svg>`
  )
}

/** Отрезок ленты под строкой пояснения этапа; без `rail` — пустое место той же ширины. */
const railSvg = (rail?: Rail) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="${LINE_PX}" viewBox="0 -2 16 ${LINE_PX}">` +
  (rail ? railPath(-2, 18, rail) : '') +
  `</svg>`

/** Как выглядит заголовок секции: название, цвет, значок в терминале (`glyph`) и на десктопе (`icon`, сетка 16×16, C — цвет). */
type Look = { title: string; color: string; glyph: string; icon: string }

const LOOKS: Record<'stages' | 'plan' | 'past', Look> = {
  stages: {
    title: 'ЭТАПЫ',
    color: BLUE,
    glyph: '◉',
    icon:
      '<path d="M8 4.5V11.5" stroke="C" stroke-width="1.4" stroke-opacity=".6"/>' +
      '<circle cx="8" cy="3" r="2.1" fill="C"/><circle cx="8" cy="8" r="2.1" fill="C"/>' +
      '<circle cx="8" cy="13" r="1.9" fill="none" stroke="C" stroke-width="1.4"/>',
  },
  plan: {
    title: 'ПЛАН',
    color: PURPLE,
    glyph: '☰',
    icon:
      '<path d="M2.2 4.6l1.6 1.6 2.6-3" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="4.3" cy="11.5" r="1.9" fill="none" stroke="C" stroke-width="1.4"/>' +
      '<path d="M8.6 4.5H14M8.6 11.5H14" stroke="C" stroke-width="1.6" stroke-linecap="round"/>',
  },
  past: {
    title: 'РАНЕЕ',
    color: GRAY,
    glyph: '◷',
    icon:
      '<path d="M2 8a6 6 0 1 0 6-6 6.5 6.5 0 0 0-4.5 1.8L2 5.3" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M2 2v3.3h3.3" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M8 4.8V8l2.4 1.3" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  },
}

/** Значок заголовка секции, 12 пикселей в рамке высотой в строку текста. */
const sectionSvg = (look: Look) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="${LINE_PX}" viewBox="0 ${(16 - (LINE_PX * 16) / 12) / 2} 16 ${(LINE_PX * 16) / 12}">` +
  look.icon.replace(/"C"/g, `"${look.color}"`) +
  `</svg>`

/** Строка пояснения под этапом: приглушённая, если не задан цвет. */
type Line = { text: string; color?: string }

const stageLines = (id: StageId, stage: Stage, isSkipped: boolean, detailed: boolean, narrow: boolean): Line[] => {
  if (isSkipped || stage.status === 'pending') {
    return []
  }

  const lines: Line[] = []

  if (id === 'context') {
    const files = stage.files.length
    lines.push({
      text: files
        ? `прочитано ${files} ${plural(files, 'файл', 'файла', 'файлов')} · ${stage.count} ${plural(stage.count, 'действие', 'действия', 'действий')}`
        : `${stage.count} ${plural(stage.count, 'действие', 'действия', 'действий')} · ${stage.last}`,
    })
  }

  if (id === 'work') {
    const files = stage.files
    const count = `${files.length} ${plural(files.length, 'файл', 'файла', 'файлов')}`
    if (files.length > FILES_LIMIT && detailed) {
      // Подробно — каждый файл своей строкой.
      lines.push({ text: `${count}:` }, ...files.map(name => ({ text: name })))
    } else if (files.length > 0) {
      const more = files.length > FILES_LIMIT ? ` +${files.length - FILES_LIMIT}` : ''
      lines.push({ text: `${count}: ${files.slice(-FILES_LIMIT).join(', ')}${more}` })
    } else if (stage.count > 0) {
      lines.push({ text: stage.last })
    }
  }

  if (RESULT_STAGES.includes(id)) {
    const runs = stage.count > 1 ? ` · ${stage.count} ${plural(stage.count, 'запуск', 'запуска', 'запусков')}` : ''
    lines.push(stage.status === 'failed' ? { text: `${stage.last} — ошибка${runs}`, color: RED } : { text: `${stage.last}${runs}` })
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
    // Имя занято другим плагином — команды не будет, но остальной старт сессии должен пройти.
    await $.command.register({
      name: 'roadmap',
      description: 'Открыть дорожную карту (`/roadmap reset` — новая задача, `/roadmap band` — под чат, `/roadmap pane` — в панель)',
    }).catch(() => undefined)
    // Раз в 30 с — чтобы время текущего шага шло; пока Claude не работает, время стоит и перерисовка не нужна.
    $.clock.every(30_000, async () => {
      if (await read($, isWorking)) {
        $.ui.invalidate('ui.render')
      }
    })
    await refreshProject($).catch(() => undefined)
    if ((await read($, placement)) === 'pane') {
      void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    }

    return next(e)
  })

  on('command.run', { command: 'roadmap' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'band' || arg === 'pane') {
      await moveTo($, arg)

      return { text: arg === 'band' ? 'Дорожная карта теперь под чатом, над полем ввода.' : 'Дорожная карта снова в панели.' }
    }

    const isReset = arg === 'reset'
    if (isReset) {
      await startNewTask($, '')
    }

    if ((await read($, placement)) === 'pane') {
      await $.ui.open({ id: PANE, title: TITLE })
    }

    return { text: isReset ? 'Дорожная карта: новая задача.' : 'Дорожная карта открыта.' }
  })

  // Каждый новый запрос — новая задача; «да», «давай», «продолжай» — продолжение текущей.
  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()
    if (isPersonPrompt(e.origin.kind, text)) {
      const current = normalize(await read($, map))
      if (!current.task && !hasActivity(current)) {
        await update($, map, () => ({ ...current, task: taskTitle(text) }))
      } else if (!isContinuation(text)) {
        await startNewTask($, taskTitle(text))
      }
    }

    return next(e)
  })

  // «Claude работает» — от начала хода основного потока до его конца; ходы субагентов не в счёт.
  on('turn.start', async ($, e, next) => {
    if (!('agentId' in e && e.agentId)) {
      await update($, isWorking, () => true)
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
    // Конец хода субагента — не конец хода Claude: этапы и «работает» не трогаем.
    if (e.agentId) {
      return next(e)
    }

    await update($, isWorking, () => false)
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
    const past = (await read($, history)).filter(item => !isServiceText(item.task))
    const showPast = await read($, isHistoryOpen)
    const working = await read($, isWorking)
    const status = taskStatus(current, found, working)
    const title = headTitle(current, await readGoal($))
    const now = await $.clock.now()

    const stages = visibleStages(current, found)
    const lastStarted = stages.reduce((at, { id }, index) => (current.stages[id].status === 'pending' ? at : index), -1)
    const doneCount = stages.filter(({ id }) => current.stages[id].status === 'done').length
    const total = current.startedAt === undefined ? '' : formatDuration(now - current.startedAt)
    const plan = current.plan

    // Все тексты режем заранее под ширину: на десктопе перенос или обрезка
    // всё равно занимают лишнюю высоту.
    const columns = e.props.bodyColumns
    const narrow = columns < 36
    /** Ширина строки внутри карточки: на десктопе минус её поля. */
    const inner = columns - (Svg ? 2 : 0)
    /** Ячеек под значок строки с зазором: на десктопе значок шире символа. */
    const iconW = Svg ? 3 : 2

    // Значок: на десктопе SVG высотой в строку текста, в терминале — цветной символ.
    const icon = (mark: Mark, size: 12 | 16, rails?: { top?: Rail; bottom?: Rail }) =>
      Svg ? (
        <Svg source={iconSvg(mark, size, rails)} alt={MARKS[mark].alt} width={size} height={LINE_PX} />
      ) : (
        <Text color={MARKS[mark].color} dimColor={!MARKS[mark].color} bold>
          {MARKS[mark].glyph}
        </Text>
      )

    const mark = (look: Look) =>
      Svg ? <Svg source={sectionSvg(look)} alt="значок" width={12} height={LINE_PX} /> : <Text color={look.color}>{look.glyph}</Text>

    /** Тихая кнопка под строками карточки: «Ещё N», «Свернуть», «Показать». */
    const more = (key: string, label: string, onPress: () => unknown) => (
      <Box key={`${key}-row`} flexDirection="row" paddingLeft={INDENT}>
        <Button key={key} plain dimColor label={label} onPress={onPress} />
      </Box>
    )

    /** Секция-карточка: значок и название цветом секции, сводка справа, строки под названием. */
    const section = (id: string, look: Look, note: string, rows: RenderChildren[]) => (
      <Box
        key={`section-${id}`}
        flexDirection="column"
        marginTop={1}
        {...(Svg ? { backgroundColor: CARD, paddingX: 1, paddingY: 1 } : {})}
      >
        <Box key={`section-${id}-head`} flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
          <Box key={`section-${id}-title`} flexDirection="row" alignItems="center" columnGap={1}>
            {mark(look)}
            <Text bold color={look.color}>
              {look.title}
            </Text>
          </Box>
          <Text dimColor>{note}</Text>
        </Box>
        {rows}
      </Box>
    )

    const toggleDetails = () => update($, isDetailed, value => !value)

    // ── Шапка: задача, под ней статус; справа — тихие кнопки (на десктопе родная кнопка ≈ 5 ячеек).

    const headRoom = Math.max(8, columns - (Svg ? 11 : 3) - 1)
    const position = working && lastStarted >= 0 ? `этап ${lastStarted + 1} из ${stages.length}` : ''
    const statusLine = status ? [status.text, position, total].filter(Boolean).join(' · ') : ''

    const head = (
      <Box key="head" flexDirection="row" justifyContent="space-between" alignItems="flex-start" columnGap={1}>
        <Box key="head-text" flexDirection="column">
          {title ? (
            <Text bold>{short(title, headRoom)}</Text>
          ) : (
            <Text dimColor>{short('Появится с вашим следующим запросом', headRoom)}</Text>
          )}
          {statusLine ? <Text dimColor>{short(statusLine, headRoom)}</Text> : null}
        </Box>
        <Box key="toolbar" flexDirection="row" columnGap={1} flexShrink={0}>
          <Button key="reset" plain dimColor label="↺" onPress={() => startNewTask($, '')} />
          <Button key="to-band" plain dimColor label="⤓" onPress={() => moveTo($, 'band')} />
        </Box>
      </Box>
    )

    // ── Этапы: лента сверху вниз, без зазоров — на десктопе линия значков смыкается.

    const workFiles = current.stages.work.files.length
    const isPlanLong = plan.length > PLAN_LIMIT
    const isFilesLong = !narrow && workFiles > FILES_LIMIT
    // На десктопе у строк этапа поле справа: время не прилипает к краю подсветки.
    const stageRoom = Math.max(8, inner - INDENT - (Svg ? 1 : 0) - iconW)

    const stageRows = stages.map(({ id, title }, index) => {
      const stage = current.stages[id]
      const isSkipped = stage.status === 'pending' && index < lastStarted
      const stageMark: Mark = isSkipped ? 'skipped' : stage.status
      const lines = stageLines(id, stage, isSkipped, detailed, narrow)
      const time = narrow ? '' : timeLabel(stage, now)
      const heading = `${title}${isSkipped ? ' · пропущено' : ''}`
      // Отрезок ленты пройден, если работа уже дошла до этапа под ним.
      const rails: { top?: Rail; bottom?: Rail } = {
        top: index > 0 ? (index <= lastStarted ? 'passed' : 'ahead') : undefined,
        bottom: index < stages.length - 1 ? (index < lastStarted ? 'passed' : 'ahead') : undefined,
      }
      const tint = stage.status === 'active' ? BLUE : stage.status === 'failed' ? RED : undefined

      return (
        <Box
          key={`stage-${id}`}
          flexDirection="column"
          paddingLeft={INDENT}
          {...(Svg ? { paddingRight: 1 } : {})}
          {...(Svg && tint ? { backgroundColor: `${tint}1a` } : {})}
        >
          <Box key={`stage-${id}-head`} flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
            <Box key={`stage-${id}-title`} flexDirection="row" alignItems="center" columnGap={1}>
              {icon(stageMark, 16, rails)}
              <Text bold={stage.status === 'active'} dimColor={stage.status === 'pending'}>
                {short(heading, stageRoom - (time ? time.length + 1 : 0))}
              </Text>
            </Box>
            {time ? (
              <Text color={stage.status === 'active' ? BLUE : undefined} dimColor={stage.status !== 'active'}>
                {time}
              </Text>
            ) : null}
          </Box>
          {lines.map((line, i) => (
            // Пояснение — под названием этапа; на десктопе слева продолжается линия ленты.
            <Box key={`stage-${id}-line-${i}`} flexDirection="row" alignItems="center" columnGap={1} paddingLeft={Svg ? 0 : 2}>
              {Svg ? <Svg source={railSvg(rails.bottom)} alt="" width={16} height={LINE_PX} /> : null}
              <Text color={line.color} dimColor={!line.color}>
                {short(line.text, stageRoom)}
              </Text>
            </Box>
          ))}
        </Box>
      )
    })

    // Кнопка «подробно» одна: у длинного плана, иначе — у длинного списка файлов.
    const stagesFooter =
      isFilesLong && !isPlanLong
        ? more(
            'details',
            detailed ? 'Свернуть' : `Ещё ${workFiles - FILES_LIMIT} ${plural(workFiles - FILES_LIMIT, 'файл', 'файла', 'файлов')}`,
            toggleDetails,
          )
        : null

    // ── План Claude: окно вокруг текущего шага, выполненное до него — одной строкой.

    const planDone = plan.filter(item => item.status === 'completed').length
    const firstOpen = plan.findIndex(item => item.status !== 'completed')
    const planStart =
      detailed || !isPlanLong ? 0 : Math.max(0, Math.min(firstOpen === -1 ? plan.length : firstOpen, plan.length - PLAN_LIMIT))
    const planShown = detailed || !isPlanLong ? plan : plan.slice(planStart, planStart + PLAN_LIMIT)
    const planRoom = Math.max(8, inner - INDENT - iconW)

    const planRow = (key: string, rowMark: Mark, text: string, isActive: boolean) => (
      <Box
        key={key}
        flexDirection="row"
        alignItems="center"
        columnGap={1}
        paddingLeft={INDENT}
        {...(Svg && isActive ? { backgroundColor: `${BLUE}1a` } : {})}
      >
        {icon(rowMark, 12)}
        <Text dimColor={rowMark === 'done'}>{short(text, planRoom)}</Text>
      </Box>
    )

    const planRows = [
      planStart > 0 ? planRow('plan-done', 'done', `${planStart} ${plural(planStart, 'шаг', 'шага', 'шагов')} выполнено`, false) : null,
      ...planShown.map((item, index) =>
        planRow(`plan-${planStart + index}`, PLAN_MARK[item.status], item.title, item.status === 'in_progress'),
      ),
      isPlanLong ? more('details', detailed ? 'Свернуть' : `Ещё ${plan.length - planShown.length}`, toggleDetails) : null,
    ]

    // ── Ранее: свёрнуто, пока не попросят.

    const pastRows = showPast
      ? past.map((item, index) => {
          const time = narrow ? '' : formatDuration(item.durationMs)

          return (
            <Box key={`past-${index}`} flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1} paddingLeft={INDENT}>
              <Box key={`past-${index}-name`} flexDirection="row" alignItems="center" columnGap={1}>
                {icon(item.isFailed ? 'failed' : item.done === item.total ? 'done' : 'skipped', 12)}
                <Text>{short(item.task, Math.max(8, inner - INDENT - iconW - (time ? time.length + 1 : 0)))}</Text>
              </Box>
              {time ? <Text dimColor>{time}</Text> : null}
            </Box>
          )
        })
      : []

    return (
      <Box flexDirection="column">
        {head}
        {section('stages', LOOKS.stages, `${doneCount}/${stages.length}`, [...stageRows, stagesFooter])}
        {plan.length > 0 ? section('plan', LOOKS.plan, `${planDone}/${plan.length}`, planRows) : null}
        {past.length > 0
          ? section('past', LOOKS.past, String(past.length), [
              ...pastRows,
              more('toggle-past', showPast ? 'Свернуть' : `Показать ${past.length}`, () => update($, isHistoryOpen, value => !value)),
            ])
          : null}
      </Box>
    )
  })

  // Карта «под чатом»: одна аккуратная строка — задача, ступени этапов через линию, время и ⤢.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const others = await next(e)
    if (e.props.hasSurvey || (await read($, placement)) !== 'band') {
      return others
    }

    const current = normalize(await read($, map))
    if (!current.task && !hasActivity(current)) {
      return others
    }

    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const found = await read($, project)
    const status = taskStatus(current, found, await read($, isWorking))
    const title = headTitle(current, await readGoal($))
    const now = await $.clock.now()
    const stages = visibleStages(current, found)
    const lastStarted = stages.reduce((at, { id }, index) => (current.stages[id].status === 'pending' ? at : index), -1)
    const total = current.startedAt === undefined ? '' : formatDuration(now - current.startedAt)

    const icon = (mark: Mark) =>
      Svg ? (
        <Svg source={iconSvg(mark, 12)} alt={MARKS[mark].alt} width={12} height={LINE_PX} />
      ) : (
        <Text color={MARKS[mark].color} dimColor={!MARKS[mark].color}>
          {MARKS[mark].glyph}
        </Text>
      )

    const steps = stages.map(({ id }, index) => {
      const stage = current.stages[id]
      const isSkipped = stage.status === 'pending' && index < lastStarted
      const mark: Mark = isSkipped ? 'skipped' : stage.status
      const time = stage.status === 'active' ? timeLabel(stage, now) : ''
      // Идущий этап и ошибка — с названием даже в сжатой цепочке.
      const isLoud = stage.status === 'active' || stage.status === 'failed'

      // Линия к этапу зелёная, если работа уже дошла до него — как лента в панели.
      return { id, mark, stage, isSkipped, isLoud, label: `${SHORT_TITLES[id]}${time ? ` ${time}` : ''}`, isPassed: index <= lastStarted }
    })

    // Всё — в одну строку без переноса: если цепочка этапов не влезает рядом с задачей,
    // у пройденных и будущих этапов остаются одни значки, а в совсем узкой полосе цепочки нет.
    const iconW = Svg ? 2 : 1
    const chainWidth = (isCompact: boolean) =>
      steps.reduce(
        (sum, step, index) =>
          sum + (index > 0 ? (isCompact ? 1 : 2) + 2 : 0) + iconW + (!isCompact || step.isLoud ? step.label.length + 1 : 0),
        0,
      )
    const rightW = (total ? total.length + 1 : 0) + (Svg ? 5 : 1)
    const free = e.props.bodyColumns - rightW - (status ? iconW + 1 : 0) - 2
    const chain = chainWidth(false) + 2 <= free - 16 ? 'full' : chainWidth(true) + 2 <= free - 16 ? 'compact' : 'none'
    const room = Math.max(8, free - (chain === 'none' ? 0 : chainWidth(chain === 'compact') + 2))

    return (
      <Box flexDirection="column">
        <Box key="roadmap-band" flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={2} marginBottom={1}>
          <Box key="roadmap-band-task" flexDirection="row" alignItems="center" columnGap={1}>
            {status ? icon(status.mark) : null}
            <Text bold>{short(title || 'Задача', room)}</Text>
          </Box>
          {chain === 'none' ? null : (
            <Box key="roadmap-band-steps" flexDirection="row" alignItems="center" columnGap={1}>
              {steps.map((step, index) => (
                <Box key={`band-${step.id}`} flexDirection="row" alignItems="center" columnGap={1}>
                  {index > 0 ? (
                    <Text color={step.isPassed ? GREEN : undefined} dimColor={!step.isPassed}>
                      {chain === 'compact' ? '─' : '──'}
                    </Text>
                  ) : null}
                  {icon(step.mark)}
                  {chain === 'full' || step.isLoud ? (
                    <Text
                      bold={step.stage.status === 'active'}
                      color={step.stage.status === 'active' ? BLUE : step.stage.status === 'failed' ? RED : undefined}
                      dimColor={step.stage.status === 'pending' || step.isSkipped}
                    >
                      {step.label}
                    </Text>
                  ) : null}
                </Box>
              ))}
            </Box>
          )}
          <Box key="roadmap-band-right" flexDirection="row" alignItems="center" columnGap={1}>
            {total ? <Text dimColor>{total}</Text> : null}
            <Button key="to-pane" plain dimColor label="⤢" onPress={() => moveTo($, 'pane')} />
          </Box>
        </Box>
        {others}
      </Box>
    )
  })
}
