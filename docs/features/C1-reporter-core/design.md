---
status: Draft
owner: "Leonid (AZANIR)"
updated_at: "2026-09-08"
feature_size: "L"
---

# Design — C1-reporter-core

> Спека: [`spec.md`](./spec.md) · Рішення пакування: [`adr/0001-adapter-bundles-the-core.md`](./adr/0001-adapter-bundles-the-core.md)
> Контракт платформи звірено з кодом 08.09.2026 (шляхи в `plune-ai/plune`).

## 1. Межа

```
@plune-ai/playwright  ──знає Playwright, не знає платформу──┐
                                                            ├──► @plune-ai/cli/reporter-core ──► HTTP
@plune-ai/vitest (D-5) ─────────────────────────────────────┘        знає платформу, не знає раннер
```

Ядро не імпортує нічого з `@playwright/test`. Адаптер не містить рядка `fetch`, назви маршруту
чи слова `Bearer`. Тест, який це стереже, — граматичний скан обох пакетів (див. `test-plan.md`).

## 2. Рішення

### D-1 — Адаптер вбудовує ядро, а не залежить від нього

ADR 0023 лишається чинним: ядро — **експорт із `@plune-ai/cli`** (`@plune-ai/cli/reporter-core`),
не новий пакет. Але пряма runtime-залежність адаптера від `@plune-ai/cli` притягла б у дерево
Playwright-проєкту `better-sqlite3` (нативна збірка), `@anthropic-ai/sdk`, `openai`, `commander` —
заради `fetch`. Це AC-13, і репо вже платило за цей самий дефект (`4ea7d92`).

Тому: `packages/playwright/` у воркспейсі цього репо, збірка з `noExternal` на ядро.
`@plune-ai/playwright` публікується **з нульовими залежностями** і одним peer — `@playwright/test`.
Повне обґрунтування й відкинуті варіанти — ADR 0001 цієї фічі.

### D-2 — Ядро без рантайм-залежностей: zod у ньому немає

ADR 0012: контракт належить платформі, клієнти йому відповідають. Копія схеми на клієнті — це
друге місце, яке може розійтися, і воно ще й тягне zod у чуже дерево. Ядро описує провід
**типами TypeScript**, а валідатором лишається платформа: вона відповідає названою помилкою
(`validation failed — <поле>: <причина>`), і саме її текст ядро показує.

Анти-дрейф — не клієнтський zod, а **контрактний тест платформи проти опублікованого пакета**,
за зразком наявного `src/server/__tests__/cli-sync-contract.test.ts`. Це те, що вимагає DoD епіка.

### D-3 — Репортер ніколи не вирішує статус

Платформа: «**The server maps, not the reporter**» (`contracts/project-settings.ts:17`). Адаптер
шле `source: 'playwright'` і `rawStatus` — рівно те слово, яким результат назвав раннер
(`passed` · `failed` · `timedOut` · `interrupted` · `skipped`). Мапу платформа вже має за
замовчуванням для `playwright`, і проєкт може її перевизначити **без релізу репортера**.

Наслідок для коду: у ядрі немає жодної гілки `if (status === 'failed')`. Поле `status` в
`resultSubmissionSchema` необовʼязкове, і ми його не заповнюємо ніколи.

### D-4 — `resultKey` детермінований і читабельний

`resultKey = ${testId}#${retry}`, обрізаний до 200 символів (стеля контракту); якщо не влазить —
`${sha256(testId).slice(0,32)}#${retry}`. Хеш — запасний шлях, не основний: ключ, який видно в
базі й у логах, дешевше налагоджувати.

Playwright-івський `TestCase.id` стабільний між шардами (він похідний від файлу, проєкту й
ланцюжка заголовків), а `TestResult.retry` розрізняє повтори. Разом це робить повторну відправку
**ідемпотентною** — платформа тримає `uniqueIndex('results_run_result_key_uniq')` на
`(run_id, result_key)` і відповідає поелементно: `accepted · duplicate · conflict · rejected`.
Саме на цьому стоїть AC-04: `merge-reports` шле те саме вдруге і отримує `duplicate`.

Параметризації в Playwright немає як окремої сутності — таблично-керовані тести відрізняються
заголовком, тобто вже входять у `testId`. `params` лишається в контракті ядра для інших раннерів.

### D-5 — Хто закриває прогін

| Ситуація | Хто шле `finish` |
|---|---|
| Один процес, без шардів (`config.shard === null`) | сам репортер в `onEnd` |
| Шарди | **ніхто з шардів**; закриває крок `merge-reports` або `plune run finish` (C5) |
| Процес упав | ніхто — прогін лишається `launched`, і це сигнал (AC-08) |

Ядро **не реєструє** `process.on('exit')`. Обробник, який «про всяк випадок» завершує прогін,
перетворив би обірваний прогін на зелений — рівно те, що AC-08 забороняє.

`finish` на вже завершеному прогоні платформа приймає як успіх (`lifecycle.ts:58`), тож гонка
двох закривачів нічого не ламає.

### D-6 — Один резолв на прогін, і він же — `configuration.expected`

Playwright знає перелік тестів у `onBegin`. Адаптер віддає його ядру один раз; ядро
використовує цей самий список **двічі**:

1. як `configuration.expected` у `POST /v1/runs` — звідси платформа рахує `notRun` (AC-09);
2. як вхід до `POST /v1/test-cases/resolve` (чанками по 500) — мапа `value → testCaseId`
   кешується на весь прогін (AC-10).

Один вхід, два використання. Раннер, що переліку не знає, резолвить на першому `flush` — та сама
функція, інший момент.

`PATCH /v1/runs/:id` C1 не викликає взагалі: усе, що він міг би змінити, відоме на старті.
Маршрут лишається для C5, де `plune run start` створює прогін раніше, ніж стає відомим `sha`.

### D-7 — Одне правило помилок

| Відповідь | Що робить ядро |
|---|---|
| мережа / 5xx / **429** | 3 спроби, експоненційний відступ; на 429 поважає `Retry-After` (платформа його шле, `rate-limit.ts:42`) |
| **401** | не ретраїть, каже `plune login` **один раз**, вимикає мережу до кінця прогону |
| **409** (прогін закритий) | не ретраїть, називає причину: двоє закрили один прогін |
| **400** | не ретраїть, друкує названу платформою причину |
| будь-що інше | не ретраїть |

І **одне правило призначення**: усе, що не відправилось, дописується у fallback. Без таблиці
«це зберігаємо, це викидаємо» — така таблиця має рівно один спосіб бути неправою і жодного
способу це помітити.

### D-8 — Fallback: JSONL, рядок = батч

`.plune/pending-results.jsonl`, поруч із `last-run.json`. Один рядок на невідправлений **батч**:

```
{"ts":"…","runId":"r-…"|null,"externalKey":"…"|null,"results":[…]}
```

Батч, а не результат, бо повторювана одиниця — саме батч: `plune run report` (C5) перечитає рядок
і надішле його як є. Дозапис (`appendFile`) переживає вбитий процес; один великий JSON — ні.

Токен у файл не потрапляє ніколи (§6.1 спеки).

### D-9 — Форма API ядра

```ts
export interface ReporterConfig {
  apiUrl?: string;          // → resolveApiUrl(), тобто PLUNE_API_URL, інакше бета
  token?: string;           // → loadToken() зі сховища plune login
  externalKey?: string;     // ключ спільного прогону; немає → прогін не приєднується
  kind?: RunKind;           // 'automated'
  meta?: RunMeta;           // sha / branch / ciUrl / runner
  batchSize?: number;       // 100, стеля 500
  fallbackPath?: string;
  fetchImpl?: typeof fetch; // шов для тестів — той самий, що в sync.ts
  log?: (line: string) => void;
}

export interface KeyRef { kind?: ExternalKeyKind; value: string }

export interface PendingResult {
  resultKey: string;
  keys: KeyRef[];        // кандидати по порядку; перший, що резолвився, виграє
  source: string;        // 'playwright'
  rawStatus: string;     // слово раннера — статус вирішує платформа (D-3)
  expectedStatus?: ResultStatus;
  execution?: Execution;
  errorContext?: string;
  params?: Record<string, unknown>;
  attachments?: Attachment[];
  assertions?: AssertionRecord[];
}

export interface RunSession {
  readonly runId: string | null;   // null — платформа була недосяжна на старті
  readonly joined: boolean;
  add(result: PendingResult): Promise<void>;
  flush(): Promise<void>;
  finish(reason?: string): Promise<void>;
  readonly stats: Readonly<RunStats>;
}

export function startRun(cfg: ReporterConfig, expected?: KeyRef[][]): Promise<RunSession>;
```

`runId: null` — не помилка, а стан: прогін не створився, усе йде у fallback, раннер працює далі
(AC-05).

## 3. Послідовність

```mermaid
sequenceDiagram
  participant A as адаптер
  participant C as reporter-core
  participant P as платформа

  A->>C: startRun(cfg, expected)
  C->>P: POST /v1/runs {schemaVersion:2, externalKey, configuration.expected}
  P-->>C: 201 {run, joined:false}  або  200 {run, joined:true}
  C->>P: POST /v1/test-cases/resolve {keys}  (чанки по 500)
  P-->>C: results[] {key, testCaseId, matchedKind}
  Note over C: мапа value → testCaseId на весь прогін

  loop кожен тест
    A->>C: add(PendingResult)
    Note over C: буфер; на batchSize — flush
    C->>P: POST /v1/runs/:id/results {results}
    P-->>C: {items[], counts{accepted,duplicate,conflict,rejected}}
  end

  A->>C: flush() в onEnd
  alt без шардів
    A->>C: finish()
    C->>P: POST /v1/runs/:id/events {event:'finish'}
  else шарди
    Note over C: не завершує — закриє merge-reports або plune run finish
  end
```

Гілки помилок (не намальовані, щоб не ховати головний шлях): будь-який крок, що не вдався за
D-7, дописує свій батч у fallback і не перериває прогін. `finish`, що не вдався, лишає прогін
`launched` — це AC-08, а не збій.

## 4. Розкладка файлів

```
src/reporter-core/
  index.ts        публічний експорт
  types.ts        дзеркало проводу (D-2 — типи, не схеми)
  client.ts       fetch + ретраї + Retry-After + класифікація відповідей (D-7)
  session.ts      startRun / add / flush / finish, буфер, мапа резолву
  fallback.ts     дозапис JSONL (D-8)
  result-key.ts   D-4

packages/playwright/
  package.json    @plune-ai/playwright, 0 залежностей, peer @playwright/test
  src/index.ts    ReporterV2: onBegin → startRun, onTestEnd → add, onEnd → flush (+finish)
  tsup.config.ts  noExternal на ядро
```

`src/index.ts` пакета `@plune-ai/cli` **не** реекспортує ядро: підшлях `./reporter-core` — окремий
вхід, щоб `require('@plune-ai/cli')` не тягнув його, а збірка адаптера не тягнула CLI.

## 5. Що лишається за межею

- Артефакти (C3): `attachments` приймаються як посилання й передаються далі; ядро нічого не
  завантажує.
- Драбина резолву (C2): `keys[]` — це і є порт. C1 наповнює його двома кандидатами
  (`playwright-id`, `path-title`); C2 додає решту сходинок, не змінюючи ані ядра, ані сигнатури.
- Імена `PLUNE_*` (C4): ядро читає `ReporterConfig`; C4 пише функцію, що будує його з оточення.
- Команди (C5): `plune run start · finish · exec · report` викликають те саме ядро.
