import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Branch, Changes, Checks, Commit, GitSnapshot, PullRequest, RemoteBranch, SectionId } from '../types'

const PANE = 'git-branches'
const TITLE = 'Branches'

const GREEN = '#3fb950'
const AMBER = '#d29922'
const RED = '#f85149'

const snapshot = atom({ plugin: 'git-branches', key: 'snapshot' } as const, null)
const isLoading = atom({ plugin: 'git-branches', key: 'isLoading' } as const, false)
const expanded = atom({ plugin: 'git-branches', key: 'expanded' } as const, [] as SectionId[])

// ── Parsing git and gh output ────────────────────────────────────────────

const lines = (text: string) => text.split(/\r?\n/).filter(line => line.trim() !== '')

export const parseTrack = (track: string) => ({
  ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
  behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
  isGone: track.includes('gone'),
})

/** `git for-each-ref refs/heads` with tab-separated fields. */
export const parseBranches = (stdout: string, current: string): Branch[] =>
  lines(stdout).map(line => {
    const [name = '', upstream = '', track = '', hash = '', time = '0', author = '', ...subject] = line.split('\t')

    return { name, upstream, ...parseTrack(track), hash, time: Number(time), author, subject: subject.join('\t'), isCurrent: name === current }
  })

/** `git for-each-ref refs/remotes`: without HEAD and without branches already present locally. */
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

/** owner/repo from the origin URL, if it is GitHub. */
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
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  REVIEW_REQUIRED: 'review required',
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
    return 'just now'
  }
  if (minutes < 60) {
    return `${minutes} min ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  if (days < 14) {
    return `${days}d ago`
  }
  if (days < 60) {
    return `${Math.floor(days / 7)}w ago`
  }

  return days < 730 ? `${Math.floor(days / 30)}mo ago` : `${Math.floor(days / 365)}y ago`
}

export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

// ── Repository snapshot ──────────────────────────────────────────────────

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

/** `gh` goes over the network: after a turn local git is enough, so the PR list is refreshed at most once every 5 minutes. */
const PR_TTL_MS = 5 * 60_000

/** Reading status does not take index.lock and does not get in the way of git running alongside. */
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' }

/** Subfolder with the project when the session folder itself is not git (a "no folder" session with a clone inside). */
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
    // The session folder is not a project: look for a clone in subfolders; if the found subfolder is gone, search again next time.
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
        prsNote = /auth|login/i.test(gh.stderr) ? 'sign in to gh: gh auth login' : 'gh could not list PRs'
      }
    } catch {
      prsNote = 'install the GitHub CLI (gh) to see PRs'
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

/** How many refreshes and fetches are running: "updating…" stays on while any one is. */
let busy = 0

/** Work under the loading indicator; overlapping calls don't switch it off for each other. */
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
 * Re-read the repository; concurrent calls wait for the same read. `isForced` reloads the PR list too,
 * ignoring the cache. `isFresh` doesn't join a read already running: it waits for it and reads again.
 */
const refresh = ($: EngineInterface, isForced = false, isFresh = false): Promise<GitSnapshot | null> => {
  if (inflight && !isFresh) {
    return inflight
  }

  const previous = inflight
  const run: Promise<GitSnapshot | null> = whileLoading($, async () => {
    // The earlier read lands first: its snapshot can't overwrite the fresh one.
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
    // A background read already running goes first: otherwise its snapshot, begun before the fetch, would land last.
    await inflight?.catch(() => null)
    const result = await $.process
      .run(['git', 'fetch', '--all', '--prune'], { timeoutMs: 120_000 })
      .catch(() => ({ exitCode: 1, stderr: 'git failed to start' }))
    if (result.exitCode !== 0) {
      $.ui.toast(`git fetch failed: ${result.stderr.trim().split('\n')[0] ?? ''}`)
    }

    // Only a new read, begun after the fetch, and with PRs.
    return refresh($, true, true)
  })

const isPaneOpen = async ($: EngineInterface) => (await $.ui.panes().catch(() => [])).some(pane => pane.id === PANE)

/** Background refresh only while the pane is open: a closed pane does not run git. */
const refreshIfOpen = async ($: EngineInterface) => {
  if (await isPaneOpen($)) {
    await refresh($)
  }
}

// ── Rendering ────────────────────────────────────────────────────────────

const BLUE = '#58a6ff'
const PURPLE = '#bc8cff'
const GRAY = '#8b949e'

/** Height of a text line on desktop: icons use it to line up with the text. */
const LINE_PX = 20

/** How many rows a section shows until it is expanded. */
const SECTION_LIMIT = 6

/** Indent of the rows under the header text: the icon and the gap. */
const INDENT = 2

/** Gap between the left and right parts of a row, in cells. */
const GAP = 2

/** Section card background on desktop. */
const CARD = '#8b949e14'

/** What a section header looks like: title, color, icon in the terminal (`glyph`) and on desktop (`icon`). */
type Look = { title: string; color: string; glyph: string; icon: string }

const STROKE = 'fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'

/** Icons on a 16×16 grid (C is the color). */
const LOOKS: Record<SectionId, Look> = {
  local: {
    title: 'BRANCHES',
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
    title: 'COMMITS',
    color: GREEN,
    glyph: '◉',
    icon: `<circle cx="8" cy="8" r="2.8" ${STROKE}/><path d="M1.5 8H5.2M10.8 8H14.5" ${STROKE}/>`,
  },
  remote: {
    title: 'ON REMOTE',
    color: GRAY,
    glyph: '◌',
    icon: `<path d="M4.6 11.9H11.6A2.7 2.7 0 0 0 11.5 6.5A3.8 3.8 0 0 0 4.3 7.1A2.4 2.4 0 0 0 4.6 11.9Z" ${STROKE}/>`,
  },
}

/** A commit graph node: at HEAD the line only goes down. */
type GraphNode = 'head' | 'commit'

/** Graph nodes in the section icon column (C is the line color): the line runs through the row and joins the neighbouring ones. */
const NODES: Record<GraphNode, string> = {
  head:
    `<path d="M8 11.4V22" stroke="C" stroke-opacity=".45" stroke-width="1.4"/>` +
    `<circle cx="8" cy="8" r="5.4" fill="${GREEN}" fill-opacity=".22"/><circle cx="8" cy="8" r="3.2" fill="${GREEN}"/>`,
  commit:
    `<path d="M8 -6V5M8 11V22" stroke="C" stroke-opacity=".45" stroke-width="1.4"/>` +
    `<circle cx="8" cy="8" r="3" fill="none" stroke="C" stroke-width="1.6"/>`,
}

/** A 12×LINE_PX icon: the 16×16 grid centred on the line. */
const iconSvg = (body: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="${LINE_PX}" viewBox="0 ${(16 - (LINE_PX * 16) / 12) / 2} 16 ${(LINE_PX * 16) / 12}">` +
  body.replace(/"C"/g, `"${color}"`) +
  `</svg>`

const AVATAR_COLORS = [BLUE, PURPLE, GREEN, AMBER, GRAY]

/** Author initials: "Ivan Petrov" → "IP", "Zulut30" → "ZU"; any script works, Cyrillic included. */
export const initials = (name: string) => {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
  const letters = words.length >= 2 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : (words[0] ?? '?').slice(0, 2)

  return letters.toUpperCase()
}

/** A circle with the author's initials: soft backdrop and colored letters, like the chips; one name always gets the same color. */
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

/** A piece of a row. Without a color and without `bold` it is dimmed. */
type Part = { text: string; color?: string; bold?: boolean }

const isPart = (part: Part | null | false | undefined): part is Part => Boolean(part)

const width = (text: string) => [...text].length

const short = (text: string, max: number) => {
  const chars = [...text.replace(/\s+/g, ' ').trim()]

  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : chars.join('')
}

/** Fit pieces into `room` cells (`sep` cells between pieces): the last one that partly fits is cut, the rest is dropped. */
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

/** "3h ago" → "3h": list rows don't need the "ago". */
const ago = (unixSeconds: number, now: number) => relativeTime(unixSeconds, now).replace(/ ago$/, '')

const CHECK_PARTS: Record<Checks, Part | null> = {
  passing: { text: '✓', color: GREEN },
  failing: { text: '✗', color: RED },
  pending: { text: '●', color: AMBER },
  none: null,
}

/** Review decision color: approved is good, changes requested waits on the author; "review required" is ordinary and dimmed. */
const REVIEW_COLORS: Record<string, string> = { approved: GREEN, 'changes requested': AMBER }

/**
 * A section row: the main text (cut to `room`), marks on the right, author and time; commits get a graph node in the icon column.
 * `badge` is the check status: rightmost among the marks and never cut along with them.
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
    // The name is taken by another plugin: no command then, but the rest of session start must still go through.
    await $.command.register({
      name: 'branches',
      description: 'Open the Git branches pane (`/branches fetch` runs git fetch first)',
    }).catch(() => undefined)
    // The first read happens outside session start so it does not delay it; the pane opens by itself only in a git project.
    $.clock.after(0, () => {
      void refresh($).then(found => (found?.isRepo ? $.ui.open({ id: PANE, title: TITLE }) : undefined)).catch(() => undefined)
    })
    $.clock.every(180_000, () => void refreshIfOpen($))

    return next(e)
  })

  on('command.run', { command: 'branches' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })
    const found = await (e.args.trim() === 'fetch' ? fetchAll($) : refresh($, true))

    return { text: found?.isRepo ? `Branches: ${found.branches.length}, current ${found.current}.` : 'This folder is not a git repository.' }
  })

  // Claude may have committed or switched branches: re-read after the turn (PRs come from the cache).
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

    // All texts are cut to width in advance: on desktop wrapping takes extra height.
    // `full` is for the header and quiet lines, `inner` for card contents (on desktop, without the card padding).
    const full = Math.max(24, e.props.bodyColumns)
    const inner = full - (Svg ? 2 : 0)
    const narrow = full < 48
    /** Room for the header buttons: on desktop they are native and wider. */
    const toolbarW = Svg ? 10 : 5

    const mark = (look: Look, color = look.color, alt = 'icon') =>
      Svg ? <Svg source={iconSvg(look.icon, color)} alt={alt} width={12} height={LINE_PX} /> : <Text color={color}>{look.glyph}</Text>

    const node = (kind: GraphNode) =>
      Svg ? (
        <Svg source={iconSvg(NODES[kind], GRAY)} alt={kind === 'head' ? 'latest commit' : 'commit'} width={12} height={LINE_PX} />
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
          ? ['Reading the repository…', 'This takes a couple of seconds.']
          : ['No data yet', 'Press ↻ to read the repository.']
        : ['No git repository here', 'Open a session in a project folder with git.']

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

    // ── Header: repository and branch, status chips and update time under them; quiet buttons on the right.

    const repoName = snap.slug || snap.root.split(/[\\/]/).pop() || 'repository'
    const branchName = snap.current === 'HEAD' ? 'detached HEAD' : snap.current || 'no commits'
    // When narrow, cut the repository first: the branch matters more.
    const titleRoom = full - toolbarW - GAP - INDENT
    const repoRoom = Math.max(6, Math.min(width(repoName), titleRoom - Math.min(width(branchName), Math.ceil(titleRoom * 0.55))))
    const branchRoom = Math.max(6, titleRoom - repoRoom)

    const sync: Part[] = !current
      ? []
      : !current.upstream
        ? [{ text: 'not published', color: AMBER }]
        : current.ahead || current.behind
          ? ([
              current.ahead ? { text: `↑${current.ahead} unpushed`, color: BLUE } : null,
              current.behind ? { text: `↓${current.behind} to pull`, color: AMBER } : null,
            ] as (Part | null)[]).filter(isPart)
          : [{ text: '✓ in sync', color: GREEN }]
    const { staged, unstaged, untracked } = snap.changes
    const dirty = staged + unstaged + untracked
    const tree: Part = dirty
      ? { text: `✎ ${dirty} ${plural(dirty, 'change', 'changes')}`, color: AMBER }
      : { text: '✓ clean', color: GREEN }
    const updated = loading ? 'updating…' : `updated ${relativeTime(Math.floor(snap.loadedAt / 1000), now)}`

    // On desktop a chip is text on a soft colored backdrop with a space on each side; in the terminal it is just colored.
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
              {mark(LOOKS.local, GREEN, 'current branch')}
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

    // ── Section cards: icon and title in the section color, the count on the right, rows under the title.

    const toggle = (id: SectionId) => update($, expanded, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))

    /** A row: the main text on the left, marks, author and time on the right; no fixed widths. */
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

      // The graph node sits in the section icon column, the text lines up with the title.
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

    /** A section card; `isCollapsed` keeps it fully collapsed until it is expanded. */
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
                label={isOpen ? 'Collapse' : isCollapsed ? `Show ${lines.length}` : `More ${hidden}`}
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
          branch.isGone ? { text: 'gone on remote', color: RED } : null,
          !branch.upstream && !branch.isGone ? { text: 'local only' } : null,
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
          pr.isDraft ? { text: 'draft' } : null,
          pr.review ? { text: pr.review, color: REVIEW_COLORS[pr.review] } : null,
        ].filter(isPart),
        badge: CHECK_PARTS[pr.checks],
        time: '',
      }
    }

    const commitLine = (commit: Commit, index: number): Line => ({
      key: `commit-${commit.hash}`,
      // The most recent commit is HEAD: a green graph node.
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

    // Nothing to show: one quiet line instead of empty cards; the long gh hint goes last.
    const quiet = [
      others.length === 0 ? 'no other branches' : '',
      snap.commits.length === 0 ? 'no commits yet' : '',
      snap.slug && snap.prs.length === 0 ? snap.prsNote || 'no open PRs' : '',
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
