# Plune quickstart

A minimal, runnable example of [`@plune-ai/cli`](https://github.com/plune-ai/cli) — config-driven
LLM eval testing. It shows both scenarios:

- **Local:** `run → report` in under 5 minutes, with offline cases that need **no API key**.
- **CI:** [`plune-ai/eval-action@v1`](https://github.com/plune-ai/eval-action) on every PR — sticky
  diff comment + merge gate on regressions.

> Verified against `@plune-ai/cli@0.2.2` and `plune-ai/eval-action@v1`. Outputs below are real.

---

## 1. Run it offline (no key, zero cost)

The offline evals run against a built-in **mock provider** (`PLUNE_MOCK_PROVIDER=1`) that returns a
fixed string — they prove the harness and CI wiring end-to-end without spending anything.

```bash
cd examples/quickstart
PLUNE_MOCK_PROVIDER=1 npx @plune-ai/cli@0.2.2 run -c plune.yaml --only=tag:offline
```

What you'll see:

```text
Plune run
3 passed · 0 failed · 0 errored · 3 total · $0.0000 · 2862ms

PASS smoke-exact (offline)
  1 row(s) passed
PASS smoke-contains (offline)
  1 row(s) passed
PASS smoke-similarity (offline)
  1 row(s) passed
```

A markdown report (for PRs / docs):

```bash
PLUNE_MOCK_PROVIDER=1 npx @plune-ai/cli@0.2.2 run -c plune.yaml --only=tag:offline --format markdown
```

```markdown
# Plune run

| Metric | Value |
| --- | --- |
| Total | 3 |
| Passed | 3 |
| Failed | 0 |
| Errored | 0 |
| Cost (USD) | 0.0000 |
| Duration (ms) | 277 |

All evals passed.
```

## 2. Run the real evals (needs a key)

```bash
cp .env.example .env        # then put a real ANTHROPIC_API_KEY in .env
npx @plune-ai/cli@0.2.2 run -c plune.yaml --only=tag:online
npx @plune-ai/cli@0.2.2 report --format markdown
```

Real output (model `claude-sonnet-4-6`, cost tracked via the `pricing:` block):

```text
Plune run
11 passed · 0 failed · 0 errored · 11 total · $0.0222 · 19033ms

PASS extraction-schema (online)
PASS faq-contains (online)
PASS faq-tone-judge (online)
PASS rag-faithfulness (online)
```

The online set exercises the assertion types that need a real model:

| Eval | Assertions | Type |
| --- | --- | --- |
| `extraction-schema` | `json-schema` | structured-output validation |
| `faq-contains` | `contains` | grounded-answer keyword |
| `faq-tone-judge` | 4× `llm-judge` | interpretable binary judge (see below) |
| `rag-faithfulness` | `faithfulness`, `answer-relevance` | RAG grounding |

The offline set (`exact-match`, `contains-all`, `semantic-similarity`) runs with **no key** —
`semantic-similarity` uses local embeddings (downloads a small model once, then stays offline).

---

## 3. CI: diff + regression gate on every PR

`.github/workflows/plune-evals.yml` wires `plune-ai/eval-action@v1`. **Copy it to your repo root**
`.github/workflows/` to activate (a workflow nested under `examples/` is not run by GitHub).

The action re-runs the config on the PR head **and** on the base branch, diffs them, posts a sticky
comment, and (with `fail-on-regression: true`) fails the check on a `pass → fail` regression. By
default `use-mock: true`, so the CI demo is free and deterministic — no secret required.

### What blocks a PR

When an eval goes `passed → failed`, the diff (real output) is:

```markdown
<!-- plune-eval-diff -->
## Plune eval diff

### ❌ 1 regression(s)

| Eval | Baseline → Current | Change |
| --- | --- | --- |
| smoke-exact | passed → failed | 🔴 regression |

_1 regression(s) · 0 improvement(s) · 0 new-fail · 0 pre-existing-fail · 0 errored · 0 removed · 2 stable_
```

…and the action exits `1`, so a branch-protection rule on the check blocks merge.

> First-PR note: the action recomputes the baseline by running the **same** config on the base
> branch — so the config must already exist there. On the very PR that introduces this folder, the
> baseline run has nothing to compare; it lands cleanly once merged to the base branch.

---

## Interpretable judge (BINEVAL-style)

`@plune-ai/cli@0.2.2`'s `llm-judge` takes a single free-text `criteria` and returns a 0–1 score.
Instead of one holistic rubric, `faq-tone-judge` splits the verdict into **atomic binary criteria —
one `llm-judge` assertion each**:

```yaml
assertions:
  - { type: llm-judge, criteria: "Score 1 if the answer is polite ... else 0." }
  - { type: llm-judge, criteria: "Score 1 if the answer is three sentences or fewer ... else 0." }
  - { type: llm-judge, criteria: "Score 1 if the answer directly addresses the question ... else 0." }
  - { type: llm-judge, criteria: "Score 1 if the answer invents no facts ... else 0." }
```

Why: in a PR diff a reviewer reads **exactly which** criterion regressed (tone? length? grounding?),
instead of a single opaque "judge: 0.62". Readable verdicts beat one black-box number.

---

## Before / after (the regression story)

1. Baseline: `plune run --format json -o baseline.json` → all evals pass.
2. Edit `prompts/system.md` (e.g. drop "three sentences or fewer") and re-run → `faq-tone-judge`'s
   length criterion drops to `0`.
3. `plune diff baseline.json current.json --fail-on-regression` exits `1`; in CI the gate blocks merge.

---

## Layout

```
examples/quickstart/
├── README.md
├── plune.yaml            # full config: offline + online evals (local dev)
├── plune.ci.yaml         # offline core only — what CI runs under the mock provider
├── datasets/
│   ├── faq.jsonl         # grounded-QA rows (question + context) for contains/judge/RAG
│   └── extraction.jsonl  # rows for json-schema extraction
├── prompts/
│   └── system.md         # the prompt template (v0.1 has no separate system role)
├── .env.example          # empty keys; copy to .env (gitignored)
├── .gitignore
└── .github/workflows/
    └── plune-evals.yml   # eval-action@v1 — copy to repo root to activate
```
