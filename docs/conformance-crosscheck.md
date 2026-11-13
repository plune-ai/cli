# `plune mcp conformance` і офіційний набір відповідності MCP: журнал розбіжностей

Ручна звірка, не гейт PR і не залежність пакета. Сторонні пакети ставилися в окрему порожню теку поза репозиторієм і запускалися з мінімальним середовищем (лише `PATH`, `SystemRoot`, `ComSpec`, `TEMP`, `TMP`; для `npm install` ще тека користувача і `APPDATA`), HTTP-сервер слухав лише `127.0.0.1`.

## Прогін 2026-11-14

### Версії

| Що | Версія |
|---|---|
| `plune mcp conformance` | CLI 0.38.0, профіль `plune-mcp-conformance` 2026-11.1, набір `protocol` |
| Офіційний набір `@modelcontextprotocol/conformance` | 0.1.16 (MIT) |
| Еталонний сервер `@modelcontextprotocol/server-everything` | 2.3.0 (`mcp-servers/everything`), Streamable HTTP і stdio |
| Node.js | 24.13.1 |

Ліцензія `server-everything`: у метаданих npm «SEE LICENSE IN LICENSE», але файлу `LICENSE` у пакеті 2.3.0 немає (лише `dist/`, `package.json`, `README.md`). README каже «licensed under the MIT License» і відсилає до файлу в репозиторії проєкту. Файл `LICENSE` репозиторію https://github.com/modelcontextprotocol/servers/blob/main/LICENSE описує перехід з MIT на Apache-2.0: новий код під Apache-2.0, внески без згоди на зміну ліцензії лишаються під MIT. Файл `LICENSE` пакета `conformance` 0.1.16 має той самий текст.

### Що вміє офіційний набір

- `conformance list --server`: 32 серверні сценарії лише для ревізій `2025-06-18` і `2025-11-25`; ревізії `2026-07-28` немає.
- `conformance server` приймає лише `--url`; stdio-сервер він не перевіряє.
- Набір `active` (типовий) пропускає `json-schema-2020-12` і `server-sse-polling`; у прогоні нижче взято `--suite all`. Результат кожного сценарію пишеться у `checks.json` лише з `-o <тека>`.

### Як запускали

Сервер: `node <пакет>/dist/index.js streamableHttp` з `PORT=3001`, `HOST=127.0.0.1` і окремо `... stdio`. Наша сторона: `plune mcp conformance --suite protocol` по HTTP і по stdio, без `--protocol-version` (сервер обох ер, автовибір дав `2026-07-28`) і ще раз з `--protocol-version 2025-11-25` та `2026-07-28` і `--fixture` (виклики `echo` і `get-structured-content`). Офіційний: `conformance server --url http://127.0.0.1:3001/mcp --suite all -o <тека>`.

Підсумок:

| Прогін | Вердикт | Невдалі |
|---|---|---|
| Наш, HTTP, `2025-11-25` | passed, 100 | `resources-read-not-found` (SHOULD), `http-host-rebinding-advice` (порада) |
| Наш, HTTP, `2026-07-28` | passed, 100 | `http-modern-get-delete-405` (SHOULD), `http-host-rebinding-advice` (порада) |
| Наш, stdio, `2025-11-25` | failed, 94.1 | `base-jsonrpc-parse-error` (MUST), `resources-read-not-found` (SHOULD) |
| Наш, stdio, `2026-07-28` | failed, 92.8 | `base-jsonrpc-parse-error` (MUST), `mod-unsupported-version` (MUST) |
| Офіційний, HTTP, `--suite all` | exit 1 | 21 з 33 сценаріїв; 20 з них через назви інструментів, підказок і ресурсів, яких цей сервер не має |

### Таблиця звірки (HTTP, ревізія `2025-11-25`, яку перевіряє офіційний набір)

| Наш id | Їхній сценарій | Наш вердикт | Їхній вердикт | Хто правий | Розділ специфікації |
|---|---|---|---|---|---|
| `life-initialize-result` | `server-initialize` | passed | SUCCESS | збіг | https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle |
| `life-ping-empty-result` | `ping` | passed | SUCCESS | збіг | https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping |
| `logging-set-level` (порада) | `logging-set-level` | passed | SUCCESS | збіг | https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging |
| `tools-list-shape`, `tools-input-schema-valid` | `tools-list` | passed | SUCCESS | збіг | https://modelcontextprotocol.io/specification/2025-11-25/server/tools |
| `resources-list-shape` | `resources-list` | passed | SUCCESS | збіг | https://modelcontextprotocol.io/specification/2025-11-25/server/resources |
| `prompts-list-shape` | `prompts-list` | passed | SUCCESS | збіг | https://modelcontextprotocol.io/specification/2025-11-25/server/prompts |
| `http-concurrent-posts-matched` | `server-sse-multiple-streams` | passed | SUCCESS (2 перевірки) | збіг | https://modelcontextprotocol.io/specification/2025-11-25/basic/transports |
| `http-origin-invalid-403`, `http-origin-localhost-accepted` | `dns-rebinding-protection` | passed | SUCCESS (2 перевірки) | збіг, див. розбіжність 3 | https://modelcontextprotocol.io/specification/2025-11-25/basic/transports |
| `http-host-rebinding-advice` (порада) | `dns-rebinding-protection` | failed | SUCCESS | обидва допустимі, див. розбіжність 3 | https://modelcontextprotocol.io/specification/2025-11-25/basic/transports |
| `completion-complete` (порада) | `completion-complete` | passed | FAILURE | розбіжність не про протокол, див. розбіжність 1 | https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/completion |
| `tools-structured-conformant`, `tools-structured-has-text`, `tools-call-unknown-error` | `tools-call-simple-text`, `-image`, `-audio`, `-embedded-resource`, `-mixed-content`, `-with-logging`, `-error`, `-with-progress`, `-sampling`, `-elicitation`, `elicitation-sep1034-defaults`, `elicitation-sep1330-enums`, `json-schema-2020-12` | passed | FAILURE (13) | розбіжність не про протокол, див. розбіжність 1 | https://modelcontextprotocol.io/specification/2025-11-25/server/tools |
| `resources-read-listed`, `resources-templates-shape` | `resources-read-text`, `resources-read-binary`, `resources-templates-read` | passed | FAILURE (3) | розбіжність не про протокол, див. розбіжність 1 | https://modelcontextprotocol.io/specification/2025-11-25/server/resources |
| `prompts-get-unknown-error` | `prompts-get-simple`, `-with-args`, `-embedded-resource`, `-with-image` | passed | FAILURE (4) | розбіжність не про протокол, див. розбіжність 1 | https://modelcontextprotocol.io/specification/2025-11-25/server/prompts |
| `resources-read-not-found` (SHOULD) | — | failed | — | ми праві, див. розбіжність 2 | https://modelcontextprotocol.io/specification/2025-11-25/server/resources |
| `http-sse-event-ids-unique`, `http-sse-stream-closes` | `server-sse-polling` (у них «pending») | passed | 3 WARNING, 0 FAILURE | вони праві про пропуск, див. розбіжність 4 | https://modelcontextprotocol.io/specification/2025-11-25/basic/transports |
| — | `resources-subscribe`, `resources-unsubscribe` | — | SUCCESS | у нас немає перевірки, див. розбіжність 5 | https://modelcontextprotocol.io/specification/2025-11-25/server/resources |

### Розбір розбіжностей

**Розбіжність 1. 20 офіційних FAILURE: сценарії вимагають власного тестового сервера.** Кожна з них падає на запиті до інструмента, підказки чи ресурсу з фіксованою назвою (`test_simple_text`, `test_prompt_with_arguments`, `test://static-text`, `json_schema_2020_12_tool` тощо), якого в `server-everything` немає; сервер відповідає `-32602 … not found`. Це не порушення протоколу: така відповідь і є описаною поведінкою. Висновок: обидва допустимі; ці сценарії про цей сервер нічого не кажуть. Наші перевірки беруть назви з `tools/list`, `resources/list`, `prompts/list` і `--fixture`, тому застосовні до будь-якого сервера.
Цитата: «Invalid prompt name: `-32602` (Invalid params)» — https://modelcontextprotocol.io/specification/2025-11-25/server/prompts (Error Handling); для інструментів «Unknown tools» належить до Protocol Errors — https://modelcontextprotocol.io/specification/2025-11-25/server/tools (Error Handling).

**Розбіжність 2. `resources-read-not-found`: сервер відповідає `-32602`, ревізія `2025-11-25` радить `-32002`.** У офіційного набору такої перевірки немає, але його сценарії `resources-read-*` побачили ту саму відповідь (`-32602 Resource not found`). Висновок: ми праві; рівень SHOULD, тож вердикт сервера лишається passed.
Цитата: «Servers SHOULD return standard JSON-RPC errors … Resource not found: `-32002`» — https://modelcontextprotocol.io/specification/2025-11-25/server/resources (Error Handling).

**Розбіжність 3. DNS rebinding: їхній SUCCESS і наша порада failed не суперечать одне одному.** Їхній сценарій шле разом `Host: evil.example.com` і `Origin: http://evil.example.com`; сервер відповідає 403 «Invalid Origin», тобто спрацьовує лише перевірка `Origin`. Наша `http-origin-invalid-403` дає те саме (passed), а порада `http-host-rebinding-advice` окремо шле лише чужий `Host` і бачить 200. Вимога специфікації стосується лише `Origin`. Висновок: обидва допустимі; наша порада не є вимогою специфікації і так і позначена.
Цитата: «Servers MUST validate the `Origin` header on all incoming connections» — https://modelcontextprotocol.io/specification/2025-11-25/basic/transports (Security Warning).

**Розбіжність 4. `server-sse-polling`: у нас немає перевірок на «priming»-подію і поле `retry`.** Офіційний набір видав три WARNING: немає події з id і порожнім `data` на початку потоку POST, немає `retry`, немає відповіді після повторного підключення з `Last-Event-ID`. Висновок: вони праві, що це рекомендації ревізії `2025-11-25`; у нас цих перевірок немає (лише унікальність id подій і закриття потоку). Кандидат на нові поради.
Цитата: «The server SHOULD immediately send an SSE event consisting of an event ID» — https://modelcontextprotocol.io/specification/2025-11-25/basic/transports (Sending Messages to the Server).

**Розбіжність 5. `resources-subscribe` / `resources-unsubscribe`: у нас перевірки немає.** Їхні сценарії лише перевіряють, що запит приймається. Висновок: прогалина в нас, не розбіжність вердиктів.
Цитата: «The protocol supports optional subscriptions to resource changes» — https://modelcontextprotocol.io/specification/2025-11-25/server/resources (Subscriptions).

### Що побачили лише наші перевірки (офіційний набір їх не має)

**Знахідка 1. `http-modern-get-delete-405` (HTTP, `2026-07-28`): наша перевірка, схоже, неправа.** Сервер говорить обома ерами: той самий процес відповідає на `initialize` (`life-initialize-result` passed у прогоні `2025-11-25`), а GET і DELETE без сесії отримують 400 за правилами `2025-11-25`. Специфікація радить 405 лише серверу, що підтримує тільки нову ревізію, і опис самої перевірки каже, що для сервера обох ер вона `not-applicable`. Але вердикт failed: при виборі ери через `server/discover` (автовибір або `--protocol-version 2026-07-28`) перевірка не дізнається, що сервер відповідає ще й на `initialize`. Тут не виправлено, записано.
Цитата: «A server that supports only this revision … SHOULD respond as follows» — https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http (Earlier Streamable HTTP Revisions).

**Знахідка 2. `mod-unsupported-version` (stdio, `2026-07-28`): вердикт залежить від попередніх перевірок, наша перевірка неправа для цього сервера.** Окремий процес сервера на `server/discover` з `1900-01-01` відповідає `-32022` з `data.supported` (перевірено сирим кадром і `--check mod-unsupported-version` окремо: passed). У повному прогоні по stdio всі перевірки ділять один процес сервера, і після запиту без `protocolVersion` у `_meta` (`mod-meta-required-fields`) сервер обох ер далі відповідає за правилами старої ери (наприклад, `-32601` на `server/discover`). Перевірка мала б іти на свіжому з'єднанні. Тут не виправлено, записано.
Цитата: «it MUST respond with an UnsupportedProtocolVersionError listing the versions it does support» — https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning (Protocol Version Negotiation).

**Знахідка 3. `base-jsonrpc-parse-error` (stdio): рівень MUST для stdio під сумнівом.** По HTTP сервер на невалідний JSON відповідає `-32700` (passed), по stdio мовчить і відповідає на наступне повідомлення. JSON-RPC 2.0 вимагає відповіді на виклик, а `-32700` з `id: null` дає лише як приклад. На stdio ж сам клієнт не має права писати не-MCP повідомлення. Висновок: на stdio розумніше рахувати це порадою, а не MUST; переглянути рівень. Тут не виправлено, записано.
Цитата: «MUST NOT write anything to the server's stdin that is not a valid MCP message» — https://modelcontextprotocol.io/specification/2025-11-25/basic/transports (stdio); «When a rpc call is made, the Server MUST reply with a Response» — https://www.jsonrpc.org/specification (5 Response object).

### Зауваги до `scripts/conformance-crosscheck.mjs`

Скрипт цього разу не запускали як є; кроки повторено вручну, бо:

- `run()` запускає `npm install`, нашу CLI й бінарник офіційного набору з `cwd` у теці з їхніми пакетами (`--out`), а правило звірки — не запускати нічого з теки зі сторонніми файлами;
- наша CLI запускається без `--protocol-version`, тож на сервері обох ер ми перевіряємо `2026-07-28`, а офіційний набір — `2025-11-25`: вердикти непорівнянні без другого прогону з `--protocol-version 2025-11-25`;
- офіційний набір запускається без `-o` і без `--suite all`: `checks.json` не зберігається, два сценарії пропущено;
- stdio не перевіряється взагалі, хоча завдання звірки його охоплює (для нашої сторони).

### Висновок

- Збіг вердиктів на всіх спільних темах, де обидва інструменти справді щось вимірювали: initialize, ping, logging, списки інструментів, ресурсів і підказок, паралельні POST, перевірка `Origin`.
- 20 з 21 офіційних FAILURE — сценарії, що вимагають власного тестового сервера, а не порушення протоколу в `server-everything`.
- У нас прогалини: «priming»-подія і `retry` для SSE (розбіжність 4), підписка на ресурси (розбіжність 5).
- Наші перевірки, що виглядають неправими: `http-modern-get-delete-405` на сервері обох ер (знахідка 1), `mod-unsupported-version` на спільному stdio-процесі (знахідка 2), рівень MUST для `base-jsonrpc-parse-error` на stdio (знахідка 3).
