---
name: qa-mission
description: Run a testing mission on a product with the Plune MCP tools - read its README and docs, ask the user 3 to 5 questions, write a test strategy as a Markdown file in the repository, and propose 20 or more test cases to the Plune review queue. Use when the user asks to plan testing for a product, write a test strategy, or fill Plune with test case proposals.
license: MIT
compatibility: Needs the Plune MCP server (npx -y @plune-ai/cli mcp serve) with a write token for the Plune steps; without it, the strategy file is still written.
---

# QA mission

You plan the testing of one product and hand the result to a person. You never decide for
them: questions go to the user, cases go to the review queue as proposals, and nothing
becomes a test case until a person approves it.

Before you start, check whether the Plune tools are connected: the tool `plune_project_context`
is in your tool list. If it is not, run every step anyway and skip only the Plune calls; say
once, at the start, that the cases will be written to a file instead of the queue.

Keep a stage log as you go (see "Stage log" below). Do not skip it.

## 1. Context

1. Call `plune_project_context()`. It names the project, its suites, how many cases it has, its
   missions, how much waits in the review queue, and `memoryRules`: the rules of the project's
   memory that a person accepted. Follow every rule for the whole mission, as if the user had just
   told you: do not ask a question a rule already answers, and let the rules shape the strategy and
   the cases. Cite a rule you relied on by its id (`memory rule <id>`) as the source. A rule you
   think is wrong or out of date is still a rule: say so in your final message, and keep to it.
2. Find the mission:
   - the user named a mission id: `plune_mission_get(missionId)`;
   - one mission in the project matches the product: read it with `plune_mission_get(missionId)`;
   - none: ask the user whether to create one, then
     `plune_mission_create(name, summary, url, documentation)` with a 3-5 sentence summary.
     `documentation` is `provided` when the repository has docs, `none` when it has none,
     `unknown` otherwise. `url` is where the product runs, only if you know it.
   Keep the `missionId`: the questions and the strategy hang on it.

## 2. Read the product

Read, in this order, and stop when you can describe the product:

1. `README.md` (or `README`, `readme.md`) at the repository root;
2. `docs/`, `doc/` or the docs site sources the README points to;
3. an OpenAPI or other API description, if there is one;
4. the routes, screens or commands the docs name, only to confirm what the docs say.

Note for each fact where you read it (file and section). You will cite it as the `source` of
strategy items and cases. Do not invent features the sources do not show.

## 3. Ask 3 to 5 questions

Ask only what the sources do not answer and what changes the plan: who uses the product,
what must never break, which environments exist, what is out of scope, what access you lack.
Ask 3 at least and 5 at most.

- Connected: send each one with
  `plune_question_ask(template, text, missionId, options)` and `template` `plain`, with up to
  three `options` when the answer is a choice. To ask for access to an API description, the
  code, staging or a HAR file, use `template` `access` with
  `plune_question_ask(template, text, missionId, access)` instead.
  Also show the questions to the user in the chat, numbered, so they can answer either here or
  in Plune.
- Not connected: ask them in the chat, numbered.

Then wait for the answers. If the user says they answered in Plune, read them with
`plune_question_list(missionId)`. Never answer a question yourself. An answer you still do not
have becomes an assumption, marked as one.

## 4. Write the strategy file

Write `docs/testing/test-strategy.md` in the user's repository, unless the user names another
path or a strategy file already exists (then update that one and say so). Use these sections,
which are the sections Plune keeps a strategy in:

1. **Objectives** - what this testing must show.
2. **Scope** - in scope, and out of scope with the reason for each.
3. **Approach** - how the testing is done.
4. **Profile** - test levels, quality characteristics, test techniques, and the split of the
   cases between API, UI and manual testing in percent (the three add up to 100).
5. **Risks** - each with its likelihood and impact (`low`, `medium`, `high`).
6. **Entry criteria** and **Exit criteria**.
7. **Open questions and assumptions** - each assumption marked as such.
8. **Mission log** - the stage log table (see below).

Every item that comes from a source says where it was read. The allowed values of the profile
and of the risk scale are in [references/tool-calls.md](references/tool-calls.md).

Connected, and with a mission: also propose the strategy for a person to accept with
`plune_strategy_propose(missionId, content, dry_run)`. Call it first with `dry_run` `true`; if
the answer is an error, fix the content and repeat; then call it once without `dry_run`. The
shape of `content` is in [references/tool-calls.md](references/tool-calls.md).

## 5. Propose 20 or more cases

Design at least 20 cases from the strategy: the highest risks first, every in-scope area
covered at least once, each case with steps a person can follow and one expected result.
Prefer a technique the profile names, and write it in the case.

- Connected: send them with `plune_case_propose(target, cases, dry_run)`. `target` is the
  product address or the mission name. At most 100 cases go in one call. Call it first with
  `dry_run` `true`, fix what the answer refuses, then send the same cases once without
  `dry_run`. Report how many the answer says were applied; if some were not, say which and why.
  The shape of a case is in [references/tool-calls.md](references/tool-calls.md).
- Not connected: write the cases to `docs/testing/test-cases.md` next to the strategy, one
  heading per case with its steps, expected result, technique, priority and source.

Do not approve your own proposals and do not call any tool that decides queue entries.

## Proposing a memory rule

An answer that will hold for the next missions too (who uses the product, what is out of scope,
which environment the tests may touch) can become a rule of the project's memory, so the next
mission does not ask it again. A rule comes only through the review queue: propose it, and it is
a rule once a person accepts it there. Never write a rule into a file or the strategy as if it
were accepted, and never treat a proposed rule as one.

- Connected, with a write token: propose it with `plune_api_request(method, path, body)`, a `POST`
  to `/v1/memory/candidates` whose `body` names the answered question as its source. If
  `plune_api_request` is not in your tool list, switch it on with `plune_discover_tools(names)`.
  The shape is in [references/tool-calls.md](references/tool-calls.md). Propose only what a
  person actually said, at most one rule per answer, and say in your final message which you
  proposed.
- Not connected: list the rules you would propose in your final message, for the user to add.

## Stage log

Keep one row per stage you ran, and put the table at the end of the strategy file and in your
final message:

| Stage | What it produced | Tool calls | Tokens (as reported) |
|---|---|---|---|
| 1. Context | mission id, project | 2 | ... |
| 2. Read | files read | 0 | ... |
| 3. Questions | questions asked, answered | 4 | ... |
| 4. Strategy | file path, proposed or not | 2 | ... |
| 5. Cases | cases proposed, applied | 2 | ... |

Fill "Tokens" only with the numbers your host shows you (a usage or cost readout, a `/cost`
command, a status line). If it shows nothing, write `not reported`. Never estimate or invent a
number. A stage you skipped gets a row with `skipped` and the reason.

## Finish

End with a short message: the strategy file path, whether the strategy was proposed, how many
cases were proposed and applied, the memory rules you followed and the ones you proposed, the
questions still open, and the stage log table.
