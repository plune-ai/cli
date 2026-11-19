# Checks on tool calls

Read this when you write the checks of a scenario (step 4) and when you read a result (step 7). The full reference
is the assertions guide of the Plune CLI: https://github.com/plune-ai/cli/blob/main/docs/guide/assertions.md

These checks read the transcript of a scenario with `mcp`: the tools the server listed, every model step, every call
with its arguments and its error. A call counts once the model asked for it, whether or not it ran.

## The checks

| Type | Fields | Passes when | Use it for |
|---|---|---|---|
| `tool-called` | `tool`, `min_count` | `tool` was called at least `min_count` times (default 1) | the tool a task needs |
| `tool-args` | `tool`, `args`, `match`, `min_count` | a call of `tool` has arguments that match `args`; a list of objects means any one of them; `match` is `partial` (default), `exact` or `ignore` | a task whose input matters (an id, a title) |
| `first-tool` | `tool` | the first call is `tool` | a task that must start with one tool |
| `tool-order` | `tools`, `strict` | the calls come in this order; with `strict`, the calls are exactly `tools` | a task with steps |
| `tool-call-count` | `tool`, `min`, `max` | the number of calls is within the bounds | a task that must not loop |
| `tool-not-called` | `tool` | `tool` was never called | negative: a call the prompt must not lead to |
| `only-tools` | `tools` | no tool off the list was called; `tools: []` means no call at all | negative: a request outside the domain; a read-only task |
| `no-destructive-tool` | (none) | no called tool may be destructive by its annotations | negative: a server with destructive tools |
| `no-tool-errors` | `tool` | no call had an error | every positive scenario |
| `token-budget` | `max` | input and output tokens over all steps are at most `max` | cost |

`partial` compares only the keys you give, strings exactly (case included). Keep `args` to the values the task
itself names; a value the model has to choose (a date format, a page size) makes a check that fails on a correct
call.

## Which scenario is negative

A negative scenario requires no call: it has no `tool-called`, `tool-args`, `first-tool` or `tool-order`, and it
forbids one with `only-tools`, `tool-not-called` or `no-destructive-tool`. A scenario that requires one tool and
forbids another (`tool-called` and `tool-not-called`) is positive.

## Results

| Status | Meaning | What to change |
|---|---|---|
| `passed` | every check passed in enough of the `runs` (`pass_threshold`) | nothing |
| `failed` | a check saw the model do what it forbids, or not do what it requires | the prompt's wording, `allowed_tools`, `limits`; never the check (ask the person before widening it) |
| `errored` | nothing was measured | the configuration, a name, the environment; or run it again |

An `errored` scenario carries a code. The ones a scenario of this skill meets:

- `ASSERTION_UNKNOWN_TOOL`: a check names a tool the model was not offered. The message lists the tools that were.
  Copy the name from the list; on a read-only server, the write tool is not listed at all (see the rules in
  `SKILL.md`).
- `ASSERTION_UNMEASURED`: a negative check found nothing, but a limit (`max_steps`, `max_tool_calls`) stopped the
  loop, so the forbidden call may be the one that was not made. Raise the limit, or make the prompt shorter to
  answer.
- A provider error (a key, a rate limit) or a server that did not start: fix it and run again.

When the model called nothing and the loop ended on its own, a negative check passes: that is a real pass.
