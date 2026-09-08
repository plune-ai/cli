# C1-reporter-core — статус

Стани: `todo` · `in progress` · `done` · `blocked`

| # | Задача | Стан | PR |
|---|---|---|---|
| T1 | result-key + types | done | PR 1 |
| T2 | client | done | PR 1 |
| T3 | fallback | done | PR 1 |
| T4 | session | done | PR 1 |
| T5 | subpath export | done | PR 1 |
| T6 | workspace + пакет адаптера | todo | |
| T7 | ReporterV2 | todo | |
| T8 | тести межі й пакування | todo | |
| T9 | e2e фікстура | todo | |
| T10 | документація | todo | |
| T11 | контрактний тест платформи (`plune-ai/plune`) | todo | |

## Порізано на PR

- **PR 1** — планові артефакти + ядро: T1 · T2 · T3 · T4 · T5
- **PR 2** — адаптер: T6 · T7 · T8 · T9 · T10
- **PR 3** — `plune-ai/plune`: T11

## Поза C1

`cli#15` (zod 3 → 4) злито окремо перед стартом — `ac96503`, PR #19. Кожен рядок ядра — це
zod-контекст, і переїзд після нього коштував би подвійної правки.
