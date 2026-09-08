/**
 * Enough XML to read a test report, and deliberately no more.
 *
 * There is no XML parser in Node's standard library and none anywhere in this repository, so the
 * choice was a dependency or this file. It is this file because the alternative puts a parser into
 * the install of every `plune` user for one command — and because what a JUnit report needs is a
 * small, closed subset: elements, attributes, text and CDATA. No namespace resolution (a prefixed
 * name is kept as written), no DTD, no entity declarations.
 *
 * What it is NOT is a tolerant parser. A report that does not parse is a report we would otherwise
 * import wrongly and silently, so every malformed shape throws with the line it was found on — the
 * error message is a large part of why this exists at all.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Text and CDATA directly inside this element, concatenated in document order. */
  text: string;
  /** 1-based line the opening tag started on — what an error message points at. */
  line: number;
}

/** A report that could not be read. Names the file and the line, never «invalid input». */
export class XmlParseError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    detail: string,
  ) {
    super(`${file}:${line} — ${detail}`);
    this.name = 'XmlParseError';
  }
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * The five named entities plus numeric ones — the whole of what a report writer emits.
 *
 * An entity nobody defined is left as written rather than dropped: `&nbsp;` in a test title is a
 * test title we still want, and silently deleting characters out of a name would break the key it
 * becomes.
 */
function decode(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      try {
        return Number.isNaN(code) ? whole : String.fromCodePoint(code);
      } catch {
        // Out of range, or a lone surrogate. Keeping the source text loses nothing a reader needs.
        return whole;
      }
    }
    return NAMED[body] ?? whole;
  });
}

const NAME_END = /[\s/>]/;
const ATTR_NAME_END = /[\s=/>]/;
const SPACE = /\s/;

/**
 * Parse a document into a synthetic root whose children are the top-level elements.
 *
 * A root rather than «the one document element» because reports in the wild are both: a
 * `<testsuites>` wrapper, or a bare `<testsuite>`, and one caller should not have to care.
 */
export function parseXml(source: string, file: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [], text: '', line: 1 };
  const stack: XmlElement[] = [root];
  let i = 0;
  let line = 1;

  /** Move the cursor, counting the lines crossed so an error can name one. */
  const advance = (to: number): void => {
    for (let j = i; j < to; j++) if (source[j] === '\n') line += 1;
    i = to;
  };
  const top = (): XmlElement => stack[stack.length - 1] as XmlElement;

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) break;
    if (lt > i) {
      const between = source.slice(i, lt);
      // Whitespace between elements is layout, not content — keeping it would put the indentation
      // of the file into the error text of every failure.
      if (between.trim() !== '') top().text += decode(between);
      advance(lt);
    }

    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end === -1) throw new XmlParseError(file, line, 'a comment is never closed');
      advance(end + 3);
      continue;
    }
    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9);
      if (end === -1) throw new XmlParseError(file, line, 'a CDATA section is never closed');
      // Raw: CDATA is what a writer uses precisely so that `&` and `<` mean themselves.
      top().text += source.slice(i + 9, end);
      advance(end + 3);
      continue;
    }
    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2);
      if (end === -1) throw new XmlParseError(file, line, 'a processing instruction is never closed');
      advance(end + 2);
      continue;
    }
    if (source.startsWith('<!', i)) {
      const end = source.indexOf('>', i + 2);
      if (end === -1) throw new XmlParseError(file, line, 'a declaration is never closed');
      advance(end + 1);
      continue;
    }
    if (source.startsWith('</', i)) {
      const end = source.indexOf('>', i + 2);
      if (end === -1) throw new XmlParseError(file, line, 'a closing tag is never closed');
      const name = source.slice(i + 2, end).trim();
      const open = top();
      if (open === root) throw new XmlParseError(file, line, `</${name}> closes nothing`);
      if (open.name !== name) {
        throw new XmlParseError(file, line, `</${name}> closes <${open.name}>, opened on line ${open.line}`);
      }
      stack.pop();
      advance(end + 1);
      continue;
    }

    // An opening tag. Scanned by hand rather than by regex because an attribute value may hold a
    // `>` — a stack trace inside `message="..."` routinely does — and a regex for the tag's end
    // would cut the element in half there.
    const startLine = line;
    let j = i + 1;
    const nameStart = j;
    while (j < source.length && !NAME_END.test(source[j] as string)) j += 1;
    const name = source.slice(nameStart, j);
    if (name === '') throw new XmlParseError(file, startLine, 'a tag with no name');

    const el: XmlElement = { name, attrs: {}, children: [], text: '', line: startLine };
    let selfClosing = false;
    for (;;) {
      while (j < source.length && SPACE.test(source[j] as string)) j += 1;
      if (j >= source.length) throw new XmlParseError(file, startLine, `<${name}> is never closed`);
      if (source[j] === '/' && source[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      if (source[j] === '>') {
        j += 1;
        break;
      }
      const attrStart = j;
      while (j < source.length && !ATTR_NAME_END.test(source[j] as string)) j += 1;
      const attr = source.slice(attrStart, j);
      if (attr === '') throw new XmlParseError(file, startLine, `<${name}> has an attribute with no name`);
      while (j < source.length && SPACE.test(source[j] as string)) j += 1;
      if (source[j] !== '=') {
        throw new XmlParseError(file, startLine, `<${name}> attribute "${attr}" has no value`);
      }
      j += 1;
      while (j < source.length && SPACE.test(source[j] as string)) j += 1;
      const quote = source[j];
      if (quote !== '"' && quote !== "'") {
        throw new XmlParseError(file, startLine, `<${name}> attribute "${attr}" is not quoted`);
      }
      const close = source.indexOf(quote, j + 1);
      if (close === -1) throw new XmlParseError(file, startLine, `<${name}> attribute "${attr}" is never closed`);
      el.attrs[attr] = decode(source.slice(j + 1, close));
      j = close + 1;
    }

    top().children.push(el);
    if (!selfClosing) stack.push(el);
    advance(j);
  }

  if (stack.length > 1) {
    const open = top();
    throw new XmlParseError(file, open.line, `<${open.name}> is never closed`);
  }
  if (root.children.length === 0) throw new XmlParseError(file, 1, 'no elements — is this an XML report?');
  return root;
}

/** Every descendant with this name, in document order. Does not descend into a match. */
export function findAll(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.name === name) out.push(child);
      else walk(child);
    }
  };
  walk(el);
  return out;
}
