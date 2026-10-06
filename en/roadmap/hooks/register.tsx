import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

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
const GRAY = '#8b949e'
const TRACK = '#8b949e55'

const HISTORY_LIMIT = 8

/** Height of a text line on desktop, in pixels: icons line up with the text by it. */
const LINE_PX = 20

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

/** Move the roadmap: into the side pane or into a band under the chat. */
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

/** A value saved by an older version of the mod may lack newer fields. */
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

// Deploy means real deploy commands only, not the word "deploy" somewhere in the text.
const DEPLOY_RE =
  /\b(vercel|netlify|wrangler|flyctl|railway|serverless|heroku|kamal|dokku|surge)\b(?![.\w-])|\b(firebase|fly|cdk|sam|amplify|eb)\s+deploy\b|\bgcloud\s+(app|run|functions)\s+deploy\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?deploy\b|\bdocker\s+push\b|\bkubectl\s+apply\b|\bhelm\s+(upgrade|install)\b|\bgh\s+workflow\s+run\b|\bdeploy\.(sh|ps1)\b/i
const PUSH_RE = /\bgit\s+(push|commit)\b|\bgh\s+pr\s+create\b/i
const TEST_RE =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(go|cargo|dotnet|deno|bun|make)\s+test\b|\bplugin\s+test\b|\b(pytest|jest|vitest|mocha|phpunit|playwright|cypress)\b/i
const CHECK_RE =
  /\b(tsc|eslint|biome|ruff|mypy|flake8|pylint|clippy|phpcs|stylelint|typecheck|type-check|lint|validate)\b|\bprettier\s+--check\b|\bcargo\s+check\b|\bgo\s+vet\b|\bphp\s+-l\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\bgit\s+diff\b/i
// Commands that only read: if the whole script is made of them, it is context gathering.
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
 * it was run for (`pattern`), then its first words.
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

/** Which stage a tool call belongs to; null means it doesn't affect the map. */
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
      return { stage: found[0], last: describeCommand(command, found[1]) }
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

/** Step start: the stage becomes current, and the previously current one is done. */
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

/** Step end: checks, tests, push and deploy take their status from the command's result. */
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

/** End of turn: context and implementation are no longer running. */
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

const CONTINUE_RE =
  /^(go ahead|do it|sounds good|yes|yep|yeah|ok|okay|sure|go|continue|proceed|next|lgtm|right|agreed)([\s,.!]|$)/i

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

// ── Claude's own plan ────────────────────────────────────────────────────

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
    return '<1m'
  }

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
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

/** A GitHub Actions-style step icon, for desktop. */
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

  // A `size`-pixel circle in a frame one text line high, so it sits exactly at the line's center.
  const unitsHigh = (LINE_PX * 16) / size

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${LINE_PX}" ` +
    `viewBox="0 ${(16 - unitsHigh) / 2} 16 ${unitsHigh}">${body[mark]}</svg>`
  )
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
        ? `read ${files} ${plural(files, 'file', 'files')} · ${stage.count} ${plural(stage.count, 'action', 'actions')}`
        : `${stage.count} ${plural(stage.count, 'action', 'actions')} · ${stage.last}`,
      isDim: true,
    })
  }

  if (id === 'work') {
    if (stage.files.length > 0) {
      const names = detailed ? stage.files.join(', ') : stage.files.slice(-3).join(', ')
      const more = !detailed && stage.files.length > 3 ? ` +${stage.files.length - 3}` : ''
      lines.push({ text: `${stage.files.length} ${plural(stage.files.length, 'file', 'files')}: ${names}${more}`, isDim: true })
    } else if (stage.count > 0) {
      lines.push({ text: stage.last, isDim: true })
    }

    if (plan.length > 0 && !narrow) {
      const limit = detailed ? plan.length : 5
      const firstOpen = plan.findIndex(item => item.status !== 'completed')
      const start = Math.max(0, Math.min(firstOpen === -1 ? plan.length : firstOpen, plan.length - limit))
      if (start > 0) {
        lines.push({ text: `${start} more ${plural(start, 'step', 'steps')} done`, isDim: true, mark: 'done' })
      }
      for (const item of plan.slice(start, start + limit)) {
        lines.push({ text: item.title, mark: PLAN_MARK[item.status], isDim: item.status === 'completed' })
      }
      if (start + limit < plan.length) {
        lines.push({ text: `and ${plan.length - start - limit} more`, isDim: true })
      }
    }
  }

  if (RESULT_STAGES.includes(id)) {
    const runs = stage.count > 1 ? ` · ${stage.count} ${plural(stage.count, 'run', 'runs')}` : ''
    lines.push(
      stage.status === 'failed' ? { text: `${stage.last} — failed${runs}`, color: RED } : { text: `${stage.last}${runs}`, isDim: true },
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
      description: 'Open the task roadmap (`/roadmap reset` new task, `/roadmap band` under the chat, `/roadmap pane` back to the pane)',
    })
    // Every 30 s, so the current step's time keeps ticking.
    $.clock.every(30_000, () => $.ui.invalidate('ui.render'))
    await refreshProject($).catch(() => undefined)
    if ((await read($, placement)) === 'pane') {
      void $.ui.open({ id: PANE, title: TITLE })
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
    // Any request other than a slash command starts Claude's turn.
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
    const status = taskStatus(current, found, await read($, isWorking))
    const now = await $.clock.now()

    const columns = e.props.bodyColumns
    const narrow = columns < 36
    // Text width next to an icon. Texts are cut in advance: a long truncated line
    // on desktop still takes up height as if it wrapped.
    const room = Math.max(16, columns - 4)
    const stages = visibleStages(current, found)
    const lastStarted = stages.reduce((at, { id }, index) => (current.stages[id].status === 'pending' ? at : index), -1)
    const doneCount = stages.filter(({ id }) => current.stages[id].status === 'done').length
    const total = current.startedAt === undefined ? '' : formatDuration(now - current.startedAt)
    const barCells = Math.max(8, Math.min(24, columns - 12))
    const filledCells = Math.round((barCells * doneCount) / Math.max(1, stages.length))

    // Icon: on desktop an SVG one text line high, in the terminal a colored glyph.
    const icon = (mark: Mark, isSmall = false) =>
      Svg ? (
        <Svg source={iconSvg(mark, isSmall ? 12 : 16)} alt={MARKS[mark].alt} width={isSmall ? 12 : 16} height={LINE_PX} />
      ) : (
        <Text color={MARKS[mark].color} dimColor={!MARKS[mark].color} bold>
          {MARKS[mark].glyph}
        </Text>
      )

    return (
      <Box flexDirection="column">
        <Box key="head" flexDirection="column" marginBottom={1}>
          <Box key="head-row" flexDirection="row" justifyContent="space-between">
            <Text dimColor bold>
              TASK
            </Text>
            {status ? (
              <Box key="status" flexDirection="row" alignItems="center" columnGap={1}>
                {icon(status.mark, true)}
                <Text color={status.color}>{status.text}</Text>
                {total ? <Text dimColor>· {total}</Text> : null}
              </Box>
            ) : null}
          </Box>
          <Text bold={Boolean(current.task)} dimColor={!current.task} wrap="wrap">
            {current.task || 'Appears with your next request'}
          </Text>
          <Box key="progress" flexDirection="row" alignItems="center" columnGap={1}>
            {Svg ? (
              <Svg
                source={progressSvg(doneCount / Math.max(1, stages.length), 120)}
                alt={`${doneCount} of ${stages.length}`}
                width={120}
                height={6}
              />
            ) : (
              <Box key="bar" flexDirection="row">
                <Text color={GREEN}>{'━'.repeat(filledCells)}</Text>
                <Text dimColor>{'─'.repeat(barCells - filledCells)}</Text>
              </Box>
            )}
            <Text dimColor>
              {doneCount} of {stages.length}
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
            const heading = `${title}${isSkipped ? ' · skipped' : ''}`

            return (
              <Box
                key={id}
                flexDirection="row"
                columnGap={1}
                {...(Svg && (stage.status === 'active' || stage.status === 'failed')
                  ? { backgroundColor: stage.status === 'active' ? '#58a6ff1a' : '#f851491a', paddingX: 1 }
                  : {})}
              >
                {icon(mark)}
                <Box key={`${id}-body`} flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Box key={`${id}-head`} flexDirection="row" justifyContent="space-between" columnGap={1}>
                    <Text bold={stage.status === 'active'} dimColor={stage.status === 'pending'}>
                      {short(heading, room - time.length - 1)}
                    </Text>
                    {time ? (
                      <Text color={stage.status === 'active' ? BLUE : undefined} dimColor={stage.status !== 'active'}>
                        {time}
                      </Text>
                    ) : null}
                  </Box>
                  {lines.map(line =>
                    line.mark ? (
                      <Box flexDirection="row" columnGap={1}>
                        {icon(line.mark, true)}
                        <Text dimColor={line.isDim}>{short(line.text, room - 3)}</Text>
                      </Box>
                    ) : (
                      <Text
                        color={line.color ?? (stage.status === 'active' ? BLUE : undefined)}
                        dimColor={line.isDim && stage.status !== 'active'}
                      >
                        {short(line.text, room)}
                      </Text>
                    ),
                  )}
                </Box>
              </Box>
            )
          })}
        </Box>

        <Box key="actions" flexDirection="row" columnGap={1} marginTop={1}>
          <Button key="details" label={detailed ? 'Brief' : 'Details'} onPress={() => update($, isDetailed, value => !value)} />
          <Button key="reset" label="New task" onPress={() => startNewTask($, '')} />
          <Button key="to-band" label="⬇ Under chat" onPress={() => moveTo($, 'band')} />
        </Box>

        {past.length === 0 ? null : (
          <Box key="past" flexDirection="column" marginTop={1}>
            <Button
              key="toggle-past"
              plain
              dimColor
              label={`${showPast ? '▾' : '▸'} Earlier · ${past.length}`}
              onPress={() => update($, isHistoryOpen, value => !value)}
            />
            {showPast
              ? past.map((item, index) => (
                  <Box key={`past-${index}`} flexDirection="row" justifyContent="space-between" columnGap={1}>
                    <Box key={`past-${index}-name`} flexDirection="row" columnGap={1}>
                      {icon(item.isFailed ? 'failed' : item.done === item.total ? 'done' : 'skipped', true)}
                      <Text dimColor>{short(item.task, room - (narrow ? 3 : 10))}</Text>
                    </Box>
                    {narrow ? null : <Text dimColor>{formatDuration(item.durationMs)}</Text>}
                  </Box>
                ))
              : null}
          </Box>
        )}
      </Box>
    )
  })

  // The roadmap "under the chat": two lines above the prompt, the task and the stage chain.
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
    const room = Math.max(16, e.props.bodyColumns - 4)

    const icon = (mark: Mark) =>
      Svg ? (
        <Svg source={iconSvg(mark, 12)} alt={MARKS[mark].alt} width={12} height={LINE_PX} />
      ) : (
        <Text color={MARKS[mark].color} dimColor={!MARKS[mark].color}>
          {MARKS[mark].glyph}
        </Text>
      )

    const right = [status?.text, total].filter(Boolean).join(' · ')

    return (
      <Box flexDirection="column">
        <Box key="roadmap-band" flexDirection="column">
          <Box key="roadmap-band-top" flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Box key="roadmap-band-task" flexDirection="row" alignItems="center" columnGap={1}>
              {status ? icon(status.mark) : null}
              <Text bold>{short(current.task || 'Task', room - right.length - 12)}</Text>
            </Box>
            <Box key="roadmap-band-right" flexDirection="row" alignItems="center" columnGap={1}>
              {right ? <Text color={status?.color} dimColor={!status}>{right}</Text> : null}
              <Button key="to-pane" plain dimColor label="⤢ Pane" onPress={() => moveTo($, 'pane')} />
            </Box>
          </Box>
          <Box key="roadmap-band-steps" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
            {stages.map(({ id }, index) => {
              const stage = current.stages[id]
              const isSkipped = stage.status === 'pending' && index < lastStarted
              const mark: Mark = isSkipped ? 'skipped' : stage.status
              const time = stage.status === 'active' ? timeLabel(stage, now) : ''

              return (
                <Box key={`band-${id}`} flexDirection="row" alignItems="center" columnGap={1}>
                  {index > 0 ? <Text dimColor>›</Text> : null}
                  {icon(mark)}
                  <Text
                    bold={stage.status === 'active'}
                    color={stage.status === 'active' ? BLUE : stage.status === 'failed' ? RED : undefined}
                    dimColor={stage.status === 'pending' || isSkipped}
                  >
                    {SHORT_TITLES[id]}
                    {time ? ` ${time}` : ''}
                  </Text>
                </Box>
              )
            })}
          </Box>
        </Box>
        {others}
      </Box>
    )
  })
}
