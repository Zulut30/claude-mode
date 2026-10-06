import { describe, expect, mock, test } from 'claude-code/testing'

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
  `main\torigin/main\tahead 2\ta1b2c3d\t${T - 3 * HOUR}\tИван\tfix: шапка`,
  `feature/login\torigin/feature/login\tbehind 5\tb2c3d4e\t${T - 48 * HOUR}\tАня\tfeat: вход`,
  `old\torigin/old\tgone\tc3d4e5f\t${T - 900 * 24 * HOUR}\tИван\tстарое`,
  `wip\t\t\td4e5f6a\t${T - 600}\tИван\tчерновик`,
].join('\n')

const REMOTES = [
  `origin\ta1b2c3d\t${T}\tИван\tfix`,
  `origin/HEAD\ta1b2c3d\t${T}\tИван\tfix`,
  `origin/main\ta1b2c3d\t${T}\tИван\tfix`,
  `origin/feature/login\tb2c3d4e\t${T}\tАня\tfeat`,
  `origin/hotfix\te5f6a7b\t${T - 5 * 24 * HOUR}\tПётр\thotfix: срочно`,
].join('\n')

const PRS = JSON.stringify([
  {
    number: 12,
    title: 'Страница входа',
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
  props: { title: 'Ветки', isFocused: false, bodyColumns: 72, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

describe('разбор вывода', () => {
  test('ветки, удалённые, статус, адрес GitHub', () => {
    const branches = parseBranches(HEADS, 'main')
    expect(branches[0]).toMatchObject({ name: 'main', ahead: 2, behind: 0, isCurrent: true, subject: 'fix: шапка' })
    expect(branches[1]).toMatchObject({ name: 'feature/login', behind: 5 })
    expect(branches[2]?.isGone).toBe(true)
    expect(branches[3]?.upstream).toBe('')

    expect(parseRemotes(REMOTES, branches).map(branch => branch.name)).toEqual(['origin/hotfix'])
    expect(parseStatus(GIT['git status --porcelain=v1'] ?? '')).toEqual({ staged: 1, unstaged: 1, untracked: 1 })
    expect(parseCommits(`a1\t${T}\tИван\tfix: a\tb`)).toEqual([{ hash: 'a1', time: T, author: 'Иван', subject: 'fix: a\tb' }])

    expect(parseGithubSlug('git@github.com:acme/site.git')).toBe('acme/site')
    expect(parseGithubSlug('https://github.com/acme/site')).toBe('acme/site')
    expect(parseGithubSlug('https://gitlab.com/acme/site.git')).toBe('')
  })

  test('PR и проверки', () => {
    expect(parsePrs(PRS)[0]).toMatchObject({ number: 12, branch: 'feature/login', checks: 'passing', review: 'одобрено' })
    expect(summarizeChecks([])).toBe('none')
    expect(summarizeChecks([{ status: 'IN_PROGRESS' }])).toBe('pending')
    expect(summarizeChecks([{ state: 'PENDING' }])).toBe('pending')
    expect(summarizeChecks([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { state: 'SUCCESS' }])).toBe('failing')
  })

  test('относительное время', () => {
    expect(relativeTime(T - 30, NOW)).toBe('только что')
    expect(relativeTime(T - 5 * 60, NOW)).toBe('5 мин назад')
    expect(relativeTime(T - 3 * HOUR, NOW)).toBe('3 ч назад')
    expect(relativeTime(T - 48 * HOUR, NOW)).toBe('2 д назад')
    expect(relativeTime(T - 900 * 24 * HOUR, NOW)).toBe('2 г назад')
  })
})

test('панель: ветки, PR, изменения и сворачивание секций', async ($, on) => {
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
      return ok(`a1b2c3d\t${T - 3 * HOUR}\tИван\tfix: шапка\nf0f0f0f\t${T - 30 * HOUR}\tАня\tinit`)
    }
    if (command.startsWith('gh pr list')) {
      return ok(PRS)
    }

    return ok(GIT[command] ?? '')
  })

  await $.command.run({ command: 'branches', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'git-branches', surface, ...PANE })
    expect(await ui.find({ type: 'Link', text: 'acme/site' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '↑2 не запушено' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✎ 1 изменено · 1 в индексе · 1 новый' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '#12' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'нет на сервере' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'только локально' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'Страница входа' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /проверки прошли · одобрено/ })).toBeDefined()
    // Удалённые свёрнуты по умолчанию.
    expect(await ui.find({ type: 'Link', text: 'origin/hotfix' })).toBeUndefined()
    await ui.press({ key: 'toggle-remote' })
    expect(await ui.find({ type: 'Link', text: 'origin/hotfix' })).toBeDefined()
    await ui.press({ key: 'toggle-remote' })
    await ui.unmount()
  }
})

test('не git-папка — понятное сообщение', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))

  const reply = await $.command.run({ command: 'branches', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(reply.text).toBe('Эта папка не git-репозиторий.')

  const ui = await $.ui.mount({ plugin: 'git-branches', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'Здесь нет git-репозитория' })).toBeDefined()
  await ui.unmount()
})
