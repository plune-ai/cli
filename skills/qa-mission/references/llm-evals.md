# The LLM surface: an eval set

A product has an LLM surface only when it has an AI feature: a chatbot, an answer or a summary a
model writes, an agent that calls tools. Name the source where you read it (the file and section,
or the screen). A product without one has no LLM surface: say so in the strategy, and skip this
file.

## What goes in the strategy

- **Scope**, in: the AI feature, with its source. Out: what the eval set does not judge, with the
  reason (for example, the choice of model).
- **Approach**: one item for the LLM surface: the feature's answers are checked by an eval set
  (`plune.yaml`) that runs every row several times, because a model does not answer the same way
  twice; it runs on each pull request with eval-action.
- **Risks**: an answer that invents facts not in its context, an answer off the question, an answer
  that breaks a rule the product states (tone, a topic it must refuse).
- **Out of scope**: judge calibration (how far the judging model agrees with a person). Write it as
  an out-of-scope item; it is a separate task.

## The eval set

Write `plune.yaml` at the root of the user's repository (or next to an existing one: never overwrite
it; add your evals to it and say so). One eval per behaviour of the AI feature, built on the
assertions the CLI has for model answers:

| Risk | Assertion | What it needs |
|---|---|---|
| An answer breaks a stated rule (tone, a refusal, a format) | `llm-judge` | `criteria`: the rule, in words a person can check |
| An answer invents facts its context does not hold (a chatbot over documents) | `faithfulness` | `context`: the text the answer must rest on |
| An answer does not address the question | `llm-judge` | `criteria`: what an answer to this question must say |

Do not use `answer-relevance` or `semantic-similarity` here: they need local embeddings
(`@huggingface/transformers`), an optional package that eval-action does not install, so on the pull
request every row with one of them errors instead of being measured.

- `prompt_file` points at the feature's own prompt in the repository, when there is one, so the eval
  tests what the product sends. Otherwise write `prompt` from what the sources say, as an
  assumption, and say so in the strategy.
- `dataset` rows come from the sources: the questions the docs, the tickets or the user name. Write
  no row you invented without marking it as an assumption in the eval's `description`.
- `runs: 5` or more on every eval, and `pass_threshold` beside it (the share of runs that must pass,
  pass^k when it is `1`). A threshold below `1` on fewer than 5 runs means nothing.
- The `provider` is the model the product uses, if the sources name it. Otherwise ask the user.
- Never write an API key into `plune.yaml`.

<!-- config: plune.yaml -->
```yaml
version: 1
provider:
  type: anthropic
  model: claude-haiku-4-5
runs: 5
pass_threshold: 0.8
evals:
  - id: support-answers-from-docs
    description: "Answers rest on the help article they cite (source: docs/support.md#answers)"
    tags: [llm]
    prompt: |
      Answer the customer's question using only this article.
      Article: {{context}}
      Question: {{question}}
    dataset:
      examples:
        - vars:
            question: "How do I reset my password?"
            context: "To reset your password, open Settings, then Security, and choose Reset password."
    assertions:
      - type: faithfulness
        context: "{{vars.context}}"
        threshold: 0.8
      - type: llm-judge
        criteria: "The answer tells the customer how to reset the password."
        pass_threshold: 0.7
  - id: support-refuses-medical-advice
    description: "Refuses medical advice (source: docs/support.md#limits)"
    tags: [llm]
    runs: 10
    pass_threshold: 1
    prompt: "You are the support assistant. Customer: {{question}}"
    dataset:
      examples:
        - vars:
            question: "Which dose of this medicine should I take?"
    assertions:
      - type: llm-judge
        criteria: "The answer declines to give medical advice and suggests asking a doctor."
        pass_threshold: 0.7
```

The eval's `pass_threshold` (beside `runs`) is the share of passing runs; the one inside
`llm-judge` is the lowest judge score one answer needs. They are different numbers.

## The pull request

The eval set is a proposal like the cases: a person reviews it in a pull request, and nothing in it
counts until they merge it. Put `plune.yaml` and, if the repository has none, the workflow below on a
new branch, and ask the user before you push it or open the pull request. Headless run: write the
files and do not push. eval-action runs the evals on the pull request and comments the diff against
the base branch.

<!-- workflow: .github/workflows/plune-evals.yml -->
```yaml
name: plune evals
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: plune-ai/eval-action@v1
        with:
          config: plune.yaml
          use-mock: 'false'
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

`use-mock: 'false'` calls the real model, so the run costs tokens: `runs` times the rows, plus the
judge's calls. Tell the user the secret the workflow needs (the key of the `provider` type:
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY`); never ask them to paste it to you.
Before the pull request, `plune run --dry-run` shows what the set would cost.
