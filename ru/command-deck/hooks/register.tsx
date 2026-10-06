import { atom, read, update } from 'claude-code'
import type { CommandInfo, EngineInterface, Register } from 'claude-code'

import type { CommandDeckSection } from '../types'

const PANE = 'command-deck'
const TITLE = 'Команды'
/** Своя команда: в списке панели её нет. */
const SELF = 'deck'

const GREEN = '#3fb950'
const AMBER = '#d29922'
const GRAY = '#8b949e'

/** Высота строки текста на десктопе: по ней значки встают вровень с текстом. */
const LINE_PX = 20

/** Сколько строк показывать в секции, пока её не развернули. */
const SECTION_LIMIT = 6

/** Отступ строк под текстом заголовка: значок и зазор. */
const INDENT = 2

/** Фон карточки секции на десктопе. */
const CARD = '#8b949e14'

const expanded = atom({ plugin: 'command-deck', key: 'expanded' } as const, [] as CommandDeckSection[])

// ── Каталог ──────────────────────────────────────────────────────────────

/** Перед запуском спросить через `$.ui.ask`: вопрос и подпись «да». */
export type Confirm = { question: string; yes: string }

export type DeckEntry = { name: string; why: string; confirm?: Confirm }

type GroupId = Exclude<CommandDeckSection, 'rest'>

/** Как выглядит заголовок секции: название, цвет, значок в терминале (`glyph`) и на десктопе (`icon`). */
type Look = { title: string; color: string; glyph: string; icon: string }

type Group = Look & { id: GroupId; entries: DeckEntry[] }

const CONFIRM: Record<string, Confirm> = {
  clear: { question: 'Очистить переписку и начать с чистого листа?', yes: 'Да, очистить' },
  exit: { question: 'Завершить сессию Claude Code?', yes: 'Да, выйти' },
  quit: { question: 'Завершить сессию Claude Code?', yes: 'Да, выйти' },
}

/**
 * Команды, которым без аргументов нечего делать и выбора они не открывают:
 * кнопкой их не запустить. /model, /resume, /export, /memory без аргументов
 * открывают свой выбор — они остаются.
 */
const NEEDS_ARGS = new Set(['add-dir', 'btw', 'loop'])

/** Значки в сетке 16×16 (C — цвет). */
const GROUPS: Group[] = [
  {
    id: 'context',
    title: 'КОНТЕКСТ И ПАМЯТЬ',
    color: '#58a6ff',
    glyph: '◐',
    icon: '<circle cx="8" cy="8" r="6" fill="none" stroke="C" stroke-width="1.6"/><path d="M8 2 A6 6 0 0 1 8 14 Z" fill="C"/>',
    entries: [
      { name: 'compact', why: 'Сжать переписку, освободить контекст' },
      { name: 'clear', why: 'Начать заново: переписка очистится', confirm: CONFIRM.clear },
      { name: 'context', why: 'Что занимает контекстное окно' },
      { name: 'memory', why: 'Открыть файлы памяти (CLAUDE.md)' },
    ],
  },
  {
    id: 'project',
    title: 'ПРОЕКТ И КОД',
    color: GREEN,
    glyph: '◇',
    icon: '<path d="M5.5 4 L2 8 L5.5 12 M10.5 4 L14 8 L10.5 12" fill="none" stroke="C" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    entries: [
      { name: 'init', why: 'Создать CLAUDE.md с описанием проекта' },
      { name: 'review', why: 'Ревью пулл-реквеста или изменений' },
      { name: 'code-review', why: 'Ревью текущих изменений на баги' },
      { name: 'security-review', why: 'Проверить изменения на уязвимости' },
    ],
  },
  {
    id: 'session',
    title: 'СЕССИЯ',
    color: AMBER,
    glyph: '◷',
    icon: '<circle cx="8" cy="8" r="6" fill="none" stroke="C" stroke-width="1.6"/><path d="M8 4.5 V8 L10.5 9.5" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    entries: [
      { name: 'cost', why: 'Сколько потрачено в этой сессии' },
      { name: 'usage', why: 'Расход и остаток лимитов тарифа' },
      { name: 'resume', why: 'Вернуться к прошлой сессии' },
      { name: 'export', why: 'Сохранить переписку в файл' },
      { name: 'model', why: 'Выбрать модель для ответов' },
    ],
  },
  {
    id: 'panels',
    title: 'НАШИ ПАНЕЛИ',
    color: '#bc8cff',
    glyph: '▣',
    icon: '<rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="C" stroke-width="1.6"/><path d="M9.5 3 V13" stroke="C" stroke-width="1.6"/>',
    entries: [
      { name: 'roadmap', why: 'Дорожная карта: этапы задачи' },
      { name: 'branches', why: 'Ветки Git, изменения и PR' },
      { name: 'inspector', why: 'Из чего состоит контекст' },
    ],
  },
]

const REST = {
  title: 'ВСЕ ОСТАЛЬНЫЕ',
  color: GRAY,
  glyph: '/',
  icon: '<path d="M10.5 2.5 L5.5 13.5" stroke="C" stroke-width="1.8" stroke-linecap="round"/>',
}

/** Строка панели: команда, как её запускать, и пояснение. */
export type DeckRow = { name: string; text: string; confirm?: Confirm }

export type Deck = { groups: { id: GroupId; rows: DeckRow[] }[]; rest: DeckRow[] }

/** Команда из списка по имени: точное совпадение, иначе плагинная `<плагин>:<имя>`. */
export const findCommand = (list: readonly CommandInfo[], name: string) =>
  list.find(command => command.name === name) ?? list.find(command => command.name.endsWith(`:${name}`))

const isSelf = (command: CommandInfo) => command.name === SELF || command.plugin === 'command-deck'

/** Список движка → секции панели: только то, что есть; остальное — по алфавиту в «Все остальные». */
export const buildDeck = (list: readonly CommandInfo[]): Deck => {
  const unique = new Map<string, CommandInfo>()
  for (const command of list) {
    if (!isSelf(command) && !NEEDS_ARGS.has(command.name) && !unique.has(command.name)) {
      unique.set(command.name, command)
    }
  }
  const available = [...unique.values()]
  const taken = new Set<string>()

  const groups = GROUPS.map(group => ({
    id: group.id,
    rows: group.entries.flatMap(entry => {
      const found = findCommand(available, entry.name)
      if (!found || taken.has(found.name)) {
        return []
      }
      taken.add(found.name)

      return [{ name: found.name, text: entry.why, confirm: entry.confirm }]
    }),
  }))

  const rest = available
    .filter(command => !taken.has(command.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(command => ({ name: command.name, text: command.description, confirm: CONFIRM[command.name] }))

  return { groups, rest }
}

// ── Запуск ───────────────────────────────────────────────────────────────

export const short = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, Math.max(1, max - 1))}…` : line
}

/**
 * Запуск — через `$.command.run`: это тот же путь, что `/имя` в строке ввода
 * (событие `command.run`, ждёт простоя сессии, строки в транскрипте), и он сам
 * разводит локальные команды, панели и prompt-команды (/init, /review начинают
 * ход модели). `$.prompt.submit` не подходит: это промпт модели от имени плагина,
 * а не набранная слэш-команда.
 */
export const runCommand = async ($: EngineInterface, row: DeckRow) => {
  if (row.confirm) {
    const answer = await $.ui
      .ask(row.confirm.question, { header: 'Подтвердите', options: [row.confirm.yes, 'Отмена'] })
      .catch(() => undefined)
    if (answer !== row.confirm.yes) {
      return
    }
  }

  // Что сделала команда, видно в чате; всплывашка — только если она что-то ответила или не запустилась.
  try {
    const reply = await $.command.run({ command: row.name })
    if (reply.text) {
      $.ui.toast(`/${row.name}: ${short(reply.text, 120)}`)
    }
  } catch (error) {
    $.ui.toast(`Не удалось запустить /${row.name}: ${short(error instanceof Error ? error.message : String(error), 120)}`)
  }
}

// ── Отрисовка ────────────────────────────────────────────────────────────

const iconSvg = (body: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="${LINE_PX}" viewBox="0 ${(16 - (LINE_PX * 16) / 12) / 2} 16 ${(LINE_PX * 16) / 12}">` +
  body.replace(/"C"/g, `"${color}"`) +
  `</svg>`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Имя занято другим плагином — команды не будет, но остальной старт сессии должен пройти.
    await $.command.register({
      name: SELF,
      description: 'Открыть панель «Команды»: главные команды с пояснениями и запуском в один клик',
    }).catch(() => undefined)
    // Открывается сама, вкладкой рядом с остальными панелями.
    void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: SELF }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return {
      text: opened.isPlaced ? 'Панель «Команды» открыта.' : 'Панель «Команды» появится, когда хватит места: расширьте окно.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined

    const list = await $.command.list().catch(() => [] as CommandInfo[])
    const deck = buildDeck(list)
    const open = await read($, expanded)

    const columns = e.props.bodyColumns
    // Строки идут под текстом заголовка (отступ INDENT), справа — ▶; на десктопе ещё поля карточки и родная кнопка.
    const textRoom = Math.max(8, columns - INDENT - 1 - (Svg ? 2 + 5 : 1))

    const mark = (look: Look) =>
      Svg ? <Svg source={iconSvg(look.icon, look.color)} alt="значок" width={12} height={LINE_PX} /> : <Text color={look.color}>{look.glyph}</Text>

    const toggle = (id: CommandDeckSection) =>
      update($, expanded, ids => (ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id]))

    const row = (item: DeckRow) => (
      <Box key={`row-${item.name}`} flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1} paddingLeft={INDENT}>
        <Box key={`row-${item.name}-lines`} flexDirection="column">
          <Text bold>{short(`/${item.name}`, textRoom)}</Text>
          {item.text ? <Text dimColor>{short(item.text, textRoom)}</Text> : null}
        </Box>
        <Button key={`run-${item.name}`} plain label="▶" onPress={() => runCommand($, item)} />
      </Box>
    )

    /** Секция-карточка: значок и название цветом группы, число справа, строки под названием; `isCollapsed` — свёрнута, пока не раскроют. */
    const section = (id: CommandDeckSection, look: Look, items: DeckRow[], isFirst: boolean, isCollapsed = false) => {
      const isOpen = open.includes(id)
      const limit = isCollapsed ? 0 : SECTION_LIMIT
      const hidden = items.length - limit

      return (
        <Box
          key={`section-${id}`}
          flexDirection="column"
          marginTop={isFirst ? 0 : 1}
          {...(Svg ? { backgroundColor: CARD, paddingX: 1, paddingY: 1 } : {})}
        >
          <Box key={`section-${id}-head`} flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
            <Box key={`section-${id}-title`} flexDirection="row" alignItems="center" columnGap={1}>
              {mark(look)}
              <Text bold color={look.color}>
                {short(look.title, Math.max(8, columns - 8))}
              </Text>
            </Box>
            <Text dimColor>{String(items.length)}</Text>
          </Box>
          {(isOpen ? items : items.slice(0, limit)).map(row)}
          {hidden > 0 ? (
            <Box key={`more-${id}-row`} flexDirection="row" paddingLeft={INDENT}>
              <Button
                key={`more-${id}`}
                plain
                dimColor
                label={isOpen ? 'Свернуть' : isCollapsed ? `Показать ${items.length}` : `Ещё ${hidden}`}
                onPress={() => toggle(id)}
              />
            </Box>
          ) : null}
        </Box>
      )
    }

    const sections = [
      ...GROUPS.map(group => ({ id: group.id as CommandDeckSection, look: group as Look, items: deck.groups.find(one => one.id === group.id)?.rows ?? [], isCollapsed: false })),
      { id: 'rest' as CommandDeckSection, look: REST, items: deck.rest, isCollapsed: true },
    ].filter(one => one.items.length > 0)

    return (
      <Box flexDirection="column">
        {sections.length === 0 ? (
          <Text key="empty" dimColor>
            Список команд пока пуст.
          </Text>
        ) : (
          sections.map((one, index) => section(one.id, one.look, one.items, index === 0, one.isCollapsed))
        )}
      </Box>
    )
  })
}
