# Tool calls of the QA mission

The shapes the Plune tools take. The tools check every argument and answer with the field
that is wrong, so a `dry_run` call first is the cheap way to find a mistake.

## Allowed values

- Test levels: `component`, `component-integration`, `system`, `system-integration`, `acceptance`.
- Quality characteristics: `functional-suitability`, `performance-efficiency`, `compatibility`,
  `interaction-capability`, `reliability`, `security`, `maintainability`, `flexibility`, `safety`.
- Test techniques: `equivalence-partitioning`, `boundary-value`, `decision-table`,
  `state-transition`, `statement`, `branch`, `error-guessing`, `exploratory`, `checklist`.
- Risk likelihood and impact: `low`, `medium`, `high`.
- Where a strategy item was read (`source.kind`): `mission-source`, `doc-section`, `screen`,
  `endpoint`, `requirement`, `url`.
- Where a case was read (`source.kind`): `url`, `openapi-operation`, `requirement`, `pasted-text`.
- A case's `execution`: `auto` (it can be automated) or `manual` (the default).

## A question

`plune_question_ask` with a plain question and up to three options:

<!-- input: plune_question_ask -->
```json
{
  "template": "plain",
  "text": "Which environment may the tests run against?",
  "missionId": "m_123",
  "options": ["staging only", "staging and production read-only", "a local build"]
}
```

## The strategy

`plune_strategy_propose`. Each list of items holds 1 to 25 items; risks hold 1 to 50. An item
is `text` (Markdown, up to 1000 characters), with an optional `source`, and `assumption: true`
when you assumed it. The split adds up to 100.

<!-- input: plune_strategy_propose -->
```json
{
  "missionId": "m_123",
  "dry_run": true,
  "content": {
    "objectives": [{ "text": "Show that sign-up and sign-in work for a new user", "source": { "kind": "doc-section", "ref": "README.md#getting-started" } }],
    "scope": {
      "in": [{ "text": "Sign-up, sign-in, password reset" }],
      "out": [{ "text": "Billing: handled by the payment provider, not by this product" }]
    },
    "approach": [{ "text": "Risk-based: the highest risks get cases first" }],
    "profile": {
      "levels": ["system", "acceptance"],
      "characteristics": ["functional-suitability", "security"],
      "techniques": ["equivalence-partitioning", "boundary-value"],
      "split": { "api": 40, "ui": 40, "manual": 20 },
      "notes": [{ "text": "Staging is the only environment", "assumption": true }]
    },
    "risks": [{ "text": "A reset link can be used twice", "likelihood": "medium", "impact": "high" }],
    "entryCriteria": [{ "text": "A build is deployed to staging" }],
    "exitCriteria": [{ "text": "Every high risk has a passed case" }]
  }
}
```

## Cases

`plune_case_propose`. 1 to 100 cases in one call. A case has a `title` (up to 300 characters),
1 to 20 `steps` (up to 400 characters each) and one `expected` result; the rest is optional.

<!-- input: plune_case_propose -->
```json
{
  "target": "https://staging.example.com",
  "dry_run": true,
  "cases": [
    {
      "title": "Sign-up refuses a password one character shorter than the minimum",
      "steps": ["Open the sign-up page", "Enter a new email and a 7-character password", "Submit the form"],
      "expected": "The form is not sent and says the password needs at least 8 characters",
      "execution": "auto",
      "technique": "boundary-value",
      "priority": "high",
      "source": { "kind": "requirement", "value": "README.md#passwords" },
      "rationale": "The minimum length is the boundary the docs name"
    }
  ]
}
```
