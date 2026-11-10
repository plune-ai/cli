# `plune mcp serve` і дві ери протоколу MCP: що виміряно

- Дата 2026-11-10; CLI 0.34.4 на `@modelcontextprotocol/sdk` 1.32.2; тести `src/mcp/__tests__/serve-stdio.e2e.test.ts` (лише `pnpm test:e2e`).

## Коротко

Сервер говорить лише легасі-ерою (`2025-11-25` і старші, з `initialize`). Клієнт лише ревізії `2026-07-28`, який починає із зонда `server/discover`, отримує `-32601 Method not found`. Клієнт обох ер після цього переходить на `initialize` і працює. Щоб працювали обидва види клієнтів, потрібен транспорт обох ер (див. «Міграція»).

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

## Живий прогін

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

## `plune_discover_tools` у новій ері

- Сьогодні модерний клієнт із зондом до `tools/list` не доходить. Без зонда він бачить 17 → після discover 18, а сервер шле голе `notifications/tools/list_changed` без `subscriptions/listen`, що порушує 2026-07-28.
- Після `serveStdio` (SDK 2.x) один екземпляр сервера закріплено за з'єднанням stdio, тож відкриті інструменти житимуть у процесі так само.
- Але модерний клієнт дізнається про зміну лише через `subscriptions/listen` (`toolsListChanged`) або коли сплине `ttlMs`. Тому для модерної ери `tools/list` має віддавати `ttlMs: 0`, а сповіщення — йти через підписку; перевірити тестом після міграції.
- Відповідь discover уже містить `visible`.
- SEP-2567 (без сесій): на stdio прямого конфлікту немає, для HTTP механіку довелося б переробити.
- Поза задачею: виконавець інструментів не обмежує кількість відкритих, тож відкриття всіх п'яти прихованих дає 22 > `MAX_VISIBLE_TOOLS` (20).

## Клієнти

- Claude Code: рантайм v2 на MCP TypeScript SDK 2.0 «adds MCP protocol revision 2026-07-28». Він питає stdio-сервери про нову ревізію, з рештою працює як v1. Типовий з v2.1.232 (сесії з прапорцями) і з v2.1.274 (решта). Змінні `MCP_SDK_GENERATION`, `MCP_PROTOCOL_NEGOTIATION` (`auto`/`legacy`); сервер, що відмовив, можуть не питати 7 днів. https://code.claude.com/docs/en/mcp
- Codex: ревізію не названо — не підтверджено документацією. https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- Пріоритет: зараз найважливіший легасі-рядок (він обслуговує обох клієнтів); модерний знадобиться для клієнтів лише нової ери.

## SDK (npm, 2026-11-10)

- `@modelcontextprotocol/sdk` 1.32.2 (MIT): `2025-11-25`…`2024-10-07`, без `2026-07-28` і `server/discover`.
- `@modelcontextprotocol/server` 2.4.0 (Apache-2.0, Node 20+, `@modelcontextprotocol/core` 2.4.0, `zod ^4.2.0`): «stable release line, implementing the 2026-07-28 MCP spec»; NOTICE немає; `serveStdio(factory, options)` обирає еру за першим повідомленням; є `enable()` і `disable()`.

## Міграція

Окремий крок: `serveStdio` з `@modelcontextprotocol/server` 2.x. Після нього модерний рядок матриці стає «works», а висновок доповнюється виміром після міграції.

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
- Зникло поле `execution.taskSupport: "forbidden"`. Це значення за замовчуванням ревізії `2025-11-25`, тож зміст не змінився.
- Виклик інструмента, якого немає в списку (наприклад, інструмента запису для токена `read`), тепер дає протокольну помилку `-32602`, а не результат з `isError: true`. Так вимагають сторінки tools обох ревізій: «Unknown tools» — це протокольна помилка.
  https://modelcontextprotocol.io/specification/2025-11-25/server/tools
  https://modelcontextprotocol.io/specification/2026-07-28/server/tools

### Відкрите питання: `plune_discover_tools` і вимога до `tools/list`

Сторінка tools ревізії `2026-07-28` каже, що набір у `tools/list` «MUST NOT vary per-connection or as a side effect of other requests on the connection». Набір МОЖЕ залежати від авторизації. Наша механіка «відкрити інструмент до кінця сесії» змінює список саме як побічний ефект виклику `plune_discover_tools`. Технічно вона працює в обох ерах (сповіщення йде через підписку, `ttlMs: 0`), але для модерної ери суперечить цьому MUST.

Варіанти, які потребують продуктового рішення:

- **(А)** Лишити як є і задокументувати відхилення. Найменше змін.
- **(Б)** У модерній ері віддавати в `tools/list` усі інструменти, які дозволяє токен (зараз 22). Але обмеження «не більше 20 видимих» тоді порушується.
- **(В)** У модерній ері список сталий (основні інструменти), а приховані можна викликати за назвою. `plune_discover_tools` лише повертає їхні описи й схеми. Це потребує власної обробки `tools/list` замість стандартної.

Для легасі-ери в усіх варіантах поведінка лишається як раніше.

https://modelcontextprotocol.io/specification/2026-07-28/server/tools
