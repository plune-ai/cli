# Changelog

All notable changes to `@plune-ai/cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each section is dated from the release tag it names. `0.2.1`, `0.2.2` and `0.2.3` were published from
tags whose committed `package.json` still read `0.2.0` — the publish job takes the version from the
tag (see 0.2.2), so the tag is the authority for what shipped, not the committed file.

## [Unreleased]

## [0.38.0] - 2026-11-13

### Added

- **A model × eval matrix: `provider` may be a list of models (MCP-D6).** Each eval runs once per model; with several models the result ids are `<eval>@<model>`, and `plune run` and `plune report` show a table with the state, the share of passing runs, the cost and the median latency of each cell. `plune diff --format json` gains `matrix`; the markdown diff shows the changed, failing, unmeasured and errored cells within a 60,000-character budget, cut by whole rows with the comment marker first. `--dry-run` prices each cell at its own model's rates. With one model (an object or a one-element list) ids, reports, JSON and the config hash are unchanged.
- **`plune ingest` reads a `cairn mcp-test` run (mode `mcp`).** Each case becomes a test case with one `tools/call` step (arguments masked, then cut to 200 characters); `passed` and `failed` carry over, `could-not-run` is blocked only when the call went out, and a case that was never sent has no verdict. The input is size-checked before it is read and its shape is strict; an older CLI refuses this mode with exit 2 before anything is uploaded.
- **`plune mcp conformance --suite tasks`: the checks of a server that offers the Tasks extension (MCP-C6).** 13 checks of `io.modelcontextprotocol/tasks` (revision 2026-07-28, stage "Beta, to Core"), outside the frozen profile: `tasks-result-type`, `tasks-undeclared-no-task`, `tasks-undeclared-capability-error`, `tasks-get-status-shape`, `tasks-status-payload`, `tasks-ttl-poll-integers`, `tasks-unknown-id-get`, `tasks-unknown-id-update-cancel`, `tasks-cancel-ack`, `tasks-update-ack`, `tasks-failed-status-message`, `tasks-http-name-header` and `tasks-input-request-keys-unique`. Each entry quotes the sentence of the extension text its level comes from; a type with no keyword (`ttlMs`, `pollIntervalMs`) and a sentence about the client (`Mcp-Name`) are `SHOULD` and marked derived. Only a session of 2026-07-28 or later, against a server that declares the extension, is judged; any other is `not-applicable`. Every check needs a task from a tool `--fixture` names: without one it is `could-not-run` (`needs-input`) and no tool is called. A run makes at most 3 tasks, polls at most 6 times within 5 seconds, cancels what it did not see finish, and reports a task that still runs after `Left behind`. An answer that is no JSON-RPC answer, 429, 5xx or 3xx is `could-not-run`, never `failed`; each "the server must refuse" check has a control that the same request in valid form is accepted.
- **`plune mcp conformance --config` help names YAML.** The help said a JSON file; a file whose name ends in `.yaml` or `.yml` has been read as YAML all along. The README has a section for the command, and the guide no longer lists headless sign-in as missing.
- **`plune mcp conformance` Streamable HTTP checks: SSE reading is bounded (MCP-C3).** The SSE reader reads each character once, keeps no line over 64 KiB and stops at 100 events or 1 MiB; a stream cut at a limit makes the checks that read it could-not-run instead of judging a part, and the connection is closed.
- **`plune mcp conformance` Streamable HTTP checks: statuses, controls and sessions (MCP-C3).** A redirect, 429 or a server error to a notification, GET, DELETE or a refusal probe is could-not-run, not a verdict; 401 is could-not-run (prerequisite-failed). The missing-session, wrong-version and ended-session refusals each have a control (the valid request accepted first). The session id is masked in every detail and body. Sessions the run opened are closed with DELETE, and the report's `ownSessions` counts those left open.
- **`plune mcp scan --active`, step 3: a page the scan serves, stdio servers and `--import-conformance`.** An entry with `fetches: true` and a `urlArgument` makes the scan serve a random harmless marker on 127.0.0.1 (from the first such probe to the end of the run) and report the advice finding `scan/probe/untrusted-content-verbatim` when the tool returns it with no boundary. With `--yes` the probes start a stdio server through the same wrapper (budgets, declared calls, destructive hints and the journal all apply), stop it on every way out, and run the `malformed` and `fetches` probes; authentication probes are "not applicable (stdio)". `--import-conformance <file>` shows the rows of a `plune mcp conformance` report in the summary as imported; they are not findings and never change the exit code. A `destructiveHint` that is present and not a boolean blocks a call.
- **`plune mcp scan --active`, step 2: `--journal`, `scan/probe/error-detail-leak` and `scan/hint/destructive-missing`.** `--journal <file>` writes one JSON line for every frame a probe sends, every answer and every frame the wrapper refuses, as it happens, through the one wrapper; no token (plain, URL-encoded, base64, base64url), no secret header and no response body or argument value is written, a journal that cannot be opened is exit 2, and one that cannot be written stops the probes. A probe entry with `malformed: true` sends its tool a call whose arguments are derived from the tool's `inputSchema` (first required property dropped, else one property of a wrong type), as `account-a`, counted in the budgets, and searches the error for five linear patterns (stack, file path, SQL, internal host); a match is the advice finding `scan/probe/error-detail-leak` with the pattern id and the tool only, never the text. `scan/hint/destructive-missing` (info, no gate, static) names a tool with annotations but no `destructiveHint` that is not `readOnlyHint: true`, as the threat catalog defines it. A journal path that is a file the scan reads or writes elsewhere is exit 2; any journal write failure makes the scan exit 3; a malformed call that ran says so; derived arguments are bounded.
- **`plune mcp conformance --suite apps`: the checks of a server that offers MCP Apps (MCP-C6).** 8 checks over `tools/list`, `resources/list` and `resources/read`, outside the frozen profile: `apps-ui-resource-uri-scheme` (`ui://`), `apps-ui-resource-exists`, `apps-ui-mime-type` (`text/html;profile=mcp-app`), `apps-ui-content-payload` (one of `text` and `blob`, an HTML5 doctype), `apps-ui-listed-mime`, `apps-ui-visibility-values`, `apps-ui-meta-shapes` and `apps-ui-tool-text-fallback`. Each entry quotes the sentence of the extension's specification its level comes from; where that text has no `MUST` or `SHOULD` (the values of `visibility`, the shapes of `csp`, `permissions`, `domain` and `prefersBorder`) the entry is `SHOULD` and marked derived. The suite only reads: it asks for `ui://` resources a tool or the list names, never runs, opens or parses their HTML, and calls a tool only for the text-fallback check, and only one that `--fixture` names (without a fixture the check is `could-not-run`, `needs-input`). A server that declares no `io.modelcontextprotocol/ui` extension and has no tool with `_meta.ui` gets `not-applicable` on every check. A resource over 4 MiB, or with comments before the doctype that run past 2048 characters, is `could-not-run`, never `failed`. Only the error that means "not found" in the revision of the run (`-32002` up to 2025-11-25, `-32602` from 2026-07-28) makes `apps-ui-resource-exists` fail; any other error and an empty contents list are `could-not-run`. At most 32 `ui://` addresses are read: over that, and when `resources/list` cannot be read, the checks that depend on them are `could-not-run` and say so. A listed resource without a `mimeType` is not judged by `apps-ui-listed-mime`. `--list-checks`, `--explain` (now also prints the quoted sentence of a check that is not derived) and the report link catalog entries to the extension's text. It runs together with `--suite protocol`; with `--suite oauth` it does not, as nothing else does yet.
- **`plune mcp scan --active --probes <file>`: active probes against a server that is yours (MCP-G5, step 1).** Only the calls in the probe file are sent, with `--confirm-host` for a server that is not on this machine, a budget (`--max-calls`, `--max-requests`) and tokens read from the variables `--token-env` and `--other-token-env`. Rules `scan/probe/unauthenticated-call`, `scan/probe/garbage-token-accepted` and `scan/probe/cross-account-access`; a probe that did not run is exit `3`, never a pass.
- **`plune mcp scan`: the static scan of what a model or a person cannot see in an MCP server, one report, one exit code (MCP-G6).** It reads snapshot files (`--snapshot [label=]file`), client configuration files (`--config`, or `--client claude-code|cursor|vscode` for the project file), a pin file (`--pin-file`) or one live server, runs the description, pin, config and cross-server rules, and exits `0` nothing that gates, `1` a finding at `--fail-on` (default `error`; heuristics are advice and gate only with `--gate-heuristics`), `2` usage, `3` not measured (an empty snapshot, an unreadable file, `--active`, which is not part of this version). `--format human|json|github|sarif`, `--reporter junit-xml`, `--out`; an exceptions file (`--ignore-file`, a `reason` and an `expires` of at most 180 days each) hides a finding from the exit code, never a `3`. A command in a configuration file is read, never run; no secret value and no description text is printed in any format.
- **An accuracy corpus for the `scan/cfg/*` rules of the coming `plune mcp scan`, and its measure (MCP-G7, second part).** `corpus/config/malicious/` holds client files as text with an expectation file (`{ rule, path }` pairs, where each came from) for all 13 `scan/cfg/*` rules, at least three each, from plain to hidden; tokens are never stored, a placeholder is expanded at run time to a fake value of the right format. `corpus/config/benign/` holds ordinary files for every client, including ones that set rules off legitimately; all `origin: synthetic`. `measureConfig()` in `src/mcp-testing/scan/corpus-config.ts` reports per rule the expected findings made and missed and the false findings per server entry and per field, for `real` and `synthetic` apart, and counts apart what the scanner must say it did not check (a value over 64 KB, a command over 4096, a broken file, a file over the limit). A test checks that no result of the scanner holds a fake token or 8 of its characters in a row, and compares the measure with `corpus/config/baseline.json`. No rule changed.
- **`plune mcp conformance --suite oauth`: registration and the token response (MCP-C5).** Five checks, outside the frozen profile: `oauth-reg-prereg` (a pre-registered client at the authorization endpoint, no secret sent), `oauth-reg-dcr` and `oauth-reg-dcr-http-redirect-rejected` (dynamic registration, off unless `registration.allowClientCreation` is true in `--config`; the client is deleted with RFC 7592 when the server allows it, else the result names the client that remains), `oauth-reg-cimd` (a client_id URL, and one whose document does not match) and `oauth-token-format`. What the server issues (`client_secret`, `registration_access_token`, tokens) is masked in every output.
- **`plune mcp conformance --suite oauth`: negative probes that need no sign-in (MCP-C5).** Two checks, outside the frozen profile: `oauth-neg-invalid-client` (a client_id that does not exist is refused at the authorization endpoint and, when `--config` allows, at the token endpoint) and `oauth-neg-authorize-redirect-mismatch` (a redirect URI the client did not register is not redirected to). Each has the real client as a control; no client is registered and the other redirect URI is on an `.invalid` host and is never followed.
- **`plune mcp scan`: a file that cannot be read after it was found is the same outcome as one that is too large.** A snapshot or pin file that vanishes between the check and the size read, or cannot be read for permissions, is a "could not run" row (exit 3) with a fixed reason; an exceptions file is a usage error (exit 2). No OS error text and no full path is printed. Before, an unreadable snapshot or pin file (a failed read) was a usage error (exit 2) and a failed size read was an uncaught error; now both are the row and exit 3. The duplicate-label message now passes both file names through the same masking as other printed paths.
- **An accuracy corpus for the `scan/cross/*` rules of the coming `plune mcp scan`, and its measure (MCP-G7, third part).** `corpus/cross/malicious/` holds groups of two or more server snapshots with the findings they must set off (9 for `scan/cross/duplicate-tool-name`, 13 for `scan/cross/foreign-tool-reference`), from plain to hidden; 10 of them are designed misses the rules are known not to meet (case, hidden-character, homoglyph, separator, paraphrase and encoding variants), recorded as misses. `corpus/cross/benign/` holds 12 ordinary groups, including two unrelated servers that both have `search`, a server and its staging copy, and common verbs in prose; all `origin: synthetic`. `measureCross()` in `src/mcp-testing/scan/corpus-cross.ts` reports per rule found and missed, and false findings per group and per tool pair, `real` and `synthetic` apart; no rule is gate eligible while there are no real units. A test compares the measure with `corpus/cross/baseline.json` and turns each rule off in turn to see the measure move. This measures recall on fixtures written here, not the share of real attacks found, and "found / expected" counts the designed misses in "expected"; false findings are counted per group and per tool pair (the rate per pair is findings divided by pairs of tools, not a share of tools). The loader rejects unknown keys, missing provenance, invalid JSON and oversized files, each naming the file. No rule changed.
- **`plune mcp conformance --suite oauth`: `oauth-e2e-token-works` (MCP-C5).** With a client-credentials client in `--config`, a token is obtained for the server and the one request that tells a protected server from an open one is sent with it; a 401 is a failure only for a Bearer token that is a JWT whose `aud` holds the resource (an opaque token or another token type is could-not-run). The new id is outside the frozen profile. The token is masked in every output and is not revoked.
- **`plune mcp conformance --suite oauth`: stricter code-exchange checks (MCP-C5).** The wrong-verifier and redirect probes pass only for HTTP 400 `invalid_grant`; any other refusal is could-not-run. A repeated `iss` fails, a redirect with other user info is not the redirect URI, a cut connection in the control exchange says a token may have been issued, and a `--config` over 64 KiB is refused by its size before it is read.
- **`plune mcp conformance --suite oauth`: `--config` in YAML (MCP-C5).** A file named `.yaml` or `.yml` is read as YAML with the same keys and rules as JSON. Anchors, aliases, custom tags and merge keys are refused (so a small file cannot expand into a large one), and a file over 64 KiB is refused before it is parsed, JSON too.
- **`plune mcp conformance --suite oauth`: `auth: "headless"` and three checks that use a code (MCP-C5).** `oauth-authz-response-iss` (2026-07-28: `iss` of the authorization response, judged from the redirect alone), `oauth-neg-pkce-wrong-verifier` and `oauth-neg-token-redirect-mismatch` (a code exchanged with another verifier or redirect_uri must be refused; one control exchange first). Only a redirect with a code from the authorization endpoint is used, nothing is followed; a sign-in page is could-not-run (needs-input). Codes, verifiers and tokens are masked; issued tokens are not revoked.
- **`plune mcp conformance --suite oauth`: `oauth-neg-insufficient-scope` (MCP-C5).** A SHOULD: with a client-credentials client and the new `--config` key `narrowScopes`, a token with the full `scopes` must be accepted (the control), and a token with `narrowScopes` should get 403 with `error="insufficient_scope"`. A 2xx to the narrow token is could-not-run, not a verdict. At most two requests to each endpoint; both tokens are masked and not revoked.
- **`plune mcp conformance --suite oauth`: the matrix (MCP-C5).** `registration` in `--config` may be a list of methods: the suite runs once for each revision and each method, each run is labelled and scored on its own, and the set report adds a `combined` summary made from the counters of all runs.
- **An accuracy corpus for the description rules of the coming `plune mcp scan`, and a measure over it (MCP-G7, first part).** `corpus/malicious/` holds 57 hand-written fixtures (a snapshot plus the `{ rule, pointer }` pairs it must set off, with where it came from and who wrote it), at least three for each of the 14 `scan/desc/*` rules, some hidden in characters, some plain, some reworded or in another language on purpose. `corpus/benign/` holds 19 ordinary tool lists written for the purpose (Ukrainian, Persian, Arabic, Hebrew, Hindi, Chinese, Japanese, emoji with joiners, very short and very long texts), all `origin: synthetic`; no real tool list is part of it yet (`corpus/SOURCES.json` is empty). `measure()` in `src/mcp-testing/scan/corpus.ts` gives per rule how many expected findings were made, which were missed, and how many ordinary texts were flagged, for `real` and `synthetic` apart, with the Wilson upper bound; a rule without a fixture is `not measured`. This is fixture recall, not the share of real attacks found. A test compares the measure with `corpus/baseline.json` (date and commit of the measure) and fails on a fixture newly missed, a new false finding, a rule without fixtures or a corpus that changed without the baseline. The corpus is not in the npm package. No rule changed.
- **Report without a verdict: pass-rate words and intervals in `plune diff`, friction signals on agentic rows, and `plune run --tool-description` (MCP-D7).** `plune diff` adds an «Advice (does not change the exit code)» section (the `advice` field in JSON) for evals with repeats on both sides and, when the populations match, for all evals together: the 95 % interval of the difference of two pass rates (Newcombe method 10 over Wilson intervals, percentage points) and one of «probably worse», «probably better», «no difference visible» or «too few attempts» (fewer than 5 attempts on either side, never unlocked by a minimum of 0). The exit code, gates, eval states and `unmeasured` count never read it. `plune run` files friction signals on each agentic row as advice: `identical-retry`, `pagination-continuation` (not a repeat), `search-after-id` (only between calls of different steps) and `friction-unmeasured` when an answer cannot be read; they carry tool, steps, count and key paths, never identifier values; `no-repeated-call` shares its comparison with them. `plune run --tool-description <tool>=<text|@file>` (repeatable) shows the model another description of a tool for that run only, records the SHA-256 of the new text (`agent.description_overrides` on each row), and `plune diff` of two runs of the same population adds an «Experiment with descriptions» section: first tool called by each side and the `first-tool` hit share with its interval. See [the CLI guide](docs/guide/cli.md#advice-in-plune-diff).
- **The client-configuration rules of the coming `plune mcp scan`, as a library function (MCP-G4): `scanClientConfig(files, options)` in `src/mcp-testing/scan/config/`.** It reads the text of the files it is given (`.mcp.json` and `~/.claude.json` for Claude Code, `.cursor/mcp.json`, `.vscode/mcp.json`, `claude_desktop_config.json`; of `~/.claude.json` only `mcpServers` and `projects[*].mcpServers`) and opens nothing itself: no file, no process, no connection. The 13 `scan/cfg/*` rules and the 2 `scan/cross/*` rules of the rule catalog, with its ids, classes, levels and gating: a literal token of a known format, and a credential in a URL, and plain `http` to a host that is not loopback are `error` and gate; a shell command, a package without an exact version, `-y`, a host or package outside a list the caller passes are `warn` and gate only after the corpus measure; a literal under a credential name, a download piped into a shell and a file server rooted at a drive or the home directory are `advice` that never gates. Across servers, given their snapshots: one tool name on two servers, and a text that names a tool of another server. A finding holds the rule, the server label, the path of the field, the line and column of its value (as an editor counts them, for LF, CRLF and a lone CR) and a fixed sentence: never the value, a part of it, its length or its hash; text from the file is escaped and cannot start a line with `::`. References (`${VAR}`, `${env:VAR}`, `${input:id}`) are not secrets. A rule that needs a list or snapshots that were not given is listed as not evaluated, and a file with no server, or one that cannot be read, has its own status: neither is clean. A hostile file (very deep nesting, 8 MB or more, `__proto__` keys, a value of the wrong kind, repeated keys, comments outside VS Code) gives a problem or a finding, never an exception. No command yet.
- **`plune mcp conformance --suite oauth`: the first checks of an HTTP server's authorization (MCP-C5).** 15 checks, outside the frozen profile: the 401 and its Bearer challenge, the protected resource metadata (by `resource_metadata` or the well-known URI), the authorization server's metadata and its issuer, PKCE, HTTPS, `iss`, Client ID Metadata Documents, a token nobody issued, and `oauth-neg-wrong-audience` (a token issued for another resource must get 401, with a token for the server itself as the control). New flags `--config <file>` (secrets only by the name of an environment variable) and `--allow-origin <origin>`; no request or credential goes to an origin other than the server's without it. One report per revision (2025-11-25, 2026-07-28).
- **`plune mcp pin`: what a person approved of an MCP server, in a lock file that is committed, and `--check` for CI (MCP-G3).** `plune mcp pin <target>` connects, prints every tool, prompt and resource template in full (each character that does not print as its code point, with the escaping of the description rules), asks for an approval in a terminal or takes `--yes`, and only then writes `plune-mcp.lock.json` (`--lock`): `kind`, `lockVersion: 1`, and per server (named after `serverInfo.name`, or `--name`) its transport, a source without secrets (`stdio`, never the command; an HTTP origin and path, never the query), the server's name and version for reference, each entry as the contract snapshot normalizes it with the SHA-256 of the canonical JSON of its versioned fields (tools: `name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations`), a server hash and the time of approval. LF, no BOM; read the same after a CRLF checkout. Run again, it shows only the differences and asks for each one. `--check` writes nothing and classifies each entry as changed, added or removed (`scan/pin/tool-changed`, `tool-added`, `tool-removed`), or the server as not pinned (`scan/pin/server-not-pinned`), with the field-by-field difference of `plune mcp diff` and a mark on what the model reads (the old and the new description side by side); the order of a list and `server.version` are no difference. Exit `0` as pinned, `1` a difference, `2` a usage or file error (an entry edited by hand, another `lockVersion`), `3` nothing compared (the server could not be reached or listed nothing). `--stability` asks for `tools/list` `--times` times in one session (default 3, `--pause` apart), listens `--wait` for `notifications/tools/list_changed`, then asks once in a new session: `scan/pin/list-unstable` and `scan/pin/differs-between-sessions` (`warn`, exit `1`), `scan/pin/list-changed-announced` (`info`), and the limit of what it can see with every result. `--format json` for `--check` and `--stability`. See [the CLI guide](docs/guide/cli.md#plune-mcp-pin), with a GitHub Actions example.
- **`Session.notified(method)`** in the connection layer: how many notifications of a method a server has sent on the connection.

- **The description rules of the coming `plune mcp scan`, as a library function (MCP-G2): `scanDescriptions(snapshot, { showDecoded })` in `src/mcp-testing/scan/descriptions.ts`.** It reads every text of a contract snapshot a model sees: a tool's name, title, description and `annotations.title`, every key and string at any depth of `inputSchema` and `outputSchema`, prompts with their arguments, resources and resource templates with their addresses, and the server's `instructions`. The 14 `scan/desc/*` rules of the rule catalog (docs/features/mcp-scan/threat-catalog.md), with its ids, classes, levels and gating: Unicode tag characters, bidi controls and terminal escapes (`error`, gating); zero-width characters, other control characters, HTML comments, base64 that decodes to text, and a text over 1 MB, scanned to the limit (`warn`, gating only after the corpus measure); a joiner or direction mark outside the scripts and emoji that need it, and five phrase lists (instructions to set others aside, credential paths, keeping something from the user, calling another tool first, a string parameter that asks for the conversation or other content) as `advice` that never gates, with `gating: false` on the finding. A finding names the rule, a JSON Pointer to the text, the offset in code points and what matched; nothing the server sent is shown raw: an excerpt of at most 80 characters shows every character that does not print as its code point, and the text that tag characters spell appears only with `showDecoded`, escaped too. A snapshot with no text is `nothing-to-scan`, not clean. The phrase lists are versioned data (`src/mcp-testing/scan/phrases.ts`). `findToolNames(text, names)` finds a tool name at word bounds, in its own letter case, for the cross-server rule to come. No command yet; `plune mcp serve`'s own snapshot has no finding.

- **`plune diff` gates for pass rate, cost and tokens, with waivers.** New flags, each off until given: `--max-pass-rate-drop-percent <n>`, `--max-cost-usd <n>`, `--max-cost-increase-percent <n>`, `--max-tokens <n>`, and `--waivers <file>`. A value that is missing never gives green: the overall pass rate is compared only when both runs measured the same evals, rows, repeats, model and checks and each side has at least 10 attempts, and the diff names each difference; a cost gate needs a known price (`priced: true`) on every row it reads and counts what the cache saved as cost; a zero-cost baseline leaves the relative gate unmeasured. A waiver (YAML: `gate`, `eval` for a regression, `reason` of at most 200 characters, `granted`, `expires` at most 30 days later) lifts a measured failure only, never «not measured»; expired and unused waivers are listed, and a malformed file is exit `2`. Exit codes with `--fail-on-regression` or a gate: `0` all measured and nothing failed, `1` a measured failure (wins), `2` input error, `3` something not measured. The report has a «Gates» section in console, Markdown and JSON (the added `gates` field). Without these flags the exit code and the JSON are unchanged. See [the CLI guide](docs/guide/cli.md#exit-codes). A dry run on either side makes the pass-rate gate `unmeasured` (exit `3`) as well, with a reason that names it: a dry run judges no row, so a rate over it is not a measurement, and no waiver lifts that (#252).
- **`plune run` records what each eval measured (`EvalResult.measured`).** The number of repeats and rows, a hash of the rows' `vars`, a hash of the checks and the model; not the prompt text. Optional and additive: `schemaVersion` stays 1, and a result without it reads as an unknown population.

- **`plune mcp conformance` checks Streamable HTTP on the wire and a local server's protection against DNS rebinding.** 22 new entries, all over HTTP only (`not-applicable` on stdio): a notification is `202` with no body or an error status, a request is answered as `application/json` or `text/event-stream` in UTF-8 JSON at one endpoint, concurrent POSTs get their own ids, GET is an SSE stream or `405`, session ids are visible ASCII, a missing session id or an invalid `MCP-Protocol-Version` is `400`, a deleted session is `404`, SSE event ids are unique, a message is not broadcast to two GET streams (with `--fixture`), an SSE stream ends after its response; for 2026-07-28, no server request on a request's stream, `X-Accel-Buffering: no`, and GET/DELETE `405` on a modern-only server. On `localhost`, `127.0.0.1`, `[::1]` and `*.localhost` (elsewhere `not-applicable`, a new reason `not-local`): a foreign `Origin` gets `403`, proven against two controls (a localhost `Origin` and none are accepted, else `could-not-run`), the port is not reachable at an outside address, and a foreign `Host` is refused, as advice outside the specification that never moves the score. The requests are raw HTTP, not an MCP client; each check keeps them in a new optional `details` field, secrets masked, and the `--header` values go to the URL under test only, with no redirect followed. `http-close-cancels` is catalogued but `could-not-run` (`needs-input`) for now. Profile `2026-11.1` is unchanged, so the new checks stay out of the score.

- **Every `plune mcp conformance` check now has a server that makes it red (MCP-C7).** A test (`fixture-matrix.test.ts`) runs each broken fixture server and one good server per transport and era through the whole command, and fails when a requirement of the catalog is red on none of them, unless the id is named in the test with its reason (`http-close-cancels`, `life-version-negotiation`); a good server must have no `failed` check. Two fixture servers gained modes for `tools-list-order-stable`, `http-single-endpoint` and `http-modern-get-delete-405`. `scripts/conformance-crosscheck.mjs` sets up the official conformance package and a reference server in an empty folder outside the repository, for a manual comparison (a minimal environment, an exact version, a port that must be free); it is not scheduled, not part of any gate and adds no dependency.

- **`plune mcp conformance` checks servers of the 2026-07-28 revision.** `--protocol-version auto` now finds the era by the rule of the specification: a `server/discover` probe first, modern on a `DiscoverResult` or a modern error (`-32020`, `-32021`, `-32022`), legacy (the `initialize` handshake on a new connection) on anything else or silence; the report says which (`era`) and why (`eraDetection`). `--protocol-version 2026-07-28` runs modern without a handshake, and `--protocol-version both` runs a dual-era server once per era, as a `mcp-conformance-report-set` of two reports each scored on its own. 31 new `mod-*` entries, each citing the 2026-07-28 text: server/discover and the required `_meta` fields (`-32602`, `-32022`), removed methods (`-32601`, HTTP `404`), a list on a fresh connection and the same lists on every connection, an unknown resource as `-32602` and never empty contents, caching hints (`ttlMs`, `cacheScope`, the same scope on every page), subscriptions (acknowledgment first, only the kinds asked for and tagged, a successful response when the server ends one), the HTTP request headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-{Name}`: `400` and `-32020` when unlike the body or missing, names in any case, Base64 decoded, valid `x-mcp-header` declarations, no `Mcp-Session-Id` from a modern-only server), and over the whole run a known `resultType`, no undefined code of `-32099`..`-32020`, no log message without `logLevel`, and every message valid against `schema.json` of 2026-07-28, shipped with the CLI. Every `mod-*` check is `not-applicable` (`era`) in a legacy run. Profile `2026-11.1` is unchanged, so they stay out of the score. A modern run no longer rides an `initialize` handshake: forced to 2026-07-28, a legacy-only server is now `could-not-run` (`prerequisite-failed`) rather than measured over a legacy session.

### Changed

- **`plune diff --fail-on-regression` on a current run with no evals exits `3`, not `0`.** Nothing was measured, so the gate has no verdict.

### Fixed

- **A subcommand's `--config` is no longer taken by the global `-c/--config`.** The oauth suite of `plune mcp conformance` never received its `--config` file, `plune mcp scan` lost every `--config` value, and the `.env` beside that file was loaded as if it were a `plune.yaml`'s. Only a `-c/--config` before the subcommand now names the config whose `.env` is read.
- **`plune init`: the text after it names what the first run needs, and the scaffolded eval accepts its own expected answers (#246).** The hint said `plune run` needed no account and no token, and the run then stopped on a missing provider key; it now names the key and where it goes (`.env`, from `.env.example`) and `PLUNE_MOCK_PROVIDER=1` for a run with no key. The scaffolded `plune.yaml` checked every answer with `contains` and the value `the`, which none of the sample answers (`4`, `Paris`, `hello`) contain; it now checks each answer against the `expected` value of its own row, ignoring case. The interactive wizard wrote a check for the fixed text `expected output` and now does the same. The hint names the key of the provider written to `plune.yaml` (`OPENAI_API_KEY` after choosing openai). A check that uses `{{expected}}` now fails on a row with no `expected` value, saying so, instead of comparing against an empty string and passing on every answer.
- **`plune mcp serve` refuses an unsupported revision on every request, not only the first.** Over stdio the SDK checks the revision the opening message claims and then pins the connection, so a later `server/discover` or `tools/list` claiming `1900-01-01` was answered as if it were supported. It now gets `-32022` with `data.supported` and `data.requested`, as revision 2026-07-28 asks: «the server accepts or rejects each request independently».
- **`plune mcp conformance`: `http-bind-loopback` keeps what each try got.** The verdict line now lists every outside address of this machine it tried, by family, with what the connection got (`open`, `refused`, `no answer in 500 ms` or the socket error), for example `(IPv4 refused, IPv6 refused)`. The addresses themselves still stay out of the report. The guide's `not-offered` reason now also names an SSE check on a server that answered every request as JSON.

- **`plune run --dry-run` gives a price and no verdict, and no longer replaces the last run (#244).** A dry run runs no assertion, and a row with no assertion counted as passed: the console said `3 passed` and `PASS`, and the result was saved to `.plune/last-run.json`, so `plune report` then said `All evals passed.` over a run that had failed. Now a dry run counts no row as passed, failed or errored: the console and Markdown reports say how many rows were priced and the estimated cost, and `.plune/last-run.json` is left as it was (none is written where there was none). In `--format json` the result has a new optional `dry_run: true`, every row has `inconclusive: "skipped"`, `summary.passed` is `0` and `summary.skipped` is the number of rows, and every eval has `passed: false`; a script that read `passed: true` of a dry run as a green check no longer gets one. `--dry-run --bail` still prices every eval, the exit code stays `0`, and `schemaVersion` stays 1.
- **`plune run`: a dataset file that is not found is a config error, not an internal one (#256).** The run printed the raw file-system error with "This one is on us" and exited `1`, which asks for a report about a mistake in the user's own project. It now prints one line that names the file and where it was looked for (`datasets/example.jsonl: dataset file not found (looked for <full path>)`) and exits `2`, with and without `--dry-run`. A dataset path that cannot be read as a file (a folder, no permission) is the same config error, with the reason from the file system.
- **A file-system error on a path is no longer called an internal error (#258).** `plune run --output <a folder that is not there>/report.md`, or a project where `.plune` is a file, printed the raw file-system error with "This one is on us" and exited `1`, the code of a failed assertion. Such an error now ends with one line of advice (check the path in the message and that you may read and write it) and exit `2`, and nothing asks for a report. A command that could not be started is not such an error and is reported as before. The change is in the handler the commands share, so it holds for each command that reported such an error this way; an error that is not a file-system error on a path is reported as before.

## [0.37.0] - 2026-11-13

### Added

- **`plune_case_propose` takes an optional `missionId` and returns `itemIds`, the ids of the review-queue entries it created; `plune_review_list` takes `missionId` to read one mission's entries (#230).** A platform that does not know the mission ignores it and names no ids, and the call still works.
- **`plune_project_context` hands the agent the project's memory rules, and the `qa-mission` skill follows them.** The answer has a new `memoryRules` field: the rules a person accepted in the review queue and has not retired (`GET /v1/memory/rules?state=in_force`, in the server's project), each as its `id` and `text`. A proposed or rejected rule is never in it, and a platform that keeps no project memory (404) answers `[]` while the rest of the context stands; any other refusal fails the call as before. The skill tells the agent to follow every rule for the whole mission and not to ask what a rule answers, and to propose a new rule only to the review queue (`POST /v1/memory/candidates` through `plune_api_request`), never writing one as accepted. Non-breaking for the contract: one output field added, and the description says so. The tool-list and answer budgets are set again from the new measures.
- **The `qa-mission` skill, in the Agent Skills format, under `skills/qa-mission` and in the npm package.** With the Plune MCP tools, an agent reads the product's README and docs, asks 3 to 5 questions (`plune_question_ask`, or the chat when not connected), writes a test strategy as a Markdown file in the repository and proposes it with `plune_strategy_propose`, and proposes 20 or more cases to the review queue with `plune_case_propose`, each write tried with `dry_run` first. It keeps a stage log with the tokens the host reports, never an estimate. A unit test checks every tool name, call argument and example input of the skill against the tool contract. See [the guide](docs/guide/qa-mission.md).
- **`plune automate <caseId>`: one case from Plune through Cairn's `automate`, the code it wrote printed as a diff of new files (#148).** The case is read with your token, written in Cairn's ATC format into a temporary run folder, and Cairn runs in `--repo` (default: the current directory) with no `PLUNE_*` variable and no value holding the token, reading a copy of the repo's `.env` without them. `--cairn <path>` names Cairn's executable or `.js` entry, `--url` the app's address, and arguments after `--` go to Cairn (`--run` and `--into-project` are refused). Nothing is written into the repo and, without `--send`, nothing is queued. Exit `2` for a missing Cairn, a case not found or one with no steps; `1` when Cairn fails or writes nothing.
- **`plune automate <caseId> --send`: the code Cairn wrote goes to the review queue as an automation proposal (`POST /v1/review-items/automations`) (#148).** The proposal carries the files the diff shows, whole and at the same `tests/…` paths, the first spec file's first `test()` call as the case's code with its `path:line`, the case's current code hash as `baseHash` when it has code, and the Cairn and CLI versions (`cairn --version` starts with the same environment, without `PLUNE_*` or the token). The bounds are checked before anything is sent: at most 10 files, 16 384 bytes each, 65 536 bytes in all; over one, nothing is sent and each failed bound is named (exit `2`). The answer is printed on stderr: a new queue entry (201) or the one waiting for the case replaced at a higher revision (200), with any file the server did not keep. A refusal prints the server's status, code and message (exit `1`), as does a set of files with no `test()` call. Without `--send` nothing is sent, as before. Needs a Plune that serves the route.

- **`provider.reasoning_effort`: `none`, `minimal`, `low`, `medium`, `high` or `xhigh`, sent as is by `openai` on plain and agentic rows (#220).** Unset, nothing is sent and requests are unchanged. `gpt-6-luna` refuses function tools on Chat Completions while it reasons, so the agent scenarios in `mcp-evals/plune.yaml` set `none`. `anthropic` does not send it and says so once per model on stderr; `openrouter` does not send it, its reasoning parameter has another shape. The cache key is unchanged and does not hold it.

- **`tool-args` takes a list of argument sets as alternatives: a call that fits any one of them matches.** For a parameter a tool accepts in more than one form (a string or a list of strings), a check can name each form instead of picking one. One object, as before, works unchanged; `match` applies to each set, and the failure reason names every set.

### Fixed

- **The `find-smoke-cases` agent scenario checks the search, not the form of its filter.** It failed every run of both models of the weekly run, which found the three smoke cases with `{"tag": "smoke"}`: the check wanted the list form, though the tool sends a string and a one-item list as the same query (`tag=smoke`). It now takes either form and no longer asks for the search to come first (a look at the project overview before it is a read, not a mistake); a wrong tag or a write still fails, and the offline plays prove both.

- **`tool-not-called`, `only-tools`, `no-tool-errors` and `no-destructive-tool` are measured on a loop that ended on its own, even when an answer's stored excerpt was cut (#223).** They read only the calls and the tool list, and a cut excerpt shortens only texts, never drops a call, so a model that read a page of cases over 4 KiB no longer left the row `errored` with `ASSERTION_UNMEASURED`. A loop stopped by a limit stays unmeasured, and `collection` still reads `partial` when an excerpt was cut.

- **`anthropic` and `openai` no longer send request parameters that current models refuse with a 400.** `anthropic` sends the configured `temperature` only to the models that still take one (Claude Opus 4.6 and Sonnet 4.6, the 4.5, 4.1 and 4 generations, Haiku 4.5 and the 3.x models); every other model, such as `claude-sonnet-5-5`, gets none, and the run says once per model on stderr that the configured value was not sent. `openai` sends the output limit as `max_completion_tokens` instead of the deprecated `max_tokens`, which newer models such as `gpt-6-luna` refuse. `openrouter` still sends `max_tokens`. Both apply to plain and agentic rows. The cache key is unchanged: it still holds the configured temperature.

- **The tool loop of an agentic eval offers a tool the server switches on during the row.** The loop read `tools/list` once, when a row started, so a tool a server lists only after a call (`plune mcp serve` in the 2025 protocol era shows a hidden tool once `plune_discover_tools` switches it on, and says so with `notifications/tools/list_changed`) was never offered: the model's call to it was recorded as `not-offered`, and a check that named it stopped the row with `ASSERTION_UNKNOWN_TOOL`. Now the list is read again after every step with a call that succeeded, and what it holds is offered from the next step, still within `allowed_tools`. The re-read does not wait for the notification, which over HTTP may arrive on another stream after the call's answer. `agent.tools` holds every tool listed at any point of the row, `offered` if it ever was, so a check may name a tool the list held only for a while; a name never listed is still `ASSERTION_UNKNOWN_TOOL`. The step whose request first offered a changed list carries the new optional `offered_changed` (`added`, `removed`). A server with a fixed list (the 2026-07-28 era) behaves as before. `schemaVersion` stays `1`.

## [0.36.0] - 2026-11-11

### Added

- **`plune mcp conformance` writes JUnit XML: `--reporter junit-xml` and `--out junit-xml=<path>`, as `lint`, `check` and `diff` do.** `--out` is now repeatable and takes `json` or `junit-xml` before `=`, parsed by the same code as the other commands, so one run writes `conformance.json` and `conformance.xml` together. One `<testcase>` per selected check, `classname` `mcp.conformance.<suite>` and `name` the check id: a failed `MUST` of the profile is a `<failure>`, a failed `SHOULD`, `MAY` or advice is `<skipped type="advisory">`, `could-not-run` is an `<error>` with its reason (never a pass), `not-applicable` and `pending` are `<skipped>` with theirs; the reason, `expected`, `actual`, `fix` and the `specRef` are in the case's text, secrets masked as in the JSON result. A `<failure>` is there exactly when the exit code is `1`; the exit code does not depend on the formats asked for. `--format human|json` and a bare `--out <path>` (JSON) work as before.

## [0.35.0] - 2026-11-11

### Added

- **Tool-call assertions: which tools the model called, with what arguments, in what order, at what cost.** Fourteen new types read the transcript of an eval with `mcp`: `tool-called`, `tool-not-called`, `tool-args` (`match: partial | exact | ignore`, `{{vars.X}}` in the arguments), `tool-order` (`strict`), `only-tools`, `first-tool`, `no-tool-errors`, `tool-call-count` (`min`, `max`), `token-budget`, `tool-latency`, `tool-result-size` (the size before the transcript's cut), `tool-result-schema` and `no-destructive-tool` (safe only with `readOnlyHint: true` or `destructiveHint: false`, as MCP says). Each has a class, `measure`, `deterministic` or `heuristic`, in one table. `no-repeated-call` is the one heuristic: what it finds goes to the row's `agent.advice`, shown by the console and Markdown reports, never into `assertions` and never into the status or the exit code. A check that measured nothing does not pass: a negative check that found nothing on a transcript a limit stopped or an excerpt cut, a measure without its numbers, makes the row `errored` with `ASSERTION_UNMEASURED`; a tool name the model was not offered is `ASSERTION_UNKNOWN_TOOL` with the offered names; a violation that was found still fails. A failure says what was expected, the calls seen with their step and masked, cut arguments, and where to look, never the content of an answer. One of these types in an eval without `mcp` is exit `2` before any model call. `assertionConfigSchema` accepts the new types; `RowResult` and the rest of the public types are unchanged, `schemaVersion` stays `1`.

- **The tool loop of an agentic eval: the model calls the MCP server's tools, and the row keeps the transcript.** For each row of an eval with `mcp`, `plune run` opens one session with its server, offers the model the tools `allowed_tools` names, runs every call it asks for on the server in the order asked, and gives the answers back, until the model answers without a call or a limit stops it; `output` is the last text, and the assertions judge it. `anthropic`, `openai` and `openrouter` take tools (`Provider.respond`, optional, so a provider without it is unchanged); a name a provider refuses (`files/read`) is offered as a safe one and mapped back. The row's new optional `agent` field holds the server's tools with their annotations, every step with its tokens and cost, and every call with its arguments, `executed`, `is_error` and its kind (`content`, `protocol`, `timeout`, `not-offered`, `bad-arguments`), its time, and an excerpt of its answer (4 KiB at most, 256 KiB a row) with the size measured before the cut; `stop` names the limit that ended the loop, and `collection` is `partial` when something was not seen. A tool the model was not offered is not run. A lost server, a failed provider or a reply cut off in a call makes the row `errored` and keeps the transcript. The cost is the sum of the steps, `priced: false` when one was unpriced. The loop is never cached; `--cache-strict` with an agentic eval is exit `2`. Agentic rows run one at a time unless `--concurrency` or `provider.concurrency` says otherwise. `--dry-run` prices `max_steps` calls and says that tool schemas are not counted. `PLUNE_MOCK_PROVIDER=1` plays the steps of `PLUNE_MOCK_SCRIPT`; without a script an agentic eval is exit `2`. Values of the server's `env` and `headers` are masked in the transcript, `output` and errors. `schemaVersion` stays `1`.
- **An `mcp` block in `plune.yaml`: the MCP server of an agentic eval, its tools and its limits.** `mcp.servers.<name>` is a stdio server (`command`, `args`, `env`, `cwd`) or an HTTP one (`url`, `headers`), exactly one of the two; `mcp.limits` holds the defaults. An eval's `mcp` names a `server`, may restrict `allowed_tools` (left out: every tool the server lists; `[]` is refused) and may override `limits`. Every limit has a finite default: `max_steps` `10`, `max_tool_calls` `20`, `max_total_tokens` `100000`, `timeout_ms` `120000` per row, `tool_timeout_ms` `30000` per call; `0`, a negative number or a fraction is refused. Server values take `${VAR}` and `${VAR:-default}` and nothing else, with no shell; an unset one is exit `2` that names the variable and never a value, and `plune.yaml` keeps `${VAR}` as written, so `config_hash` does not change with the value. A literal value under a key that looks like a credential is a warning on stderr that never changes the exit code. `plune run` and `--dry-run` check the block before any model call, and a dry run starts no server. A CLI older than this one stops on the top-level `mcp` key.
- **`plune mcp conformance`: the protocol checks.** The 30 checks of the protocol suite now run instead of reporting `pending`: the handshake, declared capabilities against served methods (and the reverse), `ping`, the answers to invalid JSON (`-32700`), an unknown method (`-32601`) and wrong parameters (`-32602`), response ids, the entries of the tools, resources, templates and prompts lists, `inputSchema` and `outputSchema` in their own dialect (2020-12, 2019-09, draft-07), tool names, pagination (64 pages at most) and invalid cursors, `logging/setLevel`, `completion/complete`, and on stdio a clean stdout and the exit when stdin closes. Requests go as plain JSON-RPC beside the connection, so an answer is judged as sent. `--fixture <file>` lists the only tools a run calls (`{ "tool", "arguments" }`); without it the two checks of tool results are `could-not-run` (`needs-input`). A failed handshake makes the checks after it `could-not-run` (`prerequisite-failed`); after two timeouts in a row the rest are not tried. New reasons: `not-offered` and `unsupported-dialect`. The profile `2026-11.1` holds 17 scored checks (see Changed).
- **`plune mcp serve` answers a line that is not JSON with `-32700` and `id: null`**, as JSON-RPC 2.0 asks, instead of dropping it with a line on stderr.

- **`plune mcp conformance`: the model of conformance checks.** One catalog of checks (stable id, suite, kind, `MUST`/`SHOULD`/`MAY`, cited sections, eras, transports), five states with reasons, a score that counts only `MUST` checks of a frozen profile (`2026-11.1`, its SHA-256 digest in every result), and `--list-checks`, `--explain`, `--suite`, `--check`, `--protocol-version`, `--format human|json`, `--out`. Exit `0` passed, `1` a scored check failed, `2` the server did not start or a flag is wrong, `3` conformance not established.
- **Repeats for every eval: `runs` and `pass_threshold`.** `runs` (a whole number from `1` to `100`, default `1`) runs each dataset row that many times, one run after another, with rows still in parallel; `pass_threshold` (above `0`, at most `1`, default `1`) is the share of the runs that must pass. Both go at the top of `plune.yaml` or on an eval, which wins; `plune run --runs <n>` overrides `runs` for one run. A row needs `ceil(pass_threshold × runs)` passes; when the runs that errored could still have reached that, the row is `errored`, not `failed`. Every run is kept in the row's optional `attempts` (`runs`, `pass_threshold`, `passed`, `failed`, `errored`, `results`); the row's own fields are those of its first run in the row's state, its `usage`, `cache_saved` and `latency_ms` are sums, and `cached` is true only when every run came from the cache. Each run after the first has a cache key of its own, so `runs: 10` makes ten model calls and the next run replays them; the first run keys as before, so existing cache entries still answer. The console and Markdown reports show `7/10` and the row's state, `--dry-run` multiplies its estimate by `runs`, and `plune diff` compares the rows' verdicts as before. Without `runs` the output is unchanged. This `pass_threshold` is not the one of `llm-judge` (the lowest judge score), and a config error names which one it means.

### Changed

- **`plune mcp conformance`: two levels follow the specification.** `logging-set-level` and `completion-complete` are `SHOULD`, not `MUST`: the specification requires declaring the capability, not handling the request. They leave the profile `2026-11.1` (17 checks). `base-jsonrpc-parse-error` and `base-unknown-method-error` are marked derived: MCP requires JSON-RPC 2.0, which names the codes.

## [0.34.6] - 2026-11-10

### Fixed
- **`--fail-on-failures` no longer passes a run that no result reached (plune-ai/plune#2575).** `plune run import` of a report
  whose cases the project does not have yet sends nothing to the run (`0 accepted · 28 with no matching test case`), and the gate
  then read `gate passed — 0 failed` and exited `0`, even when the report held failures. Without a runner of its own
  (`run import`, `run finish`, `sync`), such a run now exits `1`: `gate failed — no result reached the run, so there is nothing
  to pass.` `run exec` keeps the command's own code, as before.

## [0.34.5] - 2026-11-10

### Added

- **`plune mcp lint`: why a model will stumble over an MCP server's tools (plune-ai/plune#2427).** It reads the server's `tools/list` to its last page and runs deterministic rules that cite the MCP specification, plus heuristics that report `warn` at most; English and Ukrainian descriptions are read alike. `--fail-on error|warn|info|never` (default `error`); `--list-rules` prints the catalog without connecting; `--call` calls only the tools that are read-only, not destructive and need no argument, and checks their answers. Exceptions live in `plune-mcp-ignore.yaml`, each with a required `reason` and an optional `expires`; an entry that covers nothing is reported as stale. Over 1000 tools the two pairwise rules, and on an input schema nested deeper than 64 levels the two schema rules, report `could-not-run` instead of hanging or crashing, and no exception hides that (plune-ai/plune#2562, plune-ai/plune#2564).
- **`plune mcp check`: does an MCP server start and answer (plune-ai/plune#2429).** In order: `start`, `initialize`, `protocol-version`, `capabilities`, `tools-list`, `resources-list`, `resource-templates-list`, `prompts-list`, `ping`, each `passed`, `failed`, `not-applicable` or `could-not-run`. No answer within `--check-timeout` (default `15s`) is `could-not-run`, never `failed`, and two timeouts in a row end the run. `--wait` keeps trying a `--url` server that CI starts beside the step. `--smoke` calls up to `--smoke-limit` (5) tools that say `readOnlyHint: true`, are not destructive and need no argument, always with `{}`; `--allow-write-calls` adds only tools that say `destructiveHint: false`, and a tool that says `destructiveHint: true` is never called. It needs no Plune account and never calls the platform.
- **`plune mcp snapshot` and `plune mcp diff`: an MCP server's contract in a file, and what changed in it (plune-ai/plune#2428).** `snapshot` writes the server's tools, resources, resource templates, prompts, name, capabilities and instructions as one stable JSON file to commit (`schemaVersion: 2`, sorted, without time, command, URL or headers). `diff <baseline> [current]` compares it with a second file or with a live server and classifies each change as `breaking`, `non-breaking` or `informational`, with a one-sentence reason; a change it cannot classify is shown and counted apart. A changed description or instructions, or a tool that becomes less safe, carries the `security` signal, a changed server name `identity`; signals never change the class or the exit code. `--fail-on breaking|any|none` (default `breaking`).
- **One connection for every `plune mcp` command that tests a server (plune-ai/plune#2426).** The server is a command after `--` (stdio) or `--url` (Streamable HTTP; `--sse` for the older SSE transport), with `--header "Name: value"`, `--header-env Name=VAR`, `--env KEY=VALUE` / `--env KEY`, `--cwd`, `--timeout` and `--debug-out`. Headers go to the server's own origin only, and a redirect to another origin is not followed. Header, env and URL secrets, and each argument of 8 characters or more of the command after `--`, are masked wherever the server repeats them; a secret the server prints encoded or in pieces gets past the mask. The server and every process it started are ended when the command finishes or is interrupted. Over stdio one message holds at most 10 MB; a larger one is exit `2` that names the limit, not «exited before it answered» (plune-ai/plune#2565). Duration flags take at most 2147483647 ms, the longest a timer can wait.
- **One set of report formats for `plune mcp lint`, `check` and `diff` (plune-ai/plune#2430).** `--format human|json|github|markdown` on stdout, `--reporter junit-xml`, and a repeatable `--out [<format>=]<path>` (`json`, `junit-xml`, `markdown`), all from one connection; a bare `--out path` is JSON. Every JSON document carries `kind` and `schemaVersion`. `github` writes `::error`, `::warning` and `::notice` annotations, at most 10 of each per step; `markdown` is a pull request comment with a hidden marker per command, in which server text cannot mention anyone, link or embed; the JUnit file has stable case names and agrees with the exit code. No other output lets server text start a workflow command.
- Exit codes of `plune mcp lint`, `check`, `snapshot` and `diff`: `0` nothing at the `--fail-on` level and everything measured, `1` a finding, failed check or change at that level (`snapshot` has no `1`), `2` a flag, a file or the connection is wrong and you can fix it, `3` nothing measured — never a pass.
- **`plune mcp serve` answers both MCP protocol eras (plune-ai/plune#2421, plune-ai/plune#2551).** A client of the `initialize` line (`2025-11-25` and older) is served as before, and a client of revision `2026-07-28` (`server/discover`, no handshake) now too. In that era `tools/list` stays the same for the whole connection: `plune_discover_tools` describes the hidden tools with their `inputSchema`, switches nothing on and sends no `notifications/tools/list_changed`, and a hidden tool is called by its name. In the 2025 era discovery reveals tools as before.
- **The tool contract of `plune mcp serve` is pinned and measured (plune-ai/plune#2418, plune-ai/plune#2419).** The repository holds a snapshot of every tool and a context budget for each list a client can see; a renamed tool, a new required parameter, a changed description or a list that grows past its budget fails a test before it merges. A provider's token counter puts the first list of a write token (17 tools) at 8922 tokens and the read list (8 tools) at 1864.
- The package ships `THIRD_PARTY_NOTICES`, the MIT attribution for the lint rule groups (plune-ai/plune#2417).

### Changed

- **`plune mcp serve` in the 2025 era: two differences a client can see (plune-ai/plune#2421).** Tool schemas declare JSON Schema 2020-12 instead of draft-07 (every keyword they use exists in draft-07 too), and calling a tool that is not in the list, a hidden tool before `plune_discover_tools` included, is the protocol error `-32602` instead of a result with `isError`, as the tools page of both revisions requires. The output schema of `plune_discover_tools` gains the optional `available[].inputSchema`, filled only in the `2026-07-28` era (plune-ai/plune#2551).
- **Line separators and bidirectional controls are replaced in report text plune prints (plune-ai/plune#2427).** U+2028, U+2029, U+202A–U+202E and U+2066–U+2069 now become `?`, as control characters already did: in the file names, test titles and attachment names of `plune run import`, and in the test name of the reporter's «shortened to fit its key» warning.

`@plune-ai/playwright` stays 0.7.1: its own code did not change, but it embeds `reporter-core`, so the replacement above reaches the Playwright reporter only with its next version.

## [0.34.4] - 2026-11-09

### Fixed

- **`plune diff` no longer calls an eval passed when none of its rows was judged (plune-ai/plune#2497).** An eval whose rows were all blocked or skipped, or whose dataset was empty, had no verdict but counted as passed, so `--fail-on-regression` exited `0` under «✅ No regressions». Such an eval is now `unmeasured` and the flag exits `3`. An eval with one passed row and the rest skipped still passes. In `--format json`, `evals[].current` and `evals[].baseline` can now hold `unjudged`; an unjudged baseline counts like an errored one. The badge reads «⚠️ not measured» for every unmeasured eval. A CI gate whose evals were all skipped now fails.

The adapter stays 0.7.1: nothing it embeds changed.

## [0.34.3] - 2026-11-09

### Changed

- **`plune_review_decide` names `policy_refused` (plune-ai/plune#2499).** The tool's description now tells the agent that an entry the platform skips as `policy_refused` was refused by the project's review policy: it is not retried, it needs another reviewer, and its `detail` says why.

### Fixed

- A dataset line that is not valid JSON, or a row without a `vars` object, now stops `plune run` with `<file>:<line>` and exit 2 instead of an internal error (plune-ai/plune#2543).

## [0.34.2] - 2026-11-09

### Added

- **`plune mcp serve`: cases from pasted text (plune-ai/plune#1876).** `plune_cases_generate` starts a run of the project's AI on pasted text (`POST /v1/projects/:id/case-generations`) with the platform's own body: `input: { kind: 'pasted-text', text, title? }`, `maxCases` (1–12, 8 when left out), `language`, `confirmDuplicates`, plus `dry_run` and an optional `projectId`. The run spends the project's AI budget; its proposals land in the review queue and none becomes a case until a person approves it. The Jira-ticket input is refused before any request. `plune_cases_generation_get` reads a run by the id the start answered with — its state (`queued`, `running`, `done`, `failed`, `cancelled`), counters and cost. A platform refusal (409 `duplicate_source`, 422 `ticket_too_empty` / `text_too_long`, 429, 503 / 409 for the project's AI) comes back with its status, `code` and body unchanged. Both tools are listed from the start; the default list grows from 15 to 17 of at most 20. Starting a run with a token needs a platform version that lets a token start one from pasted text; an older one answers 403.

## [0.34.1] - 2026-11-09

### Changed

- **`plune diff --fail-on-regression` exits `3` when an eval was not measured (plune-ai/plune#2414).** An eval that errored in the current run, or errored in the baseline and fails now, has no verdict. Before, such a run exited `0` under a «✅ No regressions» headline, so a gate passed when the model never answered. The summary gains `unmeasured`; the headline reads «⚠️ N eval(s) not measured»; a regression still exits `1` first. An eval that errored in the baseline and fails now gets the new status `unmeasured` instead of `pre-existing-fail`. The `errored` status and every other field are unchanged, and without the flag the exit stays `0`. A CI script that runs `plune diff --fail-on-regression` now fails when the provider was down during the current run.

### Fixed

- **`defaults.assertions` in `plune.yaml` now run on every eval (plune-ai/plune#2415).** The schema accepted them and the guide promised them, but no eval ran them, so a run stayed green with a shared check that could never pass. They run ahead of each eval's own assertions; a check listed in both places runs twice. An eval still needs its own `assertions` key (`[]` when the shared checks are enough). A suite that relied on them being ignored can now go red.

The adapter stays 0.7.1: nothing it embeds changed.

## [0.34.0] - 2026-11-07

### Added

- **`plune mcp serve`: the Plune tools for AI agents over MCP stdio (#146, plune-ai/plune#1284).** Claude Code, Codex or any MCP client gets the Plune a token reaches — project context, cases, the review queue, missions, sources, questions, strategy, reports — as tools. At most 20 are listed at once; the rest are found with `plune_discover_tools`. Every write tool takes `dry_run`, a batch stops at 100 items, and every request carries `X-Plune-Session`, so the platform holds the caller to its agent rules: a proposed case lands in the review queue, a bulk decision needs a confirm, and a delete is refused. The token is read as every platform command reads it (`PLUNE_TOKEN`, else the saved login); `--project <id>` (default `PLUNE_PROJECT`) picks the project and `--read-only` offers only the read tools. Without a token it exits 2. stdout carries only the protocol.
- **`@plune-ai/cli/mcp-tools`: the same tool contract without a transport.** The tool definitions, their input and output schemas and the executor, importing only `zod`, `node:crypto` and `fetch`, so a service can give an agent the same tools without the CLI or MCP.

The adapter stays 0.7.1: nothing it embeds changed.

## [0.33.0] - 2026-11-05

### Added

- **k6 summaries and Lighthouse reports import as runs (#149).** `plune run import` reads a k6 end-of-test summary (`--summary-export`, or the `handleSummary` data) and a Lighthouse JSON report, detected by their own keys or named with `--format k6 | lighthouse`. A k6 threshold is one result, `<metric> <expression>`, passed or failed as k6 judged it, with the metric's measured values as its message; a summary with no thresholds is refused with exit 2, since there is nothing to pass or fail. A Lighthouse category is one result, its score shown 0–100 and passed at or above `--min-score <category>=<n>` (repeatable) or 90 for a category not named; a `null` score fails and says so, and a `runtimeError` fails every category with its message (`NO_ERROR`, which older Lighthouse writes into a clean report, is no error). A `--min-score` naming a category the report does not have, or given for a report that is not Lighthouse or for a folder, is refused with exit 2 before any run is opened. A k6 threshold is keyed by the summary file's name too, so two summaries with the same threshold under one `--key` are two results (renaming the file starts a new test); a Lighthouse category is keyed and named by its form factor too (`configSettings.formFactor`), so a mobile and a desktop report of one page both land. A report file that starts with a UTF-8 BOM is read without it, in every format. The results go through the same run and batches as every other import.
- **k6 and Lighthouse imports, follow-ups (#149).** A test now pins that an Allure `*-result.json` starting with a UTF-8 BOM reads like any other result. The README says that a k6 result is keyed by the summary file's base name, not its folder, so matrix jobs under one `--key` each name their summary file apart (`summary-<scenario>.json`), and that a crossed threshold or a Lighthouse score under its bar is a failed result in a finished run with exit 0, and exit 1 only with `--fail-on-failures`.
- **`usage.priced` tells a known $0 from a price nobody knows (#151).** `plune sync` wrote `usage.cost_usd: 0` both for a model whose price is unknown and for a model whose price is known and zero (an OpenRouter `:free` model, `pricing: 0` for a local model), so the platform could not tell them apart. Now `usage` carries `priced: boolean`: `true` when the price is known, a zero price and a provider-reported actual cost included; `false` when no price exists for the model. A row is `priced: false` if any of its calls (the answer or a judge call) was unpriced; a cache hit takes the flag from the model's price. The field is optional in the RunResult contract and its schema, so a report written before it validates and reads as before, and `schemaVersion` stays 1. `resolveCostEntry` returns the cost with the flag; `resolveCost` is unchanged.

## [0.32.2] - 2026-11-03

Also `@plune-ai/playwright` **0.7.1** - the adapter embeds `reporter-core`, so both fixes below reach the
Playwright reporter only with this version.

### Fixed

- **A key's kind is part of its identity in the reporter (#156).** Plune keeps a test's key as its kind and its value, so a Qase `7` and a TestRail `7` can name two different cases. The reporter remembered its lookups by the value alone: with both keys in one run, the second answer overwrote the first, or the second key was never asked about, and a result was recorded on the other case without an error. The run's list of expected tests and the offer of unknown tests (two tests with one value offered as one) had the same flaw. Now every lookup is remembered by kind and value. `plune run import` was not affected: it sends `path-title` and `playwright-id` keys only, and a `path-title` always holds a `#` while a Playwright id never does, so its two kinds never share a value.
- **A case created from an offer gets its result when Plune names the test by another of its keys (#156).** Plune names a discovered test by its highest-ranked key, and the reporter held the result under the first key it sent. A Playwright test with a Qase or TestRail id in its metadata sends that id first, so the case was created and the run's result for it was not recorded. The result is now held under each of its keys.

## [0.32.1] - 2026-11-03

`@plune-ai/playwright` stays at **0.7.0**: `reporter-core` and `packages/playwright` are unchanged since 0.31.0.

### Fixed

- **A JUnit report without a suite `timestamp` keeps its durations (plune-ai/plune#2310).** Maven Surefire writes no `timestamp` on `<testsuite>`, and `plune run import` dropped every Maven test's `time` with the missing start, so a Java run arrived with no durations at all. Now a case with a `time` sends it as the span that ends when the import read the report, as Plune's dashboard sends a duration a person typed: the duration is what Plune sorts and averages results by. A suite with a `timestamp` (Gradle, pytest, Jest) is read as before; a `timestamp` that does not parse as a date counts as none, and a `time` too large for any date sends no execution instead of stopping the import. A case with neither a `timestamp` nor a `time` still sends no execution. The file's mtime is still not used: a report copied from another job would carry the copy's time.

## [0.32.0] - 2026-11-03

`@plune-ai/playwright` stays at **0.7.0**: `reporter-core` and `packages/playwright` are unchanged since 0.31.0.

### Added

- **`plune run import` reads a folder of JUnit XML files (plune-ai/plune#2309).** Maven Surefire (`target/surefire-reports`) and Gradle (`build/test-results/test`) write a `TEST-<class>.xml` per class, so a Java suite no longer needs Allure to reach Plune: `plune run import target/surefire-reports` reads every `*.xml` of the folder that is a JUnit report, in the order of the file names, and sends them as one run (`meta.runner` is `junit`, as for one file). Only the folder's own regular files are read: subfolders (Gradle's `binary/`) and links are not opened. An `*.xml` that is not JUnit is skipped with one line in the output. A `[[ATTACHMENT|path]]` counts from the folder the XML file is in, as for one file. A folder with a `*-result.json` in it is still read as `allure-results`; `--format junit` reads a folder as JUnit files, and `--format playwright-json` on a folder is refused. A folder with neither is an error that names both, and up to three of the files it skipped as not JUnit (exit 2, as before for a folder without `*-result.json`); a file in it that cannot be read is `Cannot read <file>.` with exit 1, as one file is. Maven tests arrive without a duration for now: Surefire writes no `timestamp` on a suite (plune-ai/plune#2310). A file name in `XmlParseError` and in `Cannot read` is now printed without control characters, for one file as for a folder. The README's Java section now starts with Maven and Gradle without Allure, and names the Allure adapter `io.qameta.allure:allure-jupiter` (`allure-junit5` is a relocation to it since 2.35.1) and `allure.results.directory` for where its folder goes.

## [0.31.0] - 2026-10-30

Also `@plune-ai/playwright` **0.7.0** - the adapter embeds `reporter-core`, so `PLUNE_CONFIGURATION` below reaches the
Playwright reporter only with this version.

### Added

- **`PLUNE_CONFIGURATION` names the combination a CI job runs (plune-ai/plune#1251).** `PLUNE_CONFIGURATION="Browser=Chrome;Operating system=Windows"` sends `configuration` (group name → value label) on every results batch of the Playwright reporter and `plune run import`, so the jobs of a matrix that share `PLUNE_RUN` land in one run, each under its own combination: one the run already has, or one Plune adds. Pairs split at `;`, a pair at its first `=`, both sides trimmed; blank pairs are dropped, and an unset or blank variable sends the batch as before. A pair without `=`, a name or a value, or a group named twice (case not mattering), stops the command before anything is sent, as a bad `PLUNE_SHARD` does. A 422 from the platform (other groups than the run's, past 25 combinations or 40 000 results to expect) is printed as it came, and the batch goes to the fallback file, whose line now records the combination. `plune run report` sends a batch with the combination its line recorded, and with none for a line that recorded none; it does not read `PLUNE_CONFIGURATION`, so a replay in another cell of the matrix cannot move results into its own, and a typo in the variable there does not stop it. Needs a platform that takes `configuration` on `POST /v1/runs/:id/results` (plune-ai/plune#2131, release 0.1.50).
- **`plune ingest` shows up in the platform's job queue (plune-ai/plune#2047).** A long import from Cairn used to leave no trace in the queue, so an import that died half-way was noticed late. Now an ingest opens a job of kind `ingest` once the run reads cleanly, sized by the cases it sends (`0 / N`), reports the upload through `PATCH /v1/jobs/:id/progress` with the run the import landed in as the job's `subjectId`, so the run's page lists it, and ends it completed, or failed with the line the CLI prints. As with `plune sync`: an older platform without `POST /v1/jobs` is not told, a job report never fails the ingest or changes its exit code, and when the ingest goes through, a report the platform did not take is said once on stderr (`plune: could not report this ingest to the job queue (…)`). Naming the run needs a platform that takes `subjectId` in a progress report (beta 0.1.45 and later); an older one refuses that one report, which is said on stderr, and the job still ends.

## [0.30.2] - 2026-10-25

### Fixed

- **`plune sync` shows up in the platform's job queue (#139).** 0.30.0 and 0.30.1 promised a job for every sync, but the platform answered the very first request with 400, so no job ever opened and the sync went on without one, silently. The CLI sent `progress: 0` where the platform takes `{ done, total }` or nothing, updated the job through `PATCH /v1/jobs/:id`, which does not exist, and named the kind `cli-sync`, which the queue panel has no words for. Now a sync opens a job of kind `sync` with the run's rows as its size (none while the run has no rows, never `0 / 0`), reports the upload through `PATCH /v1/jobs/:id/progress` with the run id as the cursor, and ends it through `PATCH /v1/jobs/:id/state`: completed, or failed with the error text. A job report still never fails the sync or changes its exit code, but when the sync itself goes through, a job report the platform did not take is now said once on stderr (`plune: could not report this sync to the job queue (…)`); an older platform without the route is still not told. The tests now hold the requests to the platform's own job schemas instead of a fake server that took anything.

## [0.30.1] - 2026-10-24

Also `@plune-ai/playwright` **0.6.0** - the adapter embeds `reporter-core`, and its last release, 0.5.0,
went out with 0.17.0. The reporter changes listed from 0.18.0 on reach the adapter only with this version,
the fix below included.

### Fixed

- **A run whose list of expected tests is too large no longer loses its results (plune-ai/plune#1949).** When the platform answers the start of a run with 413 (the run's configuration is over the 1 MiB a run keeps, or the request over its body limit), the reporter starts the run again without `configuration` and says so. The results land as before; that run has no not-run count and no full-run claim (`PLUNE_FULL_RUN`), since both travel with the list. Before, the refused start sent every result of the run to the fallback file, which a CI job deletes with itself. Any other refusal of the start behaves as before. Applies to `plune run import` and the Playwright reporter, the two that send a list; `plune run start` and `plune run exec` start a run without one.

## [0.30.0] - 2026-10-22

### Added

- **`plune sync` reports itself as a job (plune-ai/plune#1769).** Against a platform that has `POST /v1/jobs`, a sync opens a job of kind `cli-sync` named after the project directory (or the `--file` name), reports progress with the run id as the cursor once the upload is in, and finishes it, as failed with the error text when the sync fails. A platform that answers 404 or 405 for the route, or any error on a job report, changes nothing: the sync runs as before and its exit code is the same. The request shapes for updating and finishing a job are not confirmed against a real platform.

## [0.29.0] - 2026-10-22

### Added

- **`plune requirements links <file.md>` (plune-ai/plune#1608).** Imports a traceability matrix (requirement key to test) as links between requirements and cases. No flags lists the tables; `--table <n> --requirement-column <header> --test-column <header>` is a dry run until `--yes`, with `--separator` (1 to 3 characters, default `,`) for several keys in one cell and `--project`. The report lists links to make, links already there and every unmatched key or test with its reason; `--json` prints the platform's answer, `--fail-on-unmatched` exits `1` on any unmatched row. Same errors and exit codes as `requirements import`. Not run against a real platform.
- **`errorContextOmitted` when the reporter cuts an error text (plune-ai/plune#1281).** An error text over the 512 KiB transport limit is cut by whole lines, with `…[omitted N lines]…` where they were. Now the result also carries `errorContextOmitted`: how many characters that cut took out (counted in characters, not bytes, the marker not included). The platform keeps it as `errorContextMeta.omittedByReporter` and ends Copy prompt with `[truncated by the reporter: N characters omitted]`. The key is left out when nothing was cut, never 0. Applies to `plune run import` (Playwright JSON, Allure) and the Playwright reporter; JUnit text is not cut by the CLI.
- **`plune ids [--write]` (plune-ai/plune#1291).** Writes the Plune case id of each Playwright test that names none into `plune/ids.json` (`{ "<path-title>": "<case id>" }`), not into your test files. A dry run unless `--write`. Only tests whose case Plune holds get an entry; entries are only added (never overwritten or removed), the file is sorted, a rerun writes nothing, and a broken mapfile is refused with exit `2`. The Playwright reporter reads the mapfile: an entry names the case after the `PluneId` annotation, `@P<id>` and a metadata attachment and before the `playwright-id` and `path-title` keys, so a renamed test keeps its case. The path is `plune/ids.json` under the directory the run starts in, or `PLUNE_IDS_FILE` / the `idsFile` reporter option; a missing file changes nothing, an invalid one is warned about once and ignored.

## [0.28.0] - 2026-10-22

### Added

- **`plune run start --name` and `plune run exec --name` (plune-ai/plune#1715).** Same as `plune run import --name`: the text is the run's title and wins over `PLUNE_RUN_TITLE`; without it the name is what it was. For `exec`, the reporter inside the command joins the run and keeps that title.
- **`plune verify` (plune-ai/plune#1291).** Compares the project's automated cases with the Playwright tests in the code and prints both sides of the drift: cases the code no longer has (already `detached`, or one a full run would detach) and tests with no case yet. A test is matched by the id it names (`PluneId` annotation or `@P<id>`), else by its `path-title` key. Read-only: nothing is written to the platform or to your source. `--from <file>` takes a saved `playwright test --list --reporter=json`, `--fail-on-drift` exits 1 on any difference. Playwright only; writing ids back into the source is not part of this.
- **`plune run import --name <text>` (plune-ai/plune#1715).** Names the run in the list; before, every import was called after the current folder and two imports from one folder could not be told apart. Without the flag the name is what it was (`PLUNE_RUN_TITLE`, then folder, time and where it ran). Renaming runs already created is not part of this.
- **`plune run --cache-strict` and `--cache-max-age` (plune-ai/plune#1696).** `--cache-strict` answers every row from the cache and never calls the model for a completion (judge assertions still do); a row with no entry ends the run with exit code `5` and a list of those rows (`--no-cache` with it, or with `--cache-max-age`, is exit `2`). `--cache-max-age 12h` (also `90s`, `15m`, `7d`) opens the existing expiry. The console report and `summary.cache` in the JSON now say how many rows came from the cache, from the model, or had no entry, and the tokens and cost the cache saved.

### Changed

- **`better-sqlite3` is an optional dependency (plune-ai/plune#1716).** When its prebuilt binary cannot be fetched and the machine has no compiler, `npm i -g @plune-ai/cli` used to stop on the node-gyp build; now npm skips the module, the install succeeds, and `plune run` prints `completion cache disabled` and runs with the cache off. README lists the install requirements and the rebuild step.
- **The completion cache keeps only usable answers (plune-ai/plune#1696).** An empty answer, one cut off by the token limit, one carrying a provider error, or one without the format the eval expects (JSON for `json-schema`) is no longer stored; a stored answer that no longer has that format is deleted and the model is asked once in the same run. `CACHE_POLICY_VERSION` is now part of the cache key, so raising it makes older entries unreachable (the run reports `cache policy changed, N entries are stale` once). Entries written by 0.27.0 and earlier are dropped on the first run.

## [0.27.0] - 2026-10-18

### Added

- **`plune run import` has a time limit of its own (plune-ai/plune#1473).** The whole import gives up after 600 s by default (`--timeout <seconds>` or `PLUNE_IMPORT_TIMEOUT`, the flag wins; `0` turns the limit off). Before, a platform that stopped answering kept the command waiting until CI killed the job, and the run it had opened stayed in progress. On a timeout the command tries to send `terminate` for the run it opened (waiting up to 15 s for it), prints one line that says the platform may have received part of the results and whether the run was terminated, and exits 1. A run shared with other jobs (`--key` with `PLUNE_SHARD`, `PLUNE_PROCEED` or `PLUNE_SHARED_RUN`) is left open and named; if the run was never started the line says its id is not known. Not run against a real platform.

## [0.26.0] - 2026-10-18

### Added

- **`plune requirements import` maps several tables in one run (plune-ai/plune#1624).** Repeat `--table "<n>:key=ID,text=Requirement,fixed-category=functional"`, each with its own columns (`key`, `title`/`text`, `description`, `priority`, `category`, `type`, `status`, `criteria`, `fixed-category`, `fixed-type`); the request carries them as `tables`, and `--map-priority`, `--type` and `--map-category` are shared. `--table 0 --key-column ...` works as before; the two forms are not mixed (exit 2). The plan names the table of each row, shows the new skip reasons (`template placeholder`, `first on line N, again on line M`), and says `this file is an empty template` when the platform reports one (exit 0, like any skipped row). Not run against a real platform.

### Changed

- **Faster result upload (plune-ai/plune#1393).** Result batches of one run go four at a time (the first alone, so a refused token or a closed run is met by one request), over reused connections; the default batch is still 500, so 7 000 results are 14 requests, not 70. Ordering is kept: the run starts before the first result and closes after the last is answered; a failed batch still goes to the fallback file. Gain estimated from measured round trips, not measured on a real platform.

## [0.25.0] - 2026-10-17

### Added

- **`plune requirements import <file.md>` (#113, plune-ai/plune#1594).** Requirements from a Markdown file, in the two steps of the
  platform's import (plune-ai/plune#1621). With no mapping flags it lists the tables and sections the file has (and which look like
  requirements) and exits 0; `--table <n>` with `--key-column`, `--title-column` or `--text-column`, `--description-column`,
  `--priority-column`, `--category-column`, `--type-column`, `--status-column`, `--criteria-column`, `--map-priority`, `--map-category`,
  or `--sections <heading|n>` with `--unit`, `--key-prefix`, `--priority-from`, runs a **dry run** (`create 3 · update 0 · unchanged 12 ·
  skip 1`, the rows by action with line and reason, the value tables, what was not imported); `--yes` writes it, `--json` prints the raw
  answer. Impossible flag combinations and a file over 1 MiB are refused before any request (exit 2); a platform without the routes gets
  one message ("This platform does not support requirements import yet") instead of a stack trace. `--project <id>` / `PLUNE_PROJECT`
  names the project when the account has several. Not run against a platform that has the routes (not deployed yet).
- **`PLUNE_SHARD=k/N` closes a sharded run by itself (#110).** A shard that sets it uploads as before, then sends
  `{"event":"finish","shardIndex":k,"shardsExpected":N}`; the platform (plune-ai/plune#1601) closes the run when N distinct shards have
  reported. It implies `PLUNE_SHARED_RUN`. The job prints `plune: shard k of N done — R of N shards reported` as its last line and
  `plune: run closed` when it was the Nth; exit codes do not depend on the counts, and `--fail-on-failures` gates on the summary the closing
  shard receives. A value that is not `k/N` with `1 <= k <= N <= 1000`, or a different N than the run already holds (409
  `shards_mismatch`), is a configuration error and fails. A platform without the feature (400, or an answer without counts) gets one
  warning and the run is left open as before. Unset: nothing changes. The Playwright reporter honours it too. Not run against a
  platform that has the feature (not deployed yet).

### Changed

- **A trusted source's first import records the results of the cases it creates (plune-ai/plune#1581).** `plune run import --create`
  (and the reporters, with offering on) created the cases of a trusted source but sent nothing for them, so the run showed zeros and
  the new cases had empty histories until a second import. When the platform answers `created` with the new case's `id`, the result of
  that test now goes to the same run, files included, and the summary reads `3 added as cases (trusted source) and their results
  recorded`. A result that cannot be delivered goes to the fallback file like any other. A platform that returns no `id` behaves and
  reads as before. `queued`, `duplicate`, `refused` and `known` tests are never resent. Needs the platform half of the same issue.
- **Files are uploaded 16 at once by default, not 4 (#81).** The bulk routes of 0.23.0 took the announce and confirm steps off the
  per-file path, but the PUTs of the bytes to the bucket (and every call of the one-by-one fallback) still waited in a pool of 4,
  so 1 280 screenshots stayed bound by the round trip. The platform limits do not bind there: the bulk routes allow 120 requests
  and 6 000 files a minute per user, and the bytes go to the customer's bucket. `PLUNE_UPLOAD_CONCURRENCY` and
  `--upload-concurrency` still set 1 to 32 (the flag wins); a 429 still waits out its `Retry-After` for every request of the
  import, so a platform that pushes back is not hammered harder. The files line now reads `(16 at once, ...)`. Not measured
  against the real platform.

### Fixed

- **A quota 429 is told by the `quota` object in the body, not by a missing `Retry-After` (#111).** plune-ai/plune#1599 adds
  `Retry-After` to the quota 429 that has a reset time (the daily runs quota); the CLI would have read it as a throttle, waited
  and retried for nothing. A 429 whose JSON body has a `quota` object now stops at once, with the exit code as before, and the
  message names the limit: `quota exceeded (runs: 50 of 50 used, resets 2026-10-18T00:00:00.000Z) — <server words>`. A 429
  with `Retry-After` and no `quota` is still a throttle (waited, capped at 60 s, retried); a 429 with neither is still read as a
  quota, so an older platform behaves as before. A 429 whose body is not JSON does not crash. Release this before or together
  with the platform change.

## [0.24.0] - 2026-10-16

### Added

- **`plune sync` sends `Idempotency-Key` on `POST /v1/runs`.** The key is the SHA-256 (hex) of the exact request body, so
  repeating an upload whose answer was lost gives the same run instead of a second one, and other content gets another
  key. A repeat answered `200` is a success with the same result as a fresh upload; `422` (the key was used with another
  body) and `409` (its run is in the Bin) are reported as errors. A server that does not know the header ignores it.

### Changed

- **`plune run import` says why tests wait and how to skip it.** After `--create` on a source the project does not trust,
  the line "N unknown test(s) offered to the review queue" now adds that they wait there for a decision and do not count
  on the run until approved, and names the source to add under Settings → Trusted sources (`junit`, `allure` or
  `playwright`). Before, the run showed zeros with no explanation and the field there gives no hint of the name.

## [0.23.0] - 2026-10-15

### Changed

- **`plune run import` (and the Playwright reporter) upload a report's files through the bulk routes of the platform.** Up to
  100 files go in one `uploads-batch` request with the SHA-256 of each (read as a stream), the bytes go to the bucket as before
  (or through `direct-batch` for a project without one), and `complete-batch` confirms them. Each file has its own verdict: a
  refused one is reported and retried alone, the rest of its request is not affected, and a file the platform already has is
  `exists` and is not sent again. A 429 on a request waits out its `Retry-After`. Against a platform without the bulk routes
  (404) the CLI falls back to one request per file, decided by the answer. The files line gains `N already there (skipped)` and
  the number of requests made to Plune. On a local fake server with 20 ms per request, 2760 files of 70 KB took 5522 requests
  and 65 s one by one, and 56 requests and 24 s in batches; the real server has not been measured.

## [0.22.0] - 2026-10-15

### Added

- **`PLUNE_UPLOAD_CONCURRENCY` and `--upload-concurrency` for `plune run import`.** Files in flight at once were fixed at 4;
  with a round trip above ~160 ms a report of thousands of screenshots is bound by that, not by bandwidth. The variable (and
  the flag, which wins) takes 1 to 32, default 4; anything else is ignored with a warning. The Playwright reporter reads
  the variable too.
- **`PLUNE_UPLOAD_RETRIES`** (0 to 20, default 6, was 2): how often a file's request is retried after a 429 with a `Retry-After`.
  The header is read as seconds or an HTTP date and capped at 60 s; the wait gets up to 50 % jitter, and every other request
  of the process waits through the same pause instead of finding the limit for itself. A 429 with no `Retry-After` is still
  the quota and is not retried; a platform that is down is still tried twice (three times for a bucket).
- **A line about the files before the summary**: `plune: files — N uploaded, N skipped, N retried, N dropped, in 41.2 s (16 at once)`.
  A dropped file is still reported without its file and still does not change the exit code; it is now counted.

### Changed

- **Results go in batches of 500, not 100 (plune-ai/plune#1393).** The platform's ceiling per request is 500 and the 8 MiB
  byte packing of a call is unchanged, so a run of 7 000 results is 14 requests instead of 70 (about 2.3 times faster per
  result against a local platform; the time on a real network is not measured). `PLUNE_BATCH_SIZE` still sets it, up to 500.
  The "N of M results sent" line only appears for a run larger than one batch, so it now starts at 501 results (it did at
  101); `PLUNE_BATCH_SIZE=100` keeps the old cadence.

## [0.21.0] - 2026-10-13

### Added

- **`plune run grep <run>`: a run's automated cases as one `--grep` (#85).** The command Plune shows for an
  automated run's «Re-run N failed» — `npx playwright test --grep "$(plune run grep <run-id> --failed)"` — and the
  one for a mixed run launched without a plan — `PLUNE_RUN=<key> npx playwright test --grep "$(plune run grep <key>)"`
  — now work as they are. The pattern is built as `plune plan grep` builds a plan's (the same `grepFragment`, joined
  with `|`, `(?!)` when nothing is taken), from `GET /v1/runs/:id/cases`: what the run expected or holds a result of,
  manual cases left out. `<run>` is the run's id or its key (`rk_` and ten hex, found with `GET /v1/runs?key=`);
  anything else is refused with exit 2 before a request is sent, and a key no run carries exits 1. `--failed` asks
  the platform for the cases whose latest result it counts as failed or broken (`?status=failed,broken`), so a muted
  case's failure is left out by the platform's rule, not by a copy of it in the CLI. stderr says how many cases were
  taken and how many left out. Needs a Plune with plune-ai/plune#1333; an older one answers 404.

## [0.20.0] - 2026-10-13

### Changed

- **`plune ingest`: a Cairn case whose request got no answer arrives as `blocked` (plune-ai/plune#1327).** Cairn's
  API evidence records a transport error when a request gets no response after the retries; the case used to be
  sent as `failed`, blaming the product for an unreachable target. It now carries the verdict `blocked`, so the
  platform records a `blocked` result. Needs a Plune that accepts the verdict (plune-ai/plune#1330); an older one
  refuses the whole ingest with a validation error.

## [0.19.0] - 2026-10-12

### Added

- **`--fail-on-failures`: a release gate that honours mute (plune-ai/plune#1247).** `plune run finish`,
  `plune run exec`, `plune run import` and `plune sync` take the flag, and the exit code is then the
  platform's verdict on the run rather than the runner's. The run commands read the summary the platform
  freezes at `finish`, which the `finish` event already answers with (the CLI used to throw it away); `sync`
  reads it with one `GET /v1/runs/:id/summary` after the upload. The platform counts a muted case's
  `failed` or `broken` under `muted`, so a mute set in Plune keeps the gate green without the CLI holding a
  muted flag of its own. Exit 1 on `failed + broken > 0` and on any expected case that never reported
  (`notRun`); `blocked` and `skipped` do not fail it; exit 1 when there is no verdict at all (the platform
  could not be reached, the finish was refused, the run was left open or terminated). `run exec` keeps the
  command's own exit code when no result reached the run and nothing was expected of it. A second
  `plune run finish` on a finished run is not refused by the platform: it answers with the summary frozen
  the first time, so the gate reads the same verdict. Without the flag every command exits as before, and
  `plune run` (local evals) does not change. `RunSession.finish()` in `@plune-ai/cli/reporter-core` now
  resolves to that frozen summary (`FrozenSummary`), or `undefined` when the platform answered with none.

## [0.18.0] - 2026-10-12

### Fixed

- **The run key in the docs and the reporter examples carries the attempt (cli#78).** GitHub Actions'
  "Re-run failed jobs" reuses `GITHUB_RUN_ID` and increments `GITHUB_RUN_ATTEMPT`. A key built from the
  run id alone sent the second attempt at a run that is already closed, so the platform took none of its
  results and they stayed on the runner in `.plune/pending-results.jsonl`. `README.md`,
  `packages/playwright/README.md` and the `plune run` examples now use
  `"$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"` (the Playwright option reads
  `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`), and the note in
  `docs/guide/cli.md` says what actually happens without it, instead of claiming the re-run would
  overwrite the original run's results.
- **The quota detail no longer carries the raw token (cli#79).** A 429 without `Retry-After` is
  classified as `invalid` and reported as `quota exceeded (no Retry-After)` with the server's own words
  appended — but they were appended raw, while the same response's text one line above went through
  `scrub()`. A proxy or a gateway that echoes the bearer token back in an error page put it into a CI
  log anyone with read access can scroll. The appended text is scrubbed now, and a test holds it there.
- **A deleted run is recoverable for 30 days, and only an owner of the project can bring it back
  (cli#80).** The server keeps it for 30 days, not six months, and the way back is Settings → Bin
  rather than a request to Plune. `plune run delete` prints the sentence the platform's own dialogs
  use, its `--help` description and the `README.md` command table say 30 days, and the command's
  comment no longer speaks of six months.

### Changed

- **The run summary counts `blocked` and `skipped` apart from `failed` (plune-ai/plune#1245).** A row
  that reports `inconclusive` (ADR 0045) now counts by that word, not by its assertions or its error:
  a blocked row whose assertions failed is `blocked`, not `failed`, and a skipped row with an error is
  `skipped`, not `errored`. This is the order the platform already uses when it stores the row. **The
  numbers change** for any run with such rows: `failed` and `errored` go down, `blocked` and `skipped`
  go up, and `passed + failed + errored + blocked + skipped` is `total`. Runs without `inconclusive`
  rows count exactly as before. `Summary.blocked` and `Summary.skipped` are optional in the contract, so
  a RunResult written before them still validates and `schemaVersion` stays 1; `plune run` always
  writes both. The console line and the markdown table show them only when they are not zero, so an
  all-pass report reads as it did. The summary, both reporters and `plune diff` now share one
  classifier instead of three copies, so a blocked row cannot become a regression in the diff either.
  Exit codes are unchanged: only `failed` (1) and `errored` (2) move them. `invalid` is not added; it
  is Plune's `broken`, which the CLI calls `errored`.

## [0.17.1] - 2026-10-12

### Added

- **is_flaky / is_muted flags for TestCase contract (plune#1246, PR #88).** Adds two optional fields to the `TestCase` schema:
  - `is_flaky` — assertion about a case: "this test is unstable by nature" (diagnostics).
  - `is_muted` — human decision: "we execute and record it, but it does not count toward the run summary" (policy).
  Both are purely additive: a producer that does not send them validates exactly as before, so `schemaVersion` stays at 2.
  The platform already validates these fields on `POST /v1/test-cases` (plune#1246, ADR 0045).
- **A result row can say the product was never judged (`inconclusive`) (plune-ai/plune#1244, ADR 0045).**
  `RowResult.inconclusive?: 'blocked' | 'skipped'` — optional and purely additive, so a runner that
  does not send it validates exactly as before and `schemaVersion` stays 1. Until now a row stopped
  by a dependency or an environment had exactly one word available to it, `failed`, and the word was
  wrong: a red build because something fell over reads identically to a red build because the code
  is broken, and those are two different pieces of work. The Plune platform already validates the
  field on `POST /v1/runs`; this is the producer's half of the same contract. `invalid` is
  deliberately not accepted — Qase's `invalid` is Plune's `broken`, and a second word for one idea
  would fork the contract at both ends.
- **`plune run import <folder>` reads an Allure `allure-results` folder (plune-ai/plune#1221).** One reader for
  every Allure adapter (pytest, JUnit 5, TestNG, Playwright, Cypress, Jest, Vitest, WebdriverIO, .NET): each
  `*-result.json` is a test with its status (`passed`, `failed`, `broken`, `skipped`, sent as written), time,
  failure message and trace, and steps; `*-container.json` names the suite. The files in `attachments[]` of the
  test, of its steps and of its fixtures go the path a JUnit file does, with the `type` from the JSON or the
  extension; a `source` is checked and read by the same code as a JUnit `[[ATTACHMENT|path]]`, so a missing one
  is listed and counted and `--fail-on-missing-attachments` applies, and one outside the folder is refused. The
  same test run again (same `historyId`) is one test with attempts, the last to stop counting. A folder with no
  `*-result.json` exits 2 with a message. A file keeps the name the adapter gave it (`after add`) with the
  extension of the real file when the name has none (`after add.png`); a results folder reached through a link
  works as a JUnit report's does. Only regular files named `*-result.json` and `*-container.json` are read, none over
  64 MB; a file in a shape nobody wrote ends the import with exit 2 and its name, never a stack trace; at most 100
  files of one test are read, as for JUnit. This is how Jest gets files per test, which `jest-junit` cannot give.
- **Trace, video, screenshots and text go to the project's bucket (plune-ai/plune#946).** When the project has
  a storage bucket connected, every file an attempt kept is uploaded straight to it over short-lived links
  Plune hands out per file: streamed from disk, four at a time, retried on network failures, 5xx and 429, with one
  new link on a 403. The links are never printed; a warning names the file and a code, and never fails the import.
  The run says once that the bucket was found, and the summary reads `N file(s) uploaded to your bucket`.
  Without a bucket nothing changes for screenshots and text; a trace or a video is counted as not stored.
- **`plune run import` of a JUnit report sends the files its tests announce (plune-ai/plune#1220).** A test that
  prints `[[ATTACHMENT|path]]` on a line of its own to `system-out` or `system-err` (pytest, Maven Surefire, Vitest,
  PHPUnit, .NET's JunitXml.TestLogger and Cypress's `mocha-junit-reporter` all carry it into the report) has that
  file uploaded to its result by the path the Playwright reporter's files take: the project's bucket, the
  platform's own route for a picture or a text, a skip otherwise. Any extension; a relative path counts from the
  folder of the report. A file that is not there never fails the import: each gets a line with the test and the
  path from the report, always, and the output ends with `Imported N results · M files uploaded · K files not found`.
  `--fail-on-missing-attachments` turns K > 0 into exit code 1, after every result is sent. A path that leaves the
  folder of the report, by `..`, an absolute path or a link, is refused with the same line and never read (a report
  reached through a link may name its files by the folder's real path). Test names and paths from the report are
  printed without control characters. Output
  `jest-junit` writes once per suite names no test, so nothing is read from it.

### Changed

- `plune run import` no longer prints its own screenshot and text-file count lines; the session's summary line
  carries them.

## [0.17.0] - 2026-09-30

Also `@plune-ai/playwright` **0.5.0** - the adapter embeds `reporter-core`, where the upload of a result's
text files lives, and it now hands the core the bytes of an attachment kept as a `body`. Plune's dashboard
opens what is uploaded in the result's panel (plune-ai/plune#981); a platform that does not keep text files
refuses them, and the results arrive as before.

### Added

- **A test's JSON and text files reach Plune with their results (plune-ai/plune#928).** When
  `@plune-ai/playwright` reports a run, or `plune run import` reads a Playwright JSON report, what each
  attempt attached as `application/json` or `text/plain` — a log is `text/plain` — is uploaded to its
  result once the platform has stored it, as the screenshots are: a passed test's as well as a failed
  one's, every upload answered before the run is closed. Both ways of attaching are read: by `path`
  (`testInfo.attach('server.log', { path })`) and as a `body`
  (`testInfo.attach('api-response', { body: JSON.stringify(data), contentType: 'application/json' })`),
  which leaves no file — the reporter hands the core the bytes Playwright gives it, and the import
  decodes the report's base64. Up to 512 KiB a file and 10 a result, apart from the screenshots' 20.
  The type is the attachment's, in any case and with any parameters (`Text/Plain; charset=UTF-8`); it is
  not guessed from a file's extension, so an attachment that names none is not sent. A charset goes to
  the platform only when it is UTF-8, the one it takes, and the bytes are checked as UTF-8 before
  they leave. Markdown, HTML, CSV, XML, traces and videos are not uploaded, nor is an image attached as
  a `body`. The name is the attachment's, cut to the 200 characters the platform takes, and the
  extension of its file follows a name that has none of its own — `testInfo.attach('api-response', { path })`
  arrives as `api-response.json`; a body goes by its name as it is. Nothing is cleaned or cut on this
  side: the platform cleans a text before it keeps it. Needs a platform that keeps text files
  (plune-ai/plune#928); with an older one each is refused, counted, and said once.
- **What stays behind is counted, and costs nothing else.** A text over 512 KiB, one that is not UTF-8 or
  holds a NUL byte, an empty one, one past the 10th of its result, one named with a leading `_` (hidden in
  Playwright's own reports too) or not on this machine is skipped, with one line for each reason —
  `plune: text file "…" not uploaded — …`; one the platform refuses is counted, with one line for the
  first. Neither costs a result or changes an exit code. The summary says it:
  `plune: 12 accepted · 10 screenshot(s) uploaded · 3 text file(s) uploaded, 1 skipped`, and
  `plune run import` prints `3 text file(s) uploaded to their results, 1 skipped.` after the
  screenshots' line, which is unchanged, and nothing for a report with no text files.
  `RunStats.textFiles` and the import's result carry the three numbers, apart from `screenshots`.
- **A text attached as a `body` is never written to the fallback file.** It exists only in memory, and
  JSON would write it as one number for every byte: `.plune/pending-results.jsonl` keeps what it kept
  before and no bytes of a body, so a result sent again with `plune run report` goes without it. The files
  it names by path are uploaded then if they are still on disk, as before.
- **`filesOf` in `@plune-ai/cli/reporter-core` also hands over a JSON or a text kept as a `body`.**
  `ResultFile.path` is optional now and `ResultFile.body` holds the bytes; an image, a trace or a page
  kept as a body is not handed over.

## [0.16.0] - 2026-09-30

Also `@plune-ai/playwright` **0.4.0** - the adapter embeds `reporter-core`, where the commit and the branch,
the reason an offer was refused and the marker that ties a replayed run together live. A run panel shows
the commit and the branch only on a platform that hands them out (plune-ai/plune#964); on an older one
the results arrive as before and the panel shows none.

### Added

- **`plune run import` reads a `@P<id>` in a JUnit test's name as the case the test is (#38).** The
  token ADR 0023 fixed — read by `@plune-ai/playwright` and by the Playwright JSON import — was ignored
  on the JUnit road, so a renamed or moved test was offered as new while the case it used to be kept
  the history. Now the same `@P<id>` in a test's name is that result's case. The key stays as the name
  gives it: the token is not stripped, as the adapter does not strip it. In Playwright's own JUnit
  report the token is read from the test's own title, not from the `describe` titles around it, as the
  reporter reads it; from any other runner's report it is read from the whole name, which is all that
  report holds.

- **A run says where it ran: the commit and the branch (plune-ai/plune#927).** `@plune-ai/playwright` and
  `plune run import` open the run with `meta.sha` and `meta.branch` beside the `runner` and `ciUrl` they
  already sent, so the platform's run panel has something to show; until now no client sent either.
  - The reporter takes the commit from `metadata.ci.commitHash`, which Playwright writes itself, and the
    branch from `metadata.ci.branch` (GitLab, Jenkins). Playwright gives no branch on GitHub Actions, so
    there it is `GITHUB_HEAD_REF` — the pull request's own branch — and, when that is empty, as on a
    push, `GITHUB_REF_NAME`.
  - `plune run import` reads the same from the job's variables: `GITHUB_SHA`; `CI_COMMIT_SHA` and
    `CI_COMMIT_REF_NAME`; `GIT_COMMIT` and `GIT_BRANCH` — each set only where its CI is recognised
    (`GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`), so a stray `GIT_COMMIT` on a laptop is no commit. A
    Playwright JSON report that names a commit gives that one, as it gives the CI run: whoever imports
    may be another job, and its branch is not that commit's — so such a report gets its own commit and
    no branch of the importing job's.
  - Outside a CI both are absent: nothing is guessed. On GitHub a pull request's commit is the one
    GitHub merged for the checks (`GITHUB_SHA`), which is what the tests ran on.
  - A batch the platform did not take now records the run's `meta` on its line of
    `.plune/pending-results.jsonl`, and `plune run report` opens the run it has to make with it — the
    replayed run keeps its commit, branch, CI link and runner, and takes nothing from the machine that
    replays. A line written before this has none, and gets none.
  - `ciCommit(reported?, env?)` is exported from `@plune-ai/cli/reporter-core` for an adapter that reads
    its runner's record of the CI.

### Changed

- **Every command reads `.env`, not only `run` and `report` (#46).** `plune run import`, `run start`,
  `run finish`, `run exec`, `run delete`, `run report`, `sync`, `ingest`, `pull`, `push`, `plan grep`
  and `login` never looked at a `.env`, so a `PLUNE_TOKEN` or `PLUNE_API_URL` written in one did not
  exist for them — the demo project wrapped every script in `NODE_OPTIONS=--require=dotenv/config` to
  get what `run` already had. There is one rule now, in the program and not in each command: the
  `.env` beside the config named with `-c`, then the one in the current directory, are read before
  the command looks at the environment. What is already exported wins over both files, and the
  config's file wins over the directory's. With `-c`, `run` and `report` read the current directory's
  file as well, where they read only the config's. The README says it in one paragraph.

- **`plune init` starts a project on a current model, and the run prices it (#48).** The template and
  the wizard offered `claude-3-5-sonnet-latest` and `claude-3-opus` — an alias for a model Anthropic
  has retired, and an id the API never had — and the price table stopped at those and `gpt-4o`, so a
  project on any current model read `cost_usd = 0` and a warning per call. `plune init` now writes
  `claude-sonnet-5-5` (the wizard offers OpenAI users `gpt-4o-mini`), and the table prices
  `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5` (and its dated id)
  and OpenAI's `gpt-6-astra`, `gpt-6.1-sol` and `gpt-6-luna`, with the source and the date beside
  them. The older ids keep their rows. The README example is on a current model, and the README says
  to leave `temperature` out for Claude models released after Opus 4.6.

### Fixed

- **`plune run --dry-run` needs no provider key (#49).** A dry run only prices the run and never
  touches the network, but it built its provider the way a real run does, and the provider's
  constructor asks for a key: `Missing ANTHROPIC_API_KEY`, exit 2, from the command that is meant to
  cost nothing. It now runs on a provider that can only estimate, and prices each row for the model
  the config names — `pricing` in `plune.yaml` first, the built-in table second — exactly as a real
  run would. With `PLUNE_MOCK_PROVIDER=1` the mock still answers, at zero, as before.

- **A Playwright suite's own JUnit report is keyed the way the reporter keys it (#47).** Playwright's
  `junit` reporter writes the spec file's path in `classname`, in the OS's separators, and the
  `describe` titles and the test's, joined by ` › `, in `name`. Imported as `classname#name`, a test's key —
  `tests\cart.spec.ts#cart › adds an item` — never equalled the reporter's or the JSON import's
  `tests/cart.spec.ts#cart#adds an item`, so `--create` offered every test of the suite to the review
  queue a second time. A `classname` that ends in a spec file's name (`.spec` or `.test`, then a js or
  ts extension, as Playwright matches by default) now gives the key `file#describe#…#title`, the file
  with forward slashes on every OS. A suite that matches other file names, and any report whose
  `classname` is not a spec file's name, keeps `classname#name` as before. A case an earlier import
  created from such a report carries the old key, so its test is offered to the review queue once more;
  the reporter and the JSON import are not affected.

- **`plune run import --create` no longer says the review queue is full when something else refused
  the offer (plune-ai/cli#71).** The last line about tests that could not be offered was the same for
  every refusal, so under the platform's own line saying the project had reached its case limit it told
  people to approve or reject what was waiting — which frees nothing, since approving makes a case and
  the platform refuses that the same way. The core now records why an offer was refused, told apart by
  the platform's own words on a 429 (`RunStats.unofferedWhy`: `queue`, `cases` or `other`), and the line
  follows it: a full queue keeps its advice; the case limit says the project is at its test case limit,
  to delete cases or ask an operator to raise it; anything else — a throttle, an outage, a run that is
  not there — points at the `could not offer` line above and advises nothing.

- **`plune run report` opens one run for the batches of one reporter run, and sets the file aside once
  everything has been sent (plune-ai/cli#45).** It opened a run for every line of
  `.plune/pending-results.jsonl` whose results never reached one, and a run sent in batches is several
  lines — 24 tests at a batch of 10 came back as three runs, each holding a part of the results and none
  of them the run. Every line the reporter writes now carries a marker made once per reporter session,
  and the replay opens one run, and leaves it open, for the lines that share a marker. A file written
  before this has no markers and replays one run to a line, as it did. When every result has been sent
  the file is renamed to `pending-results.<time>.sent.jsonl` beside it, so that a second
  `plune run report` does not send them all again; it is not deleted. When anything did not go, the file
  stays exactly as it was.

## [0.15.0] - 2026-09-29

Also `@plune-ai/playwright` **0.3.0** - the adapter embeds `reporter-core`, where the upload below lives, and it
hands the core every attempt's files. Needs a platform that stores a result's files
(plune-ai/plune#915); with an older one the results arrive as before and the screenshots do not.

### Added

- **A Playwright run's screenshots reach Plune with their results (plune-ai/plune#913).** When
  `@plune-ai/playwright` reports a run, or `plune run import` reads a Playwright JSON report, the images
  each attempt kept as files are uploaded to its result once the platform has stored it — a passed
  test's as well as a failed one's — so a run in Plune shows every test with what it looked at. PNG,
  JPEG and WebP, up to 2 MB a file and 20 a result; the type is the attachment's, or the extension's
  when the attachment names none. Traces, videos and text files are not uploaded, nor is an image
  attached as a `body` rather than a file. A file goes by its attachment's name, with the file's
  extension when the name has no image extension of its own — `screenshot.png` for Playwright's
  `screenshot` option, `03-results.png` for `testInfo.attach('03-results', { path })` — never by the
  copy Playwright saves as `03-results-<sha1>.png`, never by a path (a name that is one keeps its last
  segment), and cut to the 200 characters the platform takes, the extension kept. The files never ride
  in a results batch, and a result the platform already had (`duplicate`) is not sent its files again.
  Every upload is answered before the run is closed — the platform takes no file on a closed run —
  four at a time, and a 429 waits out its `Retry-After` as every other call does.
- **What stays behind is counted, and costs nothing else.** A screenshot over 2 MB, of another image
  type, past the 20th, named with a leading `_` (hidden in Playwright's own reports too) or not on this
  machine — a report copied from the job that wrote it — is skipped, with one line per reason; one the
  platform refuses is counted, with one line for the first. Neither costs a result or changes an exit
  code. The summary says it: `plune: 12 accepted · 10 screenshot(s) uploaded, 2 skipped`, and
  `plune run import` prints `10 screenshot(s) uploaded to their results, 2 skipped.` after its `Read …`
  line, which is unchanged, and nothing for a report with no screenshots. `RunStats.screenshots` and
  the import's result carry the three numbers.
- **`filesOf` in `@plune-ai/cli/reporter-core`**, beside `failureOf`: the files one attempt kept, for
  `PendingResult.files` — how both roads hand them to the core. The core never sends that field; it
  reads the files from disk as it uploads them. The client `createClient` returns gains
  `upload(path, bytes, contentType)`: the bytes as the body, through the same retries as `post`.

## [0.14.3] - 2026-09-28

The adapter `@plune-ai/playwright` stays at **0.2.8**: nothing below is in the part it embeds.

### Changed

- **Where to get a token says Account → API tokens (plune-ai/plune#868).** The dashboard moved API
  tokens out of a project's Settings into the person's account, where a token is minted for the
  project picked beside Generate. `plune login`'s description, the messages for a missing or rejected
  token and the README name the new place.

## [0.14.2] - 2026-09-24

Also `@plune-ai/playwright` **0.2.8** - the adapter embeds `reporter-core`, so every fix below reaches
it too.

### Fixed

- **An address whose host is named as the repository or the home folder is left alone
  (plune-ai/plune#790).** A posix root's leading slash matched as many slashes as there were, so it
  also took the `//` after a scheme: with the root `/app`, `http://app/login` — a compose service named
  after the image's `WORKDIR` — became `http:login`, and with the home `/root`, `http://root/x` became
  `http:~/x`. A posix path now starts with exactly one slash, escaped or not; a UNC path keeps both.
- **A path written with escaped slashes, as PHP's JSON writes them, reads like the plain one.** With no
  repository root — a report from another machine — `\/home\/bob\/…` kept the account's name; it is
  now `~\/…`. A file URL written that way lost the root but kept its `file:` (`file:e2e\/a.ts`); it now
  loses both.
- **A path in a webpack source map reads like a file URL's.** With the root known, `webpack:///…` lost
  the root but kept its `webpack:` (`webpack:src/Foo.tsx`); it now loses both. With no root, the home
  folder in such a path — `webpack:///home/bob/…`, `webpack-internal:///Users/carol/…` — kept the
  account's name; it is now `~`. Other schemes keep their `///`: `sqlite:///app/db.sqlite` is left alone.
- **An answer without the fields the core reads no longer throws.** A 2xx whose JSON lacks what the
  core reads threw out of it: the adapter said "reporting stopped" and `plune run import` ended
  non-zero. Now the lookup, the start, a batch and the offer read such an answer as that call failing,
  and a close answering `null` is taken as done:
  - the lookup without `results`, or a row without its key: it threw at the start or inside a flush,
    where the batch had already left the buffer, so its results were neither delivered nor deferred;
    they are now deferred;
  - the start without `run`: it threw in `startRun`; the results are now deferred;
  - a batch without `counts`, or with counts that hold no number: `null` threw inside the flush, and
    `{}` counted the batch as delivered with nothing accepted; the batch is now deferred;
  - the offer to the review queue (`--create`) without `results`: it threw from `finish`, and the run
    stayed open; the tests are now counted as not offered, and the run closes;
  - a close answering `null`: it threw from `finish`; the run is now taken as closed.

## [0.14.1] - 2026-09-24

Also `@plune-ai/playwright` **0.2.7** - the adapter embeds `reporter-core`, so every fix below reaches
it too, and it now closes the run only after every batch is answered.

### Fixed

- **`@plune-ai/playwright` closes the run only after every batch is answered (plune-ai/plune#790).**
  The adapter handed each result to the core without waiting for it, and the core sends a batch from
  inside that hand-over once enough results are buffered. So the run could be closed while batches were
  still in flight: the platform froze the run's never-run tests without them, refused the batches
  behind the close, and the summary counted only what had come back — in the AC-15 run, 60 of 100 were
  stored. A result the core refuses is now the one "reporting stopped" line instead of an unhandled
  rejection that ended the run with exit code 1.
- **A success the client cannot read is a batch not delivered.** A 2xx that is not JSON — a proxy's
  page — or one without counts threw out of the reporter and out of `plune run import`; the batch now
  goes to the fallback file and is named in the summary like any other refusal.
- **No path of the machine in the headline or in an attachment's name.** The headline was the error's
  first line as the runner wrote it, so a missing snapshot or a missing browser put the account's home
  folder on a page the whole project reads; it now goes through the same rewriting as the text. A first
  line over 8 KB is not sent as the headline at all (never cut): the platform keeps 300 characters of a
  headline, the line still travels in the text (unless the text is over 512 KB and the line over half
  of that, when the cut leaves it out), and the dashboard shows the text's first line instead.
  An attachment named by its path (`testInfo.attach(file, { path: file })`) is named by the file alone,
  and one with an empty content type goes without it — the platform refused the whole batch for it.
- **The repository and the home folder are rewritten only where a path starts.** A root of one segment
  such as `/app` also turned `http://localhost:3000/app/login` into `http://localhost:3000login`, and
  a home of `/root` did the same to an address ending in it. A Windows path printed with doubled
  backslashes — a string in a diff — is now rewritten too.
- **A CI link the platform would refuse is not sent.** `https:/host` and `https:host` passed as links
  because `new URL` mends them, and the platform refused the run's start for them — every result then
  went to the fallback file. A link now needs `http://` or `https://` as written.
- **The worst run arrives in at most ten calls whatever its texts hold.** The 512 KB limit on one
  failure text counted the text's raw bytes, while a batch is packed by the bytes of its JSON, where a
  quote, a backslash and a CR weigh two: a `toEqual` diff of a Windows path weighed a quarter more in
  the batch, and a hundred such failures took 12 calls instead of 10. The limit, and the 8 KB one on a
  headline, now count what the text weighs in the batch — a 40 KB first line also sent as the headline
  made a hundred results take 11.
- **A stack line cannot stall the runner or end the import.** A line over 8 192 characters is no longer
  read as a stack frame, where the pattern took time quadratic in its length on the runner's own thread,
  and a frame whose file URL has a broken escape is read as written instead of ending the report on a
  `URIError`.

## [0.14.0] - 2026-09-24

Also `@plune-ai/playwright` **0.2.6** - the adapter embeds `reporter-core`, where the failure detail
and the batches packed by bytes below live, and it sends the detail from the reporter API itself.
Needs a platform that stores the detail (plune-ai/plune#806, on the beta since 2026-09-24): an older
one drops the unknown field without a word.

### Added

- **The failure detail of a failed attempt — what failed, the declared steps down to it, where, what
  the runner kept, and the CI run (plune-ai/plune#790).** `failureOf` in `@plune-ai/cli/reporter-core`
  derives it from one normalized attempt, so `plune run import` and the reporter cannot disagree: the
  first non-empty line of the error (on a test timeout, the line of the action that was still waiting,
  not "Test timeout of N ms exceeded"), the chain of failed declared steps, the first stack frame in
  the test's own file as a posix path from the repository root (`repoRootOf` finds the root once per
  run; a file outside it, line 0 or a path the platform would refuse drops the place, not the batch),
  the names of the attachments kept as files, and the build link when it is http(s). Nothing is cut or
  searched for credentials here — the platform does both after its own cleaning. `errorContextOf`
  builds the text beside it: every error of the attempt in order, colour codes gone, the repository as
  relative paths and the home folder as `~` (any `/home/<u>`, `/Users/<u>` or `C:\Users\<u>` when the
  root is unknown, as for a report from another machine), and at most 512 KB — the CLI's transport
  limit, not a copy of the platform's 256 KB — cut by whole lines from the head and the tail around one
  `…[omitted N lines]…`, so a line longer than the limit never shows in part.

- **`plune run import` sends it for a Playwright JSON report, and opens the run with its CI run.**
  Each attempt of the report is reduced to the attempt the core reads — `errors[i]` as Playwright
  wrote them (the message, the code frame and the stack in one text, with where it was thrown), the
  declared steps, the attachments, `config.metadata.ci.buildHref` — so a failed attempt carries its
  `failure` and the text above; one that passed or was skipped carries none. The root comes from the
  report's `rootDir`, and only when that folder is on this machine: a report from somewhere else keeps
  its detail but names no place. The run opens with `meta.ciUrl` from the same `buildHref` — the CI
  run the report names, never this machine's `GITHUB_*` — and without a link at all when it is not an
  http(s) address, rather than being refused.

- **`@plune-ai/playwright` sends the same detail, from the reporter API.** Each attempt becomes the same
  normalized attempt: every error written as Playwright's own JSON report writes it (`formatError` with
  colours off — the stack's head, the code frame, the `at` lines, a cause), the declared steps kept by
  the report's own filter (`test.step` under `test.step` from the test body, so a step in a hook or a
  fixture and every action stay out of the chain), the attachments. The repository root is looked up
  once from `rootDir`; `metadata.ci` is read when the run opens, on the first result, because
  Playwright's git plugin writes it after `onConfigure`. A report of the same run imported with
  `plune run import` gives the same text and the same `failure`. Where an error carries no place, both
  roads take the first stack frame outside `node_modules`, as Playwright does.

### Changed

- **What was not delivered is said in the same words on both roads, every time.** `plune run import`'s
  summary line gains a fourth number, zero included: `Read 100 result(s) from a playwright-json
  report: 90 accepted, 0 already there, 2 unmatched, 8 not delivered.` — the results a refused batch or an
  unanswered lookup kept out of Plune. The `[0-9]+ unmatched` workflows read stays whole, and the line
  about the fallback file is unchanged. The reporter's own line says `… · 8 not delivered — written to
  .plune/pending-results.jsonl` where it said `8 written to …`. In GitHub Actions a count above zero
  also prints, once and on either road,
  `::warning::8 result(s) were not delivered to Plune — see the reporting step's log.`; no exit code
  changes.

### Fixed

- **A run whose failures carry long texts no longer loses them to one refused batch
  (plune-ai/plune#790).** Results went in batches by count alone, so fifty failures with 10 KB of text
  each were already over the route's ceiling: the batch was refused and written to the fallback file,
  which in CI goes with the runner. A batch is now at most `batchSize` results **and** at most 8 MiB of
  serialized JSON — under the 10 MiB the platform admits for it, the CLI's own number and not a copy of
  the platform's. An ordinary run still takes one call; 100 results of 256 KB take four. A result
  heavier than a batch goes alone. A refused batch costs only itself: the rest are still sent, and each
  batch left after a refused token goes to the fallback file on a line of its own, so
  `plune run report` sends it again in one call the route accepts.

- **`plune run import` reads a real Playwright JSON report without being told its format.** Detection
  looked for `"suites"` in the first 4 KB only, but Playwright writes `config` first — argv, every
  project, each reporter's options, the CI metadata — and a report of a pinned 1.63 run put it past
  7 KB: the import refused a report it reads fine. The whole file is searched now.

- **`plune run import <file> --format <fmt>` uses the format it is given.** `plune run` has a
  `--format` of its own (console | json | markdown), and the parser gave it every `--format` on the
  line, so the import never saw one: the flag was ignored, an unknown value was not refused, and the
  advice «Say which with --format» could not be followed.

- **A green Playwright run on Windows ends 0 with the reporter in it, not 0xC0000409 (#58).** The
  reporter core spoke to the platform through `fetch`, whose first request compiles undici's WASM
  parser, and V8 re-optimizes it on a background thread. Playwright calls `process.exit` as a run
  ends; landing during that compile, it tripped a libuv assertion on Windows, and a run whose tests all
  passed exited 0xC0000409 with its results delivered. The core now speaks `node:http(s)`, whose
  parser is native — the reporter, `plune run import`, `plune run report` and the run lifecycle
  commands alike; `fetchImpl` still replaces it. A platform silent for 300 s is given up on, as
  `fetch` did. Redirects are not followed: `fetch` followed them, and no platform route redirects.

## [0.13.0] - 2026-09-18

`@plune-ai/playwright` stays at **0.2.5** - nothing below touches `reporter-core`, so the adapter
has nothing to re-embed.

### Added

- **`plune plan grep <id>` — a test plan as the `--grep` a runner takes.** The platform decides which
  tests run (a plan is a collection of case filters, resolved when asked) and CI runs only those:
  `npx playwright test --grep "$(plune plan grep <id>)"`, `npx vitest run -t "$(plune plan grep <id>)"`.
  Each case of the plan contributes its title path from the `path-title` key the reporter wrote — the
  file left out, each segment escaped, `[ >#]+` between them — and the fragments are joined with
  `|`; a case with no such key goes in by title. The boundary class is what makes one pattern fit
  every runner: Playwright, jest, mocha and vitest ≤ 4 filter on the space-joined title path, vitest
  5 on `describe > title`, and a `#` a title had of its own (`… (#742)`) is a `#` in the key too. The
  ` > ` of a vitest junit name and the ` › ` of a Playwright one are boundaries as well. Only the
  pattern reaches stdout; the count of cases and of keyed cases goes to stderr. An empty plan prints
  `(?!)`, a pattern that matches nothing, because an empty `--grep` would run everything. Same
  refusals as `pull`: not logged in or a rejected token → 2, network or HTTP (a plan that does not
  exist included) → 1. Testomat's `--filter 'testomatio:plan=<id>'` is the reference; theirs greps
  `@T123` ids in titles, ours the title path.

### Fixed

- **`PLUNE_TOKEN` is read by every platform command, not only by the reporter and `run`.** `sync`,
  `ingest`, `pull` and `push` looked at the saved login alone, so a CI job with the variable set —
  the same token `run import` and `run start` were already using — was told "not logged in" and had
  to `plune login` first (#44). One ladder now, in one place: the variable, then the saved login;
  blank is absent, as the reporter reads it. The refusal names both roads.

## [0.12.0] - 2026-09-17

Also `@plune-ai/playwright` **0.2.5** - the adapter embeds `reporter-core`, and `PLUNE_FULL_RUN`
below lives there, so it moves with the same rebuild.

### Added

- **`PLUNE_FULL_RUN=1` — a run that is the whole suite says so, and the platform detaches what it
  stopped reporting.** The reporter and `plune run import` send it as `configuration.full` beside the
  list of expected tests; when the run finishes with every expected test reported, the platform moves
  the active cases this source used to report and did not this time to `detached` and the finish line
  says how many. Off by default: only whoever typed the command knows a run was not `-g smoke` or one
  file. `plune run start` sends no list to compare against, so the flag has no effect there.

- **`plune pull` and `plune push` — the project's test cases as one Markdown document, and back.**
  `plune pull [file]` writes the tree (or one suite with `--suite <id>`) as a Markdown document in
  Testomat's classical format (`GET /v1/test-cases/markdown`); `plune push [file] [--dry-run]` sends
  it back (`POST /v1/test-cases/markdown`) and prints the platform's report - created, updated,
  unchanged, refused by line, warnings. `pull` refuses to overwrite a file git sees as modified or
  untracked unless `--force`, so a pull can't quietly erase a working copy; exit 3 for that refusal,
  exit 4 when a push carried refusals (they arrive inside the 200 report, not as a failed call). The
  token is never printed.

## [0.11.1] - 2026-09-15

Also `@plune-ai/playwright` **0.2.4** - the reporter fixes below live in the adapter.

### Fixed

- **Evals on a current Claude model no longer fail with a 400 before the first row.** `plune run`
  sent `temperature: 0` on every request unless the config said otherwise, and the judge sent it
  always; models released after Claude Opus 4.6 refuse the parameter (only `1.0` is still
  accepted). The parameter now goes only when the config sets it — for the rows and for the judge
  alike — so a config without one works on any model, and a config with one keeps what it asked
  for. Cache keys are unchanged: a cache written before this still answers.

- **The reporter opens a run only once a test has reported a result.** It opened one in
  `onBegin`, which Playwright also fires for `--list`, for a `--grep` that matches nothing and for
  a suite of zero tests — so listing tests with a token set left an empty run on the platform
  every time, and with a rejected token the one request left pending at exit tripped a libuv
  assertion on Windows (`!(handle->flags & UV_HANDLE_CLOSING)`). The declared test list is still
  taken at the start and handed over whole; the run itself waits for the first result.

- **The reporter's `path-title` key spells the file with forward slashes on Windows too.** Playwright
  titles the file suite with `path.relative` (backslashes on Windows) and writes its JSON report
  posix-style, so the key the reporter wrote on a Windows machine never equalled the one
  `plune run import` derived from the report of the same run — the two met only through
  `playwright-id`. One spelling now, the one a person would type into a case. `specRef` follows.

## [0.11.0] - 2026-09-15

Also `@plune-ai/playwright` **0.2.3** - the same core, rebuilt. The adapter embeds `reporter-core`
rather than depending on it, so the default name below reaches Playwright projects only through its
own release.

### Changed

- **A run nobody named is called after when and where it ran.** `<directory> · 2026-09-15 15:26 · ci`
  instead of no title at all — the reporter, `plune run import` and `plune run start` alike. A row
  in the list now says whose, when and from where without being opened; `PLUNE_RUN_TITLE` replaces
  the whole name as before. `plune run start` also honours `PLUNE_RUN_TITLE` now — it sent no title
  under any circumstances.

## [0.10.0] - 2026-09-14

Also `@plune-ai/playwright` **0.2.2** - the same core, rebuilt. The adapter embeds `reporter-core`
rather than depending on it, so the fix below reaches Playwright projects only through its own release.

### Added

- **The reporter counts what a trusted source created.** A project can now tell the platform that a
  runner's discovered tests become cases without waiting in the review queue. When it does, the
  offer comes back `created` instead of `queued` — and this client counted only `queued`, so a run
  that filled a project with two thousand cases printed `0 offered for review` and read as a run
  where nothing happened.

  `plune run import` now says how many became cases and where to change that setting, and it stops
  pointing at the review queue in that case: those tests never entered one, so the old line sent a
  reader to an empty screen to look for work that was already done.

  Nothing changes for a project that trusts no source, which is every project by default.

- **`plune run delete <id>`** — undo an import from the surface the import happened on. Deletes the
  run and everything it produced (its results, and the review-queue entries it raised); approved test
  cases and the audit log stay. Recoverable for six months, then gone for good.

  It exists because the CLI is where the mistake is made: onboarding a suite is a loop of `plune run
  import`, and the first time somebody does it they will point it at the wrong file, the wrong `--key`
  or the wrong directory. Until now nothing could take that back, in any tool — a run was the one
  thing Plune could create and could not remove.

  No confirmation prompt, for two reasons rather than one: it is your own data, and this command's
  natural home is a script or a loop over ids, where a prompt is not caution but a hang.

  Needs a platform that serves `DELETE /v1/runs/{id}` — beta since 09.09.2026.

### Fixed

- **One over-long test name no longer loses the whole run.** A test name is a key to the platform,
  and the platform accepts a key of at most 1024 characters. A runner will happily print a
  16 384-character parameter into a title, and until now the reporter sent it as it was: the platform
  refused the run before it started, every result went to the fallback file — and in CI that file is
  deleted with the job. Four such titles cost a project every run for two days, with a green build.

  A name longer than a key is now shortened before it becomes one — the head of the name plus a
  digest of the whole, so two long names still get two keys and the same name gets the same key on
  every run. A queue entry's title is cut to what the platform shows. The reporter says so once,
  naming the first such test, and counts them in the summary: give the test a shorter name; until
  then, this is its identity.

## [0.9.1] - 2026-09-09

### Fixed

- **`--key` now actually gives several jobs one run.** The option has always said it does — *"the key
  several jobs share so their reports land in one run"* — and `run import` closed the run the moment
  it finished its own file. The second job was answered `409 run is closed to new results`, wrote
  everything to the fallback file and exited zero. Green step, green CI, a quarter of a suite
  missing.

  It never worked. It only looked as though it did during onboarding: while a project has no cases
  yet, the second report has nothing to submit, so an empty result is indistinguishable from a
  successful one. The loss appears the day the project is set up — the state it lives in from then on.

  The mechanism to prevent this was already here. `PLUNE_SHARED_RUN` and `PLUNE_PROCEED` have been
  read into `keepOpen` since the Playwright reporter needed it, and the reporter honours it; import
  parsed the same variables and ignored the answer. Now import chooses the same way the reporter
  does, and the run is closed by whoever knows the jobs are done — `plune run finish <id>`, as the
  message says.

- **A report bigger than the review queue says what is left, and what to do about it.** The queue
  holds a bounded number of waiting items, so the first import of a mature suite stops partway.
  Two things were wrong at that moment: the refusal named the batch it was carrying rather than
  everything still unoffered — every batch behind it was abandoned without a word — and the summary
  then said the unmatched tests were *"already in the review queue"*, which was untrue of every one
  of them. Both are now one line that names the real number and says the rest need a second import
  after the queue is emptied.

- **An import that landed nothing no longer opens by saying it imported.** The summary read
  `Imported 555 result(s) from a junit report: 0 accepted, 0 already there, 0 unmatched` — a
  sentence whose halves disagree, and readers stop at the verb. It now says `Read 555 result(s)`,
  which describes the file and is true of every outcome; the counts after it say what became of them.

### Added

- **Progress while a long import runs.** A report larger than one batch now reports as it goes
  (`plune: 400 of 2029 results sent`). A mature suite is a dozen or more silent round trips, and
  nothing distinguished a slow import from a hung one until the summary arrived at the end. Reports
  that fit in a single batch stay silent — there is nothing to watch.

### Documentation

- **The README said "the three cloud commands", and listed one that opens no socket.** The count
  was true at 0.2.0 and has been wrong since 0.7.0; the line sat next to the privacy promise, which
  is the sentence a reader is deciding whether to believe. It now names the four commands that never
  touch a network — `run`, `report`, `diff`, `init` — which is the half the promise is about and the
  half that does not grow with every release. The same claim was retracted from `docs.plune.ai` on
  09.09; it had a second home here, on the page npm renders.

- **How several jobs report into one run is now written down.** `--key` was documented as enough on
  its own. It never was, and since this release it is half of the answer: the key says where results
  go, `PLUNE_SHARED_RUN=1` says who does not end the run.

## [0.9.0] - 2026-09-09

### Added

- **`plune run import <file>` reads a report this CLI did not write.** JUnit XML and Playwright's own
  JSON, detected from the file rather than from its name. This is the door into Plune that costs
  nothing: an LLM provider key is what GENERATING checks needs, and a suite that already runs has
  nothing to generate — the results exist and only have to arrive.

  Until now that door was one runner wide. `@plune-ai/playwright` was the only way to hand results
  over, so a team on Jest, Vitest, pytest, PHPUnit, Surefire or Cypress had to write their own
  request against the API — for a product whose entire subject is somebody else's tests. JUnit XML is
  the format nearly all of them already print.

  Everything after parsing is the reporter core, unchanged: the same run lifecycle, the same
  identification ladder, the same fallback file when the platform is down, the same review-queue
  offer under `--create`. An importer with a connection of its own would be a second reporter to keep
  correct, and the two would drift the day one of them was fixed.

  Statuses are carried, not decided. JUnit's four words go over as `pass` / `failure` / `error` /
  `skipped` — the vocabulary the platform's own default map already spells for this format — so a
  team that reads `error` differently changes their map instead of waiting for a release here.

  Time is read from the report or left out. A case carries its duration and a suite carries a
  timestamp; there is no per-case start anywhere in the format, so a report without a suite timestamp
  records no execution at all. The file's mtime would have looked exactly like a fact.

  A Playwright JSON import derives the SAME identity as the reporter, to the character: `playwright-id`
  plus the `#`-joined path. Two derivations that disagreed would give one test two cases in Plune,
  quietly and forever, so the fixture in each suite describes the same test and both pin the literal.

  Verified against beta with the built binary before release: four cases in, four offered to the
  queue, one approved, the same file re-imported — one accepted, `unmapped: 0`.

### Changed

- The README describes the second route. It presented Plune as an eval runner and never mentioned
  that a suite you already have can be accounted for without a provider key, which is the half of
  the product most readers arrive for.


## [0.8.0] - 2026-09-08

### Added

- **`PLUNE_CREATE=1` offers the tests Plune has no case for.** The last rung of the identification
  ladder, blocked since C2 and unblocked by the platform's third kind of review-queue entry: one that
  testifies a case is MISSING rather than describing one. A reporter sees a `TestResult`, never the
  test's source, so what it offers is what it saw — the keys it was looked up by, the test's title,
  the file and line, and the runner's own word for how it went. There are no steps and no expected
  result in this shape at all, which is the point: the alternative was to invent them.

  Off unless asked for. A reporter that filled a stranger's review queue on first run would teach the
  team to stop reading the queue.

  One offer per test, not per attempt — a flaky test that ran three times is one missing case. A test
  whose adapter cannot name it or say where it lives is skipped in silence rather than sent with a
  guessed path. A failed offer is reported and dropped rather than written to the fallback file: that
  file replays results, and an offer is a question the next run asks again on its own.

- **`@plune-ai/playwright` 0.2.0 — the adapter names the test and says where it lives.** The two
  fields the core needs to offer an unresolved test, and the only two it cannot derive: the full
  `describe › title` path, because two suites in one file routinely share a title, and `file:line`,
  because a reviewer's first move on an unknown test is to open it. Read only on that path — a test
  that found its case has a case with a title of its own.

  The adapter bundles the core, so its version moves with any core behaviour it carries.

- **A run can be named, placed and marked.** `PLUNE_RUN_TITLE`, `PLUNE_ENV` and `PLUNE_LABELS` were
  recognised and refused in 0.7.0 because a Plune run had nowhere to put them; the platform has the
  fields now, so they work. Labels are comma-separated, and a blank entry is dropped — `a,,b` is a
  CI template that had nothing for the middle slot, not a request for an empty label.

  Lengths are not trimmed here. The platform states its limits and names the one you exceeded, and
  its refusal costs no results: the run fails to open, the reporter says why, and everything lands
  in the fallback file. A second copy of the caps in this package would only be a second place for
  them to drift.

  The reporter also says when a deployment kept none of it — an older one validates the body,
  stores what it knows and answers 201, which is indistinguishable from success. That was the whole
  reason these variables were refused out loud rather than sent and forgotten.

  `PLUNE_GROUP` is still refused: a group of runs is a feature that does not exist, and a group of
  one run means nothing.

## [0.7.0] - 2026-09-08

### Changed

- **zod 3 → 4.** The platform this CLI reports to has been on zod 4 since its own contract work
  landed, so anything depending on both pulled two copies of zod into one tree — 3.25.76 beside
  4.5.4 — for schemas that describe the same wire. The migration itself is four `z.record()` calls,
  which v4 requires to name their key type explicitly; nothing else here used an API v4 removed.
  Done now rather than later because the reporter core lands next, and every schema it adds would
  otherwise be written once on 3 and again on 4.

### Added

- **`@plune-ai/cli/reporter-core` — a new entry point that speaks the platform's run lifecycle.**
  Joins or creates a run by shared key, looks every test up once, sends results in batches, and
  closes the run explicitly. It has no runtime dependencies at all: the platform owns and validates
  the contract, so a client-side copy of the schema would only be a second place to drift. A
  framework adapter builds on this; the first, `@plune-ai/playwright`, follows.

  Two behaviours are deliberate and worth knowing. Nothing it fails to send is lost — an
  unreachable platform, a refused token and a closed run all append the batch to
  `.plune/pending-results.jsonl` while the test run carries on. And it never closes a run it did
  not finish watching: a crashed process leaves the run open, because a run that is silently marked
  finished reads as green when a third of it never ran.

- **A test can say which case it is, three ways.** A `PluneId` annotation, a `@P<id>` token in the
  title, or an `application/plune.metadata+json` attachment — in that order, because the deliberate
  thing an author typed should not be overruled by something a fixture generated. The attachment can
  also carry keys from another tool (`{"keys": [{"kind": "qase", "value": "Q-9"}]}`), and those come
  before the identifiers derived from the file path: a key from another system is a statement, a
  path is a guess. An attachment that cannot be parsed says nothing rather than failing the run.

- **`plune run start · finish · exec · report` — drive a platform run from a shell.** For the case
  a reporter cannot see: shards that are separate CI steps, a `merge-reports` stage, a suite split
  across two runners. `exec` does the whole thing in one line — opens the run, hands the command
  `PLUNE_RUN` and `PLUNE_PROCEED` so a reporter inside joins without closing it, then closes the run
  and exits with the command's own code.

  `plune run finish` was owed: the reporter already tells people to run it when a run is left open,
  and a message pointing at a command that does not exist is worse than no message.

  `plune run report` replays the fallback file. Until now "nothing is lost" meant the results were
  on disk in a shape nothing read, which is not the same thing. The file survives the replay — a
  partly failed send must not be the reason the rest disappears.

  These are subcommands of `run`, which takes no positional arguments; `plune run` on its own still
  runs your assertion suite exactly as before.

- **The reporter reads its settings from the environment.** `PLUNE_TOKEN`, `PLUNE_RUN`,
  `PLUNE_API_URL`, `PLUNE_SHARED_RUN`, `PLUNE_PROCEED`, `PLUNE_BATCH_SIZE` and `PLUNE_FALLBACK` fill
  in whatever a committed config left out — a config file cannot know the run key of a job that does
  not exist yet. Anything passed explicitly still wins.

  `PLUNE_RUN_TITLE`, `PLUNE_ENV`, `PLUNE_LABELS` and `PLUNE_GROUP` are recognised and **refused out
  loud**: a run has nowhere to store them yet, and a run's `meta` silently strips keys it does not
  know — so accepting them would look exactly like saving them.

- **`@plune-ai/playwright` — report an existing Playwright suite to Plune.** One line in
  `playwright.config.ts` and runs, results and failures appear in the platform, with no change
  to any test. Shards sharing a key land in one run, and `merge-reports` does not duplicate
  anything — a result's key is derived from the test id and its retry, so sending it twice is
  recognised rather than recorded twice.

  The published package has **no runtime dependencies**: the reporter core is compiled into it
  rather than depended on, so installing it does not drag a native SQLite build and two
  provider SDKs into a project that only wanted to report results.

- The user guide (`docs/guide/`) and a runnable `examples/quickstart/` project — an end-to-end
  `plune.yaml`, two datasets and a GitHub Actions workflow — now ship in this repo instead of the
  private platform repo, so the documentation sits beside the code it documents.

## [0.6.0] - 2026-08-01

### Added

- **`plune ingest <dir>` — record a Cairn run in Plune.** Reads a Cairn run directory (Cairn 0.7.0 or
  newer, which stamps its artifact format) and uploads what Plune records. Nothing uploaded becomes a
  test case: generated cases arrive in Plune's review queue as proposals for a person to accept or
  refuse, so a run cannot fill a project with cases nobody authored. The command prints three counters
  — results attached, cases proposed, cases skipped — which always account for every case sent.

  Cairn is not a dependency and does not learn about Plune. We parse its published artifact and depend
  on its `schemaVersion`, nothing else; a version this CLI does not know is refused by name rather than
  parsed on a guess. An unfinished run and evidence that cannot be joined to its cases unambiguously
  are refused the same way, and a refusal uploads nothing at all.

  `plune run` still works with no account, no token and no network (ADR 0006) — `ingest` is opt-in,
  like `sync`.

### Changed

- **Local embeddings ship separately now.** `@huggingface/transformers` moved from a hard dependency
  to an **optional peer**, so installing `@plune-ai/cli` no longer drags in the native embedding stack
  (`onnxruntime` → `sharp`, `adm-zip`, `protobufjs`) unless you actually want it.

  It powers exactly two things — the `semantic-similarity` assertion and the RAG suite. Everything else
  works untouched, and the import was already lazy, so nothing about the happy path changes. What
  changes is the failure: without the package those assertions now say which package to install instead
  of throwing `MODULE_NOT_FOUND`.

  **To keep them:** `npm i @huggingface/transformers` (or `pnpm add`) alongside the CLI.

  The reason is not tidiness. That tree carried **four HIGH advisories**, and it was being installed
  into every consumer — including a server that depends on this package purely for its zod contracts
  and never executes a line of it.

- `ajv` bumped to `^8.17.1`, which clears the `fast-uri` advisories.

## [0.5.0] - 2026-07-27

### Added

- **`sync()` is callable from code, not only from a shell.** `run()` has been the programmatic half of
  `plune run` for a while; `sync()` is now the same thing for the upload, for the same callers — CI
  code driving Plune directly instead of shelling out.

  Its failures ship as classes, because a caller has to tell "log in" (exit code 2) apart from "the
  network is down" (exit code 1): `NotLoggedInError`, `TokenRejectedError`, `SyncFileError`,
  `SyncNetworkError`, `SyncHttpError` — plus `reportSyncFailure` and the `SyncDeps` / `SyncResult`
  types.

  This is also what lets the platform test itself against the real client instead of against a
  hand-rolled POST of its own.

## [0.4.0] - 2026-07-27

### Added

- **`plune login`, `plune logout` and `plune sync` — this CLI can now reach the Plune platform.**
  The three commands used to live in the unpublished platform repo, so the copy anyone could install
  was unable to connect, and the copy that could connect was unavailable. They live here now.

  Local behaviour is unchanged and stays that way: `run`, `report`, `diff` and `init` need no account,
  no token and no network. The cloud commands load nothing until you invoke one, and they fail with a
  single actionable line instead of a stack trace — **exit 2** when you have to act (log in, fix the
  file), **exit 1** when the environment is at fault (network, server). The token is stored `0600`
  under your config directory and is never printed, returned or logged.

- **`assertionConfigSchema` is exported from the public API.** Anything that stores assertions of its
  own can now validate them with the runner's own schema instead of keeping a copy that drifts.

- **The RunResult validator is exported too**, for consumers that ingest a run rather than produce
  one: `parseRunResult`, `runResultSchema`, `RUN_RESULT_SCHEMA_VERSION`, `assertionResultRecordSchema`,
  `binaryVerdictSchema`, and the `ParsedRunResult` / `BinaryVerdict` types. `plune sync` validates the
  file with it before uploading and the platform validates the same body on receipt — one schema on
  both ends, so the two cannot disagree quietly.

## [0.3.0] - 2026-06-30

### Changed

- **BREAKING (wire format):** `plune run --format json` renames the RunResult version field
  `schema` → `schemaVersion`. The value is unchanged (`1`); only the key moved. **Anything reading the
  top-level `schema` key must switch to `schemaVersion`** — a reader that does not will see the field
  as absent rather than fail loudly, which is the dangerous half of this change.

  It aligns the CLI's output with the frozen TMS data contracts (plune-ai/plune#75). The rename also
  reaches the exported types (`RunResult`), so a TypeScript consumer is told at compile time; a
  consumer parsing the JSON by hand is not, which is why it is spelled out here.

  Version bumped `0.2.x` → `0.3.0` per the pre-1.0 policy.

## [0.2.3] - 2026-06-29

### Fixed

- **The CLI no longer exits silently when installed on Linux or macOS.** `plune <anything>` printed
  nothing, wrote no `-o` file and exited 0. npm and npx install the binary as a symlink on those
  platforms, and the entry-point guard compared the invoked path with the module path as plain strings
  — `.bin/plune` never matched `dist/cli.cjs`, so the program simply never executed. The two paths are
  now compared after resolving symlinks. Windows shims pass the real path, which is why it never
  reproduced there.

### Changed

- README: cross-links to plune.ai and the Marketplace listing, and a stale claim about what
  `plune init` scaffolds removed.

## [0.2.2] - 2026-06-14

### Fixed

- **Releasing works from the tag alone.** The publish job refused to run unless `package.json` already
  carried the tag's version, so pushing a `vX.Y.Z` tag without a preceding manual `npm version` stopped
  the release; it now sets the version from the tag. The release job also stopped passing a flag to
  `gh release edit` that only `gh release create` accepts, so re-running a release no longer fails.

## [0.2.1] - 2026-06-14

### Changed

- Release plumbing only — tag-triggered publishing to npm and GitHub Packages, and CI runners moved to
  Node 24. No change to the CLI itself: the source is identical to 0.2.0.

## [0.2.0] - 2026-06-14

First public release. Released from commit `ba43100`; no `v0.2.0` tag exists.

### Added

- `plune run` — run an assertion suite from `plune.yaml` against a provider, with result
  caching, cost reporting, and `--dry-run`, `--only <id|tag>`, `--bail`, `--no-cache`,
  `--concurrency <n>`, `--format console|json|markdown`, `-o <file>`.
- `plune report` — re-render the most recent run in any supported format.
- `plune diff <baseline> <current>` — compare two `plune run --format json` outputs and
  report pass→fail regressions, with `--fail-on-regression` for CI gating.
- `plune init` — scaffold `plune.yaml`, an example dataset, and `.env.example`
  (interactive wizard, or `--yes` for CI).
- Providers: Anthropic, OpenAI, OpenRouter.
- Ten assertion types: `exact-match`, `contains`, `contains-any`, `contains-all`,
  `json-schema`, `llm-judge`, `semantic-similarity`, `faithfulness`, `answer-relevance`,
  `context-precision`.

[Unreleased]: https://github.com/plune-ai/cli/compare/v0.17.0...HEAD
[0.17.0]: https://github.com/plune-ai/cli/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/plune-ai/cli/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/plune-ai/cli/compare/v0.14.3...v0.15.0
[0.14.3]: https://github.com/plune-ai/cli/compare/v0.14.2...v0.14.3
[0.14.2]: https://github.com/plune-ai/cli/compare/v0.14.1...v0.14.2
[0.14.1]: https://github.com/plune-ai/cli/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/plune-ai/cli/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/plune-ai/cli/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/plune-ai/cli/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/plune-ai/cli/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/plune-ai/cli/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/plune-ai/cli/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/plune-ai/cli/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/plune-ai/cli/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/plune-ai/cli/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/plune-ai/cli/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/plune-ai/cli/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/plune-ai/cli/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/plune-ai/cli/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/plune-ai/cli/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/plune-ai/cli/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/plune-ai/cli/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/plune-ai/cli/releases/tag/v0.2.1
[0.2.0]: https://github.com/plune-ai/cli/commit/ba43100599f4808b8426ddece0a9cc22ccf1e6c3
