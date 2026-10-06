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

const GRAY = '#8b949e'

/** Высота строки текста на десктопе, в пикселях: по ней значки встают вровень с текстом. */
const LINE_PX = 20

/** Сколько строк показывать в секции, пока её не развернули. */
const SECTION_LIMIT = 5

type Mark = 'current' | 'branch' | 'remote' | 'pr' | 'draft' | 'passing' | 'failing' | 'running' | 'commit'

const MARKS: Record<Mark, { glyph: string; color?: string; alt: string }> = {
  current: { glyph: '●', color: GREEN, alt: 'текущая ветка' },
  branch: { glyph: '○', alt: 'ветка' },
  remote: { glyph: '◌', color: BLUE, alt: 'ветка на сервере' },
  pr: { glyph: '○', color: BLUE, alt: 'pull request' },
  draft: { glyph: '◌', alt: 'черновик' },
  passing: { glyph: '✓', color: GREEN, alt: 'проверки прошли' },
  failing: { glyph: '✗', color: RED, alt: 'проверки упали' },
  running: { glyph: '●', color: AMBER, alt: 'проверки идут' },
  commit: { glyph: '•', alt: 'коммит' },
}

const PR_MARKS: Record<Checks, Mark> = { passing: 'passing', failing: 'failing', pending: 'running', none: 'pr' }

/** Значки в том же стиле, что и на дорожной карте; у коммита — линия, как в графе GitLens. */
const iconSvg = (mark: Mark, size: number) => {
  const ring = (color: string, extra = '') =>
    `<circle cx="8" cy="8" r="5.8" fill="none" stroke="${color}" stroke-width="1.7"${extra}/>`
  const body: Record<Mark, string> = {
    current: `<circle cx="8" cy="8" r="6.4" fill="${GREEN}"/><circle cx="8" cy="8" r="2.4" fill="#fff"/>`,
    branch: ring(GRAY, ' stroke-opacity=".8"'),
    remote: ring(BLUE, ' stroke-dasharray="2.4 1.8"'),
    pr: ring(BLUE),
    draft: ring(GRAY, ' stroke-dasharray="2.4 1.8" stroke-opacity=".8"'),
    passing:
      `<circle cx="8" cy="8" r="7" fill="${GREEN}"/>` +
      `<path d="M4.9 8.2l2 2 4.2-4.4" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
    failing:
      `<circle cx="8" cy="8" r="7" fill="${RED}"/>` +
      `<path d="M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>`,
    running: `${ring(AMBER)}<circle cx="8" cy="8" r="2.6" fill="${AMBER}"/>`,
    commit:
      `<path d="M8 -20V4.6M8 11.4V36" stroke="${GRAY}" stroke-opacity=".45" stroke-width="1.4"/>` +
      `<circle cx="8" cy="8" r="3.3" fill="none" stroke="${GRAY}" stroke-width="1.6"/>`,
  }
  const unitsHigh = (LINE_PX * 16) / size

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${LINE_PX}" ` +
    `viewBox="0 ${(16 - unitsHigh) / 2} 16 ${unitsHigh}">${body[mark]}</svg>`
  )
}

const SECTION_TITLES: Record<SectionId, string> = {
  local: 'ВЕТКИ',
  prs: 'PULL REQUESTS',
  remote: 'НА СЕРВЕРЕ',
  commits: 'КОММИТЫ',
}

const short = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, Math.max(1, max - 1))}…` : line
}

/** «3 ч назад» → «3 ч»: в строках списка «назад» лишнее. */
const ago = (unixSeconds: number, now: number) => relativeTime(unixSeconds, now).replace(/ назад$/, '')

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
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Link } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined

    const snap = await read($, snapshot)
    const loading = await read($, isLoading)
    const open = await read($, expanded)
    const now = await $.clock.now()

    const columns = e.props.bodyColumns
    const narrow = columns < 44
    // Ширина текста рядом со значком. Тексты режем заранее: длинная строка с обрезкой
    // на десктопе всё равно занимает высоту, как если бы переносилась.
    const room = Math.max(16, columns - 4)

    const icon = (mark: Mark, isSmall = false) =>
      Svg ? (
        <Svg source={iconSvg(mark, isSmall ? 12 : 16)} alt={MARKS[mark].alt} width={isSmall ? 12 : 16} height={LINE_PX} />
      ) : (
        <Text color={MARKS[mark].color} dimColor={!MARKS[mark].color}>
          {MARKS[mark].glyph}
        </Text>
      )

    /** Строка списка: значок, главное и справа короткие пометки; под главным — пояснение. */
    const row = (key: string, mark: Mark, main: RenderChildren, right: RenderChildren, sub?: { text: string; color?: string }) => (
      <Box key={key} flexDirection="row" columnGap={1}>
        {icon(mark)}
        <Box key={`${key}-body`} flexDirection="column" flexGrow={1} flexShrink={1}>
          <Box key={`${key}-main`} flexDirection="row" justifyContent="space-between" columnGap={1}>
            {main}
            {right}
          </Box>
          {sub && !narrow ? (
            <Text color={sub.color} dimColor={!sub.color}>
              {short(sub.text, room)}
            </Text>
          ) : null}
        </Box>
      </Box>
    )

    const toolbar = (
      <Box key="toolbar" flexDirection="row" columnGap={1} flexShrink={0}>
        <Button key="refresh" label="↻ Обновить" onPress={() => void refresh($)} />
        <Button key="fetch" label="⇣ Fetch" onPress={() => void fetchAll($)} />
      </Box>
    )

    if (!snap || !snap.isRepo) {
      const title = !snap ? (loading ? 'Читаю репозиторий…' : 'Нет данных') : 'Здесь нет git-репозитория'
      const hint = !snap
        ? 'Нажмите «Обновить».'
        : 'Откройте сессию в папке проекта с git — тут появятся ветки, pull request’ы и коммиты.'

      return (
        <Box flexDirection="column" rowGap={1}>
          <Text bold>{title}</Text>
          <Text dimColor wrap="wrap">
            {hint}
          </Text>
          {toolbar}
        </Box>
      )
    }

    const web = snap.slug ? `https://github.com/${snap.slug}` : ''
    const prByBranch = new Map(snap.prs.map(pr => [pr.branch, pr]))
    const current = snap.branches.find(branch => branch.isCurrent)
    const others = snap.branches.filter(branch => !branch.isCurrent)
    const { staged, unstaged, untracked } = snap.changes
    const dirty = staged + unstaged + untracked
    const changeParts = [
      unstaged ? `${unstaged} изменено` : '',
      staged ? `${staged} в индексе` : '',
      untracked ? `${untracked} ${plural(untracked, 'новый', 'новых', 'новых')}` : '',
    ].filter(Boolean)

    const sync = !current
      ? { text: '', color: undefined }
      : !current.upstream
        ? { text: 'не опубликована', color: AMBER }
        : current.ahead || current.behind
          ? {
              text: [current.ahead ? `↑${current.ahead} не запушено` : '', current.behind ? `↓${current.behind} не подтянуто` : '']
                .filter(Boolean)
                .join(' · '),
              color: current.behind ? AMBER : GREEN,
            }
          : { text: 'синхронизирована', color: undefined }

    const toggle = (id: SectionId) => update($, expanded, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))

    /** Секция: заголовок текстом, первые строки и одна кнопка «Ещё N», если строк больше. */
    const section = (id: SectionId, title: string, rows: RenderChildren[], empty?: string) => {
      const isOpen = open.includes(id)
      const shown = isOpen ? rows : rows.slice(0, SECTION_LIMIT)

      return (
        <Box key={`section-${id}`} flexDirection="column" marginTop={1}>
          <Text dimColor bold>
            {title}
            {rows.length ? ` · ${rows.length}` : ''}
          </Text>
          {rows.length === 0 && empty ? <Text dimColor>{empty}</Text> : null}
          {shown}
          {rows.length > SECTION_LIMIT ? (
            <Button
              key={`more-${id}`}
              plain
              dimColor
              label={isOpen ? 'Свернуть' : `Ещё ${rows.length - SECTION_LIMIT}`}
              onPress={() => toggle(id)}
            />
          ) : null}
        </Box>
      )
    }

    const branchRow = (branch: Branch) => {
      const pr = prByBranch.get(branch.name)
      const badges = [
        branch.ahead ? { text: `↑${branch.ahead}`, color: GREEN } : null,
        branch.behind ? { text: `↓${branch.behind}`, color: AMBER } : null,
        branch.isGone ? { text: 'нет на сервере', color: RED } : null,
        !branch.upstream && !branch.isGone ? { text: 'только локально', color: undefined } : null,
        pr ? { text: `#${pr.number}`, color: BLUE } : null,
        narrow ? null : { text: ago(branch.time, now), color: undefined },
      ].filter((badge): badge is { text: string; color: string | undefined } => badge !== null)
      const width = badges.reduce((sum, badge) => sum + badge.text.length + 1, 0)
      const name = short(branch.name, room - width - 1)
      const href = web && branch.upstream && !branch.isGone ? `${web}/tree/${encodePath(branch.name)}` : ''

      return row(
        `local-${branch.name}`,
        pr && pr.checks !== 'none' ? PR_MARKS[pr.checks] : 'branch',
        href ? <Link href={href} label={name} /> : <Text>{name}</Text>,
        <Box key={`local-${branch.name}-badges`} flexDirection="row" columnGap={1} flexShrink={0}>
          {badges.map(badge => (
            <Text color={badge.color} dimColor={!badge.color}>
              {badge.text}
            </Text>
          ))}
        </Box>,
        { text: `${branch.hash} ${branch.subject}` },
      )
    }

    const prRow = (pr: PullRequest) => {
      const checks = { passing: 'проверки прошли', failing: 'проверки упали', pending: 'проверки идут', none: '' }[pr.checks]
      const facts = [pr.branch, pr.isDraft ? 'черновик' : '', checks, pr.review].filter(Boolean).join(' · ')
      const number = `#${pr.number}`

      return row(
        `pr-${pr.number}`,
        pr.isDraft ? 'draft' : PR_MARKS[pr.checks],
        <Link href={pr.url} label={short(pr.title, room - number.length - 1)} />,
        <Text color={pr.isDraft ? undefined : BLUE} dimColor={pr.isDraft}>
          {number}
        </Text>,
        { text: facts, color: pr.checks === 'failing' ? RED : undefined },
      )
    }

    const remoteRow = (branch: RemoteBranch) => {
      const time = narrow ? '' : ago(branch.time, now)
      const label = short(branch.name, room - time.length - 1)
      const path = branch.name.replace(/^[^/]+\//, '')

      return row(
        `remote-${branch.name}`,
        'remote',
        web ? <Link href={`${web}/tree/${encodePath(path)}`} label={label} /> : <Text>{label}</Text>,
        time ? <Text dimColor>{time}</Text> : null,
        { text: `${branch.author} · ${branch.subject}` },
      )
    }

    const commitRow = (commit: Commit) => {
      const time = narrow ? '' : ago(commit.time, now)
      const subject = short(commit.subject, room - commit.hash.length - time.length - 2)

      return (
        <Box key={`commit-${commit.hash}`} flexDirection="row" columnGap={1}>
          {icon('commit')}
          <Box key={`commit-${commit.hash}-main`} flexDirection="row" justifyContent="space-between" columnGap={1} flexGrow={1} flexShrink={1}>
            <Box key={`commit-${commit.hash}-text`} flexDirection="row" columnGap={1}>
              {web ? <Link href={`${web}/commit/${commit.hash}`} label={commit.hash} /> : <Text color={AMBER}>{commit.hash}</Text>}
              <Text>{subject}</Text>
            </Box>
            {time ? <Text dimColor>{time}</Text> : null}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box key="head" flexDirection="column">
          <Box key="head-top" flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
            <Text bold>{short(snap.slug || snap.root.split(/[\\/]/).pop() || 'репозиторий', room - 24)}</Text>
            {toolbar}
          </Box>
          <Box key="head-meta" flexDirection="row" columnGap={1}>
            <Text dimColor>{loading ? 'обновляю…' : `обновлено ${relativeTime(Math.floor(snap.loadedAt / 1000), now)}`}</Text>
            {web ? <Link href={web} label="открыть на GitHub" /> : null}
          </Box>
        </Box>

        <Box key="current" flexDirection="column" marginTop={1}>
          {row(
            'current-branch',
            'current',
            <Text bold>{short(snap.current === 'HEAD' ? 'отсоединённый HEAD' : snap.current, room - sync.text.length - 1)}</Text>,
            sync.text ? (
              <Text color={sync.color} dimColor={!sync.color}>
                {sync.text}
              </Text>
            ) : null,
            dirty
              ? { text: `✎ ${changeParts.join(' · ')}`, color: AMBER }
              : { text: '✓ рабочая копия чистая', color: GREEN },
          )}
        </Box>

        {section('local', SECTION_TITLES.local, others.map(branchRow), 'других веток нет')}

        {snap.slug ? section('prs', SECTION_TITLES.prs, snap.prs.map(prRow), snap.prsNote || 'открытых PR нет') : null}

        {snap.remotes.length > 0 ? section('remote', SECTION_TITLES.remote, snap.remotes.map(remoteRow)) : null}

        {section('commits', `${SECTION_TITLES.commits} · ${short(snap.current, 24)}`, snap.commits.map(commitRow), 'коммитов пока нет')}
      </Box>
    )
  })
}
