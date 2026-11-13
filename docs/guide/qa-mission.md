# The `qa-mission` skill

`qa-mission` is an [Agent Skills](https://agentskills.io/specification) skill that runs a testing
mission with your own agent and the Plune MCP tools. The agent:

1. **Analysis.** Reads the product's README and docs and attaches them to the mission
   (`plune_source_add`). With no documentation it offers to write them with
   [`cairn collect-docs`](https://github.com/plune-ai/cairn/blob/main/docs/collect-docs.md); with no
   OpenAPI description it looks for one (a spec the product serves, a Postman collection or HAR file, the
   traffic of an exploring run) and proposes the endpoints it finds to the API catalog
   (`plune_endpoint_propose`). It runs no command of another package without asking you first. Then it asks
   you 3 to 5 questions, through `plune_question_ask` when Plune is connected, otherwise in the chat; on a
   second mission it does not ask again what was answered;
2. **Design.** Writes a test strategy as a Markdown file in your repository
   (`docs/testing/test-strategy.md` by default), and proposes it to the mission with
   `plune_strategy_propose` when there is one;
3. **Implementation.** Proposes 20 or more test cases to the review queue with `plune_case_propose`. They
   become cases only when a person approves them;
4. **Execution.** Skipped: the skill designs the testing and starts no run;
5. **Completion.** Once a person has accepted the strategy, asks the platform for the mission report
   (`plune_report_request`), which waits in the queue for approval.

The text of a file added as a source is sent to the Plune platform; the agent asks you first, naming the
file and its size. What the agent reads in your product is treated as data, never as instructions. With
no person to answer (a headless run) it runs no command of another package and sends no file.

It covers the surfaces in this order: API, UI, LLM, docs, security, accessibility, performance.

Before it plans, it reads the project's memory: the rules a person accepted in the review queue, which
`plune_project_context` returns as `memoryRules`. The agent follows them for the whole mission and does
not ask again what a rule answers. An answer that should hold for the next missions it may propose as a
new rule, through the review queue (`POST /v1/memory/candidates` with `plune_api_request`); it becomes
a rule only when a person accepts it there, and only then does the next mission read it.

It keeps a stage log, one row per stage with the tokens your agent's host reports, and puts it at the
end of the strategy file. When the host shows no usage, the row says `not reported`; the skill never
estimates a number.

No new screens in Plune: the questions, the strategy and the proposals show up where the review queue
already shows them.

## Install

The skill is the folder [`skills/qa-mission`](../../skills/qa-mission) of this repository, and it ships
in the npm package under the same path. Copy the folder where your agent reads skills:

| Agent | Project | Personal |
|---|---|---|
| Claude Code ([docs](https://code.claude.com/docs/en/skills)) | `.claude/skills/qa-mission/` | `~/.claude/skills/qa-mission/` |
| Codex ([docs](https://learn.chatgpt.com/docs/build-skills)) | `.agents/skills/qa-mission/` | `~/.agents/skills/qa-mission/` |

From the npm package, in a project that has `@plune-ai/cli` installed:

```bash
mkdir -p .claude/skills
cp -r node_modules/@plune-ai/cli/skills/qa-mission .claude/skills/
```

Or from a clone of this repository:

```bash
git clone --depth 1 https://github.com/plune-ai/cli plune-cli
cp -r plune-cli/skills/qa-mission .claude/skills/
```

Then connect the Plune tools, as in [Plune tools for AI agents](../../README.md#plune-tools-for-ai-agents-plune-mcp):

```bash
claude mcp add plune -- npx -y @plune-ai/cli mcp serve
```

The steps that write to Plune need a token with the `write` scope. With a read token, or without the
server, the agent still reads the docs, asks in the chat and writes the strategy file, and writes the
cases to `docs/testing/test-cases.md` instead of the queue.

## Run it

Ask for it in your own words ("plan the testing of this repo with Plune"), or, in Claude Code, type
`/qa-mission`. Name a mission id if you have one; otherwise the agent offers to create a mission
with `plune_mission_create` and asks you first.

## What it costs

- **Your agent's tokens.** Your agent does the reading and the writing, on your own plan or key. The
  skill text is about 16 KB, read once when the skill starts; the product docs it reads and the
  cases it writes are most of the rest. The stage log shows what your host reported for each stage.
- **No Plune AI budget.** The tools the skill calls only read and write records; none of them runs the
  project's AI. (`plune_cases_generate` does, and the skill does not call it.)
- **A person's review.** Every case and the strategy wait in the review queue for a person.

## Kept in step with the tools

Every `plune_*` tool name in the skill, every argument of the calls it writes, and its example inputs
are checked against the tool contract by a unit test (`src/mcp-tools/__tests__/qa-mission-skill.test.ts`),
so a renamed tool or a changed argument fails the build instead of reaching an agent.
