---
name: qa-mission
description: Run a testing mission on a product with the Plune MCP tools, in the stages of the ISTQB test process - analysis (sources, documentation, API catalog, 3 to 5 questions), design (a test strategy), implementation (the strategy file and 20 or more case proposals in the review queue), execution, and completion (the report). Use when the user asks to plan testing for a product, write a test strategy, or fill Plune with test case proposals.
license: MIT
compatibility: Needs the Plune MCP server (npx -y @plune-ai/cli mcp serve) with a write token for the Plune steps; without it, the strategy file is still written.
---

# QA mission

You plan the testing of one product and hand the result to a person. You never decide for
them: questions go to the user, cases, endpoints and the strategy go to the review queue as
proposals, and nothing becomes a test case, a catalog entry or an accepted strategy until a person
approves it.

Before you start, check whether the Plune tools are connected: the tool `plune_project_context`
is in your tool list. If it is not, run every stage anyway and skip only the Plune calls; say
once, at the start, that the cases will be written to a file instead of the queue.

The work goes through five stages, the activities of the ISTQB test process: analysis, design,
implementation, execution, completion. Keep a stage log as you go (see "Stage log" below). Do not
skip it.

Cover the surfaces of the product in this order, and leave one out only with a reason in the
strategy: surfaces in this order: API, UI, LLM, docs, security, accessibility, performance. A
product without an LLM feature has no LLM surface; say so instead of inventing one.

## Stage 1: Analysis

What is there to test, and what does the user know that the sources do not say.

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
   Keep the `missionId`: the sources, the questions, the strategy and the report hang on it.
3. Read the product, in this order, and stop when you can describe the product:
   1. `README.md` (or `README`, `readme.md`) at the repository root;
   2. `docs/`, `doc/` or the docs site sources the README points to;
   3. an OpenAPI or other API description, if there is one;
   4. the routes, screens or commands the docs name, only to confirm what the docs say.

   Note for each fact where you read it (file and section). You will cite it as the `source` of
   strategy items and cases. Do not invent features the sources do not show.
4. Attach what you read to the mission, so the next mission and the next reader find it there:
   `plune_source_add(missionId, kind, ref)` for a link (`kind` `url`, `openapi`, `repo` or `ticket`),
   and `plune_source_add(missionId, kind, name, text)` with `kind` `file` for the text of a Markdown,
   plain-text or JSON file of the repository. Call it with `dry_run` `true` first. Attach a source
   once; `plune_mission_get(missionId)` shows the ones already there.
5. No documentation (`documentation` is `none`, or the README says nothing about how the product
   behaves): the documents can be written by walking the running product. If Cairn is installed,
   `cairn collect-docs --url <the product address> --session <name>` writes `docs.md` with a section
   per screen, a list of open questions and `openapi.derived.json` from the traffic it saw. It needs
   a running product and a saved login session, and it makes one model call per screen: ask the
   user before you run it, and take the open questions it lists to stage 1, step 7. Read the
   result, attach it with `plune_source_add`, and set `documentation` to `provided` with
   `plune_mission_update(missionId, documentation)`. Without Cairn, or without a running product,
   say so and go on with what you have; the strategy then rests on assumptions and open questions.
6. No OpenAPI description, and the product has an API: climb this ladder and stop at the first
   rung that gives you one. Ask the user before you run a command, and read the result as a
   draft:
   1. the product serves its own: `cairn api --base-url <address>` searches the server for a spec
      (`/openapi.json`, `/v3/api-docs` and the like);
   2. the user has a Postman collection or a HAR file: `cairn api --spec <file>` converts it and
      saves `openapi.derived.json`;
   3. the traffic of an exploring run: `cairn explore --url <address> --session <name>` saves the
      API requests it saw as `openapi.derived.json`.

   Then catalog the endpoints. `plune_endpoint_propose` is not in the first tool list: switch it on
   with `plune_discover_tools(names)`, then call
   `plune_endpoint_propose(endpoints, dry_run)` with `dry_run` `true`, then once without it. Each
   endpoint is a method and a path template (`/users/{id}`, never `/users/42`). From a spec the
   user gave, `source` is `spec`; from the code, `code`; from `openapi.derived.json` or any recorded
   traffic, `source` `traffic` with `trust` `derived`, never `confirmed`. Up to 100 endpoints go in
   one call. They wait in the review queue like every other proposal.
7. Ask 3 to 5 questions. Ask only what the sources do not answer and what changes the plan: who
   uses the product, what must never break, which environments exist, what is out of scope, what
   access you lack. Ask 3 at least and 5 at most.
   - A second mission on a product you have asked about before: read what was answered before with
     `plune_question_list()` and the rules in `memoryRules`, and do not ask again what was already
     answered. Ask only what is new, even if that is fewer than 3; say in the stage log how many you
     skipped and why. An old answer you doubt still becomes a question, with the old answer in its text.
   - Connected: send each one with
     `plune_question_ask(template, text, missionId, options)` and `template` `plain`, with up to
     three `options` when the answer is a choice. To ask for access to an API description, the
     code, staging or a HAR file, use `template` `access` with
     `plune_question_ask(template, text, missionId, access)` instead.
     Also show the questions to the user in the chat, numbered, so they can answer either here or
     in Plune.
   - Not connected: ask them in the chat, numbered.

   Then wait for the answers. Headless run (no person is there to answer, or the task says so): do
   not wait for answers; record each open question as an assumption with `waitingOn` set to the id of
   the question you asked, and go on. If the user says they answered in Plune, read them with
   `plune_question_list(missionId)`. Never answer a question yourself. An answer you still do not
   have becomes an assumption, marked as one.

## Stage 2: Design

Decide what the testing is for and how it is done: the strategy.

Build the strategy content with these sections, which are the sections Plune keeps a strategy in:

1. **Objectives** - what this testing must show.
2. **Scope** - in scope, and out of scope with the reason for each.
3. **Approach** - how the testing is done, surface by surface.
4. **Profile** - test levels, quality characteristics, test techniques, and the split of the
   cases between API, UI and manual testing in percent (the three add up to 100).
5. **Risks** - each with its likelihood and impact (`low`, `medium`, `high`).
6. **Entry criteria** and **Exit criteria**.
7. **Open questions and assumptions**.
8. **Mission log** - the stage log table (see below).

Every item rests on exactly one of `source`, `assumption` or `waitingOn`, never two and never
none; the platform refuses the strategy otherwise (`strategy_lint`).

- It was read in a source: `source` says where (file and section).
- You assumed it: `assumption: true`, and nothing else.
- It waits for an answer: `waitingOn` is the id of the open question, and nothing else.

An item you read in a source that you also doubt is a `source` item; put the doubt in its text.
The allowed values of the profile and of the risk scale, and one item of each kind, are in
[references/tool-calls.md](references/tool-calls.md).

Connected, and with a mission: propose first, with `plune_strategy_propose(missionId, content, dry_run)`.
Call it with `dry_run` `true`; the platform runs its checks and the answer lists the findings. After
a refusal, fix what the findings name (each says the rule and the path of the item), and try once
more. If the second try is refused too, then stop and report the findings to the user; do not vary
the content blindly. When the dry run passes, call it once without `dry_run`. The shape of `content`
is in [references/tool-calls.md](references/tool-calls.md).

Then write `docs/testing/test-strategy.md` in the user's repository from the accepted content,
exactly as proposed (the counts too), unless the user names another path or a strategy file already
exists (then update that one and say so). Put the proposal id in the mission log. Not connected:
write the file from the content you built, and say it was not proposed.

## Stage 3: Implementation

Turn the strategy into cases a person can follow.

Design at least 20 cases from the strategy: the highest risks first, every in-scope area
covered at least once, each case with steps a person can follow and one expected result. Go through
the surfaces in the order above. Prefer a technique the profile names, and write it in the case.

- Connected: send them with `plune_case_propose(target, cases, dry_run)`. `target` is the
  product address or the mission name; pass `missionId` too, so the queue can be read by mission.
  At most 100 cases go in one call. Call it first with `dry_run` `true`, fix what the answer
  refuses, then send the same cases once without `dry_run`. Report how many the answer says were
  applied; if some were not, say which and why. The shape of a case is in
  [references/tool-calls.md](references/tool-calls.md).
- Not connected: write the cases to `docs/testing/test-cases.md` next to the strategy, one
  heading per case with its steps, expected result, technique, priority and source.

Do not approve your own proposals and do not call any tool that decides queue entries.

## Stage 4: Execution

This skill designs the testing; a person or the product's test runner executes it. Do not start a
run and do not write results. Write the stage as `skipped` in the log, with the reason: the cases
wait for a person's review first. If the user asks you to run the approved cases, that is a
different task; say so and stop.

## Stage 5: Completion

Close the mission with a report and the lessons.

1. The report is built by the platform from the mission's own data, and it needs an accepted
   strategy first. Ask for it only after a person has accepted the strategy in the review queue:
   read `plune_review_list(missionId)` to see its state. Then call
   `plune_report_request(missionId, dry_run)` with `dry_run` `true`, and once without it; the report
   waits in the queue for a person to approve. If the strategy is still waiting, do not ask: say in
   your final message that the report can be requested once it is accepted.
2. Propose what should hold for the next missions as a memory rule (see below).
3. Finish with the final message (see "Finish").

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
| 1. Analysis | mission id, sources attached, endpoints proposed, questions asked and answered | 8 | ... |
| 2. Design | strategy file path, proposed or not | 2 | ... |
| 3. Implementation | cases proposed, applied | 2 | ... |
| 4. Execution | skipped: a person reviews the cases first | 0 | skipped |
| 5. Completion | report requested or not, memory rules proposed | 2 | ... |

Fill "Tokens" only with the numbers your host shows you (a usage or cost readout, a `/cost`
command, a status line). If it shows nothing, write `not reported`. Never estimate or invent a
number. A stage you skipped gets a row with `skipped` and the reason.

## Finish

End with a short message: the strategy file path, whether the strategy was proposed, how many
sources and endpoints you attached or proposed, how many cases were proposed and applied, whether
the report was requested, the memory rules you followed and the ones you proposed, the questions
still open, and the stage log table.
