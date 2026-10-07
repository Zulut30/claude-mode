import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Branch, Changes, Checks, Commit, GitSnapshot, PullRequest, RemoteBranch, SectionId } from '../types'

const PANE = 'git-branches'
const TITLE = 'Ветки'

const GREEN = '#3fb950'
const AMBER = '#d29922'
const RED = '#f85149'

const snapshot = atom({ plugin: 'git-branches', key: 'snapshot' } as const, null)
const isLoading = atom({ plugin: 'git-branches', key: 'isLoading' } as const, false)
const expanded = atom({ plugin: 'git-branches', key: 'expanded' } as const, [] as SectionId[])

// ── Разбор вывода git и gh ───────────────────────────────────────────────

const lines = (text: string) => text.split(/\r?\n/).filter(line => line.trim() !== '')

export const parseTrack = (track: string) => ({
  ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
  behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
  isGone: track.includes('gone'),
})

/** `git for-each-ref refs/heads` с полями через табуляцию. */
export const parseBranches = (stdout: string, current: string): Branch[] =>
  lines(stdout).map(line => {
    const [name = '', upstream = '', track = '', hash = '', time = '0', author = '', ...subject] = line.split('\t')

    return { name, upstream, ...parseTrack(track), hash, time: Number(time), author, subject: subject.join('\t'), isCurrent: name === current }
  })

/** `git for-each-ref refs/remotes`: без HEAD и без веток, уже взятых локально. */
export const parseRemotes = (stdout: string, local: Branch[]): RemoteBranch[] => {
  const taken = new Set(local.flatMap(branch => [branch.upstream, `origin/${branch.name}`]))

  return lines(stdout)
    .map(line => {
      const [name = '', hash = '', time = '0', author = '', ...subject] = line.split('\t')

      return { name, hash, time: Number(time), author, subject: subject.join('\t') }
    })
    .filter(branch => branch.name.includes('/') && !branch.name.endsWith('/HEAD') && !taken.has(branch.name))
}

export const parseCommits = (stdout: string): Commit[] =>
  lines(stdout).map(line => {
    const [hash = '', time = '0', author = '', ...subject] = line.split('\t')

    return { hash, time: Number(time), author, subject: subject.join('\t') }
  })

/** `git status --porcelain=v1`. */
export const parseStatus = (stdout: string): Changes => {
  const changes: Changes = { staged: 0, unstaged: 0, untracked: 0 }
  for (const line of lines(stdout)) {
    if (line.startsWith('??')) {
      changes.untracked += 1
      continue
    }
    if (line[0] !== ' ') {
      changes.staged += 1
    }
    if (line[1] !== ' ') {
      changes.unstaged += 1
    }
  }

  return changes
}

/** owner/repo из адреса origin, если это GitHub. */
export const parseGithubSlug = (url: string) =>
  /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.slice(1, 3).join('/') ?? ''

type CheckItem = { status?: string; conclusion?: string; state?: string }

export const summarizeChecks = (items: readonly CheckItem[] | null | undefined): Checks => {
  if (!items || items.length === 0) {
    return 'none'
  }

  const bad = /^(FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED|STARTUP_FAILURE)$/
  if (items.some(item => bad.test(item.conclusion ?? '') || bad.test(item.state ?? ''))) {
    return 'failing'
  }

  const isPending = (item: CheckItem) =>
    item.state !== undefined ? /^(PENDING|EXPECTED)$/.test(item.state) : item.status !== undefined && item.status !== 'COMPLETED'

  return items.some(isPending) ? 'pending' : 'passing'
}

const REVIEWS: Record<string, string> = {
  APPROVED: 'одобрено',
  CHANGES_REQUESTED: 'нужны правки',
  REVIEW_REQUIRED: 'ждёт ревью',
}

type GhPr = {
  number: number
  title: string
  headRefName: string
  isDraft: boolean
  url: string
  reviewDecision?: string | null
  statusCheckRollup?: CheckItem[] | null
}

export const parsePrs = (stdout: string): PullRequest[] =>
  (JSON.parse(stdout || '[]') as GhPr[]).map(pr => ({
    number: pr.number,
    title: pr.title,
    branch: pr.headRefName,
    isDraft: pr.isDraft,
    url: pr.url,
    checks: summarizeChecks(pr.statusCheckRollup),
    review: REVIEWS[pr.reviewDecision ?? ''] ?? '',
  }))

export const relativeTime = (unixSeconds: number, now: number) => {
  const minutes = Math.max(0, Math.floor((now - unixSeconds * 1000) / 60_000))
  if (minutes < 1) {
    return 'только что'
  }
  if (minutes < 60) {
    return `${minutes} мин назад`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours} ч назад`
  }
  const days = Math.floor(hours / 24)
  if (days < 14) {
    return `${days} д назад`
  }
  if (days < 60) {
    return `${Math.floor(days / 7)} нед назад`
  }

  return days < 730 ? `${Math.floor(days / 30)} мес назад` : `${Math.floor(days / 365)} г назад`
}

export const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) {
    return one
  }

  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many
}

// ── Снимок репозитория ───────────────────────────────────────────────────

const BRANCH_FORMAT = '%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)%09%(objectname:short)%09%(committerdate:unix)%09%(authorname)%09%(subject)'
const REMOTE_FORMAT = '%(refname:short)%09%(objectname:short)%09%(committerdate:unix)%09%(authorname)%09%(subject)'

const emptySnapshot = (now: number): GitSnapshot => ({
  isRepo: false,
  root: '',
  current: '',
  slug: '',
  changes: { staged: 0, unstaged: 0, untracked: 0 },
  branches: [],
  remotes: [],
  commits: [],
  prs: [],
  prsNote: '',
  loadedAt: now,
})

/** `gh` ходит в сеть: после хода хватает локального git, список PR обновляем не чаще раза в 5 минут. */
const PR_TTL_MS = 5 * 60_000

/** Чтение статуса не берёт index.lock и не мешает git, запущенному рядом. */
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' }

/** Подпапка с проектом, когда сама папка сессии не git (сессия «без папки» с клоном внутри). */
let nestedRepo: string | undefined

let prCache: { at: number; slug: string; prs: PullRequest[]; note: string } | undefined

const findNestedRepo = async ($: EngineInterface) => {
  const entries = await $.fs.list().catch(() => [])
  for (const entry of entries) {
    if (entry.kind === 'dir' && !entry.name.startsWith('.') && (await $.fs.exists(`${entry.name}/.git`).catch(() => false))) {
      return entry.name
    }
  }

  return undefined
}

const loadSnapshot = async ($: EngineInterface, isForced: boolean): Promise<GitSnapshot> => {
  const now = await $.clock.now()
  const git = (args: string[]) =>
    $.process
      .run(['git', ...args], { timeoutMs: 15_000, env: GIT_ENV, ...(nestedRepo ? { cwd: nestedRepo } : {}) })
      .catch(() => ({ exitCode: 127, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }))

  let top = await git(['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) {
    // Папка сессии не проект — ищем клон в подпапках; найденная подпапка пропала — ищем заново в следующий раз.
    nestedRepo = nestedRepo === undefined ? await findNestedRepo($) : undefined
    top = nestedRepo === undefined ? top : await git(['rev-parse', '--show-toplevel'])
    if (top.exitCode !== 0) {
      nestedRepo = undefined

      return emptySnapshot(now)
    }
  }

  const [head, heads, remotes, status, log, origin] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['for-each-ref', '--sort=-committerdate', `--format=${BRANCH_FORMAT}`, 'refs/heads']),
    git(['for-each-ref', '--sort=-committerdate', '--count=40', `--format=${REMOTE_FORMAT}`, 'refs/remotes']),
    git(['status', '--porcelain=v1']),
    git(['log', '-n', '8', '--format=%h%x09%ct%x09%an%x09%s']),
    git(['remote', 'get-url', 'origin']),
  ])

  const current = head.stdout.trim()
  const branches = parseBranches(heads.stdout, current)
  const slug = origin.exitCode === 0 ? parseGithubSlug(origin.stdout) : ''

  const isPrsFresh = prCache !== undefined && prCache.slug === slug && now - prCache.at < PR_TTL_MS
  let prs: PullRequest[] = isPrsFresh ? (prCache?.prs ?? []) : []
  let prsNote = isPrsFresh ? (prCache?.note ?? '') : ''
  if (slug && (isForced || !isPrsFresh)) {
    try {
      const gh = await $.process.run(
        ['gh', 'pr', 'list', '--state', 'open', '--limit', '30', '--json', 'number,title,headRefName,isDraft,url,reviewDecision,statusCheckRollup'],
        { timeoutMs: 20_000, ...(nestedRepo ? { cwd: nestedRepo } : {}) },
      )
      if (gh.exitCode === 0) {
        prs = parsePrs(gh.stdout)
        prsNote = ''
      } else {
        prsNote = /auth|login/i.test(gh.stderr) ? 'войдите в gh: gh auth login' : 'gh не смог получить PR'
      }
    } catch {
      prsNote = 'установите GitHub CLI (gh), чтобы видеть PR'
    }
    prCache = { at: now, slug, prs, note: prsNote }
  }

  return {
    isRepo: true,
    root: top.stdout.trim(),
    current,
    slug,
    changes: parseStatus(status.stdout),
    branches,
    remotes: parseRemotes(remotes.stdout, branches),
    commits: log.exitCode === 0 ? parseCommits(log.stdout) : [],
    prs,
    prsNote,
    loadedAt: now,
  }
}

let inflight: Promise<GitSnapshot | null> | null = null

/** Сколько обновлений и fetch идёт сейчас: «обновляю…» горит, пока идёт хоть одно. */
let busy = 0

/** Работа под индикатором загрузки; перекрывающиеся вызовы не гасят его друг другу. */
const whileLoading = async <T,>($: EngineInterface, work: () => Promise<T>): Promise<T> => {
  busy += 1
  await update($, isLoading, () => busy > 0)
  try {
    return await work()
  } finally {
    busy -= 1
    await update($, isLoading, () => busy > 0)
  }
}

/**
 * Перечитать репозиторий; параллельные вызовы ждут один и тот же. `isForced` — и список PR тоже,
 * не глядя на кэш. `isFresh` — не брать уже идущее чтение: дождаться его и прочитать заново.
 */
const refresh = ($: EngineInterface, isForced = false, isFresh = false): Promise<GitSnapshot | null> => {
  if (inflight && !isFresh) {
    return inflight
  }

  const previous = inflight
  const run: Promise<GitSnapshot | null> = whileLoading($, async () => {
    // Прошлое чтение ложится первым: его снимок не перепишет свежий.
    await previous?.catch(() => null)
    try {
      const next = await loadSnapshot($, isForced)
      await update($, snapshot, () => next)

      return next
    } catch {
      return null
    }
  }).finally(() => {
    if (inflight === run) {
      inflight = null
    }
  })
  inflight = run

  return run
}

const fetchAll = ($: EngineInterface) =>
  whileLoading($, async () => {
    // Идущее фоновое чтение — до fetch: иначе его снимок, начатый до fetch, лёг бы последним.
    await inflight?.catch(() => null)
    const result = await $.process
      .run(['git', 'fetch', '--all', '--prune'], { timeoutMs: 120_000 })
      .catch(() => ({ exitCode: 1, stderr: 'git не запустился' }))
    if (result.exitCode !== 0) {
      $.ui.toast(`git fetch не удался: ${result.stderr.trim().split('\n')[0] ?? ''}`)
    }

    // Только новое чтение, начатое после fetch, и с PR.
    return refresh($, true, true)
  })

const isPaneOpen = async ($: EngineInterface) => (await $.ui.panes().catch(() => [])).some(pane => pane.id === PANE)

/** Фоновое обновление — только пока панель открыта: закрытая не запускает git. */
const refreshIfOpen = async ($: EngineInterface) => {
  if (await isPaneOpen($)) {
    await refresh($)
  }
}

// ── Отрисовка ────────────────────────────────────────────────────────────

const BLUE = '#58a6ff'
const PURPLE = '#bc8cff'
const GRAY = '#8b949e'

/** Высота строки текста на десктопе: по ней значки встают вровень с текстом. */
const LINE_PX = 20

/** Сколько строк показывать в секции, пока её не развернули. */
const SECTION_LIMIT = 6

/** Отступ строк под текстом заголовка: значок и зазор. */
const INDENT = 2

/** Промежуток между левой и правой частью строки, в ячейках. */
const GAP = 2

/** Фон карточки секции на десктопе. */
const CARD = '#8b949e14'

/** Как выглядит заголовок секции: название, цвет, значок в терминале (`glyph`) и на десктопе (`icon`). */
type Look = { title: string; color: string; glyph: string; icon: string }

const STROKE = 'fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'

/** Значки в сетке 16×16 (C — цвет). */
const LOOKS: Record<SectionId, Look> = {
  local: {
    title: 'ВЕТКИ',
    color: BLUE,
    glyph: '⎇',
    icon:
      `<circle cx="4.5" cy="3.5" r="1.8" ${STROKE}/><circle cx="4.5" cy="12.5" r="1.8" ${STROKE}/>` +
      `<circle cx="11.5" cy="4.5" r="1.8" ${STROKE}/><path d="M4.5 5.3V10.7M11.5 6.3C11.5 9.2 4.5 8.2 4.5 10.7" ${STROKE}/>`,
  },
  prs: {
    title: 'PULL REQUESTS',
    color: PURPLE,
    glyph: '⇄',
    icon:
      `<circle cx="4.5" cy="3.5" r="1.8" ${STROKE}/><circle cx="4.5" cy="12.5" r="1.8" ${STROKE}/>` +
      `<circle cx="11.5" cy="12.5" r="1.8" ${STROKE}/><path d="M4.5 5.3V10.7M11.5 10.7V6.5C11.5 5.1 10.6 4 9 4H7M8.6 2.3L7 4L8.6 5.7" ${STROKE}/>`,
  },
  commits: {
    title: 'КОММИТЫ',
    color: GREEN,
    glyph: '◉',
    icon: `<circle cx="8" cy="8" r="2.8" ${STROKE}/><path d="M1.5 8H5.2M10.8 8H14.5" ${STROKE}/>`,
  },
  remote: {
    title: 'НА СЕРВЕРЕ',
    color: GRAY,
    glyph: '◌',
    icon: `<path d="M4.6 11.9H11.6A2.7 2.7 0 0 0 11.5 6.5A3.8 3.8 0 0 0 4.3 7.1A2.4 2.4 0 0 0 4.6 11.9Z" ${STROKE}/>`,
  },
}

/** Узел графа коммитов: у HEAD линия уходит только вниз. */
type GraphNode = 'head' | 'commit'

/** Узлы графа в колонке значка секции (C — цвет линии): линия проходит сквозь строку и сшивает соседние. */
const NODES: Record<GraphNode, string> = {
  head:
    `<path d="M8 11.4V22" stroke="C" stroke-opacity=".45" stroke-width="1.4"/>` +
    `<circle cx="8" cy="8" r="5.4" fill="${GREEN}" fill-opacity=".22"/><circle cx="8" cy="8" r="3.2" fill="${GREEN}"/>`,
  commit:
    `<path d="M8 -6V5M8 11V22" stroke="C" stroke-opacity=".45" stroke-width="1.4"/>` +
    `<circle cx="8" cy="8" r="3" fill="none" stroke="C" stroke-width="1.6"/>`,
}

/** Значок 12×LINE_PX: сетка 16×16 по центру строки. */
const iconSvg = (body: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="${LINE_PX}" viewBox="0 ${(16 - (LINE_PX * 16) / 12) / 2} 16 ${(LINE_PX * 16) / 12}">` +
  body.replace(/"C"/g, `"${color}"`) +
  `</svg>`

const AVATAR_COLORS = [BLUE, PURPLE, GREEN, AMBER, GRAY]

/** Инициалы автора: «Ivan Petrov» → «IP», «Zulut30» → «ZU». */
export const initials = (name: string) => {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
  const letters = words.length >= 2 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : (words[0] ?? '?').slice(0, 2)

  return letters.toUpperCase()
}

/** Кружок с инициалами автора: мягкая подложка и буквы цветом, как у плашек; цвет постоянный для одного имени. */
const avatarSvg = (name: string) => {
  const hash = [...name].reduce((sum, char) => (sum * 31 + (char.codePointAt(0) ?? 0)) % 9973, 7)
  const color = AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? GRAY

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="${LINE_PX}" viewBox="0 ${(16 - LINE_PX) / 2} 16 ${LINE_PX}">` +
    `<circle cx="8" cy="8" r="7.5" fill="${color}" fill-opacity=".2"/>` +
    `<text x="8" y="10.6" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="7" font-weight="600" fill="${color}">${initials(name)}</text>` +
    `</svg>`
  )
}

/** Кусок строки. Без цвета и без `bold` он приглушён. */
type Part = { text: string; color?: string; bold?: boolean }

const isPart = (part: Part | null | false | undefined): part is Part => Boolean(part)

const width = (text: string) => [...text].length

const short = (text: string, max: number) => {
  const chars = [...text.replace(/\s+/g, ' ').trim()]

  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : chars.join('')
}

/** Уложить куски в `room` ячеек (между кусками — `sep` ячеек): последний влезающий режется, хвост отбрасывается. */
const fit = (parts: readonly Part[], room: number, sep: number) => {
  const out: Part[] = []
  let left = room
  for (const part of parts) {
    const cost = out.length > 0 ? sep : 0
    const need = width(part.text)
    if (need + cost <= left) {
      out.push(part)
      left -= need + cost
      continue
    }
    if (out.length === 0 || left - cost >= 4) {
      out.push({ ...part, text: short(part.text, Math.max(2, left - cost)) })
    }
    break
  }

  return out
}

const partsWidth = (parts: readonly Part[]) => parts.reduce((sum, part, i) => sum + width(part.text) + (i > 0 ? 1 : 0), 0)

/** «3 ч назад» → «3 ч»: в строках списка «назад» лишнее. */
const ago = (unixSeconds: number, now: number) => relativeTime(unixSeconds, now).replace(/ назад$/, '')

const CHECK_PARTS: Record<Checks, Part | null> = {
  passing: { text: '✓', color: GREEN },
  failing: { text: '✗', color: RED },
  pending: { text: '●', color: AMBER },
  none: null,
}

/** Цвет решения ревью: одобрено — хорошо, правки — ждёт автора; «ждёт ревью» обычное и приглушено. */
const REVIEW_COLORS: Record<string, string> = { одобрено: GREEN, 'нужны правки': AMBER }

/**
 * Строка секции: главное (режется под `room`), справа пометки, автор и время; у коммитов — узел графа в колонке значка.
 * `badge` — состояние проверок: крайним справа среди пометок и не режется вместе с ними.
 */
type Line = {
  key: string
  main: (room: number) => RenderChildren[]
  meta: Part[]
  badge?: Part | null
  time: string
  author?: string
  node?: GraphNode
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Имя занято другим плагином — команды не будет, но остальной старт сессии должен пройти.
    await $.command.register({
      name: 'branches',
      description: 'Открыть панель веток Git (`/branches fetch` — сначала git fetch)',
    }).catch(() => undefined)
    // Первое чтение — вне старта сессии, чтобы не задерживать его; панель открывается сама только в git-проекте.
    $.clock.after(0, () => {
      void refresh($).then(found => (found?.isRepo ? $.ui.open({ id: PANE, title: TITLE }) : undefined)).catch(() => undefined)
    })
    $.clock.every(180_000, () => void refreshIfOpen($))

    return next(e)
  })

  on('command.run', { command: 'branches' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })
    const found = await (e.args.trim() === 'fetch' ? fetchAll($) : refresh($, true))

    return { text: found?.isRepo ? `Ветки: ${found.branches.length}, текущая ${found.current}.` : 'Эта папка не git-репозиторий.' }
  })

  // Claude мог закоммитить или переключить ветку — перечитываем после хода (PR — из кэша).
  on('turn.complete', async ($, e, next) => {
    $.clock.after(0, () => void refreshIfOpen($))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Link } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined

    const snap = await read($, snapshot)
    const loading = await read($, isLoading)
    const open = await read($, expanded)
    const now = await $.clock.now()

    // Все тексты режем заранее под ширину: перенос на десктопе занимает лишнюю высоту.
    // `full` — шапка и тихие строки, `inner` — содержимое карточки (на десктопе без её полей).
    const full = Math.max(24, e.props.bodyColumns)
    const inner = full - (Svg ? 2 : 0)
    const narrow = full < 48
    /** Место под кнопки шапки: на десктопе они родные и шире. */
    const toolbarW = Svg ? 10 : 5

    const mark = (look: Look, color = look.color, alt = 'значок') =>
      Svg ? <Svg source={iconSvg(look.icon, color)} alt={alt} width={12} height={LINE_PX} /> : <Text color={color}>{look.glyph}</Text>

    const node = (kind: GraphNode) =>
      Svg ? (
        <Svg source={iconSvg(NODES[kind], GRAY)} alt={kind === 'head' ? 'последний коммит' : 'коммит'} width={12} height={LINE_PX} />
      ) : kind === 'head' ? (
        <Text color={GREEN}>●</Text>
      ) : (
        <Text dimColor>○</Text>
      )

    const tone = (part: Part) => (
      <Text bold={part.bold} color={part.color} dimColor={!part.color && !part.bold}>
        {part.text}
      </Text>
    )

    if (!snap || !snap.isRepo) {
      const [title, hint] = !snap
        ? loading
          ? ['Читаю репозиторий…', 'Это займёт пару секунд.']
          : ['Нет данных', 'Нажмите ↻, чтобы прочитать репозиторий.']
        : ['Здесь нет git-репозитория', 'Откройте сессию в папке проекта с git.']

      return (
        <Box flexDirection="column">
          <Box key="head-top" flexDirection="row" justifyContent="space-between" alignItems="flex-start" columnGap={GAP}>
            <Box key="head-title" flexDirection="column" flexShrink={1}>
              <Text bold>{short(title, full - toolbarW)}</Text>
              <Text dimColor>{short(hint, full - toolbarW)}</Text>
            </Box>
            <Box key="toolbar" flexDirection="row" flexShrink={0}>
              <Button key="refresh" plain dimColor label="↻" onPress={() => void refresh($, true)} />
            </Box>
          </Box>
        </Box>
      )
    }

    const web = snap.slug ? `https://github.com/${snap.slug}` : ''
    const prByBranch = new Map(snap.prs.map(pr => [pr.branch, pr]))
    const current = snap.branches.find(branch => branch.isCurrent)
    const others = snap.branches.filter(branch => !branch.isCurrent)

    // ── Шапка: репозиторий и ветка, под ними плашки статуса и время обновления; справа тихие кнопки.

    const repoName = snap.slug || snap.root.split(/[\\/]/).pop() || 'репозиторий'
    const branchName = snap.current === 'HEAD' ? 'отсоединённый HEAD' : snap.current || 'нет коммитов'
    // Узко — режем сначала репозиторий: ветка важнее.
    const titleRoom = full - toolbarW - GAP - INDENT
    const repoRoom = Math.max(6, Math.min(width(repoName), titleRoom - Math.min(width(branchName), Math.ceil(titleRoom * 0.55))))
    const branchRoom = Math.max(6, titleRoom - repoRoom)

    const sync: Part[] = !current
      ? []
      : !current.upstream
        ? [{ text: 'не опубликована', color: AMBER }]
        : current.ahead || current.behind
          ? ([
              current.ahead ? { text: `↑${current.ahead} не запушено`, color: BLUE } : null,
              current.behind ? { text: `↓${current.behind} не подтянуто`, color: AMBER } : null,
            ] as (Part | null)[]).filter(isPart)
          : [{ text: '✓ синхронизирована', color: GREEN }]
    const { staged, unstaged, untracked } = snap.changes
    const dirty = staged + unstaged + untracked
    const tree: Part = dirty
      ? { text: `✎ ${dirty} ${plural(dirty, 'изменение', 'изменения', 'изменений')}`, color: AMBER }
      : { text: '✓ чисто', color: GREEN }
    const updated = loading ? 'обновляю…' : `обновлено ${relativeTime(Math.floor(snap.loadedAt / 1000), now)}`

    // Плашка на десктопе — текст на мягкой цветной подложке с пробелом по краям; в терминале просто цветом.
    const chipPad = Svg ? 2 : 0
    const chipGap = Svg ? 1 : GAP
    const chips = fit([...sync, tree], full - chipPad, chipGap + chipPad)
    const chipsW = chips.reduce((sum, part, i) => sum + width(part.text) + chipPad + (i > 0 ? chipGap : 0), 0)
    const showUpdated = full - chipsW - chipGap >= width(updated)

    const chip = (part: Part) =>
      Svg && part.color ? (
        <Text color={part.color} backgroundColor={`${part.color}26`}>
          {` ${part.text} `}
        </Text>
      ) : (
        tone(part)
      )

    const header = (
      <Box key="head" flexDirection="column">
        <Box key="head-top" flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={GAP}>
          <Box key="head-title" flexDirection="row" alignItems="center" columnGap={GAP} flexShrink={1}>
            <Text bold>{short(repoName, repoRoom)}</Text>
            <Box key="head-branch" flexDirection="row" alignItems="center" columnGap={1}>
              {mark(LOOKS.local, GREEN, 'текущая ветка')}
              <Text bold>{short(branchName, branchRoom)}</Text>
            </Box>
          </Box>
          <Box key="toolbar" flexDirection="row" columnGap={1} flexShrink={0}>
            <Button key="refresh" plain dimColor label="↻" onPress={() => void refresh($, true)} />
            <Button key="fetch" plain dimColor label="⇣" onPress={() => void fetchAll($)} />
          </Box>
        </Box>
        <Box key="head-status" flexDirection="row" alignItems="center" columnGap={chipGap}>
          {chips.map(chip)}
          {showUpdated ? <Text dimColor>{updated}</Text> : null}
        </Box>
      </Box>
    )

    // ── Секции-карточки: значок и название цветом секции, число справа, строки под названием.

    const toggle = (id: SectionId) => update($, expanded, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))

    /** Строка: слева главное, справа пометки, автор и время; без фиксированных ширин. */
    const row = (line: Line, meta: Part[], room: number, timeW: number) => {
      const body = (
        <Box key={`${line.key}-body`} flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={GAP} flexGrow={1}>
          <Box key={`${line.key}-main`} flexDirection="row" alignItems="center" columnGap={1} flexShrink={1}>
            {line.main(room)}
          </Box>
          <Box key={`${line.key}-right`} flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            {meta.map(tone)}
            {line.author && !narrow ? (
              Svg ? (
                <Svg source={avatarSvg(line.author)} alt={line.author} width={16} height={LINE_PX} />
              ) : (
                <Text dimColor>{initials(line.author)}</Text>
              )
            ) : null}
            {timeW ? <Text dimColor>{line.time}</Text> : null}
          </Box>
        </Box>
      )

      // Узел графа встаёт в колонку значка секции, текст — вровень с заголовком.
      return line.node ? (
        <Box key={line.key} flexDirection="row" alignItems="center" columnGap={1}>
          {node(line.node)}
          {body}
        </Box>
      ) : (
        <Box key={line.key} flexDirection="row" paddingLeft={INDENT}>
          {body}
        </Box>
      )
    }

    /** Секция-карточка; `isCollapsed` — свёрнута целиком, пока не раскроют. */
    const section = (id: SectionId, lines: Line[], isCollapsed = false) => {
      const look = LOOKS[id]
      const isOpen = open.includes(id)
      const limit = isCollapsed ? 0 : SECTION_LIMIT
      const hidden = lines.length - limit
      const visible = isOpen ? lines : lines.slice(0, limit)

      const maxMeta = Math.max(6, Math.floor(inner * 0.4))
      const metas = visible.map(line => [...fit(line.meta, maxMeta - (line.badge ? 2 : 0), 1), ...(line.badge ? [line.badge] : [])])
      const metaW = Math.max(0, ...metas.map(partsWidth))
      const timeW = narrow ? 0 : Math.max(0, ...visible.map(line => width(line.time)))
      const authorW = !narrow && visible.some(line => line.author) ? 3 : 0
      const room = Math.max(8, inner - INDENT - (metaW ? metaW + GAP : 0) - authorW - (timeW ? timeW + GAP : 0) - 1)

      return (
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
                {short(look.title, Math.max(8, inner - 8))}
              </Text>
            </Box>
            <Text dimColor>{String(lines.length)}</Text>
          </Box>
          {visible.map((line, i) => row(line, metas[i] ?? [], room, timeW))}
          {hidden > 0 ? (
            <Box key={`more-${id}-row`} flexDirection="row" paddingLeft={INDENT}>
              <Button
                key={`more-${id}`}
                plain
                dimColor
                label={isOpen ? 'Свернуть' : isCollapsed ? `Показать ${lines.length}` : `Ещё ${hidden}`}
                onPress={() => toggle(id)}
              />
            </Box>
          ) : null}
        </Box>
      )
    }

    const branchLine = (branch: Branch): Line => {
      const pr = prByBranch.get(branch.name)

      return {
        key: `local-${branch.name}`,
        main: room => [<Text>{short(branch.name, room)}</Text>],
        meta: [
          branch.behind ? { text: `↓${branch.behind}`, color: AMBER } : null,
          branch.ahead ? { text: `↑${branch.ahead}` } : null,
          branch.isGone ? { text: 'удалена на сервере', color: RED } : null,
          !branch.upstream && !branch.isGone ? { text: 'локальная' } : null,
          pr ? { text: `#${pr.number}` } : null,
        ].filter(isPart),
        badge: pr ? CHECK_PARTS[pr.checks] : null,
        time: ago(branch.time, now),
      }
    }

    const prLine = (pr: PullRequest): Line => {
      const number = `#${pr.number}`

      return {
        key: `pr-${pr.number}`,
        main: room => [<Link href={pr.url} label={number} />, <Text>{short(pr.title, room - width(number) - 1)}</Text>],
        meta: [
          pr.isDraft ? { text: 'черновик' } : null,
          pr.review ? { text: pr.review, color: REVIEW_COLORS[pr.review] } : null,
        ].filter(isPart),
        badge: CHECK_PARTS[pr.checks],
        time: '',
      }
    }

    const commitLine = (commit: Commit, index: number): Line => ({
      key: `commit-${commit.hash}`,
      // Самый свежий коммит — HEAD: зелёный узел графа.
      node: index === 0 ? 'head' : 'commit',
      author: commit.author,
      main: room => [
        web ? <Link href={`${web}/commit/${commit.hash}`} label={commit.hash} /> : <Text dimColor>{commit.hash}</Text>,
        <Text>{short(commit.subject, room - width(commit.hash) - 1)}</Text>,
      ],
      meta: [],
      time: ago(commit.time, now),
    })

    const remoteLine = (branch: RemoteBranch): Line => ({
      key: `remote-${branch.name}`,
      author: branch.author || undefined,
      main: room => [<Text>{short(branch.name.replace(/^origin\//, ''), room)}</Text>],
      meta: [],
      time: ago(branch.time, now),
    })

    // Пустое — одной тихой строкой вместо пустых карточек; длинная подсказка про gh — последней.
    const quiet = [
      others.length === 0 ? 'других веток нет' : '',
      snap.commits.length === 0 ? 'коммитов пока нет' : '',
      snap.slug && snap.prs.length === 0 ? snap.prsNote || 'открытых PR нет' : '',
    ]
      .filter(Boolean)
      .join(' · ')
      .replace(/^./, letter => letter.toUpperCase())

    return (
      <Box flexDirection="column">
        {header}
        {others.length > 0 ? section('local', others.map(branchLine)) : null}
        {snap.slug && snap.prs.length > 0 ? section('prs', snap.prs.map(prLine)) : null}
        {quiet ? (
          <Box key="quiet" flexDirection="row" marginTop={1}>
            <Text dimColor>{short(quiet, full)}</Text>
          </Box>
        ) : null}
        {snap.commits.length > 0 ? section('commits', snap.commits.map(commitLine)) : null}
        {snap.remotes.length > 0 ? section('remote', snap.remotes.map(remoteLine), true) : null}
      </Box>
    )
  })
}
