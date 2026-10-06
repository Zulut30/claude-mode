import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { PastTask, PlanItem, Project, Roadmap, Stage, StageId, StageStatus } from '../types'

const PANE = 'roadmap'
const TITLE = 'Roadmap'

/** Stages top to bottom; `needs` is the project trait that shows a stage before it has run. */
export const STAGES: { id: StageId; title: string; needs?: keyof Project }[] = [
  { id: 'context', title: 'Context' },
  { id: 'work', title: 'Implementation' },
  { id: 'check', title: 'Checks', needs: 'hasChecks' },
  { id: 'test', title: 'Tests', needs: 'hasTests' },
  { id: 'push', title: 'Push', needs: 'isGit' },
  { id: 'deploy', title: 'Deploy', needs: 'hasDeploy' },
]

// Stages closed only by a command's result, not by the end of the turn.
const RESULT_STAGES: StageId[] = ['check', 'test', 'push', 'deploy']

const GREEN = '#3fb950'
const BLUE = '#58a6ff'
const RED = '#f85149'
const PURPLE = '#bc8cff'
const GRAY = '#8b949e'

const HISTORY_LIMIT = 8

/** Height of a text line on desktop, in pixels: icons line up with the text by it. */
const LINE_PX = 20

/** Indent of a card's rows under the header text: the icon and the gap. */
const INDENT = 2

/** Section card background on desktop. */
const CARD = '#8b949e14'

/** How many plan steps are visible until the plan is expanded. */
const PLAN_LIMIT = 5

/** How many changed files are visible in the implementation line until it is expanded. */
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

/** Short stage names for the band under the chat. */
const SHORT_TITLES: Record<StageId, string> = {
  context: 'Context',
  work: 'Implementation',
  check: 'Checks',
  test: 'Tests',
  push: 'Push',
  deploy: 'Deploy',
}

/** Move the roadmap: into the side pane or as a band under the chat. */
const moveTo = async ($: EngineInterface, where: 'pane' | 'band') => {
  await update($, placement, () => where)
  if (where === 'pane') {
    await $.ui.open({ id: PANE, title: TITLE })
  } else {
    await $.ui.close({ id: PANE })
  }
}

/** Task status for the header: working, done, or something failed. */
export const taskStatus = (current: Roadmap, found: Project, working: boolean) => {
  const stages = visibleStages(current, found)
  if (!current.task && !hasActivity(current)) {
    return null
  }
  if (working) {
    return { mark: 'active' as const, text: 'Claude is working', color: BLUE }
  }
  if (stages.some(({ id }) => current.stages[id].status === 'failed')) {
    return { mark: 'failed' as const, text: 'Something failed', color: RED }
  }

  return { mark: 'done' as const, text: 'Done · waiting for you', color: GREEN }
}

/** A value from an older version of the mod may lack the new fields. */
export const normalize = (value: Partial<Roadmap> | null | undefined): Roadmap => {
  const base = emptyMap()

  const task = value?.task && !isServiceText(value.task) ? value.task : ''

  return { ...base, ...value, task, stages: { ...base.stages, ...value?.stages }, plan: value?.plan ?? [] }
}

/** Service inserts (`<agent-message …>`, `<task-notification>`) are not a person's requests. */
export function isServiceText(text: string) {
  return /^\s*<[a-z][\w-]*[\s>]/i.test(text)
}

const edit = ($: EngineInterface, fn: (current: Roadmap) => Roadmap) => update($, map, current => fn(normalize(current)))

// ── Parsing tool calls ───────────────────────────────────────────────────

const CONTEXT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'ToolSearch', 'LSP'])
const WORK_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const CHECK_SKILLS = new Set(['verification-before-completion', 'code-review', 'requesting-code-review', 'security-review'])

// Deploy means only real deploy commands, not the word "deploy" somewhere in the text.
const DEPLOY_RE =
  /\b(vercel|netlify|wrangler|flyctl|railway|serverless|heroku|kamal|dokku|surge)\b(?![.\w-])|\b(firebase|fly|cdk|sam|amplify|eb)\s+deploy\b|\bgcloud\s+(app|run|functions)\s+deploy\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?deploy\b|\bdocker\s+push\b|\bkubectl\s+apply\b|\bhelm\s+(upgrade|install)\b|\bgh\s+workflow\s+run\b|\bdeploy\.(sh|ps1)\b/i
const PUSH_RE = /\bgit\s+(push|commit)\b|\bgh\s+pr\s+create\b/i
const TEST_RE =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(go|cargo|dotnet|deno|bun|make)\s+test\b|\bplugin\s+test\b|\b(pytest|jest|vitest|mocha|phpunit|playwright|cypress)\b/i
const CHECK_RE =
  /\b(tsc|eslint|biome|ruff|mypy|flake8|pylint|clippy|phpcs|stylelint|typecheck|type-check|lint|validate)\b|\bprettier\s+--check\b|\bcargo\s+check\b|\bgo\s+vet\b|\bphp\s+-l\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\bgit\s+diff\b/i
// Read-only commands: if the whole script consists of them, it is context gathering.
const READ_RE =
  /^(ls|dir|cat|head|tail|less|more|find|grep|rg|pwd|wc|tree|stat|file|which|where|type|echo|printf|sort|uniq|cut|jq|sleep|true|Get-ChildItem|Get-Content|Get-Item|Select-String|Test-Path|Resolve-Path|sed\s+-n|git\s+(status|log|show|diff|branch|remote|ls-files|rev-parse|blame|config\s+--get)|gh\s+(repo\s+view|pr\s+(list|view|status|checks|diff)|issue\s+(list|view)|run\s+(list|view)|api|auth\s+status|search))\b/i
const SKIP_SEGMENT_RE = /^(cd|export|set|do|done|then|fi|for|if|else|while)\b/

/** Quoted strings become empty: "deploy" in a commit message is not a deploy. */
export const unquoted = (command: string) => command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')

/** The script without heredoc bodies (`<<EOF … EOF`): commit and file text is not commands. */
export const withoutHeredocs = (command: string) =>
  command.replace(/<<-?\s*['"]?(\w+)['"]?([^\n]*)\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g, '$2')

/** The script's commands one by one, without variable assignments and `cd`. */
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
 * A command in brief, without paths or variables: take the line of the script
 * it was run for (`pattern`), and the first words of that line.
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

/** Which stage a tool call belongs to; null means it does not affect the roadmap. */
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
    // Deploy and push only by the commands themselves; tests and checks can also be told by a quoted file.
    const found = rules.find(([, re]) => re.test(bare)) ?? rules.slice(2).find(([, re]) => re.test(script))
    if (found) {
      // In "git add && git commit && git push" the label is the push itself, otherwise the stage would count as "commit only".
      const pattern = found[0] === 'push' && /\bgit\s+push\b/i.test(bare) ? /\bgit\s+push\b/i : found[1]

      return { stage: found[0], last: describeCommand(command, pattern) }
    }

    const segments = commandSegments(bare)
    const isReadOnly = segments.length > 0 && segments.every(segment => READ_RE.test(segment))

    return { stage: isReadOnly ? 'context' : 'work', last: describeCommand(command) }
  }

  if (WORK_TOOLS.has(tool)) {
    const file = basename(field(e, 'file_path') || field(e, 'notebook_path'))

    return { stage: 'work', last: `editing ${file}`, file }
  }

  if (tool === 'Skill') {
    const skill = field(e, 'skill')

    return { stage: CHECK_SKILLS.has(skill) ? 'check' : 'context', last: `skill ${skill}` }
  }

  if (CONTEXT_TOOLS.has(tool)) {
    if (tool === 'Read') {
      const file = basename(field(e, 'file_path'))

      return { stage: 'context', last: `reading ${file}`, file }
    }

    const what = field(e, 'pattern') || field(e, 'query') || field(e, 'description') || field(e, 'url')

    return { stage: 'context', last: short(`${tool} ${what}`, 48) }
  }

  if (tool.startsWith('mcp__') && /deploy/i.test(tool)) {
    return { stage: 'deploy', last: short(tool.split('__').pop() ?? tool, 48) }
  }

  return null
}

// ── Stage transitions ────────────────────────────────────────────────────

const isCommitPending = (stage: Stage) => stage.status === 'active' && stage.last.startsWith('committed')

/** Start of a step: its stage becomes current, the previous current one is done. */
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

/** End of a step: checks, tests, push and deploy take their status from the command's result. */
export const finishStep = (current: Roadmap, step: Step, isError: boolean, now: number): Roadmap => {
  if (!RESULT_STAGES.includes(step.stage)) {
    return current
  }

  const stage = current.stages[step.stage]
  const isCommitOnly = step.stage === 'push' && /\bgit\s+commit\b/i.test(step.last) && !/\bgit\s+push\b/i.test(step.last)
  const status: StageStatus = isError ? 'failed' : isCommitOnly ? 'active' : 'done'
  const last = isCommitOnly && !isError ? 'committed, not pushed yet' : step.last

  return {
    ...current,
    stages: { ...current.stages, [step.stage]: { ...stage, status, last, endedAt: status === 'active' ? undefined : now } },
  }
}

/** End of the turn: context and implementation are no longer "running". */
export const closeTurn = (current: Roadmap, now: number): Roadmap => {
  const stages = { ...current.stages }
  for (const id of ['context', 'work'] as const) {
    if (stages[id].status === 'active') {
      stages[id] = { ...stages[id], status: 'done', endedAt: now }
    }
  }

  return { ...current, stages }
}

// ── New task ─────────────────────────────────────────────────────────────

// English confirmations, plus the Russian ones from the Russian edition of the mod.
// A bare "go" counts only on its own ("go!"), not as the start of "go through the tests".
const CONTINUE_RE =
  /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|go on|go(?=[.!]*$)|let['’]?s go|do it|continue|carry on|keep going|proceed|next|agreed|sounds good|lgtm|confirmed|ship it|да|ага|угу|ок|окей|давай|продолжай|продолжи|дальше|го|верно|согласен|подтверждаю|поехали|запускай|можно)([\s,.!]|$)/i

// A person's requests: from the input box, the phone, the desktop app. Agent messages (`peer`) and notifications are not.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

export const isPersonPrompt = (origin: string, text: string) =>
  PERSON_ORIGINS.has(origin) && text.trim() !== '' && !text.trim().startsWith('/') && !isServiceText(text)

/** Task title: the first meaningful line of the request, up to ~90 characters at a word boundary. */
export const taskTitle = (text: string) => {
  const line = text.split(/\r?\n/).map(one => one.trim()).find(Boolean) ?? ''
  if (line.length <= 90) {
    return line
  }

  const cut = line.slice(0, 90)
  const space = cut.lastIndexOf(' ')

  return `${(space > 50 ? cut.slice(0, space) : cut).replace(/[\s,.;:—-]+$/, '')}…`
}

/** A short "yes / go ahead / continue" continues the current task; anything else starts a new one. */
export const isContinuation = (text: string) => {
  const line = text.trim()

  return line.length <= 60 && CONTINUE_RE.test(line)
}

const hasActivity = (current: Roadmap) => STAGES.some(({ id }) => current.stages[id].status !== 'pending') || current.plan.length > 0

/** Task summary for "Earlier". */
export const summarize = (current: Roadmap, found: Project, now: number): PastTask => {
  const stages = visibleStages(current, found)
  const ends = stages.map(({ id }) => current.stages[id].endedAt ?? 0)
  const endedAt = Math.max(...ends, 0) || now

  return {
    task: current.task || 'Untitled',
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

// ── The plan Claude keeps itself ─────────────────────────────────────────

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

// ── What the project has ─────────────────────────────────────────────────

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

// ── Rendering ────────────────────────────────────────────────────────────

export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

export const formatDuration = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) {
    return '<1 min'
  }

  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
}

/** Which stages to show: those that have run or that fit the project. */
export function visibleStages(current: Roadmap, found: Project) {
  return STAGES.filter(stage => !stage.needs || found[stage.needs] || current.stages[stage.id].status !== 'pending')
}

type Mark = 'done' | 'active' | 'failed' | 'pending' | 'skipped'

const MARKS: Record<Mark, { glyph: string; color?: string; alt: string }> = {
  done: { glyph: '✓', color: GREEN, alt: 'done' },
  active: { glyph: '●', color: BLUE, alt: 'running' },
  failed: { glyph: '✗', color: RED, alt: 'failed' },
  pending: { glyph: '○', alt: 'upcoming' },
  skipped: { glyph: '–', alt: 'skipped' },
}

const PLAN_MARK: Record<PlanItem['status'], Mark> = { completed: 'done', in_progress: 'active', pending: 'pending' }

/** A segment of the stage timeline: `passed` means work has already gone past it, `ahead` that it is still ahead. */
type Rail = 'passed' | 'ahead'

const railPath = (from: number, to: number, rail: Rail) =>
  `<path d="M8 ${from}V${to}" stroke="${rail === 'passed' ? GREEN : GRAY}" ` +
  `stroke-opacity="${rail === 'passed' ? '.6' : '.35'}" stroke-width="1.5"/>`

/**
 * A step icon in the spirit of GitHub Actions, for desktop: a circle of `size`
 * pixels centred in the line. `rails` is the timeline above and below the circle,
 * up to the line's edges: in neighbouring rows it joins into one vertical line.
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

  // A frame one text line high, in icon units (16 units = `size` pixels).
  const unitsHigh = (LINE_PX * 16) / size
  const top = (16 - unitsHigh) / 2
  // The circle spans 1.5 to 14.5; the line stops one unit short of it.
  const lines = (rails.top ? railPath(top, 0.5, rails.top) : '') + (rails.bottom ? railPath(15.5, top + unitsHigh, rails.bottom) : '')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${LINE_PX}" ` +
    `viewBox="0 ${top} 16 ${unitsHigh}">${lines}${body[mark]}</svg>`
  )
}

/** A timeline segment under a stage's detail line; without `rail`, blank space of the same width. */
const railSvg = (rail?: Rail) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="${LINE_PX}" viewBox="0 -2 16 ${LINE_PX}">` +
  (rail ? railPath(-2, 18, rail) : '') +
  `</svg>`

/** How a section header looks: title, color, terminal icon (`glyph`) and desktop icon (`icon`, 16×16 grid, C is the color). */
type Look = { title: string; color: string; glyph: string; icon: string }

const LOOKS: Record<'stages' | 'plan' | 'past', Look> = {
  stages: {
    title: 'STAGES',
    color: BLUE,
    glyph: '◉',
    icon:
      '<path d="M8 4.5V11.5" stroke="C" stroke-width="1.4" stroke-opacity=".6"/>' +
      '<circle cx="8" cy="3" r="2.1" fill="C"/><circle cx="8" cy="8" r="2.1" fill="C"/>' +
      '<circle cx="8" cy="13" r="1.9" fill="none" stroke="C" stroke-width="1.4"/>',
  },
  plan: {
    title: 'PLAN',
    color: PURPLE,
    glyph: '☰',
    icon:
      '<path d="M2.2 4.6l1.6 1.6 2.6-3" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="4.3" cy="11.5" r="1.9" fill="none" stroke="C" stroke-width="1.4"/>' +
      '<path d="M8.6 4.5H14M8.6 11.5H14" stroke="C" stroke-width="1.6" stroke-linecap="round"/>',
  },
  past: {
    title: 'EARLIER',
    color: GRAY,
    glyph: '◷',
    icon:
      '<path d="M2 8a6 6 0 1 0 6-6 6.5 6.5 0 0 0-4.5 1.8L2 5.3" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M2 2v3.3h3.3" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M8 4.8V8l2.4 1.3" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  },
}

/** A section header icon, 12 pixels in a frame one text line high. */
const sectionSvg = (look: Look) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="${LINE_PX}" viewBox="0 ${(16 - (LINE_PX * 16) / 12) / 2} 16 ${(LINE_PX * 16) / 12}">` +
  look.icon.replace(/"C"/g, `"${look.color}"`) +
  `</svg>`

/** A detail line under a stage: dimmed unless a color is set. */
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
        ? `read ${files} ${plural(files, 'file', 'files')} · ${stage.count} ${plural(stage.count, 'action', 'actions')}`
        : `${stage.count} ${plural(stage.count, 'action', 'actions')} · ${stage.last}`,
    })
  }

  if (id === 'work') {
    const files = stage.files
    const count = `${files.length} ${plural(files.length, 'file', 'files')}`
    if (files.length > FILES_LIMIT && detailed) {
      // Detailed: each file on its own line.
      lines.push({ text: `${count}:` }, ...files.map(name => ({ text: name })))
    } else if (files.length > 0) {
      const more = files.length > FILES_LIMIT ? ` +${files.length - FILES_LIMIT}` : ''
      lines.push({ text: `${count}: ${files.slice(-FILES_LIMIT).join(', ')}${more}` })
    } else if (stage.count > 0) {
      lines.push({ text: stage.last })
    }
  }

  if (RESULT_STAGES.includes(id)) {
    const runs = stage.count > 1 ? ` · ${stage.count} ${plural(stage.count, 'run', 'runs')}` : ''
    lines.push(stage.status === 'failed' ? { text: `${stage.last} — failed${runs}`, color: RED } : { text: `${stage.last}${runs}` })
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
    // The name is taken by another plugin: no command then, but the rest of session start must go on.
    await $.command.register({
      name: 'roadmap',
      description: 'Open the roadmap (`/roadmap reset` new task, `/roadmap band` under the chat, `/roadmap pane` back to the pane)',
    }).catch(() => undefined)
    // Every 30 s so the current step's time keeps ticking; while Claude is idle, time stands still and no redraw is needed.
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

      return { text: arg === 'band' ? 'The roadmap is now under the chat, above the prompt.' : 'The roadmap is back in its pane.' }
    }

    const isReset = arg === 'reset'
    if (isReset) {
      await startNewTask($, '')
    }

    if ((await read($, placement)) === 'pane') {
      await $.ui.open({ id: PANE, title: TITLE })
    }

    return { text: isReset ? 'Roadmap: new task.' : 'Roadmap opened.' }
  })

  // Every new prompt is a new task; "yes", "go ahead", "continue" continue the current one.
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
    // Any prompt except a slash command starts a Claude turn.
    if (text && !text.startsWith('/')) {
      await update($, isWorking, () => true)
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const isMain = !('agentId' in e && e.agentId)

    // Claude's plan: TodoWrite as a whole, TaskCreate/TaskUpdate one step at a time.
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
    const now = await $.clock.now()

    const stages = visibleStages(current, found)
    const lastStarted = stages.reduce((at, { id }, index) => (current.stages[id].status === 'pending' ? at : index), -1)
    const doneCount = stages.filter(({ id }) => current.stages[id].status === 'done').length
    const total = current.startedAt === undefined ? '' : formatDuration(now - current.startedAt)
    const plan = current.plan

    // All texts are cut to width up front: on desktop wrapping or clipping
    // takes extra height anyway.
    const columns = e.props.bodyColumns
    const narrow = columns < 36
    /** Row width inside the card: on desktop, minus its padding. */
    const inner = columns - (Svg ? 2 : 0)
    /** Cells for a row's icon with its gap: on desktop the icon is wider than a character. */
    const iconW = Svg ? 3 : 2

    // Icon: on desktop an SVG one text line high, in the terminal a colored glyph.
    const icon = (mark: Mark, size: 12 | 16, rails?: { top?: Rail; bottom?: Rail }) =>
      Svg ? (
        <Svg source={iconSvg(mark, size, rails)} alt={MARKS[mark].alt} width={size} height={LINE_PX} />
      ) : (
        <Text color={MARKS[mark].color} dimColor={!MARKS[mark].color} bold>
          {MARKS[mark].glyph}
        </Text>
      )

    const mark = (look: Look) =>
      Svg ? <Svg source={sectionSvg(look)} alt="icon" width={12} height={LINE_PX} /> : <Text color={look.color}>{look.glyph}</Text>

    /** A quiet button under a card's rows: "N more", "Collapse", "Show N". */
    const more = (key: string, label: string, onPress: () => unknown) => (
      <Box key={`${key}-row`} flexDirection="row" paddingLeft={INDENT}>
        <Button key={key} plain dimColor label={label} onPress={onPress} />
      </Box>
    )

    /** A section card: icon and title in the section color, summary on the right, rows under the title. */
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

    // ── Header: the task with the status under it; quiet buttons on the right (on desktop a native button is ≈ 5 cells).

    const headRoom = Math.max(8, columns - (Svg ? 11 : 3) - 1)
    const position = working && lastStarted >= 0 ? `stage ${lastStarted + 1} of ${stages.length}` : ''
    const statusLine = status ? [status.text, position, total].filter(Boolean).join(' · ') : ''

    const head = (
      <Box key="head" flexDirection="row" justifyContent="space-between" alignItems="flex-start" columnGap={1}>
        <Box key="head-text" flexDirection="column">
          {current.task ? (
            <Text bold>{short(current.task, headRoom)}</Text>
          ) : (
            <Text dimColor>{short('Appears with your next prompt', headRoom)}</Text>
          )}
          {statusLine ? <Text dimColor>{short(statusLine, headRoom)}</Text> : null}
        </Box>
        <Box key="toolbar" flexDirection="row" columnGap={1} flexShrink={0}>
          <Button key="reset" plain dimColor label="↺" onPress={() => startNewTask($, '')} />
          <Button key="to-band" plain dimColor label="⤓" onPress={() => moveTo($, 'band')} />
        </Box>
      </Box>
    )

    // ── Stages: a top-to-bottom timeline with no gaps, so on desktop the icons' line joins up.

    const workFiles = current.stages.work.files.length
    const isPlanLong = plan.length > PLAN_LIMIT
    const isFilesLong = !narrow && workFiles > FILES_LIMIT
    // On desktop stage rows have right padding, so the time does not stick to the highlight's edge.
    const stageRoom = Math.max(8, inner - INDENT - (Svg ? 1 : 0) - iconW)

    const stageRows = stages.map(({ id, title }, index) => {
      const stage = current.stages[id]
      const isSkipped = stage.status === 'pending' && index < lastStarted
      const stageMark: Mark = isSkipped ? 'skipped' : stage.status
      const lines = stageLines(id, stage, isSkipped, detailed, narrow)
      const time = narrow ? '' : timeLabel(stage, now)
      const heading = `${title}${isSkipped ? ' · skipped' : ''}`
      // A timeline segment is passed if the work has already reached the stage below it.
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
            // The detail line sits under the stage title; on desktop the timeline continues on the left.
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

    // Only one "details" button: on a long plan, otherwise on a long file list.
    const stagesFooter =
      isFilesLong && !isPlanLong
        ? more(
            'details',
            detailed ? 'Collapse' : `${workFiles - FILES_LIMIT} more ${plural(workFiles - FILES_LIMIT, 'file', 'files')}`,
            toggleDetails,
          )
        : null

    // ── Claude's plan: a window around the current step; what is done before it fits in one line.

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
      planStart > 0 ? planRow('plan-done', 'done', `${planStart} ${plural(planStart, 'step', 'steps')} done`, false) : null,
      ...planShown.map((item, index) =>
        planRow(`plan-${planStart + index}`, PLAN_MARK[item.status], item.title, item.status === 'in_progress'),
      ),
      isPlanLong ? more('details', detailed ? 'Collapse' : `${plan.length - planShown.length} more`, toggleDetails) : null,
    ]

    // ── Earlier: collapsed until asked for.

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
              more('toggle-past', showPast ? 'Collapse' : `Show ${past.length}`, () => update($, isHistoryOpen, value => !value)),
            ])
          : null}
      </Box>
    )
  })

  // The roadmap "under the chat": one tidy row — the task, the stage steps joined by a line, the time and ⤢.
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
      // The running stage and a failure keep their name even in the compact chain.
      const isLoud = stage.status === 'active' || stage.status === 'failed'

      // The line to a stage is green if work has reached it, like the timeline in the pane.
      return { id, mark, stage, isSkipped, isLoud, label: `${SHORT_TITLES[id]}${time ? ` ${time}` : ''}`, isPassed: index <= lastStarted }
    })

    // Everything in one row without wrapping: if the stage chain does not fit next to the task,
    // passed and upcoming stages keep only their icons, and a very narrow band has no chain at all.
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
            <Text bold>{short(current.task || 'Task', room)}</Text>
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
