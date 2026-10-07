// "Safety net": before a dangerous command from Claude (rm -r, git push --force, reset --hard, clean -f…) the call stops,
// the person sees exactly what would be lost and picks Run or Cancel. On Cancel Claude gets the reason and does not retry blindly.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

const HEADER = 'Safety net'
const RUN = 'Run'
const CANCEL = 'Cancel'
/** The mod's store key: whether the safety net is off (survives a restart). */
const OFF_KEY = 'isOff'
/** The preview waits no longer: 5 s per git call, 5 s in all for the folder walk. */
const TIMEOUT_MS = 5_000
/** Folder walk: at most this many entries and levels deep; folders listed at once. */
const MAX_ENTRIES = 2_000
const MAX_DEPTH = 6
const BATCH = 8
/** The command in the question: one line, no longer than this. */
const MAX_COMMAND = 100
/** How many paths and commits to name, how many lines in the question in all. */
const MAX_TARGETS = 6
const MAX_ITEMS = 3
const MAX_LINES = 16
/** Reading the status takes no index.lock and does not disturb a git running alongside. */
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' }
/** What the safety net catches, for `/guard`. */
const WATCHED = 'rm -r, Remove-Item -Recurse, rd /s, git push --force, reset --hard, clean -f, checkout -- ., restore ., branch -D, stash drop/clear'

const isOff = atom({ plugin: 'command-guard', key: 'isOff' } as const, false)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The name is taken by another plugin: no command then, but the rest of the session start must go on.
    await $.command
      .register({ name: 'guard', description: 'Safety net for dangerous commands: `/guard off` turns it off, `/guard on` turns it back on' })
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
          ? 'Safety net is off: Claude will run dangerous commands without asking. Turn it on: /guard on'
          : 'Safety net is on: before a dangerous command Claude asks you and shows what would be lost.',
      }
    }

    return {
      text: (await read($, isOff))
        ? 'Safety net is off. Turn it on: /guard on'
        : `Safety net is on: ${WATCHED}. Before such a command Claude asks you and shows what would be lost. Turn it off: /guard off`,
    }
  })

  // Other plugins' calls are their own business: only Claude itself (and its subagents) is guarded.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = next.origin.plugin === 'engine' ? await guard($, e.command, 'bash') : undefined

    return deny === undefined ? next(e) : { deny }
  })

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const deny = next.origin.plugin === 'engine' ? await guard($, e.command, 'powershell') : undefined

    return deny === undefined ? next(e) : { deny }
  })
}

/** A dangerous command: ask the person. Returns the refusal reason for Claude, or undefined to run it. */
const guard = async ($: EngineInterface, command: string, dialect: Dialect): Promise<string | undefined> => {
  if (await read($, isOff)) {
    return undefined
  }
  const dangers = classify(command, dialect)
  if (dangers.length === 0) {
    return undefined
  }
  const lost = await preview($, dangers).catch(() => ["• couldn't count what would be lost"])
  // Asking failed (no dialog, the question was dismissed): the safe answer is not to run it.
  const answer = await $.ui.ask(buildQuestion(command, lost), { header: HEADER, options: [RUN, CANCEL] }).catch(() => undefined)
  if (answer === RUN) {
    return undefined
  }
  $.ui.toast(`Safety net: not run — ${oneLine(command, 60)}`)

  return refusal(command, answer)
}

// ── Parsing the command ──────────────────────────────────────────────────

export type Dialect = 'bash' | 'powershell' | 'cmd'

/** A word of a command: its text without quotes and escapes; as written; whether it starts with `~`/`$HOME`; whether it holds a variable, a substitution or a glob. */
export type Word = { value: string; raw: string; home: boolean; dynamic: boolean }

/** What gets deleted: as written, and the path (`~/…`, relative or absolute); `null` — can't be known in advance. */
export type Target = { shown: string; path: string | null }

/** A dangerous part of a command. `dir` — where it runs: '' — the session folder, a path — after `cd` or `git -C`, `null` — unknown. */
export type Danger = { dir: string | null } & (
  | { kind: 'delete'; targets: Target[] }
  | { kind: 'push'; isLease: boolean; remote?: string; refspec?: string }
  | { kind: 'reset'; target?: string }
  | { kind: 'discard'; how: 'checkout' | 'restore'; paths: string[] }
  | { kind: 'clean'; args: string[] }
  | { kind: 'branch'; branches: string[] }
  | { kind: 'stash'; isClear: boolean; ref?: string }
)

/** The bracket closing the one at `open`; quoted strings are skipped. */
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

/** Skips a heredoc body: the lines up to and including the tag line. */
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
 * Splits a command into simple commands (on `;`, `&&`, `||`, `|`, `&`, newline) and their words.
 * Strips quotes, does not count heredoc bodies, here-strings and comments as commands, drops redirect targets (`> file`).
 * `nested` — the texts of `$(…)`, `` `…` `` and PowerShell `(…)`/`{…}` blocks: they are checked on their own.
 */
export function split(src: string, dialect: Dialect): { segments: Word[][]; nested: string[] } {
  const ps = dialect === 'powershell'
  const cmd = dialect === 'cmd'
  const escape = ps ? '`' : cmd ? '^' : '\\'
  // A variable name from position lastIndex (flag y), without copying the rest of the string.
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
  // `$HOME` (and `$env:USERPROFILE` in PowerShell) at the start of a word is the home folder; any other variable can't be known in advance.
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
      // `$((…))` is arithmetic, not a command.
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
      // In PowerShell '' inside single quotes is the quote itself.
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
      // In bash a backslash inside "…" escapes only $ ` " \ and newline: "C:\Users" stays as it is.
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
    // `2>` and `*>`: the number before the arrow is a stream, not a word of the command.
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
      // An escape before a newline continues the line.
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
      // A PowerShell here-string @'…'@ is one word; its body is not a command.
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
      // `& "C:\tool.exe"` — the call operator, a word of its own.
      end()
      at().value = '&'
      i += 1
      end()
    } else if (';|&)'.includes(c) || (c === '(' && !ps) || (c === '}' && ps)) {
      // End of a simple command; in bash `{`/`}` are words (dropped below), in PowerShell a block is read whole above.
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

/** Wrappers followed by the real command, and their options that take a value: `sudo -u root rm …`, `xargs -n 1 rm …`. */
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

/** The command's name: no folder, no `.exe`, lower case. */
export const commandName = (word: string) =>
  word
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase()

/** Strips assignments, keywords and wrappers (sudo, env, xargs…) off a simple command. */
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
    // timeout takes a duration after its options.
    rest = rest.slice(name === 'timeout' ? k + 1 : k)
  }
}

/** The path of a word: `~/…` for the home folder, `null` — it holds a variable, a substitution or a glob. */
export const wordPath = (w: Word | undefined): string | null => {
  if (!w || w.dynamic) {
    return null
  }
  const value = w.value.replace(/\\/g, '/')

  return w.home ? `~${value}` : value.startsWith('~') ? `./${value}` : value
}

const isAbsolute = (path: string) => /^([A-Za-z]:)?[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)

/** `cd base`, then `path`: an absolute path or `~` replaces the base, a relative one is appended. */
export const joinPath = (base: string | null, path: string | null): string | null => {
  if (base === null || path === null) {
    return null
  }
  if (path === '' || path === '.') {
    return base
  }

  return base === '' || isAbsolute(path) || path.startsWith('~') ? path : `${base.replace(/\/+$/, '')}/${path}`
}

/** The script inside `bash -c`, `powershell -Command`, `cmd /c`, `iex`. */
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

/** `rm -r`, `-R`, `-rf`, `--recursive`; a plain `rm file` is not dangerous. */
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

/** `Remove-Item … -Recurse` and its short forms (`rm -r`, `ri -rec`); with `-WhatIf` it is only a dry run. */
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

/** Dangerous git subcommands; `git -C <folder>` changes where they run. */
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
      // `--staged` without `--worktree` only unstages — the changes stay.
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
 * The dangerous parts of a command: recursive delete, force push, reset --hard, clean -f, discarding changes, branch -D, stash drop/clear.
 * Looks at the commands of the chain themselves (`&&`, `;`, `|`), not at text in quotes, heredocs and comments; goes into `bash -c`, `cmd /c`, `$(…)`.
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

// ── Paths ────────────────────────────────────────────────────────────────

/** Folds `.` and `..`, forward slashes; a Windows drive is kept: `C:/a/../b` → `C:/b`. */
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

/** An absolute path: `~` is the home folder, a relative path is from the session folder, Git Bash `/c/…` is `C:/…`; can't compute — undefined. */
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

/** What makes a target especially dangerous: a drive root, the whole home folder, the project folder inside it. */
export const warning = (path: string, cwd: string, home?: string) => {
  const key = (p: string) => {
    const clean = normalize(p).replace(/\/+$/, '')

    return /^[A-Za-z]:/.test(clean) ? clean.toLowerCase() : clean
  }
  const target = key(path)
  if (target === '' || /^[a-z]:$/.test(target)) {
    return 'this is a drive root'
  }
  if (home && target === key(home)) {
    return 'this is your whole home folder'
  }
  const project = cwd ? key(cwd) : ''

  return project && (project === target || project.startsWith(`${target}/`)) ? 'your project is inside it' : undefined
}

// ── Preview ──────────────────────────────────────────────────────────────

/** What a path deletes: nothing there, a file, a link, or a folder with its file count and size (`isPartial` — the walk hit a limit). */
export type Measured =
  | { kind: 'missing' }
  | { kind: 'link' }
  | { kind: 'file'; bytes: number }
  | { kind: 'dir'; files: number; bytes: number; isPartial: boolean }

type Where = { cwd: string; home: string | undefined; deadline: number }

/** A breadth-first folder walk: at most MAX_ENTRIES entries, MAX_DEPTH levels and until `deadline`. Links are not followed — rm does not follow them. */
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
      // The clock did not answer: the walk still keeps to the entry limit.
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
    return ["• delete: the paths come from input (a pipe, xargs) — can't count in advance"]
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

  return rest > 0 ? [...rows, `• … and ${plural(rest, PATHS)} more`] : rows
}

/** Non-empty `git` output lines; leading spaces matter (`git status --porcelain`). */
const lines = (stdout: string) =>
  stdout
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(line => line.trim() !== '')

/** The path of a `git status --porcelain` line: after "XY ", the new one for a rename. */
const statusPath = (line: string) =>
  line
    .slice(3)
    .replace(/^.* -> /, '')
    .replace(/^"|"$/g, '')

/** The first few lines of a list, indented, and "… and N more". */
const items = (list: readonly string[]) => [
  ...list.slice(0, MAX_ITEMS).map(line => `    ${oneLine(line, 70)}`),
  ...(list.length > MAX_ITEMS ? [`    … and ${list.length - MAX_ITEMS} more`] : []),
]

/** The first names, comma-separated, and "and N more". */
const names = (list: readonly string[]) =>
  `${list.slice(0, MAX_ITEMS).join(', ')}${list.length > MAX_ITEMS ? ` and ${list.length - MAX_ITEMS} more` : ''}`

/** "uncommitted changes in 3 files will be lost (+40 −12 lines): a.ts, b.ts, c.ts" from `git status` and `git diff --shortstat`. */
export const changesLine = (head: string, files: readonly string[], shortstat: string) => {
  if (files.length === 0) {
    return `${head}: no uncommitted changes — nothing to lose`
  }
  const added = /(\d+) insertion/.exec(shortstat)?.[1] ?? '0'
  const removed = /(\d+) deletion/.exec(shortstat)?.[1] ?? '0'
  const stat = added === '0' && removed === '0' ? '' : ` (+${added} −${removed} lines)`

  return `${head}: uncommitted changes in ${plural(files.length, FILES)} will be lost${stat}: ${names(files)}`
}

/** The commits a force push erases from the remote: there, but not in what is pushed. */
export const pushRange = (danger: { remote?: string; refspec?: string }) => {
  if (!danger.remote || !danger.refspec) {
    return 'HEAD..@{u}'
  }
  const [src = '', dst = src] = danger.refspec.replace(/^\+/, '').split(':')

  return `${src || 'HEAD'}..${danger.remote}/${dst.replace(/^refs\/heads\//, '')}`
}

/** `git clean` options for the `-n` dry run: without -f, -i, -n, -q. */
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

/** A short name of the dangerous part for the question line. */
export const label = (danger: Danger) => {
  switch (danger.kind) {
    case 'delete':
      return 'delete'
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
    return [`${head}: can't count in advance — unknown folder`]
  }
  const git = (...args: string[]) => $.process.run(['git', ...args], { cwd, timeoutMs: TIMEOUT_MS, env: GIT_ENV })

  switch (danger.kind) {
    case 'push': {
      const log = await git('log', '--oneline', pushRange(danger))
      const lease = danger.isLease ? ["  --force-with-lease is the safer form: the push is refused if the remote has something you haven't seen"] : []
      if (log.exitCode !== 0) {
        return [`${head}: can't check — the branch has no upstream or isn't on the remote`, ...lease]
      }
      const commits = lines(log.stdout)
      if (commits.length === 0) {
        return [`${head}: nothing on the remote would be lost (as of the last fetch)`, ...lease]
      }

      return [`${head}: ${plural(commits.length, COMMITS)} on the remote that you don't have will be lost:`, ...items(commits), ...lease]
    }
    case 'reset': {
      const [status, diff, log] = await Promise.all([
        git('status', '--porcelain'),
        git('diff', 'HEAD', '--shortstat'),
        danger.target ? git('log', '--oneline', `${danger.target}..HEAD`) : undefined,
      ])
      if (status.exitCode !== 0) {
        return [`${head}: git status failed — can't check`]
      }
      // reset --hard leaves untracked files (??) alone: the changes in tracked ones are lost.
      const changed = lines(status.stdout)
        .filter(line => !line.startsWith('??'))
        .map(statusPath)
      const commits = log && log.exitCode === 0 ? lines(log.stdout) : []

      return [
        changesLine(head, changed, diff.stdout),
        ...(commits.length > 0 ? [`  ${plural(commits.length, COMMITS)} leave the branch (still in the reflog):`, ...items(commits)] : []),
      ]
    }
    case 'discard': {
      const [status, diff] = await Promise.all([
        git('status', '--porcelain', '--', ...danger.paths),
        git('diff', '--shortstat', '--', ...danger.paths),
      ])
      if (status.exitCode !== 0) {
        return [`${head}: git status failed — can't check`]
      }
      // The index state comes back: the changes not yet staged (second column) are lost.
      const changed = lines(status.stdout)
        .filter(line => !line.startsWith('??') && line.charAt(1) !== ' ')
        .map(statusPath)

      return [changesLine(head, changed, diff.stdout)]
    }
    case 'clean': {
      const dry = await git('clean', '-n', ...dryArgs(danger.args))
      if (dry.exitCode !== 0) {
        return [`${head}: the git clean -n dry run failed — can't check`]
      }
      const files = lines(dry.stdout).map(line => line.replace(/^Would remove /, ''))

      return [files.length > 0 ? `${head}: deletes ${plural(files.length, UNTRACKED)}: ${names(files)}` : `${head}: nothing to delete`]
    }
    case 'branch': {
      const found = await Promise.all(
        danger.branches.slice(0, MAX_TARGETS).map(async branch => {
          const log = await git('log', '--oneline', branch, '--not', '--remotes', 'HEAD')
          if (log.exitCode !== 0) {
            return [`• branch ${branch}: no such branch`]
          }
          const commits = lines(log.stdout)

          return commits.length === 0
            ? [`• branch ${branch}: all its commits are on a remote or in the current branch — nothing is lost`]
            : [`• branch ${branch}: ${plural(commits.length, COMMITS)} only there — not on any remote or in the current branch:`, ...items(commits)]
        }),
      )

      return found.flat()
    }
    case 'stash': {
      const list = await git('stash', 'list')
      const all = list.exitCode === 0 ? lines(list.stdout) : []
      if (danger.isClear) {
        return all.length > 0 ? [`${head}: ${plural(all.length, STASHES)} will be lost:`, ...items(all)] : [`${head}: the stash is empty — nothing to lose`]
      }
      const ref = stashRef(danger.ref)
      const entry = all.find(line => line.startsWith(`${ref}:`))

      return [entry ? `${head}: loses ${oneLine(entry, 80)}` : `${head}: no ${ref} entry — nothing to lose`]
    }
  }
}

/** Exactly what would be lost: lines for the question, one set per dangerous part. Never hangs: git has a timeout, the walk has limits. */
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
    dangers.map(danger => describe($, danger, where).catch(() => [`• ${label(danger)}: couldn't count (git didn't answer within 5 s?)`])),
  )

  return parts.flat()
}

// ── Formatting ───────────────────────────────────────────────────────────

const FILES = ['file', 'files'] as const
const COMMITS = ['commit', 'commits'] as const
const PATHS = ['path', 'paths'] as const
const UNTRACKED = ['untracked path', 'untracked paths'] as const
const STASHES = ['stash entry', 'stash entries'] as const

/** A number with thousands separators: 12,345. */
const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** "1 file", "3 files". */
export const plural = (n: number, [one, many]: readonly [string, string]) => `${group(n)} ${n === 1 ? one : many}`

/** 512 B, 2.9 KB, 5 MB. */
export const formatSize = (bytes: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const shown = unit === 0 ? String(value) : value.toFixed(1).replace(/\.0$/, '')

  return `${shown} ${units[unit]}`
}

/** The line about one delete target: "build — folder: 2 files, 2.9 KB". */
export const describeTarget = (shown: string, measured: Measured | undefined, warn?: string) => {
  const what = !measured
    ? "can't count in advance"
    : measured.kind === 'missing'
      ? 'no such path'
      : measured.kind === 'link'
        ? 'a link: only the link itself is removed'
        : measured.kind === 'file'
          ? `file, ${formatSize(measured.bytes)}`
          : measured.files === 0 && !measured.isPartial
            ? 'empty folder'
            : measured.isPartial
              ? `folder: ≥ ${plural(measured.files, FILES)}, ≥ ${formatSize(measured.bytes)} (not fully counted)`
              : `folder: ${plural(measured.files, FILES)}, ${formatSize(measured.bytes)}`

  return `${shown} — ${what}${warn ? ` — ⚠ ${warn}` : ''}`
}

/** One line without extra spaces; longer than `max` — with "…". */
export const oneLine = (text: string, max = MAX_COMMAND) => {
  const line = text.replace(/\s+/g, ' ').trim()
  const chars = [...line]

  return chars.length <= max ? line : `${chars.slice(0, max - 1).join('')}…`
}

/** The question: what Claude wants and what would be lost. */
export const buildQuestion = (command: string, lost: readonly string[]) =>
  [`Claude wants to run: ${oneLine(command)}`, ...lost.slice(0, MAX_LINES)].join('\n')

/** The refusal reason for Claude, so it does not retry blindly. */
export const refusal = (command: string, answer: string | undefined) => {
  const shown = oneLine(command, 80)
  if (answer === undefined) {
    return `Cancelled: "${shown}" is a dangerous command that needs confirmation, but the person couldn't be asked (no dialog, or the question was dismissed). Don't retry it or work around it with another command; if it's needed, ask the person to run it themselves or to turn the safety net off: /guard off.`
  }
  if (answer === CANCEL) {
    return `Cancelled: the person did not allow "${shown}" (dangerous-command safety net). Don't retry this command or work around it with another one — ask how to proceed.`
  }

  return `Cancelled: asked about "${shown}", the person answered: "${oneLine(answer, 200)}". The command was not run.`
}
