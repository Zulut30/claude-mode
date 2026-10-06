import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Branch, Changes, Checks, Commit, GitSnapshot, PullRequest, RemoteBranch, SectionId } from '../types'

const PANE = 'git-branches'
const TITLE = 'Branches'

const GREEN = '#3fb950'
const AMBER = '#d29922'
const RED = '#f85149'
const BLUE = '#58a6ff'

const snapshot = atom({ plugin: 'git-branches', key: 'snapshot' } as const, null)
const isLoading = atom({ plugin: 'git-branches', key: 'isLoading' } as const, false)
const collapsed = atom({ plugin: 'git-branches', key: 'collapsed' } as const, ['remote'] as SectionId[])

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

/** `git for-each-ref refs/remotes`: without HEAD and without branches already tracked locally. */
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
    return `${minutes}m ago`
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

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

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

const loadSnapshot = async ($: EngineInterface): Promise<GitSnapshot> => {
  const now = await $.clock.now()
  const git = (args: string[]) =>
    $.process
      .run(['git', ...args], { timeoutMs: 15_000 })
      .catch(() => ({ exitCode: 127, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }))

  const top = await git(['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) {
    return emptySnapshot(now)
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

  let prs: PullRequest[] = []
  let prsNote = ''
  if (slug) {
    try {
      const gh = await $.process.run(
        ['gh', 'pr', 'list', '--state', 'open', '--limit', '30', '--json', 'number,title,headRefName,isDraft,url,reviewDecision,statusCheckRollup'],
        { timeoutMs: 20_000 },
      )
      if (gh.exitCode === 0) {
        prs = parsePrs(gh.stdout)
      } else {
        prsNote = /auth|login/i.test(gh.stderr) ? 'sign in to gh: gh auth login' : 'gh could not list PRs'
      }
    } catch {
      prsNote = 'install the GitHub CLI (gh) to see PRs'
    }
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

/** Re-read the repository; concurrent calls share the same pending read. */
const refresh = ($: EngineInterface) => {
  inflight ??= (async () => {
    await update($, isLoading, () => true)
    try {
      const next = await loadSnapshot($)
      await update($, snapshot, () => next)

      return next
    } catch {
      return null
    } finally {
      await update($, isLoading, () => false)
      inflight = null
    }
  })()

  return inflight
}

const fetchAll = async ($: EngineInterface) => {
  await update($, isLoading, () => true)
  const result = await $.process
    .run(['git', 'fetch', '--all', '--prune'], { timeoutMs: 120_000 })
    .catch(() => ({ exitCode: 1, stderr: 'git failed to start' }))
  if (result.exitCode !== 0) {
    $.ui.toast(`git fetch failed: ${result.stderr.trim().split('\n')[0] ?? ''}`)
  }

  return refresh($)
}

// ── Rendering ────────────────────────────────────────────────────────────

const CHECK_MARKS: Record<Checks, { glyph: string; color?: string; text: string }> = {
  passing: { glyph: '✓', color: GREEN, text: 'checks passed' },
  failing: { glyph: '✗', color: RED, text: 'checks failed' },
  pending: { glyph: '●', color: AMBER, text: 'checks running' },
  none: { glyph: '', text: '' },
}

const SECTION_TITLES: Record<SectionId, string> = {
  local: 'LOCAL BRANCHES',
  prs: 'PULL REQUESTS',
  remote: 'REMOTE BRANCHES',
  commits: 'COMMITS',
}

const LIST_LIMIT = 15

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'branches',
      description: 'Open the Git branches pane (`/branches fetch` runs git fetch first)',
    })
    // First read happens outside session start so it is not delayed; the pane opens by itself only in a git project.
    $.clock.after(0, () => {
      void refresh($).then(found => (found?.isRepo ? $.ui.open({ id: PANE, title: TITLE }) : undefined))
    })
    $.clock.every(180_000, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'branches' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })
    const found = await (e.args.trim() === 'fetch' ? fetchAll($) : refresh($))

    return { text: found?.isRepo ? `Branches: ${found.branches.length}, current ${found.current}.` : 'This folder is not a git repository.' }
  })

  // Claude may have committed or switched branches; re-read after each turn.
  on('turn.complete', async ($, e, next) => {
    $.clock.after(0, () => void refresh($))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const loading = await read($, isLoading)
    const folded = await read($, collapsed)
    const now = await $.clock.now()
    const columns = e.props.bodyColumns
    const narrow = columns < 44
    const wide = columns >= 70

    const toolbar = (
      <Box key="toolbar" flexDirection="row" columnGap={1} flexShrink={0}>
        <Button key="refresh" label="↻ Refresh" onPress={() => void refresh($)} />
        <Button key="fetch" label="⇣ Fetch" onPress={() => void fetchAll($)} />
      </Box>
    )

    if (!snap) {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>{loading ? 'Reading the repository…' : 'No data yet. Press Refresh.'}</Text>
          {toolbar}
        </Box>
      )
    }

    if (!snap.isRepo) {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text bold>No git repository here</Text>
          <Text dimColor wrap="wrap">
            Open a session in a project folder that uses git to see branches, PRs and commits.
          </Text>
          {toolbar}
        </Box>
      )
    }

    const web = snap.slug ? `https://github.com/${snap.slug}` : ''
    const prByBranch = new Map(snap.prs.map(pr => [pr.branch, pr]))
    const currentBranch = snap.branches.find(branch => branch.isCurrent)
    const { staged, unstaged, untracked } = snap.changes
    const dirty = staged + unstaged + untracked
    const changeParts = [
      unstaged ? `${unstaged} modified` : '',
      staged ? `${staged} staged` : '',
      untracked ? `${untracked} untracked` : '',
    ].filter(Boolean)

    const toggle = (id: SectionId) =>
      update($, collapsed, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))

    const section = (id: SectionId, count: number, title: string, body: () => RenderChildren) => {
      const isFolded = folded.includes(id)

      return (
        <Box key={`section-${id}`} flexDirection="column" marginTop={1}>
          <Button key={`toggle-${id}`} plain label={`${isFolded ? '▸' : '▾'} ${title}  ${count}`} onPress={() => toggle(id)} />
          {isFolded ? null : body()}
        </Box>
      )
    }

    const more = (key: string, hidden: number) =>
      hidden > 0 ? (
        <Box key={key}>
          <Text dimColor>…and {hidden} more</Text>
        </Box>
      ) : null

    const branchRow = (branch: Branch) => {
      const pr = prByBranch.get(branch.name)
      const check = pr ? CHECK_MARKS[pr.checks] : undefined
      const href = web && branch.upstream && !branch.isGone ? `${web}/tree/${encodePath(branch.name)}` : ''

      return (
        <Box key={`local-${branch.name}`} flexDirection="column">
          <Box key={`local-${branch.name}-head`} flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Box key={`local-${branch.name}-name`} flexDirection="row" columnGap={1} flexShrink={1}>
              <Text color={branch.isCurrent ? GREEN : undefined} dimColor={!branch.isCurrent}>
                {branch.isCurrent ? '●' : '○'}
              </Text>
              {href ? (
                <Link href={href} label={branch.name} />
              ) : (
                <Text bold={branch.isCurrent} wrap="truncate-end">
                  {branch.name}
                </Text>
              )}
            </Box>
            <Box key={`local-${branch.name}-badges`} flexDirection="row" columnGap={1} flexShrink={0}>
              {branch.ahead ? <Text color={GREEN}>↑{branch.ahead}</Text> : null}
              {branch.behind ? <Text color={AMBER}>↓{branch.behind}</Text> : null}
              {branch.isGone ? <Text color={RED}>not on remote</Text> : null}
              {!branch.upstream && !branch.isGone ? <Text dimColor>local only</Text> : null}
              {pr ? <Text color={BLUE}>#{pr.number}</Text> : null}
              {check?.glyph ? <Text color={check.color}>{check.glyph}</Text> : null}
              {narrow ? null : <Text dimColor>{relativeTime(branch.time, now)}</Text>}
            </Box>
          </Box>
          {narrow ? null : (
            <Text dimColor wrap="truncate-end">
              {'  '}
              {branch.hash} {branch.subject}
              {wide ? ` · ${branch.author}` : ''}
            </Text>
          )}
        </Box>
      )
    }

    const prRow = (pr: PullRequest) => {
      const check = CHECK_MARKS[pr.checks]
      const facts = [pr.branch, pr.isDraft ? 'draft' : '', check.text, pr.review].filter(Boolean).join(' · ')

      return (
        <Box key={`pr-${pr.number}`} flexDirection="column">
          <Box key={`pr-${pr.number}-head`} flexDirection="row" columnGap={1}>
            <Text color={pr.isDraft ? undefined : BLUE} dimColor={pr.isDraft}>
              #{pr.number}
            </Text>
            <Link href={pr.url} label={pr.title} />
          </Box>
          {narrow ? null : (
            <Text color={pr.checks === 'failing' ? RED : undefined} dimColor={pr.checks !== 'failing'} wrap="truncate-end">
              {'  '}
              {facts}
            </Text>
          )}
        </Box>
      )
    }

    const remoteRow = (branch: RemoteBranch) => {
      const name = branch.name.replace(/^[^/]+\//, '')

      return (
        <Box key={`remote-${branch.name}`} flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Box key={`remote-${branch.name}-name`} flexDirection="row" columnGap={1} flexShrink={1}>
            <Text dimColor>☁</Text>
            {web ? <Link href={`${web}/tree/${encodePath(name)}`} label={branch.name} /> : <Text wrap="truncate-end">{branch.name}</Text>}
          </Box>
          {narrow ? null : <Text dimColor>{relativeTime(branch.time, now)}</Text>}
        </Box>
      )
    }

    const commitRow = (commit: Commit) => (
      <Box key={`commit-${commit.hash}`} flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Box key={`commit-${commit.hash}-text`} flexDirection="row" columnGap={1} flexShrink={1}>
          {web ? (
            <Link href={`${web}/commit/${commit.hash}`} label={commit.hash} />
          ) : (
            <Text color={AMBER}>{commit.hash}</Text>
          )}
          <Text wrap="truncate-end">{commit.subject}</Text>
        </Box>
        {narrow ? null : (
          <Text dimColor>
            {wide ? `${commit.author} · ` : ''}
            {relativeTime(commit.time, now)}
          </Text>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box key="card" flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box key="card-top" flexDirection="row" justifyContent="space-between" columnGap={1}>
            {web ? <Link href={web} label={snap.slug} /> : <Text bold>{snap.root.split(/[\\/]/).pop()}</Text>}
            {toolbar}
          </Box>
          <Box key="card-branch" flexDirection="row" columnGap={1} flexWrap="wrap">
            <Text color={GREEN}>●</Text>
            <Text bold>{snap.current === 'HEAD' ? 'detached HEAD' : snap.current}</Text>
            {currentBranch?.ahead ? <Text color={GREEN}>↑{currentBranch.ahead} to push</Text> : null}
            {currentBranch?.behind ? <Text color={AMBER}>↓{currentBranch.behind} to pull</Text> : null}
          </Box>
          <Text color={dirty ? AMBER : GREEN} wrap="truncate-end">
            {dirty ? `✎ ${changeParts.join(' · ')}` : '✓ working tree clean'}
          </Text>
          <Text dimColor>{loading ? 'refreshing…' : `updated ${relativeTime(Math.floor(snap.loadedAt / 1000), now)}`}</Text>
        </Box>

        {section('local', snap.branches.length, SECTION_TITLES.local, () => [
          ...snap.branches.slice(0, LIST_LIMIT).map(branchRow),
          more('local-more', snap.branches.length - LIST_LIMIT),
        ])}

        {snap.slug
          ? section('prs', snap.prs.length, SECTION_TITLES.prs, () =>
              snap.prs.length > 0
                ? snap.prs.map(prRow)
                : [
                    <Box key="prs-empty">
                      <Text dimColor>{snap.prsNote || 'no open PRs'}</Text>
                    </Box>,
                  ],
            )
          : null}

        {snap.remotes.length > 0
          ? section('remote', snap.remotes.length, SECTION_TITLES.remote, () => [
              ...snap.remotes.slice(0, LIST_LIMIT).map(remoteRow),
              more('remote-more', snap.remotes.length - LIST_LIMIT),
            ])
          : null}

        {section('commits', snap.commits.length, `${SECTION_TITLES.commits} · ${snap.current}`, () => snap.commits.map(commitRow))}
      </Box>
    )
  })
}
