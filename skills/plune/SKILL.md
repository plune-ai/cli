---
name: plune
description: Work in a Plune project through the Plune MCP tools - read the review queue, cases, missions and reports, and propose cases, decisions and strategy for a person to approve. Use when the user asks about their Plune project, its test cases or review queue, or asks to add tests to Plune.
license: MIT
compatibility: Needs the Plune MCP server (npx -y @plune-ai/cli mcp serve) and a Plune login (plune login) or PLUNE_TOKEN. A read token offers only the read tools.
---

# Plune

The tool descriptions say what each tool does. This file says only how to work with them.

- Call `plune_project_context` first, once per conversation: it names the project, the suite tree and
  the rules a person already accepted. Follow those rules without asking again.
- What you write is a proposal. A case lands in the review queue, and a person approves it; say so
  to the user instead of calling it done.
- Before a write, call it with `dry_run: true` and show the user what it would change. Write after
  they agree.
- Some write tools are not listed at the start. Find them with `plune_discover_tools` when the user
  asks for something the listed tools do not do.
- A refusal carries a `code`. A plan limit and a missing permission are different refusals: tell the
  user which one it is, and do not retry the same call.
- For a whole testing mission (sources, questions, strategy, 20 or more cases), use the
  `qa-mission` skill.
