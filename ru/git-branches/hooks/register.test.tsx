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

test('панель: ветки, PR, изменения, удалённые и коммиты', async ($, on) => {
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

    // Шапка: репозиторий текстом и текущая ветка, под ними плашки; справа две тихие кнопки.
    expect(await ui.find({ type: 'Text', text: /^acme\/site$/ })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'acme/site' })).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'refresh' }))?.text).toBe('↻')
    expect((await ui.find({ type: 'Button', key: 'fetch' }))?.text).toBe('⇣')
    expect(await ui.find({ type: 'Text', text: /^main$/ })).toBeDefined()
    // На десктопе пометки — плашки с отступом по краям.
    expect(await ui.find({ type: 'Text', text: /^\s?↑2 не запушено\s?$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\s?✎ 3 изменения\s?$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^обновлено только что$/ })).toBeDefined()

    // Ветки: текущая не повторяется, у остальных — пометки справа.
    expect(await ui.find({ type: 'Text', text: /^ВЕТКИ$/ })).toBeDefined()
    expect(await ui.find({ key: 'local-main' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^feature\/login$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^↓5$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^#12$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^удалена на сервере$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^локальная$/ })).toBeDefined()

    // PR: ссылкой только номер.
    expect(await ui.find({ type: 'Link', text: '#12' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Страница входа$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^одобрено$/ })).toBeDefined()

    // Коммиты.
    expect(await ui.find({ type: 'Link', text: 'a1b2c3d' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^fix: шапка$/ })).toBeDefined()

    // «На сервере» свёрнута, пока не нажмут «Показать N».
    expect(await ui.find({ type: 'Text', text: /^НА СЕРВЕРЕ$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^hotfix$/ })).toBeUndefined()
    expect((await ui.find({ key: 'more-remote' }))?.text).toBe('Показать 1')
    await ui.press({ key: 'more-remote' })
    expect(await ui.find({ type: 'Text', text: /^hotfix$/ })).toBeDefined()
    expect((await ui.find({ key: 'more-remote' }))?.text).toBe('Свернуть')
    await ui.press({ key: 'more-remote' })
    expect(await ui.find({ type: 'Text', text: /^hotfix$/ })).toBeUndefined()

    await ui.unmount()
  }
})

test('не git-папка — понятное сообщение', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))

  const reply = await $.command.run({ command: 'branches', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(reply.text).toBe('Эта папка не git-репозиторий.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'git-branches', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^Здесь нет git-репозитория$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Откройте сессию в папке проекта с git' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ВЕТКИ' })).toBeUndefined()
    await ui.unmount()
  }
})

test('папка сессии не git, а проект лежит в подпапке — панель показывает его', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.list', () => ({
    value: [
      { name: '.cache', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      { name: 'notes.txt', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
      { name: 'site', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    ],
  }))
  // Движок отдаёт путь уже абсолютным.
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
  expect(reply.text).toBe('Ветки: 0, текущая main.')
  expect(dirs[0]).toBeUndefined()
  expect(dirs.slice(1).every(dir => dir === 'site')).toBe(true)
})

const sleep = (ms: number) =>
  new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, ms))

/**
 * ⇣ нажата, пока идёт фоновое чтение (↻). `readMs` — сколько оно идёт, `fetchMs` — сколько идёт
 * git fetch; время двигает тест. До fetch у feature/login отставания нет, после — ↓5.
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
      // Что видит чтение, решается в его начале.
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

  // Индикатор на каждом шаге, пока чтение и fetch вместе не закончились.
  const isLoadingSeen: boolean[] = []
  for (let at = 500; at < readMs + fetchMs; at += 500) {
    await clock.advance(500)
    await sleep(10)
    isLoadingSeen.push((await ui.find({ type: 'Text', text: /^обновляю…$/ })) !== undefined)
  }
  await clock.advance(500)
  await sleep(10)

  // Последний снимок прочитан после fetch, и PR перечитаны после него.
  expect(log.filter(entry => entry.startsWith('read:')).at(-1)).toBe('read:after')
  expect(log.lastIndexOf('gh')).toBeGreaterThan(log.indexOf('fetch'))
  expect(await ui.find({ type: 'Text', text: /^↓5$/ })).toBeDefined()
  // Пока шло хоть что-то — «обновляю…», даже когда одно из двух уже закончилось; потом — нет.
  expect(isLoadingSeen.every(Boolean)).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^обновлено только что$/ })).toBeDefined()
  await ui.unmount()
}

test('⇣ во время долгого фонового чтения: снимок — после fetch, а не начатый до него', fetchDuringRefresh(2000, 500))

test('⇣ во время короткого фонового чтения: «обновляю…» горит до конца fetch', fetchDuringRefresh(500, 2000))

test('длинный список: первые 6 веток и кнопка «Ещё N»', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const many = ['main\torigin/main\t\ta0\t' + T + '\tИван\tm']
    .concat(Array.from({ length: 7 }, (_, i) => `feat-${i}\t\t\tb${i}\t${T - i * HOUR}\tИван\tf${i}`))
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
    expect(await ui.find({ type: 'Text', text: /^ВЕТКИ$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^7$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^feat-5$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^feat-6$/ })).toBeUndefined()
    expect((await ui.find({ key: 'more-local' }))?.text).toBe('Ещё 1')
    // Коммитов нет — тихая строка вместо пустой карточки.
    expect(await ui.find({ type: 'Text', text: /^Коммитов пока нет · открытых PR нет$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^КОММИТЫ$/ })).toBeUndefined()

    await ui.press({ key: 'more-local' })
    expect(await ui.find({ type: 'Text', text: /^feat-6$/ })).toBeDefined()
    expect((await ui.find({ key: 'more-local' }))?.text).toBe('Свернуть')

    await ui.press({ key: 'more-local' })
    expect(await ui.find({ type: 'Text', text: /^feat-6$/ })).toBeUndefined()
    await ui.unmount()
  }
})
