# `plune mcp serve` і дві ери протоколу MCP: що виміряно

- Дата 2026-11-10; тести `src/mcp/__tests__/serve-stdio.e2e.test.ts` (лише `pnpm test:e2e`).
- Три виміри: **до** міграції (CLI 0.34.4 на `@modelcontextprotocol/sdk` 1.32.2) — розділи «Живий прогін (до міграції)» і «`plune_discover_tools` у новій ері (до міграції)»; **після** — розділ «Після міграції» (`@modelcontextprotocol/server` 2.4.0); **сталий список** у новій ері — розділ «`plune_discover_tools` і вимога до `tools/list`: варіант В».

## Коротко

Тепер сервер працює з обома ерами: клієнт, що відкриває з'єднання `initialize` (`2025-11-25` і старші), і клієнт ревізії `2026-07-28` із зондом `server/discover` (див. «Після міграції»). Вимогу `2026-07-28` до сталого `tools/list` закрито варіантом В: у новій ері список не змінюється, прихований інструмент викликається за назвою (див. розділ про варіант В).

До міграції сервер говорив лише легасі-ерою: клієнт лише ревізії `2026-07-28` на зонд `server/discover` отримував `-32601 Method not found`, а клієнт обох ер після цього переходив на `initialize`.

## Статус ревізії

`2026-07-28` — **Current** («ready for use and may continue to receive backwards compatible changes»): https://modelcontextprotocol.io/specification/versioning . Терміни: modern, legacy, dual-era (там само).

## Що змінилося для stdio

Джерела:

- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio
- https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- https://modelcontextprotocol.io/specification/2026-07-28/schema

Зміни:

- Рукостискання немає; у `params._meta` обов'язкові `io.modelcontextprotocol/protocolVersion` і `io.modelcontextprotocol/clientCapabilities`, `clientInfo` слід додавати.
- `server/discover` обов'язковий; `DiscoverResult` містить `resultType`, `supportedVersions`, `capabilities`, `ttlMs`, `cacheScope`.
- Непідтримана версія → `-32022` з `data.supported` і `data.requested`.
- Кожен результат має `resultType`; списки мають `ttlMs` і `cacheScope`.
- Сервер не пише запитів у stdout (замість них `InputRequiredResult`).
- `notifications/tools/list_changed` — лише в `subscriptions/listen` і лише за фільтром клієнта.
- Рамка без змін: одне повідомлення на рядок, у stdout лише MCP, журнали в stderr, вихід, коли stdin закрито.
- Сумісність: клієнт обох ер надсилає першим `server/discover`; `DiscoverResult` або модерна помилка означають модерний сервер, решта або тиша — легасі, і клієнт переходить на `initialize` (не за одним кодом помилки).
- Матриця: Modern→Legacy не працює; Dual-era→Legacy працює; Legacy→Dual-era працює; Modern→Dual-era працює.

## Живий прогін (до міграції)

`PLUNE_TOKEN=<вигаданий> PLUNE_API_URL=http://127.0.0.1:<порт> node dist/cli.cjs mcp serve`

| Клієнт | Надіслав | Відповідь | Підсумок |
|---|---|---|---|
| Легасі, SDK 1.x | `initialize` 2025-11-25 | `protocolVersion: "2025-11-25"`, `tools.listChanged: true` | працює: 17 інструментів, виклик, discover, 20, вихід після закриття stdin |
| Модерний, рядки JSON | перший `server/discover` з `_meta` 2026-07-28 | `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}` | відмова |
| Модерний без зонда | `tools/list` з модерним `_meta` | список за легасі-правилами: лише `tools`, без `resultType`, `ttlMs`, `cacheScope` | неоднозначна відповідь замість чіткої відмови |
| Легасі, невідома версія | `initialize` 1900-01-01 | `protocolVersion: "2025-11-25"` | легасі-узгодження |

```text
> {"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}
< {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}
> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}
< {"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"plune","version":"0.34.4"}},"jsonrpc":"2.0","id":1}
```

Життєвий цикл: у stdout лише JSON-RPC по рядку; вихід з кодом 0 за десятки мс після закриття stdin; без токена — код 2, причина в stderr; токена немає ні в stdout, ні в stderr. Тести перевірено чотирма мутаціями.

## `plune_discover_tools` у новій ері (до міграції)

- До міграції модерний клієнт із зондом до `tools/list` не доходить. Без зонда він бачить 17 → після discover 18, а сервер слав голе `notifications/tools/list_changed` без `subscriptions/listen`, що порушує 2026-07-28.
- Очікування на міграцію: після `serveStdio` (SDK 2.x) один екземпляр сервера закріплено за з'єднанням stdio, тож відкриті інструменти житимуть у процесі так само (підтвердилось, див. «Після міграції»).
- Але модерний клієнт дізнається про зміну лише через `subscriptions/listen` (`toolsListChanged`) або коли сплине `ttlMs`. Тому для модерної ери `tools/list` має віддавати `ttlMs: 0`, а сповіщення — йти через підписку; перевірено тестом після міграції.
- Відповідь discover уже містить `visible`.
- SEP-2567 (без сесій): на stdio прямого конфлікту немає, для HTTP механіку довелося б переробити.
- Поза задачею: виконавець інструментів не обмежує кількість відкритих, тож відкриття всіх п'яти прихованих дає 22 > `MAX_VISIBLE_TOOLS` (20).

## Клієнти

- Claude Code: рантайм v2 на MCP TypeScript SDK 2.0 «adds MCP protocol revision 2026-07-28». Він питає stdio-сервери про нову ревізію, з рештою працює як v1. Типовий з v2.1.232 (сесії з прапорцями) і з v2.1.274 (решта). Змінні `MCP_SDK_GENERATION`, `MCP_PROTOCOL_NEGOTIATION` (`auto`/`legacy`); сервер, що відмовив, можуть не питати 7 днів. https://code.claude.com/docs/en/mcp
- Codex: ревізію не названо — не підтверджено документацією. https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- Пріоритет на момент виміру до міграції: найважливішим був легасі-рядок (він обслуговував обох клієнтів); модерний потрібен для клієнтів лише нової ери. Після міграції працюють обидва.

## SDK (npm, 2026-11-10)

- `@modelcontextprotocol/sdk` 1.32.2 (MIT): `2025-11-25`…`2024-10-07`, без `2026-07-28` і `server/discover`.
- `@modelcontextprotocol/server` 2.4.0 (Apache-2.0, Node 20+, `@modelcontextprotocol/core` 2.4.0, `zod ^4.2.0`): «stable release line, implementing the 2026-07-28 MCP spec»; NOTICE немає; `serveStdio(factory, options)` обирає еру за першим повідомленням; є `enable()` і `disable()`.

## Міграція

Окремий крок: `serveStdio` з `@modelcontextprotocol/server` 2.x. Після нього модерний рядок матриці став «works»; вимір — у наступному розділі.

## Після міграції (2026-11-10, `@modelcontextprotocol/server` 2.4.0)

Сервер тепер запускається через `serveStdio`, і транспорт обирає еру за першим повідомленням. `@modelcontextprotocol/sdk` 1.32.2 лишився лише залежністю для розробки: на ньому написано тестовий легасі-клієнт. Бандл `dist/cli.cjs` його не підтягує.

| Клієнт | Надіслав | Відповідь | Підсумок |
|---|---|---|---|
| Легасі, SDK 1.x `Client` | `initialize` 2025-11-25 | `protocolVersion: "2025-11-25"`, `tools.listChanged: true` | працює; тест AC-1 зелений без змін |
| Модерний, рядки JSON | перший `server/discover` | `DiscoverResult`: `supportedVersions: ["2026-07-28"]`, `capabilities.tools.listChanged: true`, `resultType: "complete"`, `ttlMs: 0`, `cacheScope: "private"`, у `_meta` — `serverInfo` | **працює** |
| Модерний | `tools/list` | 17 інструментів, `resultType: "complete"`, `ttlMs: 0`, `cacheScope: "private"` | працює |
| Модерний | `tools/list` з версією `1900-01-01` | `-32022`, `data.requested: "1900-01-01"`, `data.supported` з `2026-07-28` | за специфікацією |
| Модерний | `subscriptions/listen` `{toolsListChanged: true}`, потім `plune_discover_tools` | `notifications/subscriptions/acknowledged`, потім `notifications/tools/list_changed`, обидва з `_meta.io.modelcontextprotocol/subscriptionId` = id запиту listen; наступний `tools/list` дає 18 | працює |
| Модерний без підписки | `plune_discover_tools` | жодного сповіщення в stdout; наступний `tools/list` уже з новим інструментом | за специфікацією |
| Легасі, невідома версія | `initialize` 1900-01-01 | `protocolVersion: "2025-11-25"` | як і раніше |

Рядки про `plune_discover_tools` у новій ері виміряно до варіанта В. Поточний стан — у розділі «`plune_discover_tools` і вимога до `tools/list`: варіант В».

```text
> {"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}
< {"result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{"listChanged":true}},"resultType":"complete","ttlMs":0,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"plune","version":"0.34.4"}}},"jsonrpc":"2.0","id":1}
> {"jsonrpc":"2.0","id":2,"method":"subscriptions/listen","params":{"_meta":{…},"notifications":{"toolsListChanged":true}}}
< {"jsonrpc":"2.0","method":"notifications/subscriptions/acknowledged","params":{"notifications":{"toolsListChanged":true},"_meta":{"io.modelcontextprotocol/subscriptionId":2}}}
> {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"plune_discover_tools","arguments":{"names":["plune_run_create"]},"_meta":{…}}}
< {"jsonrpc":"2.0","method":"notifications/tools/list_changed","params":{"_meta":{"io.modelcontextprotocol/subscriptionId":2}}}
< {"result":{"content":[…],"structuredContent":{…},"resultType":"complete","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"plune","version":"0.34.4"}}},"jsonrpc":"2.0","id":3}
```

### Що змінилось для клієнтів старої ери

Порівняння `tools/list` до і після міграції, 17 інструментів, по полях:

- `inputSchema.$schema` і `outputSchema.$schema`: `http://json-schema.org/draft-07/schema#` → `https://json-schema.org/draft/2020-12/schema` (у всіх 17 інструментів). Інший конвертер zod → JSON Schema. Решта схем не змінилась.
  Діалект 2020-12 отримують і клієнти, що погодили `2025-06-18` і старші ревізії: ті ревізії діалекту схем не визначали (на сторінці tools `2025-06-18` про нього нічого немає; правило «2020-12, якщо немає `$schema`» з'явилось у `2025-11-25`). Ризик — клієнт, що перевіряє схеми валідатором лише draft-07 (наприклад, Ajv у режимі draft-07): він може відкинути схему через незнайоме значення `$schema`. Самі схеми не використовують нічого, чого немає в draft-07: серед ключових слів усіх 22 інструментів є `anyOf`, `const`, `propertyNames`, `pattern`, і немає `prefixItems`, `$defs`, `$ref`, `unevaluated*`, `dependentSchemas`.
  https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- Зникло поле `execution.taskSupport: "forbidden"`. Це значення за замовчуванням ревізії `2025-11-25`, тож зміст не змінився.
- Виклик інструмента, якого немає в списку, тепер дає протокольну помилку `-32602`, а не результат з `isError: true`. Основний випадок — модель викликає прихований інструмент, ще не відкривши його через `plune_discover_tools`: відповідь `-32602 "Tool plune_run_create disabled"`. Рідший випадок — інструмент запису з токеном `read` (`-32602 … not found`). Так вимагають сторінки tools обох ревізій: «Unknown tools» — це протокольна помилка. Але протокольну помилку клієнт лише МОЖЕ (MAY) передати моделі, а результат з `isError` — СЛІД (SHOULD), тож підказка «спершу виклич `plune_discover_tools`» може не дійти до моделі. Обидва випадки покрито тестами в `server.test.ts`. Перший тепер лише для старої ери: у новій прихований інструмент викликається за назвою (варіант В нижче).
  https://modelcontextprotocol.io/specification/2025-11-25/server/tools
  https://modelcontextprotocol.io/specification/2026-07-28/server/tools

### `plune_discover_tools` і вимога до `tools/list`: варіант В

Сторінка tools ревізії `2026-07-28` каже, що набір у `tools/list` «MUST NOT vary per-connection or as a side effect of other requests on the connection». Набір МОЖЕ залежати від авторизації. До зміни `plune_discover_tools` розширював список як побічний ефект виклику (17 → 18 і `notifications/tools/list_changed` у підписку), тобто суперечив цьому MUST.

Обрано варіант В (з трьох: А — лишити й задокументувати, Б — віддавати всі 22 й порушити «не більше 20 видимих», В — сталий список і виклик за назвою).

Як зроблено:

- Еру сервер дізнається від транспорту: `serveStdio` передає фабриці `{ era: 'legacy' | 'modern' }` (публічний тип `McpRequestContext`), і `createPluneMcpServer` розгалужується на ній в одному місці.
- Нова ера: зареєстровано всі інструменти, які дозволяє токен, і всі ввімкнені, тож `tools/call` проходить ті самі перевірки SDK, що й для видимого. `tools/list` віддає власний обробник: лише основні інструменти, сталі на все з'єднання. Стандартний обробник `McpServer` для цього не годиться: він показує кожен увімкнений інструмент, а вимкнений не дає викликати.
- `plune_discover_tools` у новій ері нічого не вмикає: `revealed: []`, а в `available` кожен прихований інструмент має `inputSchema`.
- Стара ера без змін: discover відкриває інструмент і шле `list_changed`.

Вимір (2026-11-10, `dist/cli.cjs`, модерний клієнт рядками JSON: `server/discover`, `subscriptions/listen` `{toolsListChanged: true}`, `tools/list`, `plune_discover_tools` `{names: ["plune_run_create"]}`, `tools/list`, `plune_run_create` за назвою з `dry_run`):

| Крок | Відповідь |
|---|---|
| `tools/list` до discover | 17 інструментів, `ttlMs: 0`, `cacheScope: "private"` |
| `plune_discover_tools` | `revealed: []`; `available`: 5 прихованих, у кожного `inputSchema`; `visible`: 17 |
| `tools/list` після discover | ті самі 17; масив `tools` збігається з першим до символу (порівняно JSON) |
| `notifications/tools/list_changed` | не прийшло (лише `notifications/subscriptions/acknowledged`) |
| `plune_run_create` за назвою, не в списку | результат без `isError`: `{dryRun: true, request: {method: "POST", path: "/v1/runs", …}}` |

Тести:

- `src/mcp/__tests__/serve-stdio.e2e.test.ts` (справжній процес): список до і після discover однаковий, `list_changed` немає ні з підпискою, ні без неї (вікно 100 мс); прихований інструмент за назвою працює; з `--read-only` інструмент запису за назвою — `-32602`, до платформи запиту немає.
- `src/mcp/__tests__/server.test.ts`, блок «modern era: a fixed tool list»: те саме в пам'яті, плюс токен, який платформа відхилила як `read` (403): прихований інструмент запису далі відмовляє без запиту, а список не змінюється. Ще один тест звіряє наш список нової ери зі списком, який SDK будує для старої: однакові.
- `src/mcp-testing/__tests__/plune-tools-contract.test.ts`: вид «нова ера, після `plune_discover_tools`» — 17 інструментів, той самий список, що до discover; у старій ері — 22.
- Тест AC-1 старого клієнта (SDK 1.x) у `serve-stdio.e2e.test.ts` зелений без змін.

Що лишилось:

- Сервер і далі оголошує `tools.listChanged: true` в обох ерах. У новій ері список не змінюється, тож сповіщення не буде.
- Якщо платформа відхилить токен як `read` посеред з'єднання, у новій ері інструменти запису лишаються в списку (список сталий), а виклик відмовляє з `read_only_token`. У старій ері вони, як і раніше, зникають зі списку.
- Опис `plune_discover_tools` у контракті спільний для обох ер і каже «switch the ones you need on». У новій ері інструмент нічого не вмикає, а описує.

https://modelcontextprotocol.io/specification/2026-07-28/server/tools
