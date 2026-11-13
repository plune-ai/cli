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

## A source

`plune_source_add`. A link needs `kind` (`url`, `openapi`, `repo` or `ticket`) and `ref`. A file of the
repository needs `kind` `file`, its `name` (`.md`, `.markdown`, `.txt` or `.json`) and its `text`, up to
1 MiB.

<!-- input: plune_source_add -->
```json
{
  "missionId": "m_123",
  "kind": "openapi",
  "ref": "https://staging.example.com/openapi.json",
  "title": "Served by the product",
  "dry_run": true
}
```

## An endpoint

`plune_endpoint_propose`. 1 to 100 endpoints. `path` is a template that starts with `/` and has no query.
`source` is `spec`, `code` or `traffic`; an endpoint taken from a derived draft (`openapi.derived.json`) or
from recorded traffic is `traffic` with `trust` `derived`.

<!-- input: plune_endpoint_propose -->
```json
{
  "endpoints": [
    {
      "method": "POST",
      "path": "/users/{id}/password-reset",
      "source": "traffic",
      "trust": "derived",
      "summary": "Sends a reset link",
      "auth": ["bearer"]
    }
  ],
  "dry_run": true
}
```

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

Every item has exactly one of `source`, `assumption` or `waitingOn`: none, or two, and the platform
refuses the strategy with `strategy_lint` and a finding (rule and path) for each item. One of each:

```json
{ "text": "Passwords need at least 8 characters", "source": { "kind": "doc-section", "ref": "README.md#passwords" } }
{ "text": "Staging is the only environment", "assumption": true }
{ "text": "Which payment provider is live?", "waitingOn": "q_123" }
```

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

## A memory rule

`plune_api_request`, a `POST` to `/v1/memory/candidates`. `source.kind` is `answer` and
`source.id` the id of the answered question (from `plune_question_list`). `text` is the rule in
your words, up to 2000 characters; left out, the platform takes the answer's own words (an answer to an access question is never
copied, so it needs `text`). The call
lands a `memory_rule` entry in the review queue; it is a rule only once a person accepts it.

<!-- input: plune_api_request -->
```json
{
  "method": "POST",
  "path": "/v1/memory/candidates",
  "body": {
    "source": { "kind": "answer", "id": "ri_123" },
    "text": "Tests run against staging only; production is never touched."
  }
}
```
