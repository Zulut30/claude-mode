import type { CommandInfo, EngineInterface, Register } from 'claude-code'

import type { ModSwitchBandColumn, ModSwitchPlacement } from '../types'

const PANE = 'mod-switch'
const TITLE = 'Моды'
/** Своя команда: открывает панель. */
const SELF = 'mods'

const GREEN = '#3fb950'
const AMBER = '#d29922'
const BLUE = '#58a6ff'
const PURPLE = '#bc8cff'
const GRAY = '#8b949e'

/** Высота строки текста на десктопе: по ней значки встают вровень с текстом. */
const LINE_PX = 20

/** Отступ строк под текстом заголовка карточки: значок и зазор. */
const INDENT = 2

/** Фон карточки на десктопе. */
const CARD = '#8b949e14'

// ── Чужие значения: только чтение ────────────────────────────────────────
// Каждый мод сам хозяин своих настроек: панель их читает, а меняет — командой мода.
// Ключи — литералами: так их видит `claude plugin validate`.

const NEXT_OFF = { plugin: 'next-steps', key: 'isOff' } as const
const GUARD_OFF = { plugin: 'command-guard', key: 'isOff' } as const
const BAND_HIDDEN = { plugin: 'usage-band', key: 'hidden' } as const
const ROADMAP_PLACEMENT = { plugin: 'roadmap', key: 'placement' } as const

/** Что сейчас у модов: снимок их собственных значений. */
export type Snapshot = {
  nextOff: boolean
  guardOff: boolean
  hidden: readonly ModSwitchBandColumn[]
  placement: ModSwitchPlacement
}

const readSnapshot = async ($: EngineInterface): Promise<Snapshot> => {
  const [next, guard, band, roadmap] = await Promise.all([
    $.state.get(NEXT_OFF),
    $.state.get(GUARD_OFF),
    $.state.get(BAND_HIDDEN),
    $.state.get(ROADMAP_PLACEMENT),
  ])

  return {
    nextOff: next.value === true,
    guardOff: guard.value === true,
    hidden: Array.isArray(band.value) ? band.value : [],
    placement: roadmap.value === 'band' ? 'band' : 'pane',
  }
}

// ── Каталог ──────────────────────────────────────────────────────────────

/** Мод с переключателями: по его команде в списке движка видно, что он установлен. */
type Mod = { plugin: string; command: string }

const MODS = {
  next: { plugin: 'next-steps', command: 'next' },
  guard: { plugin: 'command-guard', command: 'guard' },
  band: { plugin: 'usage-band', command: 'band' },
  roadmap: { plugin: 'roadmap', command: 'roadmap' },
} satisfies Record<string, Mod>

export type ModId = keyof typeof MODS

const MOD_IDS = Object.keys(MODS) as ModId[]

/** Как показано состояние: значок, его цвет и подпись на кнопке. */
type StateLook = { mark: string; color: string; text: string; isDim?: boolean }

const ON: StateLook = { mark: '●', color: GREEN, text: 'Вкл' }
const OFF: StateLook = { mark: '○', color: GRAY, text: 'Выкл', isDim: true }

/** Один переключатель: кнопка, подпись, пояснение и как его читать и переключать командой мода. */
export type Switch = {
  key: string
  mod: ModId
  label: string
  why?: string
  /** Включено ли сейчас — по значениям мода. */
  isOn: (now: Snapshot) => boolean
  /** Аргументы команды мода, переводящие в это состояние. */
  args: (isOn: boolean) => string
  /** Подписи двух состояний, когда это не «Вкл»/«Выкл». */
  looks?: { on: StateLook; off: StateLook }
}

/** Как выглядит заголовок карточки: название, цвет, значок в терминале (`glyph`) и на десктопе (`icon`). */
type Card = { id: string; title: string; color: string; glyph: string; icon: string; switches: Switch[] }

const onOff = (isOn: boolean) => (isOn ? 'on' : 'off')

const COLUMNS: [ModSwitchBandColumn, string][] = [
  ['context', 'Контекст'],
  ['memory', 'Память'],
  ['limits', 'Лимиты'],
  ['speed', 'Скорость'],
  ['cache', 'Кэш'],
]

/** Значки в сетке 16×16 (C — цвет). */
const CARDS: Card[] = [
  {
    id: 'hints',
    title: 'ПОДСКАЗКИ И ЗАЩИТА',
    color: AMBER,
    glyph: '◈',
    icon: '<path d="M8 1.8 L13.5 4 V8 C13.5 11 11.2 13.2 8 14.4 C4.8 13.2 2.5 11 2.5 8 V4 Z" fill="none" stroke="C" stroke-width="1.6" stroke-linejoin="round"/><path d="M5.6 8.1 L7.3 9.8 L10.5 6.4" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    switches: [
      {
        key: 'toggle-next',
        mod: 'next',
        label: 'Дальше',
        why: 'после ответа — цель и 2–3 следующих запроса; один вызов Haiku',
        isOn: now => !now.nextOff,
        args: onOff,
      },
      {
        key: 'toggle-guard',
        mod: 'guard',
        label: 'Страховка',
        why: 'спрашивает перед rm -r, push --force, reset --hard',
        isOn: now => !now.guardOff,
        args: onOff,
      },
    ],
  },
  {
    id: 'band',
    title: 'ПОЛОСА НАД ВВОДОМ',
    color: BLUE,
    glyph: '▤',
    icon: '<rect x="2" y="2.5" width="12" height="6" rx="1.5" fill="none" stroke="C" stroke-width="1.6"/><path d="M2.8 12.5 H13.2" stroke="C" stroke-width="1.6" stroke-linecap="round"/>',
    switches: COLUMNS.map(([id, label]) => ({
      key: `toggle-col-${id}`,
      mod: 'band' as const,
      label,
      isOn: (now: Snapshot) => !now.hidden.includes(id),
      args: (isOn: boolean) => `${isOn ? 'show' : 'hide'} ${id}`,
    })),
  },
  {
    id: 'roadmap',
    title: 'ДОРОЖНАЯ КАРТА',
    color: PURPLE,
    glyph: '◇',
    icon: '<circle cx="4" cy="12" r="1.8" fill="C"/><circle cx="12" cy="4" r="1.8" fill="C"/><path d="M4 9.8 V8.5 C4 7.4 4.9 6.5 6 6.5 H10 C11.1 6.5 12 5.6 12 4.5" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="1.6 1.8"/>',
    switches: [
      {
        key: 'toggle-roadmap',
        mod: 'roadmap',
        label: 'Где показывать',
        why: 'в панели — вкладкой сбоку, под чатом — полосой над вводом',
        isOn: now => now.placement === 'pane',
        args: isOn => (isOn ? 'pane' : 'band'),
        looks: { on: { mark: '▣', color: BLUE, text: 'В панели' }, off: { mark: '▬', color: PURPLE, text: 'Под чатом' } },
      },
    ],
  },
]

/** Команда мода из списка движка: его имя или `<плагин>:<имя>`; нет — мод не установлен. */
export const findModCommand = (list: readonly CommandInfo[], mod: Mod) =>
  list.find(command => command.plugin === mod.plugin && (command.name === mod.command || command.name.endsWith(`:${mod.command}`))) ??
  list.find(command => command.plugin === undefined && command.source === 'plugin' && command.name === mod.command)

/** Какие моды установлены: имя команды каждого, у отсутствующих — `undefined`. */
export const installedMods = (list: readonly CommandInfo[]) =>
  Object.fromEntries(MOD_IDS.map(id => [id, findModCommand(list, MODS[id])?.name])) as Record<ModId, string | undefined>

// ── Переключение ─────────────────────────────────────────────────────────

export const short = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, Math.max(1, max - 1))}…` : line
}

/**
 * Переключает командой самого мода (`$.command.run`, как если бы её набрали):
 * мод сам меняет и запоминает своё значение. Ответ команды виден в чате;
 * всплывашка — только если команда не запустилась или значение не сменилось.
 */
export const toggle = async ($: EngineInterface, command: string, item: Switch) => {
  const isOn = !item.isOn(await readSnapshot($))
  const args = item.args(isOn)
  try {
    const reply = await $.command.run({ command, args })
    if (item.isOn(await readSnapshot($)) !== isOn) {
      $.ui.toast(`/${command} ${args}: ${short(reply.text || 'ничего не изменилось', 120)}`)
    }
  } catch (error) {
    $.ui.toast(`Не удалось выполнить /${command} ${args}: ${short(error instanceof Error ? error.message : String(error), 120)}`)
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
    await $.command
      .register({ name: SELF, description: 'Открыть панель «Моды»: включить и выключить подсказки, страховку, колонки полосы и место дорожной карты' })
      .catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: SELF }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return {
      text: opened.isPlaced ? 'Панель «Моды» открыта.' : 'Панель «Моды» появится, когда хватит места: расширьте окно.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined

    const list = await $.command.list().catch(() => [] as CommandInfo[])
    const commands = installedMods(list)
    // Чтение при отрисовке подписывает панель: мод сменил значение — панель перерисуется сама.
    const now = await readSnapshot($)

    const columns = e.props.bodyColumns
    // Поля карточки на десктопе (по клетке с каждой стороны) и отступ строк под заголовком.
    const room = Math.max(8, columns - INDENT - (Svg ? 2 : 0))

    const mark = (card: Card) =>
      Svg ? <Svg source={iconSvg(card.icon, card.color)} alt="значок" width={12} height={LINE_PX} /> : <Text color={card.color}>{card.glyph}</Text>

    const row = (item: Switch, command: string) => {
      const look = item.isOn(now) ? (item.looks?.on ?? ON) : (item.looks?.off ?? OFF)
      // Справа значок, зазор и кнопка; родная кнопка десктопа шире своей подписи.
      const right = 2 + look.text.length + (Svg ? 4 : 0)

      return (
        <Box key={`row-${item.key}`} flexDirection="column" paddingLeft={INDENT}>
          <Box key={`row-${item.key}-line`} flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
            <Text>{short(item.label, Math.max(4, room - 1 - right))}</Text>
            <Box key={`row-${item.key}-state`} flexDirection="row" alignItems="center" columnGap={1}>
              <Text color={look.color}>{look.mark}</Text>
              <Button key={item.key} plain dimColor={look.isDim} label={look.text} onPress={() => toggle($, command, item)} />
            </Box>
          </Box>
          {item.why ? <Text dimColor>{short(item.why, room)}</Text> : null}
        </Box>
      )
    }

    /** Карточка: значок и название цветом карточки, под ними переключатели установленных модов. */
    const card = (one: Card, isFirst: boolean) => (
      <Box
        key={`card-${one.id}`}
        flexDirection="column"
        marginTop={isFirst ? 0 : 1}
        {...(Svg ? { backgroundColor: CARD, paddingX: 1, paddingY: 1 } : {})}
      >
        <Box key={`card-${one.id}-title`} flexDirection="row" alignItems="center" columnGap={1}>
          {mark(one)}
          <Text bold color={one.color}>
            {short(one.title, Math.max(8, columns - 4))}
          </Text>
        </Box>
        {one.switches.flatMap(item => {
          const command = commands[item.mod]

          return command ? [row(item, command)] : []
        })}
      </Box>
    )

    const shown = CARDS.filter(one => one.switches.some(item => commands[item.mod]))
    const absent = MOD_IDS.filter(id => !commands[id])

    return (
      <Box flexDirection="column">
        {shown.map((one, index) => card(one, index === 0))}
        {absent.length > 0 ? (
          <Box key="absent" marginTop={shown.length > 0 ? 1 : 0}>
            <Text dimColor>{short(`Не установлены: ${absent.map(id => MODS[id].plugin).join(', ')}`, Math.max(8, columns))}</Text>
          </Box>
        ) : null}
      </Box>
    )
  })
}
