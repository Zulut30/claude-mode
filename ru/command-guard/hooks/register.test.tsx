import { describe, expect, test } from 'claude-code/testing'
import type { FsEntry, On, ToolCallResult } from 'claude-code'

import { buildQuestion, classify, describeTarget, dryArgs, formatSize, plural, pushRange, refusal, resolvePath, warning } from './register'
import type { Dialect } from './register'

const kinds = (command: string, dialect?: Dialect) => classify(command, dialect).map(danger => danger.kind)

const FILES = ['файл', 'файла', 'файлов'] as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const
const BASH_RESULT = { result: { stdout: '', stderr: '', interrupted: false } }

const file = (name: string, size: number): FsEntry => ({ name, kind: 'file', size, mtimeMs: 0, isLink: false })
const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
/** `$.tool.call` с узкой подписью: полная тянет союз всех инструментов (с MCP), и TypeScript упирается в предел глубины. */
type ShellCall = (input: { tool: 'Bash' | 'PowerShell'; command: string }) => Promise<ToolCallResult>
const shell = ($: { tool: { call: unknown } }, tool: 'Bash' | 'PowerShell', command: string) => ($.tool.call as ShellCall)({ tool, command })
const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

describe('классификатор', () => {
  test('рекурсивное удаление в bash, в том числе в цепочках и за обёртками', () => {
    expect(kinds('rm -rf build')).toEqual(['delete'])
    expect(kinds('rm -r src/old')).toEqual(['delete'])
    expect(kinds('rm --recursive tmp')).toEqual(['delete'])
    expect(kinds('sudo rm -fR /var/cache/app')).toEqual(['delete'])
    expect(kinds('npm test && rm -rf dist || echo fail')).toEqual(['delete'])
    expect(kinds('npm run build; FORCE=1 rm -r out')).toEqual(['delete'])
    expect(kinds('find . -name "*.o" | xargs -0 rm -rf')).toEqual(['delete'])
    expect(kinds('echo $(rm -rf cache)')).toEqual(['delete'])
    expect(kinds('bash -c "rm -rf build"')).toEqual(['delete'])
    expect(kinds('if [ -d build ]; then rm -rf build; fi')).toEqual(['delete'])
    expect(kinds('for f in *.cache; do rm -r "$f"; done')).toEqual(['delete'])
  })

  test('не опасно: одиночный rm, текст в кавычках, тело heredoc, комментарий', () => {
    expect(kinds('rm file.txt')).toEqual([])
    expect(kinds('rm -f notes.txt build.log')).toEqual([])
    expect(kinds('echo "rm -rf /"')).toEqual([])
    expect(kinds("git commit -m 'chore: rm -rf build, git push --force, git reset --hard'")).toEqual([])
    expect(kinds('cat > run.sh <<EOF\nrm -rf /\ngit reset --hard\nEOF\nchmod +x run.sh')).toEqual([])
    expect(kinds("cat <<-'END' | sh -n\n\trm -rf build\n\tEND")).toEqual([])
    expect(kinds(`git commit -m "$(cat <<'EOF'\nfix: don't rm -rf build (git push --force later)\nEOF\n)"`)).toEqual([])
    expect(kinds('ls -la # rm -rf build')).toEqual([])
    expect(kinds('grep -r "TODO" src')).toEqual([])
    expect(kinds('rmdir empty-dir')).toEqual([])
    expect(kinds('ls > rm-rf.log 2>&1')).toEqual([])
  })

  test('git: что опасно, а что нет', () => {
    expect(classify('git push --force')).toEqual([{ kind: 'push', dir: '', isLease: false }])
    expect(classify('git push -f origin main')).toEqual([{ kind: 'push', dir: '', isLease: false, remote: 'origin', refspec: 'main' }])
    expect(kinds('git push origin +main')).toEqual(['push'])
    expect(classify('git push --force-with-lease origin feature')[0]).toMatchObject({ kind: 'push', isLease: true })
    expect(kinds('git push origin main')).toEqual([])
    expect(kinds('git push -u origin feature')).toEqual([])
    expect(classify('git reset --hard HEAD~2')).toEqual([{ kind: 'reset', dir: '', target: 'HEAD~2' }])
    expect(kinds('git reset --soft HEAD~1')).toEqual([])
    expect(classify('git clean -fdx')).toEqual([{ kind: 'clean', dir: '', args: ['-fdx'] }])
    expect(kinds('git clean -n')).toEqual([])
    expect(kinds('git clean -fdn')).toEqual([])
    expect(classify('git checkout -- .')).toEqual([{ kind: 'discard', dir: '', how: 'checkout', paths: ['.'] }])
    expect(kinds('git checkout .')).toEqual(['discard'])
    expect(kinds('git checkout main')).toEqual([])
    expect(kinds('git checkout -b feature')).toEqual([])
    expect(classify('git restore .')).toEqual([{ kind: 'discard', dir: '', how: 'restore', paths: ['.'] }])
    expect(kinds('git restore --staged .')).toEqual([])
    expect(kinds('git restore --staged --worktree src')).toEqual(['discard'])
    expect(classify('git branch -D old')).toEqual([{ kind: 'branch', dir: '', branches: ['old'] }])
    expect(kinds('git branch --delete --force old')).toEqual(['branch'])
    expect(kinds('git branch -d old')).toEqual([])
    expect(classify('git stash drop stash@{1}')).toEqual([{ kind: 'stash', dir: '', isClear: false, ref: 'stash@{1}' }])
    expect(kinds('git stash clear')).toEqual(['stash'])
    expect(kinds('git stash')).toEqual([])
    expect(kinds('git stash pop')).toEqual([])
    expect(classify('cd repo && git -C sub reset --hard')).toEqual([{ kind: 'reset', dir: 'repo/sub' }])
  })

  test('PowerShell и cmd', () => {
    expect(kinds('Remove-Item -Recurse -Force build', 'powershell')).toEqual(['delete'])
    expect(kinds('Remove-Item build -Recurse', 'powershell')).toEqual(['delete'])
    expect(kinds('rm -r build', 'powershell')).toEqual(['delete'])
    expect(kinds('ri .\\dist -rec', 'powershell')).toEqual(['delete'])
    expect(kinds('Get-ChildItem *.tmp | ForEach-Object { Remove-Item $_ -Recurse }', 'powershell')).toEqual(['delete'])
    expect(kinds('Remove-Item file.txt', 'powershell')).toEqual([])
    expect(kinds('Remove-Item build -Recurse -WhatIf', 'powershell')).toEqual([])
    expect(kinds('Remove-Item build -Recurse:$false', 'powershell')).toEqual([])
    expect(kinds("Write-Host 'Remove-Item -Recurse build'", 'powershell')).toEqual([])
    expect(kinds('git push --force; Write-Output done', 'powershell')).toEqual(['push'])
    expect(kinds('cmd /c rd /s /q build', 'powershell')).toEqual(['delete'])
    expect(kinds('rmdir /s /q build', 'powershell')).toEqual(['delete'])
    expect(kinds('cmd //c "del /s /q *.tmp"')).toEqual(['delete'])
    expect(kinds('powershell -Command "Remove-Item -Recurse -Force out"')).toEqual(['delete'])
  })

  test('цели и папка: cd, кавычки, ~, переменные и маски', () => {
    expect(classify('cd app && rm -rf node_modules "my dir" ~/cache $TMP/x *.log')).toEqual([
      {
        kind: 'delete',
        dir: 'app',
        targets: [
          { shown: 'node_modules', path: 'node_modules' },
          { shown: '"my dir"', path: 'my dir' },
          { shown: '~/cache', path: '~/cache' },
          { shown: '$TMP/x', path: null },
          { shown: '*.log', path: null },
        ],
      },
    ])
    expect(classify('rm -rf "$HOME/.cache" "C:\\Temp\\out"')[0]).toMatchObject({
      targets: [
        { shown: '"$HOME/.cache"', path: '~/.cache' },
        { shown: '"C:\\Temp\\out"', path: 'C:/Temp/out' },
      ],
    })
    expect(classify('Remove-Item -Path $env:USERPROFILE\\tmp -Recurse', 'powershell')[0]).toMatchObject({ targets: [{ path: '~/tmp' }] })
    expect(classify('xargs rm -rf')[0]).toMatchObject({ kind: 'delete', targets: [] })
  })

  test('пути: относительно папки сессии, ~, Git Bash /c/…', () => {
    expect(resolvePath('build', '/work')).toBe('/work/build')
    expect(resolvePath('../x/./y', '/work/app')).toBe('/work/x/y')
    expect(resolvePath('~/cache', '/work', '/home/me')).toBe('/home/me/cache')
    expect(resolvePath('~/cache', '/work')).toBeUndefined()
    expect(resolvePath('build', 'C:\\Users\\me\\proj')).toBe('C:/Users/me/proj/build')
    expect(resolvePath('/c/Temp/out', 'C:\\Users\\me')).toBe('C:/Temp/out')
    expect(warning('/', '/work')).toBe('это корень диска')
    expect(warning('C:/Users/Me', 'C:/Users/me/proj', 'C:\\Users\\me')).toBe('это вся домашняя папка')
    expect(warning('/work', '/work/app')).toBe('в ней папка проекта')
    expect(warning('/work/app/build', '/work/app')).toBeUndefined()
  })
})

describe('оформление', () => {
  test('размеры и числа', () => {
    expect(formatSize(512)).toBe('512 Б')
    expect(formatSize(3000)).toBe('2,9 КБ')
    expect(formatSize(5 * 1024 * 1024)).toBe('5 МБ')
    expect(plural(1, FILES)).toBe('1 файл')
    expect(plural(3, FILES)).toBe('3 файла')
    expect(plural(11, FILES)).toBe('11 файлов')
    expect(plural(21, FILES)).toBe('21 файл')
    expect(plural(2000, FILES)).toBe('2 000 файлов')
  })

  test('строка цели и вопрос', () => {
    expect(describeTarget('build', { kind: 'dir', files: 2, bytes: 3000, isPartial: false })).toBe('build — папка: 2 файла, 2,9 КБ')
    expect(describeTarget('node_modules', { kind: 'dir', files: 2000, bytes: 5 * 1024 * 1024, isPartial: true })).toBe(
      'node_modules — папка: ≥ 2 000 файлов, ≥ 5 МБ (посчитано не всё)',
    )
    expect(describeTarget('notes.txt', { kind: 'file', bytes: 120 })).toBe('notes.txt — файл, 120 Б')
    expect(describeTarget('old', { kind: 'missing' })).toBe('old — нет такого пути')
    expect(describeTarget('*.log', undefined)).toBe('*.log — не могу посчитать заранее')
    expect(describeTarget('~', { kind: 'dir', files: 0, bytes: 0, isPartial: false }, 'это вся домашняя папка')).toBe('~ — пустая папка — ⚠ это вся домашняя папка')
    expect(buildQuestion('rm   -rf\n build', ['• build — папка: 2 файла, 2,9 КБ'])).toBe('Claude хочет: rm -rf build\n• build — папка: 2 файла, 2,9 КБ')
    expect(refusal('rm -rf build', 'Отмена')).toMatch(/^Отменено: человек не разрешил «rm -rf build»/)
    expect(refusal('rm -rf build', undefined)).toMatch(/^Отменено: «rm -rf build» — опасная команда/)
    expect(refusal('rm -rf build', 'только dist')).toMatch(/^Отменено: на вопрос о «rm -rf build» человек ответил: «только dist»/)
  })

  test('git: диапазон force push и проба clean', () => {
    expect(pushRange({})).toBe('HEAD..@{u}')
    expect(pushRange({ remote: 'origin', refspec: '+main' })).toBe('main..origin/main')
    expect(pushRange({ remote: 'origin', refspec: 'HEAD:refs/heads/release' })).toBe('HEAD..origin/release')
    expect(dryArgs(['-fdx', '--force', 'build'])).toEqual(['-dx', 'build'])
    expect(dryArgs(['-f'])).toEqual([])
  })
})

/** Ответ на вопрос «Страховки» и всё, что спросили. */
const answering = (on: On, answer: () => string | undefined) => {
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]?.question ?? ''
    asked.push(question)
    const chosen = answer()

    return chosen === undefined ? { deny: 'нет диалога' } : { result: { questions: e.questions, answers: { [question]: chosen } } }
  })

  return asked
}

/** Папка сессии `/work`, всплывашки собираются. */
const session = (on: On) => {
  on('session.cwd', () => ({ value: '/work' }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return toasts
}

/** Пути в `fs.*` приходят абсолютными по правилам хоста (на Windows — `C:\work\build`): сводим к `/work/build`. */
const local = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

test('rm -rf: вопрос с размером папки; «Отмена» — отказ с причиной, команда не выполняется; «Выполнить» — выполняется', async ($, on) => {
  const toasts = session(on)
  on('fs.stat', ($, e) => ({ value: { kind: local(e.path) === '/work/build' ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false } }))
  const listed: string[] = []
  on('fs.list', ($, e) => {
    const path = local(e.path)
    listed.push(path)

    return { value: path === '/work/build' ? [file('a.js', 1000), dir('sub')] : path === '/work/build/sub' ? [file('b.js', 2000)] : [] }
  })
  let answer = 'Отмена'
  const asked = answering(on, () => answer)
  const commands: string[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    commands.push(e.command)

    return BASH_RESULT
  })

  const cancelled = await shell($, 'Bash', 'rm -rf build')
  expect(asked).toEqual(['Claude хочет: rm -rf build\n• build — папка: 2 файла, 2,9 КБ'])
  expect(listed).toEqual(['/work/build', '/work/build/sub'])
  expect(commands).toEqual([])
  expect(cancelled.deny).toMatch(/^Отменено: человек не разрешил «rm -rf build»/)
  expect(toasts).toEqual(['Страховка: не выполнено — rm -rf build'])

  answer = 'Выполнить'
  const done = await shell($, 'Bash', 'rm -rf build')
  expect(done.deny).toBeUndefined()
  expect(commands).toEqual(['rm -rf build'])
})

test('спросить нельзя (без диалога) — отказ, команда не выполняется', async ($, on) => {
  session(on)
  on('process.run', () => ran(''))
  answering(on, () => undefined)
  const commands: string[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    commands.push(e.command)

    return BASH_RESULT
  })

  const denied = await shell($, 'Bash', 'git stash clear')
  expect(commands).toEqual([])
  expect(denied.deny).toMatch(/^Отменено: «git stash clear» — опасная команда, её нужно подтвердить/)
})

test('безопасная команда и /guard off — без вопроса; /guard on — снова спрашивает', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('store.get', () => ({ value: undefined }))
  const saved: unknown[] = []
  on('store.set', (_, e) => {
    saved.push(e.value)

    return { value: undefined }
  })
  session(on)
  on('process.run', () => ran(''))
  const asked = answering(on, () => 'Выполнить')
  const commands: string[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    commands.push(e.command)

    return BASH_RESULT
  })

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await shell($, 'Bash', 'ls -la && rm notes.txt && echo "rm -rf /"')
  expect(asked).toEqual([])

  const off = await $.command.run({ command: 'guard', args: 'off', ...RUN })
  expect(off.text).toMatch(/^Страховка выключена/)
  expect(saved).toEqual([true])
  await shell($, 'Bash', 'git reset --hard')
  expect(asked).toEqual([])
  expect((await $.command.run({ command: 'guard', args: '', ...RUN })).text).toMatch(/^Страховка выключена\. Включить: \/guard on$/)

  await $.command.run({ command: 'guard', args: 'on', ...RUN })
  expect(saved).toEqual([true, false])
  await shell($, 'Bash', 'git reset --hard')
  expect(asked.length).toBe(1)
  expect(commands).toEqual(['ls -la && rm notes.txt && echo "rm -rf /"', 'git reset --hard', 'git reset --hard'])
})

/** Другой плагин, который сам запускает Bash по своей команде `/cleanup`. */
const HELPER = {
  name: 'helper',
  register: (on: On) => {
    on('command.run', { command: 'cleanup' }, async $ => {
      // Модуль этого плагина собирается отдельно — помощник `shell` ему не виден; подпись та же, узкая.
      const done = await ($.tool.call as unknown as ShellCall)({ tool: 'Bash', command: 'rm -rf build' })

      return { text: done.deny ?? 'ok' }
    })
  },
}

test('вызов Bash от другого плагина проходит без вопроса', { plugins: [HELPER] }, async ($, on) => {
  const asked = answering(on, () => 'Отмена')
  const commands: string[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    commands.push(e.command)

    return BASH_RESULT
  })

  const reply = await $.command.run({ command: 'cleanup', args: '', ...RUN })
  expect(reply.text).toBe('ok')
  expect(asked).toEqual([])
  expect(commands).toEqual(['rm -rf build'])
})

test('git: что пропадёт при force push, reset --hard и branch -D; git — без блокировок и с таймаутом', async ($, on) => {
  session(on)
  const runs: string[] = []
  on('process.run', ($, e) => {
    runs.push(e.argv.join(' '))
    expect(e.init?.env?.GIT_OPTIONAL_LOCKS).toBe('0')
    expect(e.init?.timeoutMs).toBe(5000)
    const args = e.argv.slice(1).join(' ')
    if (args === 'log --oneline HEAD..@{u}') {
      return ran('abc1234 fix login\ndef5678 add tests\n')
    }
    if (args === 'status --porcelain') {
      return ran(' M src/a.ts\nM  src/b.ts\n?? notes.txt\n')
    }
    if (args === 'diff HEAD --shortstat') {
      return ran(' 2 files changed, 40 insertions(+), 12 deletions(-)\n')
    }
    if (args === 'log --oneline old --not --remotes HEAD') {
      return ran('9a8b7c6 wip: experiment\n')
    }

    return ran('', 128)
  })
  const asked = answering(on, () => 'Отмена')
  on('tool.call', { tool: 'Bash' }, () => BASH_RESULT)
  on('tool.call', { tool: 'PowerShell' }, () => BASH_RESULT)

  await shell($, 'Bash', 'git push --force')
  expect(asked[0]).toBe(
    'Claude хочет: git push --force\n• git push --force: с remote пропадут 2 коммита, которых у вас нет:\n    abc1234 fix login\n    def5678 add tests',
  )

  await shell($, 'Bash', 'git reset --hard')
  expect(asked[1]).toBe('Claude хочет: git reset --hard\n• git reset --hard: пропадут правки в 2 файлах (+40 −12 строк): src/a.ts, src/b.ts')

  await shell($, 'PowerShell', 'git branch -D old')
  expect(asked[2]).toBe('Claude хочет: git branch -D old\n• ветка old: 1 коммит только в ней — нет ни на remote, ни в текущей ветке:\n    9a8b7c6 wip: experiment')
  expect(runs.every(run => run.startsWith('git '))).toBe(true)
})
