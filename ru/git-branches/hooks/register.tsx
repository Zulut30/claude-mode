import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Branch, Changes, Checks, Commit, GitSnapshot, PullRequest, RemoteBranch, SectionId } from '../types'

const PANE = 'git-branches'
const TITLE = 'Ветки'

const GREEN = '#3fb950'
const AMBER = '#d29922'
const RED = '#f85149'
const BLUE = '#58a6ff'

const snapshot = atom({ plugin: 'git-branches', key: 'snapshot' } as const, null)
const isLoading = atom({ plugin: 'git-branches', key: 'isLoading' } as const, false)
const collapsed = atom({ plugin: 'git-branches', key: 'collapsed' } as const, ['remote'] as SectionId[])

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

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

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
        prsNote = /auth|login/i.test(gh.stderr) ? 'войдите в gh: gh auth login' : 'gh не смог получить PR'
      }
    } catch {
      prsNote = 'установите GitHub CLI (gh), чтобы видеть PR'
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

/** Перечитать репозиторий; параллельные вызовы ждут один и тот же. */
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
    .catch(() => ({ exitCode: 1, stderr: 'git не запустился' }))
  if (result.exitCode !== 0) {
    $.ui.toast(`git fetch не удался: ${result.stderr.trim().split('\n')[0] ?? ''}`)
  }

  return refresh($)
}

// ── Отрисовка ────────────────────────────────────────────────────────────

const CHECK_MARKS: Record<Checks, { glyph: string; color?: string; text: string }> = {
  passing: { glyph: '✓', color: GREEN, text: 'проверки прошли' },
  failing: { glyph: '✗', color: RED, text: 'проверки упали' },
  pending: { glyph: '●', color: AMBER, text: 'проверки идут' },
  none: { glyph: '', text: '' },
}

const SECTION_TITLES: Record<SectionId, string> = {
  local: 'ЛОКАЛЬНЫЕ ВЕТКИ',
  prs: 'PULL REQUESTS',
  remote: 'УДАЛЁННЫЕ ВЕТКИ',
  commits: 'КОММИТЫ',
}

const LIST_LIMIT = 15

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'branches',
      description: 'Открыть панель веток Git (`/branches fetch` — сначала git fetch)',
    })
    // Первое чтение — вне старта сессии, чтобы не задерживать его; панель открывается сама только в git-проекте.
    $.clock.after(0, () => {
      void refresh($).then(found => (found?.isRepo ? $.ui.open({ id: PANE, title: TITLE }) : undefined))
    })
    $.clock.every(180_000, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'branches' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })
    const found = await (e.args.trim() === 'fetch' ? fetchAll($) : refresh($))

    return { text: found?.isRepo ? `Ветки: ${found.branches.length}, текущая ${found.current}.` : 'Эта папка не git-репозиторий.' }
  })

  // Claude мог закоммитить или переключить ветку — перечитываем после хода.
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
        <Button key="refresh" label="↻ Обновить" onPress={() => void refresh($)} />
        <Button key="fetch" label="⇣ Fetch" onPress={() => void fetchAll($)} />
      </Box>
    )

    if (!snap) {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>{loading ? 'Читаю репозиторий…' : 'Нет данных. Нажмите «Обновить».'}</Text>
          {toolbar}
        </Box>
      )
    }

    if (!snap.isRepo) {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text bold>Здесь нет git-репозитория</Text>
          <Text dimColor wrap="wrap">
            Откройте сессию в папке проекта с git — тут появятся ветки, PR и коммиты.
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
      unstaged ? `${unstaged} изменено` : '',
      staged ? `${staged} в индексе` : '',
      untracked ? `${untracked} ${plural(untracked, 'новый', 'новых', 'новых')}` : '',
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
          <Text dimColor>…и ещё {hidden}</Text>
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
              {branch.isGone ? <Text color={RED}>нет на сервере</Text> : null}
              {!branch.upstream && !branch.isGone ? <Text dimColor>только локально</Text> : null}
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
      const facts = [pr.branch, pr.isDraft ? 'черновик' : '', check.text, pr.review].filter(Boolean).join(' · ')

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
            <Text bold>{snap.current === 'HEAD' ? 'отсоединённый HEAD' : snap.current}</Text>
            {currentBranch?.ahead ? <Text color={GREEN}>↑{currentBranch.ahead} не запушено</Text> : null}
            {currentBranch?.behind ? <Text color={AMBER}>↓{currentBranch.behind} не подтянуто</Text> : null}
          </Box>
          <Text color={dirty ? AMBER : GREEN} wrap="truncate-end">
            {dirty ? `✎ ${changeParts.join(' · ')}` : '✓ рабочая копия чистая'}
          </Text>
          <Text dimColor>{loading ? 'обновляю…' : `обновлено ${relativeTime(Math.floor(snap.loadedAt / 1000), now)}`}</Text>
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
                      <Text dimColor>{snap.prsNote || 'открытых PR нет'}</Text>
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
