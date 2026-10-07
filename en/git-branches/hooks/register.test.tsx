import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  parseBranches,
  parseCommits,
  parseGithubSlug,
  parsePrs,
  parseRemotes,
  parseStatus,
  relativeTime,
  summarizeChecks,
} from './register'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const HOUR = 3600
const T = NOW / 1000

const HEADS = [
  `main\torigin/main\tahead 2\ta1b2c3d\t${T - 3 * HOUR}\tIvan\tfix: header`,
  `feature/login\torigin/feature/login\tbehind 5\tb2c3d4e\t${T - 48 * HOUR}\tAnna\tfeat: login`,
  `old\torigin/old\tgone\tc3d4e5f\t${T - 900 * 24 * HOUR}\tIvan\told stuff`,
  `wip\t\t\td4e5f6a\t${T - 600}\tIvan\twork in progress`,
].join('\n')

const REMOTES = [
  `origin\ta1b2c3d\t${T}\tIvan\tfix`,
  `origin/HEAD\ta1b2c3d\t${T}\tIvan\tfix`,
  `origin/main\ta1b2c3d\t${T}\tIvan\tfix`,
  `origin/feature/login\tb2c3d4e\t${T}\tAnna\tfeat`,
  `origin/hotfix\te5f6a7b\t${T - 5 * 24 * HOUR}\tPeter\thotfix: urgent`,
].join('\n')

const PRS = JSON.stringify([
  {
    number: 12,
    title: 'Login page',
    headRefName: 'feature/login',
    isDraft: false,
    url: 'https://github.com/acme/site/pull/12',
    reviewDecision: 'APPROVED',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
  },
])

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const GIT: Record<string, string> = {
  'git rev-parse --show-toplevel': 'C:/code/site\n',
  'git rev-parse --abbrev-ref HEAD': 'main\n',
  'git status --porcelain=v1': ' M src/a.ts\nM  src/b.ts\n?? new.txt\n',
  'git remote get-url origin': 'git@github.com:acme/site.git\n',
}

const PANE = {
  component: 'Pane',
  requestId: 'git-branches',
  props: { title: 'Branches', isFocused: false, bodyColumns: 72, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

describe('parsing output', () => {
  test('branches, remotes, status, GitHub URL', () => {
    const branches = parseBranches(HEADS, 'main')
    expect(branches[0]).toMatchObject({ name: 'main', ahead: 2, behind: 0, isCurrent: true, subject: 'fix: header' })
    expect(branches[1]).toMatchObject({ name: 'feature/login', behind: 5 })
    expect(branches[2]?.isGone).toBe(true)
    expect(branches[3]?.upstream).toBe('')

    expect(parseRemotes(REMOTES, branches).map(branch => branch.name)).toEqual(['origin/hotfix'])
    expect(parseStatus(GIT['git status --porcelain=v1'] ?? '')).toEqual({ staged: 1, unstaged: 1, untracked: 1 })
    expect(parseCommits(`a1\t${T}\tIvan\tfix: a\tb`)).toEqual([{ hash: 'a1', time: T, author: 'Ivan', subject: 'fix: a\tb' }])

    expect(parseGithubSlug('git@github.com:acme/site.git')).toBe('acme/site')
    expect(parseGithubSlug('https://github.com/acme/site')).toBe('acme/site')
    expect(parseGithubSlug('https://gitlab.com/acme/site.git')).toBe('')
  })

  test('PRs and checks', () => {
    expect(parsePrs(PRS)[0]).toMatchObject({ number: 12, branch: 'feature/login', checks: 'passing', review: 'approved' })
    expect(summarizeChecks([])).toBe('none')
    expect(summarizeChecks([{ status: 'IN_PROGRESS' }])).toBe('pending')
    expect(summarizeChecks([{ state: 'PENDING' }])).toBe('pending')
    expect(summarizeChecks([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { state: 'SUCCESS' }])).toBe('failing')
  })

  test('relative time', () => {
    expect(relativeTime(T - 30, NOW)).toBe('just now')
    expect(relativeTime(T - 5 * 60, NOW)).toBe('5 min ago')
    expect(relativeTime(T - 3 * HOUR, NOW)).toBe('3h ago')
    expect(relativeTime(T - 48 * HOUR, NOW)).toBe('2d ago')
    expect(relativeTime(T - 900 * 24 * HOUR, NOW)).toBe('2y ago')
  })
})

test('pane: branches, PRs, changes, remotes and commits', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_, e) => {
    const command = e.argv.join(' ')
    if (command.startsWith('git for-each-ref') && command.endsWith('refs/heads')) {
      return ok(HEADS)
    }
    if (command.startsWith('git for-each-ref')) {
      return ok(REMOTES)
    }
    if (command.startsWith('git log')) {
      return ok(`a1b2c3d\t${T - 3 * HOUR}\tIvan\tfix: header\nf0f0f0f\t${T - 30 * HOUR}\tAnna\tinit`)
    }
    if (command.startsWith('gh pr list')) {
      return ok(PRS)
    }

    return ok(GIT[command] ?? '')
  })

  await $.command.run({ command: 'branches', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'git-branches', surface, ...PANE })

    // Header: the repository as text and the current branch, chips under them; two quiet buttons on the right.
    expect(await ui.find({ type: 'Text', text: /^acme\/site$/ })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'acme/site' })).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'refresh' }))?.text).toBe('↻')
    expect((await ui.find({ type: 'Button', key: 'fetch' }))?.text).toBe('⇣')
    expect(await ui.find({ type: 'Text', text: /^main$/ })).toBeDefined()
    // On desktop the marks are chips with padding on each side.
    expect(await ui.find({ type: 'Text', text: /^\s?↑2 unpushed\s?$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\s?✎ 3 changes\s?$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^updated just now$/ })).toBeDefined()

    // Branches: the current one is not repeated, the others have marks on the right.
    expect(await ui.find({ type: 'Text', text: /^BRANCHES$/ })).toBeDefined()
    expect(await ui.find({ key: 'local-main' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^feature\/login$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^↓5$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^#12$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^gone on remote$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^local only$/ })).toBeDefined()

    // PRs: only the number is a link.
    expect(await ui.find({ type: 'Link', text: '#12' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Login page$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^approved$/ })).toBeDefined()

    // Commits.
    expect(await ui.find({ type: 'Link', text: 'a1b2c3d' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^fix: header$/ })).toBeDefined()

    // "On remote" stays collapsed until "Show N" is pressed.
    expect(await ui.find({ type: 'Text', text: /^ON REMOTE$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^hotfix$/ })).toBeUndefined()
    expect((await ui.find({ key: 'more-remote' }))?.text).toBe('Show 1')
    await ui.press({ key: 'more-remote' })
    expect(await ui.find({ type: 'Text', text: /^hotfix$/ })).toBeDefined()
    expect((await ui.find({ key: 'more-remote' }))?.text).toBe('Collapse')
    await ui.press({ key: 'more-remote' })
    expect(await ui.find({ type: 'Text', text: /^hotfix$/ })).toBeUndefined()

    await ui.unmount()
  }
})

test('not a git folder: a clear message', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))

  const reply = await $.command.run({ command: 'branches', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(reply.text).toBe('This folder is not a git repository.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'git-branches', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^No git repository here$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Open a session in a project folder with git' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'BRANCHES' })).toBeUndefined()
    await ui.unmount()
  }
})

test('session folder is not git but the project is in a subfolder: the pane shows it', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.list', () => ({
    value: [
      { name: '.cache', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      { name: 'notes.txt', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
      { name: 'site', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    ],
  }))
  // The engine passes the path already made absolute.
  on('fs.exists', (_, e) => ({ value: e.path.replace(/\\/g, '/').endsWith('/site/.git') }))
  const dirs: (string | undefined)[] = []
  on('process.run', (_, e) => {
    dirs.push(e.init?.cwd)
    if (e.init?.cwd !== 'site') {
      return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    return ok(GIT[e.argv.join(' ')] ?? '')
  })

  const reply = await $.command.run({ command: 'branches', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(reply.text).toBe('Branches: 0, current main.')
  expect(dirs[0]).toBeUndefined()
  expect(dirs.slice(1).every(dir => dir === 'site')).toBe(true)
})

const sleep = (ms: number) =>
  new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, ms))

/**
 * ⇣ pressed while a background read (↻) is running. `readMs` is how long that read takes, `fetchMs` how
 * long git fetch takes; the test moves the time. Before the fetch feature/login is not behind, after it ↓5.
 */
const fetchDuringRefresh = (readMs: number, fetchMs: number): TestBody => async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const log: string[] = []
  let isFetched = false
  let isHeld = false
  on('process.run', async (_, e) => {
    const command = e.argv.join(' ')
    if (command.startsWith('git fetch')) {
      log.push('fetch')
      await clock.sleep(fetchMs)
      isFetched = true

      return ok('')
    }
    if (command.startsWith('git for-each-ref') && command.endsWith('refs/heads')) {
      // What a read sees is decided when it starts.
      const heads = isFetched ? HEADS : HEADS.replace('behind 5', '')
      log.push(isFetched ? 'read:after' : 'read:before')
      if (isHeld) {
        await clock.sleep(readMs)
      }

      return ok(heads)
    }
    if (command.startsWith('gh pr list')) {
      log.push('gh')

      return ok(PRS)
    }

    return ok(GIT[command] ?? '')
  })

  await $.command.run({ command: 'branches', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ plugin: 'git-branches', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^↓5$/ })).toBeUndefined()

  isHeld = true
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'fetch' })
  isHeld = false

  // The indicator at every step until the read and the fetch have both finished.
  const isLoadingSeen: boolean[] = []
  for (let at = 500; at < readMs + fetchMs; at += 500) {
    await clock.advance(500)
    await sleep(10)
    isLoadingSeen.push((await ui.find({ type: 'Text', text: /^updating…$/ })) !== undefined)
  }
  await clock.advance(500)
  await sleep(10)

  // The last snapshot was read after the fetch, and PRs were reloaded after it.
  expect(log.filter(entry => entry.startsWith('read:')).at(-1)).toBe('read:after')
  expect(log.lastIndexOf('gh')).toBeGreaterThan(log.indexOf('fetch'))
  expect(await ui.find({ type: 'Text', text: /^↓5$/ })).toBeDefined()
  // While anything ran: "updating…", even when one of the two had already finished; afterwards not.
  expect(isLoadingSeen.every(Boolean)).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^updated just now$/ })).toBeDefined()
  await ui.unmount()
}

test('⇣ during a long background read: the snapshot is from after the fetch, not one begun before it', fetchDuringRefresh(2000, 500))

test('⇣ during a short background read: "updating…" stays on until the fetch ends', fetchDuringRefresh(500, 2000))

test('long list: the first 6 branches and a "More N" button', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const many = ['main\torigin/main\t\ta0\t' + T + '\tIvan\tm']
    .concat(Array.from({ length: 7 }, (_, i) => `feat-${i}\t\t\tb${i}\t${T - i * HOUR}\tIvan\tf${i}`))
    .join('\n')
  on('process.run', (_, e) => {
    const command = e.argv.join(' ')
    if (command.startsWith('git for-each-ref') && command.endsWith('refs/heads')) {
      return ok(many)
    }

    return ok(GIT[command] ?? '')
  })

  await $.command.run({ command: 'branches', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'git-branches', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^BRANCHES$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^7$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^feat-5$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^feat-6$/ })).toBeUndefined()
    expect((await ui.find({ key: 'more-local' }))?.text).toBe('More 1')
    // No commits: a quiet line instead of an empty card.
    expect(await ui.find({ type: 'Text', text: /^No commits yet · no open PRs$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^COMMITS$/ })).toBeUndefined()

    await ui.press({ key: 'more-local' })
    expect(await ui.find({ type: 'Text', text: /^feat-6$/ })).toBeDefined()
    expect((await ui.find({ key: 'more-local' }))?.text).toBe('Collapse')

    await ui.press({ key: 'more-local' })
    expect(await ui.find({ type: 'Text', text: /^feat-6$/ })).toBeUndefined()
    await ui.unmount()
  }
})
