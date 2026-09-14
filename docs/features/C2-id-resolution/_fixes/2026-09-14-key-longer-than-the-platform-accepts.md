---
slug: C2-id-resolution
date: 2026-09-14
triage: gap
acs: [AC-13]
commit: <sha>
recurrence_of: none
---

# Fix: одне задовге ім'я тесту губило весь прогін — мовчки, у кожному CI-запуску з 12.09

## Symptom

Імпортуючи JUnit-звіт `plune` (`pnpm dogfood:report` → `plune run import junit.xml`), де в чотирьох
тестів `classname#name` довший за 1024 символи, очікувано: прогін стартує, 1861 результат прийнято,
задовгі імена вкорочено вголос; фактично: платформа відмовляє всьому старту —

```
plune: could not start the run (validation failed — configuration.expected.349.externalKey.value:
Too big: expected string to have <=1024 characters; …350 …351 …352). Results will be written to
.plune/pending-results.jsonl.
plune: 0 accepted · 1861 written to .plune/pending-results.jsonl
```

— і в CI fallback-файл гине разом із джобом. Масштаб: **кожен** CI-прогін `plune-ai/plune` з мержу
[#659](https://github.com/plune-ai/plune/pull/659) (12.09) і локальні гейти гілки B-7 з 11.09;
на беті `GET /v1/runs` акаунта `+dogfood-platform` показує 16 прогонів 09.09, 6 — 10.09, далі нуль
(доказ: лог CI PR #664, run `34695873210`). Крок звітування `continue-on-error`, тож збірка
лишалася зеленою, а календар епіка B-4 стояв.

Ім'я тестів — `Plune/src/contracts/__tests__/suite.test.ts:57-64`: шаблон `'%s → accepted: %s'`
бере **другий** позиційний аргумент, а це `'x'.repeat(16384)`, не `ok`. Це дефект тесту, і він
лагодиться там окремо; тут — про те, чому один такий тест коштував 1861 результат.

## Root cause

`reporter-core/session.ts` віддавав ключі платформі такими, як їх побудував імпортер
(`importers/junit.ts:72` `keyOf` → `classname#name`, так само `playwright-json.ts:92` і адаптер
`packages/playwright`), без жодної межі — свідомо: коментар D13 над `POST /v1/runs` казав «межі
оголошує платформа, її відмова не коштує результатів, усе йде у fallback». Це узагальнення C4 AC-12,
яке писалося про **описові** поля прогону (`PLUNE_RUN_TITLE`, `PLUNE_ENV`, `PLUNE_LABELS`), де
відмова справді коштує лише опису. Ключ — ідентичність: `externalKeySchema.value` ≤ 1024
(`Plune/src/contracts/test-case.ts:68`) стоїть на старті прогону, на `resolve` і на пропозиції в
чергу, тож одне задовге ім'я валить старт, а «усе йде у fallback» у CI означає «усе зникає».
Жоден тест цього не ловив: фейкова платформа в `session.test.ts` не перевіряє довжини, а C2 не мав
AC про довжину ключа — тріаж **gap**.

## The pinning test

`src/reporter-core/__tests__/session.test.ts` › «a test name longer than a key (AC-13)» (юніт,
фейкова платформа):

- `is shortened before it reaches the platform — the lookup, the start and the offer alike` —
  RED до фікса на `expect(sent.every((n) => n > 0 && n <= 1024)).toBe(true)`:
  `AssertionError: expected false to be true`.
- `says so, naming the test, and counts it once in the summary` — RED: у логу не було жодного
  рядка зі `shortened` (`said[0]` — `undefined`).
- `gives the same name the same key on every run, and two names two keys` та
  `leaves a name that fits alone` — зелені й до фікса; вони сторожать сам фікс від обрізання без
  дайджесту й від зайвого втручання на межі.

Живий доказ на зібраному бінарнику: JUnit з іменем на 2000 символів, офлайн → у fallback-файлі
ключ довжиною рівно 1024 з хвостом `#8a0f94eac214bdc0`, короткий ключ не зачеплено, у виводі
`plune: a test name longer than 1024 characters was shortened …` і `1 test name(s) shortened to
fit a key` у підсумку.

## Spec patch

Gap → додано AC-13 у §3 `spec.md` (`<!-- added-by-fix: 2026-09-14 -->`) і абзац у §5 про те,
чому тест живе в ядрі, а не в адаптері. C4 AC-12 не змінено: його межа — описові поля — тепер
названа в AC-13 явно.

## Follow-ups

- `Plune/src/contracts/__tests__/suite.test.ts:64` — шаблон `it.each` бере значення замість
  булевого; полагодити в репо `plune` разом із підняттям піна на `@plune-ai/cli@0.9.2`.
- `Plune` `scripts/dogfood-report.mjs` мовчить, коли імпорт віддав `0 accepted` з причиною у
  відповіді платформи; крок `continue-on-error` цього не покаже — потрібен `::warning::` в
  анотаціях PR (прецедент — диспатч сайту в `publish.yml`).
- Коментар D13 у `session.ts` над `POST /v1/runs` лишається чинним для описових полів; ключі й
  заголовок тепер обмежуються вище нього, і коментар над `boundKey` каже чому.
