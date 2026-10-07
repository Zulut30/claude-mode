// «Страховка»: перед опасной командой Claude (rm -r, git push --force, reset --hard, clean -f…) вызов останавливается,
// человек видит, что именно пропадёт, и выбирает «Выполнить» или «Отмена». При отмене Claude получает причину и не повторяет вслепую.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

const HEADER = 'Страховка'
const RUN = 'Выполнить'
const CANCEL = 'Отмена'
/** Ключ в хранилище мода: выключена ли страховка (переживает перезапуск). */
const OFF_KEY = 'isOff'
/** Предпросмотр не ждёт дольше: git — по 5 с на вызов, обход папок — 5 с на всё. */
const TIMEOUT_MS = 5_000
/** Обход папки: не больше стольких записей и уровней вглубь; папок за раз. */
const MAX_ENTRIES = 2_000
const MAX_DEPTH = 6
const BATCH = 8
/** Команда в вопросе — одной строкой, не длиннее. */
const MAX_COMMAND = 100
/** Сколько путей и коммитов называть поимённо, сколько строк в вопросе всего. */
const MAX_TARGETS = 6
const MAX_ITEMS = 3
const MAX_LINES = 16
/** Чтение статуса не берёт index.lock и не мешает git, запущенному рядом. */
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' }
/** Что ловит страховка — для `/guard`. */
const WATCHED = 'rm -r, Remove-Item -Recurse, rd /s, git push --force, reset --hard, clean -f, checkout -- ., restore ., branch -D, stash drop/clear'

const isOff = atom({ plugin: 'command-guard', key: 'isOff' } as const, false)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Имя занято другим плагином — команды не будет, но остальной старт сессии должен пройти.
    await $.command
      .register({ name: 'guard', description: 'Страховка от опасных команд: `/guard off` — выключить, `/guard on` — включить' })
      .catch(() => undefined)
    const saved = await $.store.get(OFF_KEY).catch(() => undefined)
    await update($, isOff, () => saved === true)

    return next(e)
  })

  on('command.run', { command: 'guard' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      const off = arg === 'off'
      await update($, isOff, () => off)
      await $.store.set(OFF_KEY, off).catch(() => undefined)

      return {
        text: off
          ? 'Страховка выключена: опасные команды Claude выполнит без вопроса. Включить: /guard on'
          : 'Страховка включена: перед опасной командой Claude спросит вас и покажет, что пропадёт.',
      }
    }

    return {
      text: (await read($, isOff))
        ? 'Страховка выключена. Включить: /guard on'
        : `Страховка включена: ${WATCHED}. Перед такой командой Claude спросит вас и покажет, что пропадёт. Выключить: /guard off`,
    }
  })

  // Вызовы других плагинов — их забота: страхуем только самого Claude (и его субагентов).
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = next.origin.plugin === 'engine' ? await guard($, e.command, 'bash') : undefined

    return deny === undefined ? next(e) : { deny }
  })

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const deny = next.origin.plugin === 'engine' ? await guard($, e.command, 'powershell') : undefined

    return deny === undefined ? next(e) : { deny }
  })
}

/** Опасная команда — спросить человека. Ответ: причина отказа для Claude или undefined — выполнять. */
const guard = async ($: EngineInterface, command: string, dialect: Dialect): Promise<string | undefined> => {
  if (await read($, isOff)) {
    return undefined
  }
  const dangers = classify(command, dialect)
  if (dangers.length === 0) {
    return undefined
  }
  const lost = await preview($, dangers).catch(() => ['• не удалось посчитать, что пропадёт'])
  // Спросить не вышло (запуск без диалога, вопрос закрыли) — безопасный ответ: не выполнять.
  const answer = await $.ui.ask(buildQuestion(command, lost), { header: HEADER, options: [RUN, CANCEL] }).catch(() => undefined)
  if (answer === RUN) {
    return undefined
  }
  $.ui.toast(`Страховка: не выполнено — ${oneLine(command, 60)}`)

  return refusal(command, answer)
}

// ── Разбор команды ───────────────────────────────────────────────────────

export type Dialect = 'bash' | 'powershell' | 'cmd'

/** Слово команды: текст без кавычек и экранирования; как написано; начинается ли с `~`/`$HOME`; есть ли в нём переменная, подстановка или маска. */
export type Word = { value: string; raw: string; home: boolean; dynamic: boolean }

/** Что удаляется: как написано и путь (`~/…`, относительный или абсолютный); `null` — заранее не узнать. */
export type Target = { shown: string; path: string | null }

/** Опасная часть команды. `dir` — где она выполнится: '' — папка сессии, путь — после `cd` или `git -C`, `null` — не узнать. */
export type Danger = { dir: string | null } & (
  | { kind: 'delete'; targets: Target[] }
  | { kind: 'push'; isLease: boolean; remote?: string; refspec?: string }
  | { kind: 'reset'; target?: string }
  | { kind: 'discard'; how: 'checkout' | 'restore'; paths: string[] }
  | { kind: 'clean'; args: string[] }
  | { kind: 'branch'; branches: string[] }
  | { kind: 'stash'; isClear: boolean; ref?: string }
)

/** Закрывающая скобка к открывающей на `open`; строки в кавычках пропускаются. */
const matching = (src: string, open: number) => {
  const [opening, closing] = src.charAt(open) === '(' ? ['(', ')'] : ['{', '}']
  let depth = 0
  for (let j = open; j < src.length; j += 1) {
    const c = src.charAt(j)
    if (c === "'" || c === '"') {
      const close = src.indexOf(c, j + 1)
      if (close < 0) {
        return src.length
      }
      j = close
    } else if (c === opening) {
      depth += 1
    } else if (c === closing && --depth === 0) {
      return j
    }
  }

  return src.length
}

/** Пропускает тело heredoc: строки до строки-метки включительно. */
const skipDoc = (src: string, from: number, doc: { tag: string; strip: boolean }) => {
  let j = from
  while (j < src.length) {
    const nl = src.indexOf('\n', j)
    const line = src.slice(j, nl < 0 ? src.length : nl).replace(/\r$/, '')
    j = nl < 0 ? src.length : nl + 1
    if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.tag) {
      break
    }
  }

  return j
}

/**
 * Разбивает команду на простые команды (по `;`, `&&`, `||`, `|`, `&`, переводу строки) и их слова.
 * Кавычки снимает, тела heredoc, here-строки и комментарии не считает командами, цели перенаправлений (`> file`) выбрасывает.
 * `nested` — тексты `$(…)`, `` `…` `` и блоков PowerShell `(…)`/`{…}`: их проверяют отдельно.
 */
export function split(src: string, dialect: Dialect): { segments: Word[][]; nested: string[] } {
  const ps = dialect === 'powershell'
  const cmd = dialect === 'cmd'
  const escape = ps ? '`' : cmd ? '^' : '\\'
  // Имя переменной с позиции lastIndex (флаг y), без копий хвоста строки.
  const NAME = ps ? /[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?/y : /[A-Za-z_][A-Za-z0-9_]*/y
  const segments: Word[][] = []
  const nested: string[] = []
  const docs: { tag: string; strip: boolean }[] = []
  let words: Word[] = []
  let word: Word | undefined
  let start = 0
  let isRedirect = false
  let i = 0

  const at = () => {
    if (!word) {
      word = { value: '', raw: '', home: false, dynamic: false }
      start = i
    }

    return word
  }
  const end = () => {
    if (!word) {
      return
    }
    word.raw = src.slice(start, i).trim()
    if (!isRedirect) {
      words.push(word)
    }
    isRedirect = false
    word = undefined
  }
  const cut = () => {
    end()
    isRedirect = false
    if (words.length > 0) {
      segments.push(words)
    }
    words = []
  }
  // `$HOME` (и `$env:USERPROFILE` в PowerShell) в начале слова — домашняя папка; любая другая переменная — заранее не узнать.
  const variable = (w: Word, name: string) => {
    const lower = name.toLowerCase()
    if (ps && (lower === 'true' || lower === 'false' || lower === 'null')) {
      w.value += `$${lower}`

      return
    }
    const isHome = ps ? ['home', 'env:home', 'env:userprofile'].includes(lower) : cmd ? lower === 'userprofile' : name === 'HOME'
    if (isHome && w.value === '' && !w.home && !w.dynamic) {
      w.home = true
    } else {
      w.dynamic = true
    }
  }
  const dollar = () => {
    const w = at()
    const after = src.charAt(i + 1)
    if (after === '(') {
      const close = matching(src, i + 1)
      const inner = src.slice(i + 2, close)
      // `$((…))` — арифметика, не команда.
      if (!inner.startsWith('(')) {
        nested.push(inner)
      }
      w.dynamic = true

      return close + 1
    }
    if (after === '{') {
      const close = src.indexOf('}', i + 2)
      variable(w, src.slice(i + 2, close < 0 ? src.length : close))

      return close < 0 ? src.length : close + 1
    }
    if (dialect === 'bash' && after === "'") {
      const close = src.indexOf("'", i + 2)
      w.value += src.slice(i + 2, close < 0 ? src.length : close)

      return close < 0 ? src.length : close + 1
    }
    NAME.lastIndex = i + 1
    const name = NAME.exec(src)?.[0]
    if (name) {
      variable(w, name)

      return i + 1 + name.length
    }
    if (/^[0-9?@*#!$_-]$/.test(after)) {
      w.dynamic = true

      return i + 2
    }
    w.value += '$'

    return i + 1
  }
  const percent = () => {
    const w = at()
    const close = src.indexOf('%', i + 1)
    const name = close < 0 ? '' : src.slice(i + 1, close)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      w.dynamic = true

      return i + 1
    }
    variable(w, name)

    return close + 1
  }
  const backtick = () => {
    const close = src.indexOf('`', i + 1)
    nested.push(src.slice(i + 1, close < 0 ? src.length : close))
    at().dynamic = true

    return close < 0 ? src.length : close + 1
  }
  const block = () => {
    const open = src.charAt(i) === '@' ? i + 1 : i
    const close = matching(src, open)
    nested.push(src.slice(open + 1, close))
    at().dynamic = true

    return close + 1
  }
  const single = () => {
    const w = at()
    let j = i + 1
    for (;;) {
      const close = src.indexOf("'", j)
      if (close < 0) {
        w.value += src.slice(j)

        return src.length
      }
      w.value += src.slice(j, close)
      // В PowerShell '' внутри одинарных кавычек — сама кавычка.
      if (ps && src.charAt(close + 1) === "'") {
        w.value += "'"
        j = close + 2
        continue
      }

      return close + 1
    }
  }
  const double = () => {
    const w = at()
    i += 1
    while (i < src.length && src.charAt(i) !== '"') {
      const d = src.charAt(i)
      const after = src.charAt(i + 1)
      // В bash внутри "…" обратная косая экранирует только $ ` " \ и перевод строки: "C:\Users" остаётся как есть.
      if (!cmd && d === escape && after !== '' && (ps || '$`"\\\n'.includes(after))) {
        w.value += after
        i += 2
      } else if (!cmd && d === '$') {
        i = dollar()
      } else if (dialect === 'bash' && d === '`') {
        i = backtick()
      } else if (cmd && d === '%') {
        i = percent()
      } else {
        w.value += d
        i += 1
      }
    }

    return i + 1
  }
  const heredoc = () => {
    end()
    let j = i + 2
    const strip = src.charAt(j) === '-'
    if (strip) {
      j += 1
    }
    while (src.charAt(j) === ' ' || src.charAt(j) === '\t') {
      j += 1
    }
    let tag = ''
    while (j < src.length && !/[\s;&|<>()]/.test(src.charAt(j))) {
      if (!`'"\\`.includes(src.charAt(j))) {
        tag += src.charAt(j)
      }
      j += 1
    }
    if (tag) {
      docs.push({ tag, strip })
    }

    return j
  }
  const redirect = () => {
    // `2>` и `*>`: число перед стрелкой — номер потока, а не слово команды.
    if (word && /^(\d+|\*)$/.test(word.value)) {
      word = undefined
    } else {
      end()
    }
    let j = i + 1
    while (src.charAt(j) !== '' && '<>&|'.includes(src.charAt(j))) {
      j += 1
    }
    isRedirect = true

    return j
  }

  while (i < src.length) {
    const c = src.charAt(i)
    const next = src.charAt(i + 1)
    if (c === '\n') {
      cut()
      i += 1
      for (const doc of docs.splice(0)) {
        i = skipDoc(src, i, doc)
      }
    } else if (c === ' ' || c === '\t' || c === '\r') {
      end()
      i += 1
    } else if (c === escape) {
      // Экран перед переводом строки — продолжение строки.
      if (next === '\n' || next === '\r') {
        i += next === '\r' && src.charAt(i + 2) === '\n' ? 3 : 2
      } else {
        at().value += next
        i += 2
      }
    } else if (c === '#' && !word && !cmd) {
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? src.length : nl
    } else if (ps && c === '<' && next === '#') {
      const close = src.indexOf('#>', i + 2)
      i = close < 0 ? src.length : close + 2
    } else if (c === "'" && !cmd) {
      i = single()
    } else if (c === '"') {
      i = double()
    } else if (ps && c === '@' && (next === "'" || next === '"') && /^\r?\n/.test(src.slice(i + 2, i + 4))) {
      // Here-строка PowerShell @'…'@ — одно слово, его тело не команда.
      const close = src.indexOf(`\n${next}@`, i + 2)
      at().value += src.slice(i + 2, close < 0 ? src.length : close)
      i = close < 0 ? src.length : close + 3
    } else if (c === '$' && !cmd) {
      i = dollar()
    } else if (c === '%' && cmd) {
      i = percent()
    } else if (c === '`' && dialect === 'bash') {
      i = backtick()
    } else if (ps && (c === '(' || c === '{' || (c === '@' && (next === '(' || next === '{')))) {
      i = block()
    } else if (c === '~' && !word && /^([\\/\s;&|)]|)$/.test(next)) {
      at().home = true
      i += 1
    } else if (c === '*' || c === '?' || c === '[') {
      const w = at()
      w.dynamic = true
      w.value += c
      i += 1
    } else if (dialect === 'bash' && c === '<' && next === '<' && src.charAt(i + 2) !== '<') {
      i = heredoc()
    } else if (c === '>' || c === '<' || (c === '&' && next === '>' && !ps)) {
      i = redirect()
    } else if (ps && c === ',') {
      end()
      i += 1
    } else if (ps && c === '&' && next !== '&') {
      // `& "C:\tool.exe"` — оператор вызова, отдельное слово.
      end()
      at().value = '&'
      i += 1
      end()
    } else if (';|&)'.includes(c) || (c === '(' && !ps) || (c === '}' && ps)) {
      // Конец простой команды; `{`/`}` в bash — слова (снимаются ниже), в PowerShell блок читается целиком выше.
      cut()
      i += 1
    } else {
      at().value += c
      i += 1
    }
  }
  cut()

  return { segments, nested }
}

/** Обёртки, за которыми идёт настоящая команда, и их ключи со значением: `sudo -u root rm …`, `xargs -n 1 rm …`. */
const WRAPPERS = new Map([
  ['sudo', 'ugCDhprt'],
  ['doas', 'uC'],
  ['env', 'uSC'],
  ['xargs', 'nILPdEsa'],
  ['nice', 'n'],
  ['timeout', 'sk'],
  ['stdbuf', 'ioe'],
  ['nohup', ''],
  ['time', 'fo'],
  ['command', ''],
  ['builtin', ''],
  ['exec', 'a'],
])
const KEYWORDS = new Set(['!', '{', '}', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '&', '.'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const CD = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location'])
const PS_REMOVE = new Set(['remove-item', 'ri', 'rm', 'rmdir', 'rd', 'del', 'erase'])
const CMD_REMOVE = new Set(['rmdir', 'rd', 'del', 'erase'])

/** Имя команды: без папки, `.exe` и регистра. */
export const commandName = (word: string) =>
  word
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase()

/** Снимает с простой команды присваивания, ключевые слова и обёртки (sudo, env, xargs…). */
const unwrap = (words: Word[]) => {
  let rest = words
  for (;;) {
    const first = rest[0]
    if (!first) {
      return rest
    }
    if (KEYWORDS.has(first.value) || ASSIGNMENT.test(first.value)) {
      rest = rest.slice(1)
      continue
    }
    const name = commandName(first.value)
    const valued = WRAPPERS.get(name)
    if (valued === undefined) {
      return rest
    }
    let k = 1
    while (k < rest.length) {
      const value = rest[k]?.value ?? ''
      if (/^-[A-Za-z]$/.test(value) && valued.includes(value.slice(1))) {
        k += 2
      } else if (value.startsWith('-') || (name === 'env' && ASSIGNMENT.test(value))) {
        k += 1
      } else {
        break
      }
    }
    // У timeout после ключей — длительность.
    rest = rest.slice(name === 'timeout' ? k + 1 : k)
  }
}

/** Путь из слова: `~/…` для домашней папки, `null` — в нём переменная, подстановка или маска. */
export const wordPath = (w: Word | undefined): string | null => {
  if (!w || w.dynamic) {
    return null
  }
  const value = w.value.replace(/\\/g, '/')

  return w.home ? `~${value}` : value.startsWith('~') ? `./${value}` : value
}

const isAbsolute = (path: string) => /^([A-Za-z]:)?[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)

/** `cd base` и затем `path`: абсолютный путь и `~` заменяют базу, относительный дописывается. */
export const joinPath = (base: string | null, path: string | null): string | null => {
  if (base === null || path === null) {
    return null
  }
  if (path === '' || path === '.') {
    return base
  }

  return base === '' || isAbsolute(path) || path.startsWith('~') ? path : `${base.replace(/\/+$/, '')}/${path}`
}

/** Скрипт внутри `bash -c`, `powershell -Command`, `cmd /c`, `iex`. */
const innerScript = (name: string, args: Word[]): { script: string; dialect: Dialect } | undefined => {
  const values = args.map(w => w.value)
  if (SHELLS.has(name)) {
    const k = values.findIndex(v => /^-[a-z]*c[a-z]*$/.test(v))
    const script = k >= 0 ? values[k + 1] : undefined

    return script === undefined ? undefined : { script, dialect: 'bash' }
  }
  if (name === 'powershell' || name === 'pwsh') {
    const k = values.findIndex(v => /^[-/](c|command)$/i.test(v))

    return k >= 0 ? { script: values.slice(k + 1).join(' '), dialect: 'powershell' } : undefined
  }
  if (name === 'cmd') {
    const k = values.findIndex(v => /^\/\/?[ck]$/i.test(v))

    return k >= 0 ? { script: values.slice(k + 1).join(' '), dialect: 'cmd' } : undefined
  }

  return name === 'iex' || name === 'invoke-expression' ? { script: values.join(' '), dialect: 'powershell' } : undefined
}

const deletion = (words: Word[]): Danger => ({
  kind: 'delete',
  dir: '',
  targets: words.map(w => ({ shown: oneLine(w.raw || w.value, 40), path: wordPath(w) })),
})

/** `rm -r`, `-R`, `-rf`, `--recursive`; одиночный `rm file` не опасен. */
const rm = (args: Word[]): Danger | undefined => {
  let isRecursive = false
  let isOptions = true
  const targets: Word[] = []
  for (const w of args) {
    if (isOptions && w.value === '--') {
      isOptions = false
    } else if (isOptions && w.value.startsWith('--')) {
      isRecursive ||= w.value === '--recursive'
    } else if (isOptions && /^-[A-Za-z]+$/.test(w.value)) {
      isRecursive ||= /r/i.test(w.value)
    } else {
      targets.push(w)
    }
  }

  return isRecursive ? deletion(targets) : undefined
}

/** `Remove-Item … -Recurse` и его сокращения (`rm -r`, `ri -rec`); с `-WhatIf` — только проба. */
const removeItem = (args: Word[]): Danger | undefined => {
  let isRecursive = false
  let isDryRun = false
  const targets: Word[] = []
  for (let k = 0; k < args.length; k += 1) {
    const w = args[k]
    if (!w) {
      continue
    }
    const flag = /^-([A-Za-z]+)(?::(.*))?$/.exec(w.value)
    if (!flag) {
      targets.push(w)
      continue
    }
    const param = (flag[1] ?? '').toLowerCase()
    const value = flag[2]
    const isOn = value?.toLowerCase() !== '$false'
    const named = (full: string, min = 1) => param.length >= min && full.startsWith(param)
    if (named('recurse') || param === 'rf' || param === 'fr') {
      isRecursive ||= isOn
    } else if (named('whatif', 2)) {
      isDryRun = isOn
    } else if (named('path') || named('literalpath') || param === 'lp' || param === 'pspath') {
      const path = value !== undefined ? { ...w, value, raw: value } : args[++k]
      if (path) {
        targets.push(path)
      }
    } else if (value === undefined && ['filter', 'include', 'exclude', 'credential', 'stream'].some(full => named(full, 3))) {
      k += 1
    }
  }

  return isRecursive && !isDryRun ? deletion(targets) : undefined
}

/** Опасные подкоманды git; `git -C <папка>` меняет, где они выполнятся. */
const gitDanger = (argv: Word[]): Danger | undefined => {
  let dir: string | null = ''
  let k = 0
  while (k < argv.length && (argv[k]?.value ?? '').startsWith('-')) {
    const value = argv[k]?.value ?? ''
    if (value === '-C') {
      dir = joinPath(dir, wordPath(argv[k + 1]))
    }
    k += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(value) ? 2 : 1
  }
  const args = argv.slice(k + 1).map(w => w.value)
  const positional = args.filter(a => !a.startsWith('-'))
  const has = (...flags: string[]) => args.some(a => flags.includes(a))
  const short = (letter: string) => args.some(a => /^-[A-Za-z]+$/.test(a) && a.includes(letter))

  switch (argv[k]?.value) {
    case 'push': {
      const isForce = has('--force') || short('f') || positional.slice(1).some(p => p.startsWith('+'))
      const isLease = args.some(a => a.startsWith('--force-with-lease'))
      const [remote, refspec] = positional

      return isForce || isLease
        ? { kind: 'push', dir, isLease: !isForce, ...(remote ? { remote } : {}), ...(refspec ? { refspec } : {}) }
        : undefined
    }
    case 'reset': {
      const [target] = positional

      return has('--hard') ? { kind: 'reset', dir, ...(target ? { target } : {}) } : undefined
    }
    case 'clean':
      return (has('--force') || short('f')) && !(has('--dry-run') || short('n')) ? { kind: 'clean', dir, args } : undefined
    case 'checkout': {
      const dash = args.indexOf('--')
      const paths = dash >= 0 ? args.slice(dash + 1) : positional.filter(p => p === '.' || p === './' || p === ':/')

      return paths.length > 0 && !has('-p', '--patch') ? { kind: 'discard', dir, how: 'checkout', paths } : undefined
    }
    case 'restore': {
      // `--staged` без `--worktree` только убирает из индекса — правки остаются.
      if (has('-p', '--patch') || (has('--staged', '-S') && !has('--worktree', '-W'))) {
        return undefined
      }
      const paths: string[] = []
      for (let j = 0; j < args.length; j += 1) {
        const a = args[j] ?? ''
        if (a === '--') {
          paths.push(...args.slice(j + 1))
          break
        }
        if (a === '-s' || a === '--source') {
          j += 1
        } else if (!a.startsWith('-')) {
          paths.push(a)
        }
      }

      return paths.length > 0 ? { kind: 'discard', dir, how: 'restore', paths } : undefined
    }
    case 'branch': {
      const isForce = short('D') || ((has('--delete') || short('d')) && (has('--force') || short('f')))

      return isForce && positional.length > 0 ? { kind: 'branch', dir, branches: positional } : undefined
    }
    case 'stash': {
      const [action, ref] = positional
      if (action === 'clear') {
        return { kind: 'stash', dir, isClear: true }
      }

      return action === 'drop' ? { kind: 'stash', dir, isClear: false, ...(ref ? { ref } : {}) } : undefined
    }
    default:
      return undefined
  }
}

const detect = (name: string, args: Word[], dialect: Dialect): Danger | undefined => {
  if (CMD_REMOVE.has(name) && args.some(w => /^\/s$/i.test(w.value))) {
    return deletion(args.filter(w => !/^\/[A-Za-z](:.*)?$/.test(w.value)))
  }
  if (dialect === 'powershell' && PS_REMOVE.has(name)) {
    return removeItem(args)
  }
  if (dialect !== 'powershell' && name === 'rm') {
    return rm(args)
  }

  return name === 'git' ? gitDanger(args) : undefined
}

/**
 * Опасные части команды: рекурсивное удаление, force push, reset --hard, clean -f, откат правок, branch -D, stash drop/clear.
 * Смотрит на сами команды цепочки (`&&`, `;`, `|`), а не на текст в кавычках, heredoc и комментариях; заходит в `bash -c`, `cmd /c`, `$(…)`.
 */
export function classify(command: string, dialect: Dialect = 'bash', depth = 0): Danger[] {
  if (depth > 3) {
    return []
  }
  const { segments, nested } = split(command, dialect)
  const found: Danger[] = []
  let dir: string | null = ''
  for (const words of segments) {
    const argv = unwrap(words)
    const first = argv[0]
    if (!first) {
      continue
    }
    const name = commandName(first.value)
    const args = argv.slice(1)
    if (CD.has(name)) {
      const to = args.find(w => !w.value.startsWith('-'))
      dir = args.some(w => w.value === '-') ? null : joinPath(dir, to ? wordPath(to) : '~')
      continue
    }
    const inner = innerScript(name, args)
    if (inner) {
      found.push(...classify(inner.script, inner.dialect, depth + 1).map(danger => ({ ...danger, dir: joinPath(dir, danger.dir) })))
    }
    const danger = detect(name, args, dialect)
    if (danger) {
      found.push({ ...danger, dir: joinPath(dir, danger.dir) })
    }
  }
  for (const script of nested) {
    found.push(...classify(script, dialect, depth + 1))
  }

  return found
}

// ── Пути ─────────────────────────────────────────────────────────────────

/** Свёртка `.` и `..`, прямые косые; диск Windows сохраняется: `C:/a/../b` → `C:/b`. */
const normalize = (path: string) => {
  const slashed = path.replace(/\\/g, '/')
  const drive = /^[A-Za-z]:/.exec(slashed)?.[0] ?? ''
  const parts: string[] = []
  for (const part of slashed.slice(drive.length).split('/')) {
    if (part === '..') {
      parts.pop()
    } else if (part !== '' && part !== '.') {
      parts.push(part)
    }
  }

  return `${drive}/${parts.join('/')}`
}

/** Абсолютный путь: `~` — домашняя папка, относительный — от папки сессии, `/c/…` из Git Bash — `C:/…`; не вычислить — undefined. */
export const resolvePath = (path: string, cwd: string, home?: string): string | undefined => {
  const base = cwd.replace(/\\/g, '/')
  if (path.startsWith('~')) {
    return home ? normalize(`${home}/${path.slice(1)}`) : undefined
  }
  if (/^[A-Za-z]:/.test(base) && /^\/[A-Za-z](\/|$)/.test(path)) {
    return normalize(`${path.charAt(1).toUpperCase()}:/${path.slice(3)}`)
  }
  if (isAbsolute(path)) {
    return normalize(path)
  }

  return base ? normalize(`${base}/${path}`) : undefined
}

/** Чем особенно опасна цель: корень диска, вся домашняя папка, папка проекта внутри. */
export const warning = (path: string, cwd: string, home?: string) => {
  const key = (p: string) => {
    const clean = normalize(p).replace(/\/+$/, '')

    return /^[A-Za-z]:/.test(clean) ? clean.toLowerCase() : clean
  }
  const target = key(path)
  if (target === '' || /^[a-z]:$/.test(target)) {
    return 'это корень диска'
  }
  if (home && target === key(home)) {
    return 'это вся домашняя папка'
  }
  const project = cwd ? key(cwd) : ''

  return project && (project === target || project.startsWith(`${target}/`)) ? 'в ней папка проекта' : undefined
}

// ── Предпросмотр ─────────────────────────────────────────────────────────

/** Что удалится по пути: нет его, файл, ссылка или папка с числом файлов и размером (`isPartial` — обход упёрся в предел). */
export type Measured =
  | { kind: 'missing' }
  | { kind: 'link' }
  | { kind: 'file'; bytes: number }
  | { kind: 'dir'; files: number; bytes: number; isPartial: boolean }

type Where = { cwd: string; home: string | undefined; deadline: number }

/** Обход папки вширь: не больше MAX_ENTRIES записей, MAX_DEPTH уровней и времени до `deadline`. Ссылки не раскрываются — rm их не проходит. */
const measure = async ($: EngineInterface, path: string, deadline: number): Promise<Measured> => {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat) {
    return { kind: 'missing' }
  }
  if (stat.isLink) {
    return { kind: 'link' }
  }
  if (stat.kind !== 'dir') {
    return { kind: 'file', bytes: stat.size }
  }
  let files = 0
  let bytes = 0
  let seen = 0
  let isPartial = false
  let level = [path]
  for (let depth = 1; level.length > 0 && !isPartial; depth += 1) {
    const deeper: string[] = []
    for (let k = 0; k < level.length; k += BATCH) {
      // Часы не ответили — обход держит предел записей.
      if (seen >= MAX_ENTRIES || (await $.clock.now().catch(() => 0)) > deadline) {
        isPartial = true
        break
      }
      const listed = await Promise.all(
        level.slice(k, k + BATCH).map(dir =>
          $.fs.list(dir).then(
            entries => ({ dir, entries }),
            () => {
              isPartial = true

              return { dir, entries: [] as FsEntry[] }
            },
          ),
        ),
      )
      for (const { dir, entries } of listed) {
        for (const entry of entries) {
          seen += 1
          if (entry.kind !== 'dir') {
            files += 1
            bytes += entry.size
          } else if (depth < MAX_DEPTH) {
            deeper.push(`${dir.replace(/\/+$/, '')}/${entry.name}`)
          } else {
            isPartial = true
          }
        }
      }
    }
    level = deeper
  }

  return { kind: 'dir', files, bytes, isPartial }
}

const deleteLines = async ($: EngineInterface, danger: Extract<Danger, { kind: 'delete' }>, where: Where) => {
  if (danger.targets.length === 0) {
    return ['• удаление: пути придут из ввода (конвейер, xargs) — не могу посчитать заранее']
  }
  const shown = danger.targets.slice(0, MAX_TARGETS)
  const rows = await Promise.all(
    shown.map(async target => {
      const spec = joinPath(danger.dir, target.path)
      const path = spec === null ? undefined : resolvePath(spec, where.cwd, where.home)
      if (path === undefined) {
        return `• ${describeTarget(target.shown, undefined)}`
      }

      return `• ${describeTarget(target.shown, await measure($, path, where.deadline), warning(path, where.cwd, where.home))}`
    }),
  )
  const rest = danger.targets.length - shown.length

  return rest > 0 ? [...rows, `• … и ещё ${plural(rest, PATHS)}`] : rows
}

/** Строки `git` без пустых; ведущие пробелы важны (`git status --porcelain`). */
const lines = (stdout: string) =>
  stdout
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(line => line.trim() !== '')

/** Путь из строки `git status --porcelain`: после «XY », у переименования — новый. */
const statusPath = (line: string) =>
  line
    .slice(3)
    .replace(/^.* -> /, '')
    .replace(/^"|"$/g, '')

/** Первые несколько строк списка с отступом и «… и ещё N». */
const items = (list: readonly string[]) => [
  ...list.slice(0, MAX_ITEMS).map(line => `    ${oneLine(line, 70)}`),
  ...(list.length > MAX_ITEMS ? [`    … и ещё ${list.length - MAX_ITEMS}`] : []),
]

/** Первые имена через запятую и «и ещё N». */
const names = (list: readonly string[]) =>
  `${list.slice(0, MAX_ITEMS).join(', ')}${list.length > MAX_ITEMS ? ` и ещё ${list.length - MAX_ITEMS}` : ''}`

/** «пропадут правки в 3 файлах (+40 −12 строк): a.ts, b.ts, c.ts» по `git status` и `git diff --shortstat`. */
export const changesLine = (head: string, files: readonly string[], shortstat: string) => {
  if (files.length === 0) {
    return `${head}: незакоммиченных правок нет — терять нечего`
  }
  const added = /(\d+) insertion/.exec(shortstat)?.[1] ?? '0'
  const removed = /(\d+) deletion/.exec(shortstat)?.[1] ?? '0'
  const stat = added === '0' && removed === '0' ? '' : ` (+${added} −${removed} строк)`

  return `${head}: пропадут правки в ${plural(files.length, FILES_IN)}${stat}: ${names(files)}`
}

/** Диапазон коммитов, которые force push сотрёт с remote: есть там, нет в том, что пушим. */
export const pushRange = (danger: { remote?: string; refspec?: string }) => {
  if (!danger.remote || !danger.refspec) {
    return 'HEAD..@{u}'
  }
  const [src = '', dst = src] = danger.refspec.replace(/^\+/, '').split(':')

  return `${src || 'HEAD'}..${danger.remote}/${dst.replace(/^refs\/heads\//, '')}`
}

/** Ключи `git clean` для пробы `-n`: без -f, -i, -n, -q. */
export const dryArgs = (args: readonly string[]) =>
  args.flatMap(a => {
    if (['--force', '--interactive', '--dry-run', '--quiet'].includes(a)) {
      return []
    }
    if (/^-[A-Za-z]+$/.test(a)) {
      const rest = a.slice(1).replace(/[fniq]/g, '')

      return rest ? [`-${rest}`] : []
    }

    return [a]
  })

const stashRef = (ref?: string) => (!ref ? 'stash@{0}' : /^\d+$/.test(ref) ? `stash@{${ref}}` : ref)

/** Короткое имя опасной части для строки вопроса. */
export const label = (danger: Danger) => {
  switch (danger.kind) {
    case 'delete':
      return 'удаление'
    case 'push':
      return danger.isLease ? 'git push --force-with-lease' : 'git push --force'
    case 'reset':
      return `git reset --hard${danger.target ? ` ${danger.target}` : ''}`
    case 'discard':
      return oneLine(`git ${danger.how} ${danger.how === 'checkout' ? '-- ' : ''}${danger.paths.join(' ')}`, 50)
    case 'clean':
      return oneLine(`git clean ${danger.args.join(' ')}`, 50)
    case 'branch':
      return oneLine(`git branch -D ${danger.branches.join(' ')}`, 50)
    case 'stash':
      return danger.isClear ? 'git stash clear' : `git stash drop${danger.ref ? ` ${danger.ref}` : ''}`
  }
}

const describe = async ($: EngineInterface, danger: Danger, where: Where): Promise<string[]> => {
  if (danger.kind === 'delete') {
    return deleteLines($, danger, where)
  }
  const head = `• ${label(danger)}`
  const cwd = danger.dir === null ? undefined : resolvePath(danger.dir || '.', where.cwd, where.home)
  if (cwd === undefined) {
    return [`${head}: не могу посчитать заранее — неизвестно, в какой папке`]
  }
  const git = (...args: string[]) => $.process.run(['git', ...args], { cwd, timeoutMs: TIMEOUT_MS, env: GIT_ENV })

  switch (danger.kind) {
    case 'push': {
      const log = await git('log', '--oneline', pushRange(danger))
      const lease = danger.isLease ? ['  --force-with-lease — форма безопаснее: push откажет, если на remote появилось то, чего вы не видели'] : []
      if (log.exitCode !== 0) {
        return [`${head}: не могу проверить — у ветки нет upstream или её нет на remote`, ...lease]
      }
      const commits = lines(log.stdout)
      if (commits.length === 0) {
        return [`${head}: по данным последнего fetch на remote ничего не пропадёт`, ...lease]
      }

      const n = commits.length

      return [`${head}: с remote ${verb(n, 'пропадёт', 'пропадут')} ${plural(n, COMMITS)}, ${verb(n, 'которого', 'которых')} у вас нет:`, ...items(commits), ...lease]
    }
    case 'reset': {
      const [status, diff, log] = await Promise.all([
        git('status', '--porcelain'),
        git('diff', 'HEAD', '--shortstat'),
        danger.target ? git('log', '--oneline', `${danger.target}..HEAD`) : undefined,
      ])
      if (status.exitCode !== 0) {
        return [`${head}: git status не сработал — не могу проверить`]
      }
      // reset --hard не трогает неотслеживаемые файлы (??): пропадают правки в отслеживаемых.
      const changed = lines(status.stdout)
        .filter(line => !line.startsWith('??'))
        .map(statusPath)
      const commits = log && log.exitCode === 0 ? lines(log.stdout) : []

      return [
        changesLine(head, changed, diff.stdout),
        ...(commits.length > 0
          ? [
              `  из ветки ${verb(commits.length, 'уйдёт', 'уйдут')} ${plural(commits.length, COMMITS)} (${verb(commits.length, 'останется', 'останутся')} в reflog):`,
              ...items(commits),
            ]
          : []),
      ]
    }
    case 'discard': {
      const [status, diff] = await Promise.all([
        git('status', '--porcelain', '--', ...danger.paths),
        git('diff', '--shortstat', '--', ...danger.paths),
      ])
      if (status.exitCode !== 0) {
        return [`${head}: git status не сработал — не могу проверить`]
      }
      // Возвращается состояние индекса: пропадают правки, ещё не добавленные в индекс (второй столбец).
      const changed = lines(status.stdout)
        .filter(line => !line.startsWith('??') && line.charAt(1) !== ' ')
        .map(statusPath)

      return [changesLine(head, changed, diff.stdout)]
    }
    case 'clean': {
      const dry = await git('clean', '-n', ...dryArgs(danger.args))
      if (dry.exitCode !== 0) {
        return [`${head}: проба git clean -n не сработала — не могу проверить`]
      }
      const files = lines(dry.stdout).map(line => line.replace(/^Would remove /, ''))

      return [files.length > 0 ? `${head}: удалит ${plural(files.length, UNTRACKED)}: ${names(files)}` : `${head}: удалять нечего`]
    }
    case 'branch': {
      const found = await Promise.all(
        danger.branches.slice(0, MAX_TARGETS).map(async branch => {
          const log = await git('log', '--oneline', branch, '--not', '--remotes', 'HEAD')
          if (log.exitCode !== 0) {
            return [`• ветка ${branch}: такой ветки нет`]
          }
          const commits = lines(log.stdout)

          return commits.length === 0
            ? [`• ветка ${branch}: все её коммиты есть на remote или в текущей ветке — ничего не потеряется`]
            : [`• ветка ${branch}: ${plural(commits.length, COMMITS)} только в ней — нет ни на remote, ни в текущей ветке:`, ...items(commits)]
        }),
      )

      return found.flat()
    }
    case 'stash': {
      const list = await git('stash', 'list')
      const all = list.exitCode === 0 ? lines(list.stdout) : []
      if (danger.isClear) {
        return all.length > 0
          ? [`${head}: ${verb(all.length, 'пропадёт', 'пропадут')} ${plural(all.length, STASHES)}:`, ...items(all)]
          : [`${head}: stash пуст — терять нечего`]
      }
      const ref = stashRef(danger.ref)
      const entry = all.find(line => line.startsWith(`${ref}:`))

      return [entry ? `${head}: пропадёт ${oneLine(entry, 80)}` : `${head}: записи ${ref} нет — терять нечего`]
    }
  }
}

/** Что именно пропадёт: строки для вопроса, по каждой опасной части команды. Никогда не висит: git — с таймаутом, обход — с пределами. */
export async function preview($: EngineInterface, dangers: readonly Danger[]): Promise<string[]> {
  const [cwd, home, now] = await Promise.all([
    $.session.cwd().catch(() => ''),
    $.env
      .get('HOME')
      .then(value => value ?? $.env.get('USERPROFILE'))
      .catch(() => undefined),
    $.clock.now().catch(() => 0),
  ])
  const where: Where = { cwd, home, deadline: now + TIMEOUT_MS }
  const parts = await Promise.all(
    dangers.map(danger => describe($, danger, where).catch(() => [`• ${label(danger)}: не удалось посчитать (git не ответил за 5 с?)`])),
  )

  return parts.flat()
}

// ── Оформление ───────────────────────────────────────────────────────────

const FILES = ['файл', 'файла', 'файлов'] as const
const FILES_IN = ['файле', 'файлах', 'файлах'] as const
const COMMITS = ['коммит', 'коммита', 'коммитов'] as const
const PATHS = ['путь', 'пути', 'путей'] as const
const UNTRACKED = ['неотслеживаемый путь', 'неотслеживаемых пути', 'неотслеживаемых путей'] as const
const STASHES = ['запись stash', 'записи stash', 'записей stash'] as const

/** Число с пробелами между тысячами: 12 345. */
const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

/** «1 файл», «3 файла», «12 файлов». */
export const plural = (n: number, [one, few, many]: readonly [string, string, string]) => {
  const tens = n % 100
  const ones = n % 10
  const form = tens >= 11 && tens <= 14 ? many : ones === 1 ? one : ones >= 2 && ones <= 4 ? few : many

  return `${group(n)} ${form}`
}

/** Слово по числу: «пропадёт» для 1, 21…; «пропадут» для остальных. */
const verb = (n: number, one: string, many: string) => (n % 10 === 1 && n % 100 !== 11 ? one : many)

/** 512 Б, 2,9 КБ, 5 МБ. */
export const formatSize = (bytes: number) => {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const shown = unit === 0 ? String(value) : value.toFixed(1).replace(/\.0$/, '').replace('.', ',')

  return `${shown} ${units[unit]}`
}

/** Строка про одну цель удаления: «build — папка: 2 файла, 2,9 КБ». */
export const describeTarget = (shown: string, measured: Measured | undefined, warn?: string) => {
  const what = !measured
    ? 'не могу посчитать заранее'
    : measured.kind === 'missing'
      ? 'нет такого пути'
      : measured.kind === 'link'
        ? 'ссылка: удалится только она сама'
        : measured.kind === 'file'
          ? `файл, ${formatSize(measured.bytes)}`
          : measured.files === 0 && !measured.isPartial
            ? 'пустая папка'
            : measured.isPartial
              ? `папка: ≥ ${plural(measured.files, FILES)}, ≥ ${formatSize(measured.bytes)} (посчитано не всё)`
              : `папка: ${plural(measured.files, FILES)}, ${formatSize(measured.bytes)}`

  return `${shown} — ${what}${warn ? ` — ⚠ ${warn}` : ''}`
}

/** Одна строка без лишних пробелов; длиннее `max` — с «…». */
export const oneLine = (text: string, max = MAX_COMMAND) => {
  const line = text.replace(/\s+/g, ' ').trim()
  const chars = [...line]

  return chars.length <= max ? line : `${chars.slice(0, max - 1).join('')}…`
}

/** Вопрос: что хочет Claude и что пропадёт. */
export const buildQuestion = (command: string, lost: readonly string[]) =>
  [`Claude хочет: ${oneLine(command)}`, ...lost.slice(0, MAX_LINES)].join('\n')

/** Причина отказа для Claude: чтобы не повторял вслепую. */
export const refusal = (command: string, answer: string | undefined) => {
  const shown = oneLine(command, 80)
  if (answer === undefined) {
    return `Отменено: «${shown}» — опасная команда, её нужно подтвердить, но спросить человека не вышло (нет диалога или вопрос закрыли). Не повторяй её и не обходи другой командой; если она нужна, попроси человека выполнить её самому или выключить страховку: /guard off.`
  }
  if (answer === CANCEL) {
    return `Отменено: человек не разрешил «${shown}» (страховка от опасных команд). Не повторяй эту команду и не обходи её другой — спроси, как быть дальше.`
  }

  return `Отменено: на вопрос о «${shown}» человек ответил: «${oneLine(answer, 200)}». Команда не выполнена.`
}
