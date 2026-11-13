/**
 * The catalog entries of the `apps` suite: what an MCP server that offers MCP Apps (tools with a UI) owes its clients.
 * Data only, like catalog.ts, which appends these to CATALOG. The text is the specification of the extension
 * (https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx, status "Stable
 * (2026-01-26)"), read on 2026-11-13 together with https://modelcontextprotocol.io/extensions/apps/overview.md and
 * https://modelcontextprotocol.io/extensions/overview.md (how a server declares an extension). Only what the text says
 * about the server is catalogued: the window of the host (sandbox, CSP enforcement, `ui/*` messages) is a requirement
 * of the host, and there is no check of it here.
 *
 * `derivation` quotes the sentence the level comes from, word for word. `derived`: the level is read from a sentence
 * that is not about exactly what the check judges, or the text gives no criterion; `derivation` says which. A rule of
 * the text with no keyword in it (`MUST`, `SHOULD`) is a `SHOULD` at most.
 */

import type { CatalogEntry, Era, SpecRef } from './catalog.js';

const BOTH: Era[] = ['legacy', 'modern'];
export const APPS_SPEC_URL =
  'https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx';
const ref = (section: string): SpecRef => ({
  revision: '2026-01-26',
  page: 'apps.mdx',
  section,
  url: APPS_SPEC_URL,
});
const FORMAT = 'UI Resource Format';
const DISCOVERY = 'Resource Discovery';

const apps = (
  s: Omit<CatalogEntry, 'suite' | 'kind' | 'derived' | 'needsFixture' | 'transports' | 'eras'> &
    Partial<Pick<CatalogEntry, 'derived' | 'needsFixture'>>,
): CatalogEntry => ({
  ...s,
  suite: 'apps',
  kind: 'check',
  derived: s.derived ?? false,
  needsFixture: s.needsFixture ?? false,
  transports: ['stdio', 'http'],
  eras: BOTH,
});

export const APPS_CATALOG: readonly CatalogEntry[] = [
  apps({
    id: 'apps-ui-resource-uri-scheme',
    title: 'The address of a UI resource starts with ui://',
    description:
      'Every _meta.ui.resourceUri a tool names is a string that starts with ui://, and so is the address of every listed resource of the MCP Apps media type.',
    level: 'MUST',
    derived: true,
    derivation:
      'UIResource.uri: "MUST use the `ui://` URI scheme to distinguish UI resources from other MCP resource types."; Content Requirements: "URI MUST start with `ui://` scheme". Both sentences are about the address of a UI resource; that the address a tool names in _meta.ui.resourceUri ("URI of UI resource for rendering tool results") is one, and that a listed resource of the MCP Apps media type is one, is read from the text.',
    specRefs: [ref(FORMAT), ref(DISCOVERY)],
  }),
  apps({
    id: 'apps-ui-resource-exists',
    title: 'The resource a tool names can be read',
    description:
      'resources/read of each ui:// resource a tool names in _meta.ui.resourceUri answers a result with contents, not an error or an empty list.',
    level: 'MUST',
    derivation: 'Resource Discovery, Behavior: "Resource MUST exist on the server"',
    specRefs: [ref(DISCOVERY)],
  }),
  apps({
    id: 'apps-ui-mime-type',
    title: 'The content of a UI resource is text/html;profile=mcp-app',
    description:
      'Each content that resources/read answers for a UI resource has the mimeType text/html;profile=mcp-app (compared as a media type: letter case and spaces around ";" do not matter).',
    level: 'MUST',
    derivation:
      'Content Requirements: "`mimeType` MUST be `text/html;profile=mcp-app` (other types reserved for future extensions)"',
    specRefs: [ref(FORMAT)],
  }),
  apps({
    id: 'apps-ui-content-payload',
    title: 'The content is one of text and blob, and is an HTML5 document',
    description:
      'Each content of a UI resource has exactly one of text (a string) and blob (base64), and the HTML it holds opens with an HTML5 doctype. A resource over 4 MiB is not judged: could-not-run.',
    level: 'MUST',
    derived: true,
    derivation:
      'Content Requirements: "Content MUST be provided via either `text` (string) or `blob` (base64-encoded)" and "Content MUST be valid HTML5 document". The text gives no criterion for a valid HTML5 document (its example is `<!DOCTYPE html><html>...</html>`); this checker judges the least: the document opens with the HTML5 doctype (after a byte order mark, white space and comments). It never parses, opens or runs the HTML. "either ... or" is read as exactly one of the two.',
    specRefs: [ref(FORMAT)],
  }),
  apps({
    id: 'apps-ui-listed-mime',
    title: 'A listed UI resource has the mimeType text/html;profile=mcp-app',
    description:
      'Every ui:// resource in resources/list has the mimeType text/html;profile=mcp-app. A server may leave UI-only resources out of the list; then there is nothing to read.',
    level: 'SHOULD',
    derivation:
      'UIResource.mimeType: "SHOULD be `text/html;profile=mcp-app` for HTML-based UIs in the initial MVP."',
    specRefs: [ref(FORMAT)],
  }),
  apps({
    id: 'apps-ui-visibility-values',
    title: 'visibility holds only model and app',
    description:
      'Where a tool sets _meta.ui.visibility, it is an array whose every element is "model" or "app".',
    level: 'SHOULD',
    derived: true,
    derivation:
      'No sentence says MUST or SHOULD about the values: McpUiToolMeta types visibility as `Array<"model" | "app">` and lists the two values ("`model`: Tool is visible to and callable by the agent", "`app`: Tool is callable by the app from the same server connection only"); Visibility: "`visibility` defaults to `["model", "app"]` if omitted". A requirement the text states only as a type has no keyword, so the level is SHOULD.',
    specRefs: [ref(DISCOVERY)],
  }),
  apps({
    id: 'apps-ui-tool-text-fallback',
    title: 'A tool with a UI also returns content',
    description:
      'A tool that has _meta.ui and that --fixture names is called, and its result has a content array with at least one block that says something: a text that is not blank, an image, audio, a resource or a resource link. Only the tools the fixture names are called; without one the check is could-not-run (needs-input).',
    level: 'MUST',
    needsFixture: true,
    derivation:
      'Graceful Degradation: "Tools MUST return meaningful content array even when UI is available". The text does not say what is meaningful; only an absent, empty or blank content is judged. A result with isError is not judged.',
    specRefs: [ref('Client<>Server Capability Negotiation')],
  }),
  apps({
    id: 'apps-ui-meta-shapes',
    title: 'csp, permissions, domain and prefersBorder have the shapes of the text',
    description:
      "In _meta.ui of a listed or read UI resource: csp is an object whose connectDomains, resourceDomains, frameDomains and baseUriDomains are arrays of strings; permissions is an object whose camera, microphone, geolocation and clipboardWrite are objects; domain is a string; prefersBorder is a boolean. A tool's _meta.ui is an object. Other members are not judged, and neither is the format of a domain (it depends on the host).",
    level: 'SHOULD',
    derived: true,
    derivation:
      'The shapes are those of the interfaces UIResourceMeta and McpUiResourceCsp; no sentence says MUST or SHOULD about them. For domain the text says "Servers MUST consult host-specific documentation for the expected domain format", which no check can read. A requirement the text states only as a type has no keyword, so the level is SHOULD.',
    specRefs: [ref(FORMAT)],
  }),
];
