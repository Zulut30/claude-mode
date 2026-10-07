# claude-mode

Моды для **Claude Code**: вкладка Code в десктопном приложении и терминал. Каждый мод — отдельная папка, ставьте только нужные.

[English version →](README.md)

| | Мод | Что даёт | Где видно | Команда | Сеть |
| --- | --- | --- | --- | --- | --- |
| 📊 | [**usage-band**](ru/usage-band) | Заполнение контекста, файлы памяти, лимиты подписки (5 часов и неделя), скорость ответа и таймер кэша | Полоса над полем ввода | `/band` | нет |
| 🗺️ | [**roadmap**](ru/roadmap) | Этапы текущей задачи: контекст → выполнение → проверка → тест → пуш → деплой, и план Claude | Панель «Дорожная карта» или полоса под чатом | `/roadmap` | нет |
| 🌿 | [**git-branches**](ru/git-branches) | Ветки, синхронизация с сервером, pull request’ы GitHub и коммиты, в духе GitLens | Панель «Ветки» | `/branches` | `gh`, `git fetch` |
| 🧭 | [**context-inspector**](ru/context-inspector) | Из чего состоит контекстное окно и что можно освободить | Панель «Контекст» | `/inspector` | нет |
| 🎛️ | [**command-deck**](ru/command-deck) | Главные слэш-команды с пояснением и запуском в один клик | Панель «Команды» | `/deck` | нет |
| ➡️ | [**next-steps**](ru/next-steps) | Цель сессии, чего Claude ждёт от вас, и 2–3 следующих запроса кнопками; клик вставляет черновик | Строка над полем ввода | `/next` | Haiku через Claude Code |
| 🛡️ | [**command-guard**](ru/command-guard) | Спрашивает перед опасными командами и показывает, что пропадёт | Окно подтверждения | `/guard` | нет |
| 🎚️ | [**mod-switch**](ru/mod-switch) | Включить или выключить «Дальше», страховку, колонки полосы над вводом и место дорожной карты — без команд | Панель «Моды» | `/mods` | нет |

Каждый мод есть на русском ([`ru/`](ru)) и английском ([`en/`](en)). Для одного мода выбирайте один язык: имена у версий совпадают.

Все панели в одном стиле: шапка с главным и тихими кнопками-значками, разделы-карточки с цветным значком и числом, цвет только по смыслу (зелёный — готово, жёлтый — ждёт, красный — ошибка, синий — сейчас).

## Как это выглядит

**usage-band** — над полем ввода:

```
КОНТЕКСТ                   ПАМЯТЬ                  5 ЧАСОВ
42% ━━━━──── 84k/200k      2 файла ~2k ток.        24% ━━────── ↻ 2 ч 15 мин

НЕДЕЛЯ                     СКОРОСТЬ                КЭШ
91% ━━━━━━━─ ↻ 3 д 4 ч     52 ток/с ▂▄▆▅▇ 3 400 ток 42 мин ━━━───── из 1 ч
```

**roadmap** — панель «Дорожная карта»:

```
сделай страницу входа                                 ↺  ⤓
Claude работает · этап 3 из 4 · 6 мин

◉ ЭТАПЫ                                             2/4
  ✓ Подготовка контекста                           1 мин
  ✓ Выполнение задачи                              4 мин
  │ 3 файла: login.tsx, api.ts, styles.css
  ● Тест                                          <1 мин
  ○ Пуш

☰ ПЛАН                                              2/5
  ✓ 2 шага выполнено
  ● Подключить API
```

**git-branches** — панель «Ветки»:

```
⎇ acme/site · main                                  ↻  ⇣
 ↑2 не запушено   ✎ 3 изменения   обновлено только что

⎇ ВЕТКИ                                               2
  feature/login                       ↓5  #12   АН  2 д
⇄ PULL REQUESTS                                       1
  #12 Страница входа                       одобрено  ✓
◉ КОММИТЫ                                             8
  a1b2c3d fix: шапка                             ИП  3 ч
```

**context-inspector** — панель «Контекст»:

```
Контекст 42%                                          ↻
84k из 200k токенов · обновлено только что
████████▓▓▓▓▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒▒▒▒

⚠ MCP-сервер «supabase» занимает 10k — если не нужен, отключите в /mcp

▤ СОСТАВ                                  ~84k ток.
  ● Сообщения                              55k · 28%
```

**command-deck** — панель «Команды»:

```
◐ КОНТЕКСТ И ПАМЯТЬ                                     4
  /compact                                              ▶
  Сжать переписку, освободить контекст
```

**next-steps** — над полем ввода после ответа:

```
◆ Моды для Claude Code      ждёт вас  выбрать, что делать дальше
ДАЛЬШЕ  [1 · Проверить вид]  [2 · Установка в один шаг]  [3 · Страховка команд]    ✕
```

**command-guard** — перед опасной командой:

```
Страховка
Claude хочет: git push --force
Пропадут 2 коммита на сервере: a1b2c3d fix: шапка, f0f0f0f init
[ Выполнить ]  [ Отмена ]
```

## Установка

Нужен **Claude Code 2.1.288** или новее. Моды используют API function hooks, который пока в раннем доступе и может меняться между версиями.

Репозиторий — это маркетплейс плагинов: каталог, из которого Claude Code ставит моды. Добавьте каталог один раз, затем ставьте нужные моды по имени. Русские моды — в каталоге `claude-mode-ru`, английские — в `claude-mode`.

**В Claude Code в терминале** наберите в сессии:

```
/plugin marketplace add https://raw.githubusercontent.com/Zulut30/claude-mode/main/ru/.claude-plugin/marketplace.json
/plugin install usage-band@claude-mode-ru
```

`/plugin install` открывает карточку мода: выберите **Install for you**. Повторите для каждого нужного мода.

**Из командной строки** (Терминал, PowerShell) — то же самое без открытия сессии. Так же ставят моды и для **десктопного приложения**: команды `/plugin` в нём нет, а настройки у него общие с терминалом.

```bash
claude plugin marketplace add https://raw.githubusercontent.com/Zulut30/claude-mode/main/ru/.claude-plugin/marketplace.json
claude plugin install usage-band@claude-mode-ru
claude plugin install roadmap@claude-mode-ru
claude plugin install git-branches@claude-mode-ru
claude plugin install context-inspector@claude-mode-ru
claude plugin install command-deck@claude-mode-ru
claude plugin install next-steps@claude-mode-ru
claude plugin install command-guard@claude-mode-ru
claude plugin install mod-switch@claude-mode-ru
```

Оставьте строки нужных модов, затем откройте новую сессию (или выполните `/reload-plugins` в открытой). В десктопном приложении после добавления каталога моды можно ставить и через **+ → Plugins → Add plugin**.

**Английские версии** — в отдельном каталоге. Для одного мода выбирайте один язык: `usage-band@claude-mode-ru` и `usage-band@claude-mode` — это один и тот же мод.

```bash
claude plugin marketplace add Zulut30/claude-mode
claude plugin install usage-band@claude-mode
```

**Обновление.** Для сторонних каталогов автообновление по умолчанию выключено. Чтобы включить, в Claude Code в терминале: `/plugin` → **Marketplaces** → `claude-mode-ru` → **Enable auto-update**. Вручную:

```bash
claude plugin marketplace update claude-mode-ru
claude plugin update usage-band@claude-mode-ru
```

Новая версия загрузится в следующей сессии.

**Удаление** одного мода: `claude plugin uninstall usage-band@claude-mode-ru` (в десктопном приложении: **+ → Plugins → Manage plugins**). Удалить каталог вместе со всеми его модами: `claude plugin marketplace remove claude-mode-ru`.

<details>
<summary><b>Вручную: из копии репозитория</b></summary>

Чтобы попробовать изменения до публикации или если команды `claude` нет. Не совмещайте с установкой из каталога: папка из `CLAUDE_CODE_PLUGIN_DIRS` молча подменяет установленный мод с тем же именем.

**1. Скачайте репозиторий** в постоянную папку:

```bash
git clone https://github.com/Zulut30/claude-mode.git ~/claude-mode
```

**2. Подключите нужные моды.**

*Десктопное приложение (и все сессии).* Откройте `~/.claude/settings.json` и добавьте в блок `env` переменную `CLAUDE_CODE_PLUGIN_DIRS`: абсолютные пути к папкам модов через `;` на Windows или через `:` на macOS/Linux. Если блок `env` уже есть, добавьте строку внутрь него.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\you\\claude-mode\\ru\\usage-band;C:\\Users\\you\\claude-mode\\ru\\roadmap;C:\\Users\\you\\claude-mode\\ru\\git-branches;C:\\Users\\you\\claude-mode\\ru\\context-inspector;C:\\Users\\you\\claude-mode\\ru\\command-deck;C:\\Users\\you\\claude-mode\\ru\\next-steps;C:\\Users\\you\\claude-mode\\ru\\command-guard;C:\\Users\\you\\claude-mode\\ru\\mod-switch"
  }
}
```

*Только терминал, на один запуск:*

```bash
claude --plugin-dir ~/claude-mode/ru/usage-band --plugin-dir ~/claude-mode/ru/roadmap --plugin-dir ~/claude-mode/ru/git-branches --plugin-dir ~/claude-mode/ru/context-inspector --plugin-dir ~/claude-mode/ru/command-deck --plugin-dir ~/claude-mode/ru/next-steps --plugin-dir ~/claude-mode/ru/command-guard --plugin-dir ~/claude-mode/ru/mod-switch
```

**3. Перезапустите приложение** или откройте новую сессию.

**Обновление:** `git pull` в папке репозитория, затем новая сессия. **Удаление:** уберите пути из `CLAUDE_CODE_PLUGIN_DIRS`.

</details>

## Команды

| Команда | Что делает |
| --- | --- |
| `/band hide <колонка>` · `/band show <колонка>` | Скрыть или показать колонку полосы: `context`, `memory`, `limits`, `speed`, `cache` |
| `/roadmap` | Открыть дорожную карту |
| `/roadmap reset` | Начать новую задачу; текущая уйдёт в «Ранее» |
| `/roadmap band` · `/roadmap pane` | Перенести карту под чат (над полем ввода) или обратно в панель |
| `/branches` | Открыть панель веток и обновить |
| `/branches fetch` | Выполнить `git fetch --all --prune` и обновить панель |
| `/inspector` | Открыть инспектор контекста и пересчитать |
| `/deck` | Открыть панель «Команды» |
| `/next` · `/next off` · `/next on` | Подсказки «Дальше»: состояние, выключить, включить |
| `/guard` · `/guard off` · `/guard on` | Страховка: состояние, выключить, включить |
| `/mods` | Открыть панель «Моды» |

Полоса над вводом, подсказки «Дальше» и страховка работают сами. Дорожная карта, инспектор контекста и «Команды» открываются сами при старте сессии, «Ветки» — сами в git-проекте.

## Что моды читают и запускают

| Мод | Читает | Запускает | Сеть |
| --- | --- | --- | --- |
| usage-band | Цифры сессии из Claude Code: контекст, память, лимиты; поток ответа модели (скорость, срок кэша) | — | нет |
| roadmap | Ваши запросы (для названия задачи) и вызовы инструментов Claude в сессии; есть ли в проекте файлы вроде `package.json`, `vercel.json` | `git rev-parse` | нет |
| git-branches | Состояние репозитория в папке сессии (или в её подпапке) | `git for-each-ref`, `git status`, `git log`, `git remote`; `gh pr list`; `git fetch` — только по кнопке ⇣ | `gh` обращается к GitHub от вашего аккаунта; `fetch` — к вашему remote |
| context-inspector | Разбивку контекста от Claude Code (локальная оценка, как `/context`) | — | нет |
| command-deck | Список команд Claude Code | Команды — только по вашему нажатию ▶ | нет |
| next-steps | Последние сообщения сессии | Вызов Haiku после ответа (выключается `/next off`) | Через Claude Code: тот же аккаунт и API |
| command-guard | Команду, которую Claude собирается выполнить | Только читающие `git log`, `git status`, `git diff`, `git clean -n` и сведения о файлах — для предпросмотра | нет |
| mod-switch | Включён или выключен каждый мод | Команды самих модов (`/next`, `/guard`, `/band`, `/roadmap`) — только по нажатию переключателя | нет |

Моды ничего не пишут в ваши файлы и не отправляют данные третьим сторонам. Состояние живёт в сессии Claude Code; next-steps запоминает в хранилище Claude Code только флаг «выключено».

**Нагрузка:** git и пересчёты идут только пока соответствующая панель открыта, список PR кэшируется на 5 минут, расход контекста берётся из Claude Code только при его изменении, живая скорость обновляется раз в секунду.

## Если что-то не видно

- **Нет полосы, скорости или кэша.** Скорость и кэш появляются после первого ответа модели. Выполните `claude plugin list`: мод должен быть в списке и включён. При ручной установке проверьте, что пути в `CLAUDE_CODE_PLUGIN_DIRS` абсолютные и указывают на папку мода (ту, где лежит `.claude-plugin`). Затем откройте новую сессию.
- **После установки из каталога загружается старая версия.** Уберите путь к моду из `CLAUDE_CODE_PLUGIN_DIRS`: локальная папка подменяет установленный мод.
- **Панель веток пишет «Здесь нет git-репозитория».** Ни папка сессии, ни её подпапки не git-проект.
- **Нет pull request’ов.** Установите [GitHub CLI](https://cli.github.com/) и выполните `gh auth login`.
- **Цифры 1–3 не вставляют подсказку.** Кликните по ней — клик работает везде.
- **Панель открылась не там, где хочется.** Место панели выбирает приложение; мод не может прикрепить её к нужной стороне или добавить пункт в меню.

## Для разработчиков

```
.claude-plugin/marketplace.json      английский каталог (claude-mode)
ru/.claude-plugin/marketplace.json   русский каталог (claude-mode-ru)
ru/  en/                             две языковые версии каждого мода
  <мод>/
    .claude-plugin/plugin.json       манифест
    hooks/hooks.json                 какой модуль загрузить
    hooks/register.ts(x)             код мода
    hooks/register.test.ts(x)        тесты
    types/index.d.ts                 типы состояния (если мод его хранит)
```

Тесты и проверка манифеста: `claude plugin test ru/roadmap`, `claude plugin validate ru/roadmap`. Проверка каталогов: `claude plugin validate .` и `claude plugin validate ru`.

Обновление до пользователей доходит, только когда меняется `version` в `plugin.json` мода: повышайте её в каждом релизе вместе с записью мода в обоих каталогах.
