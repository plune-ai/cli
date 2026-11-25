// The matcher behind `@matchesRegex`. Pure: no I/O and nothing of Node.
//
// A pattern in a config is run against text a model wrote, and the regular expressions of JavaScript
// backtrack: `(a+)+$`, `^(a+){20}$`, `^\d+\d+\d+\d+\d+x` or `^(a|a)*b` take seconds to minutes on a short text,
// and no rule about the shape of a pattern catches every such case. So the pattern is not handed to `RegExp`.
// It is compiled here to a state machine that is stepped once per character with a set of states (Thompson's
// construction), which takes at most (characters x states) steps whatever the pattern is. The verdict never
// depends on a clock.
//
// What it reads: literals, `.`, `\d \w \s \D \W \S`, `\n \r \t \f \v \0`, a backslash before any other
// character that is not a letter or a digit, classes `[a-z]` and `[^...]`, groups `( )` and `(?: )`, `|`,
// `* + ? {n} {n,} {n,m}` (a `?` after one is accepted: lazy or greedy, the same texts match), the anchors
// `^ $ \b \B`, and the flags `i`, `m`, `s`. A match is looked for anywhere in the text, as `RegExp.test` does.
// It works on UTF-16 code units, as a pattern without the `u` flag does.
//
// What it refuses, because a state machine cannot do it in linear time or because it is rarely needed:
// backreferences, lookahead and lookbehind, named groups, `\p{...}`, `\x..`, `\u....`, `\c.`.

/** How many nodes a pattern may come to once its counted repeats are written out: `a{50}` is 50. */
export const MAX_REGEX_NODES = 2000;

type CharTest = (code: number) => boolean;
type Anchor = '^' | '$' | 'b' | 'B';
type Node =
  | { t: 'char'; test: CharTest }
  | { t: 'anchor'; kind: Anchor }
  | { t: 'group'; options: Node[][] }
  | { t: 'repeat'; node: Node; min: number; max: number };

const SHORTHAND: Record<string, RegExp> = { d: /\d/, w: /\w/, s: /\s/ };
const CONTROL: Record<string, number> = { n: 10, r: 13, t: 9, f: 12, v: 11, '0': 0 };
const SIMPLE_REPEAT: Record<string, [number, number]> = { '*': [0, Infinity], '+': [1, Infinity], '?': [0, 1] };
const LINE_ENDS = new Set([10, 13, 0x2028, 0x2029]);
const QUANTIFIER = /[*+?]|\{(\d+)(?:(,)(\d*))?\}/y;

/**
 * The case class of a code unit, as a pattern with `i` and without `u` has it: its upper case when that is
 * one code unit, except that a character outside ASCII never folds to one inside (U+212A is not `K`, U+017F
 * is not `S`). Two characters match under `i` when this is equal for both.
 */
function caseClass(code: number): number {
  const upper = String.fromCharCode(code).toUpperCase();
  if (upper.length !== 1) return code;
  const folded = upper.charCodeAt(0);
  return code >= 128 && folded < 128 ? code : folded;
}

/** Case class to its members, for the classes of two or more; built once, on the first pattern with `i`. */
let caseClasses: Map<number, number[]> | undefined;

/** Every code unit that matches `code` under `i`, itself included. */
function sameCase(code: number): number[] {
  if (caseClasses === undefined) {
    const all = new Map<number, number[]>();
    for (let c = 0; c < 0x10000; c++) {
      const key = caseClass(c);
      const members = all.get(key);
      if (members === undefined) all.set(key, [c]);
      else members.push(c);
    }
    caseClasses = new Map([...all].filter(([, members]) => members.length > 1));
  }
  return caseClasses.get(caseClass(code)) ?? [code];
}

function parse(pattern: string, flags: string): Node[][] {
  let i = 0;
  const fail = (what: string): Error => new Error(`${what} (character ${i} of the pattern)`);
  const ignoreCase = flags.includes('i');

  /** With `i`, a character matches when any character of the same case class does. */
  const fold = (test: CharTest): CharTest => (ignoreCase ? (code) => sameCase(code).some(test) : test);
  const literal = (code: number): CharTest => fold((c) => c === code);

  const shorthand = (e: string): CharTest | undefined => {
    const re = SHORTHAND[e.toLowerCase()];
    if (re === undefined) return undefined;
    const negated = e !== e.toLowerCase();
    return (code) => re.test(String.fromCharCode(code)) !== negated;
  };
  /** The character after a backslash, as the code it stands for. */
  const escaped = (e: string | undefined): number => {
    if (e === undefined) throw fail('a backslash ends the pattern');
    // To RegExp `\01` is an octal escape and `\00` another: neither is the NUL this would read.
    if (e === '0' && /\d/.test(pattern[i] ?? '')) throw fail('\\0 before a digit is not supported');
    const control = CONTROL[e];
    if (control !== undefined) return control;
    if (/[A-Za-z0-9]/.test(e)) throw fail(`\\${e} is not supported`);
    return e.charCodeAt(0);
  };

  /** One member of a class: a code, or the test of a shorthand such as `\d`. */
  const classAtom = (): number | CharTest => {
    const ch = pattern[i++];
    if (ch === undefined) throw fail('a character class is not closed');
    if (ch !== '\\') return ch.charCodeAt(0);
    const e = pattern[i++];
    if (e === 'b') return 8;
    return (e === undefined ? undefined : shorthand(e)) ?? escaped(e);
  };
  const parseClass = (): CharTest => {
    const negated = pattern[i] === '^';
    if (negated) i++;
    const tests: CharTest[] = [];
    while (pattern[i] !== ']') {
      const low = classAtom();
      if (typeof low !== 'number') tests.push(low);
      else if (pattern[i] === '-' && pattern[i + 1] !== ']') {
        i++;
        const high = classAtom();
        if (typeof high !== 'number' || high < low) throw fail('a range in a character class is out of order');
        tests.push(fold((c) => c >= low && c <= high));
      } else tests.push(literal(low));
    }
    i++;
    return (code) => tests.some((test) => test(code)) !== negated;
  };

  const parseAtom = (): Node => {
    const ch = pattern[i++]!;
    if (ch === '(') {
      if (pattern[i] === '?') {
        if (pattern[i + 1] !== ':') throw fail('lookahead, lookbehind and named groups are not supported');
        i += 2;
      }
      const options = parseOptions();
      if (pattern[i] !== ')') throw fail('a group is not closed');
      i++;
      return { t: 'group', options };
    }
    if (ch === '[') return { t: 'char', test: parseClass() };
    if (ch === '.') return { t: 'char', test: flags.includes('s') ? () => true : (c) => !LINE_ENDS.has(c) };
    if (ch === '^' || ch === '$') return { t: 'anchor', kind: ch };
    // A repeat with nothing before it, or straight after another repeat: `*a`, `{3}`, `a{2}{3}`.
    QUANTIFIER.lastIndex = i - 1;
    if (QUANTIFIER.test(pattern)) throw fail('nothing to repeat');
    if (ch !== '\\') return { t: 'char', test: literal(ch.charCodeAt(0)) };
    const e = pattern[i++];
    if (e === 'b' || e === 'B') return { t: 'anchor', kind: e };
    const set = e === undefined ? undefined : shorthand(e);
    return { t: 'char', test: set ?? literal(escaped(e)) };
  };

  const parseRepeat = (atom: Node): Node => {
    QUANTIFIER.lastIndex = i;
    const m = QUANTIFIER.exec(pattern);
    if (m === null) return atom;
    i += m[0].length;
    if (atom.t === 'anchor') throw fail('an anchor cannot be repeated');
    const least = Number(m[1]);
    const counted: [number, number] = [least, m[2] === undefined ? least : m[3] === '' ? Infinity : Number(m[3])];
    const [min, max] = SIMPLE_REPEAT[m[0]] ?? counted;
    if (max < min) throw fail('a repeat has its numbers out of order');
    if (pattern[i] === '?') i++;
    return { t: 'repeat', node: atom, min, max };
  };

  function parseOptions(): Node[][] {
    const options: Node[][] = [[]];
    while (i < pattern.length && pattern[i] !== ')') {
      if (pattern[i] === '|') {
        i++;
        options.push([]);
      } else options[options.length - 1]!.push(parseRepeat(parseAtom()));
    }
    return options;
  }

  const options = parseOptions();
  if (i < pattern.length) throw fail('a ")" has no group to close');
  return options;
}

const CHAR = 0;
const SPLIT = 1;
const ANCHOR = 2;
const MATCH = 3;

interface State {
  kind: number;
  /** The next state; for a split, one of the two. */
  next: number;
  /** The other next state of a split. */
  other: number;
  test?: CharTest;
  anchor?: Anchor;
}

const isWord = (text: string, at: number): boolean => at >= 0 && at < text.length && /\w/.test(text[at]!);

/**
 * Compiles a pattern to a function that says whether a text holds a match.
 *
 * @throws Error with a sentence that says what in the pattern is not supported or not well formed.
 */
export function compileRegex(pattern: string, flags = ''): (text: string) => boolean {
  const options = parse(pattern, flags);
  const multiline = flags.includes('m');

  const states: State[] = [{ kind: MATCH, next: 0, other: 0 }];
  const tooLarge = (): Error =>
    new Error(`the pattern is too large once its repeats are written out (over ${MAX_REGEX_NODES} parts)`);
  // Every state counts, the branches of `|` and of a repeat too: the time of a match is per state.
  const add = (state: State): number => {
    if (states.length > MAX_REGEX_NODES) throw tooLarge();
    return states.push(state) - 1;
  };
  let built = 0;
  // Each returns the state to enter; `next` is where to go once the node has matched.
  const build = (node: Node, next: number): number => {
    // Counted apart from the states: a repeat of an empty group makes no state and would loop for its count.
    if (++built > MAX_REGEX_NODES) throw tooLarge();
    if (node.t === 'char') return add({ kind: CHAR, next, other: 0, test: node.test });
    if (node.t === 'anchor') return add({ kind: ANCHOR, next, other: 0, anchor: node.kind });
    if (node.t === 'group') return buildOptions(node.options, next);
    let enter = next;
    if (node.max === Infinity) {
      enter = add({ kind: SPLIT, next: 0, other: next });
      states[enter]!.next = build(node.node, enter);
    } else
      for (let k = node.min; k < node.max; k++)
        enter = add({ kind: SPLIT, next: build(node.node, enter), other: enter });
    for (let k = 0; k < node.min; k++) enter = build(node.node, enter);
    return enter;
  };
  const buildOptions = (list: Node[][], next: number): number =>
    list
      .map((sequence) => sequence.reduceRight((after, node) => build(node, after), next))
      .reduceRight((rest, entry) => add({ kind: SPLIT, next: entry, other: rest }));
  const start = buildOptions(options, 0);

  const holds = (anchor: Anchor, text: string, at: number): boolean => {
    if (anchor === 'b' || anchor === 'B') return (isWord(text, at - 1) !== isWord(text, at)) === (anchor === 'b');
    const edge = anchor === '^' ? at === 0 : at === text.length;
    return edge || (multiline && LINE_ENDS.has(text.charCodeAt(anchor === '^' ? at - 1 : at)));
  };

  return (text) => {
    // seen[s] === at: state s is already in the set of position `at`.
    const seen = new Int32Array(states.length).fill(-1);
    let matched = false;
    const enter = (list: number[], from: number, at: number): void => {
      const stack = [from];
      while (stack.length > 0) {
        const s = stack.pop()!;
        if (seen[s] === at) continue;
        seen[s] = at;
        const state = states[s]!;
        if (state.kind === SPLIT) stack.push(state.next, state.other);
        else if (state.kind === ANCHOR) {
          if (holds(state.anchor!, text, at)) stack.push(state.next);
        } else if (state.kind === MATCH) matched = true;
        else list.push(s);
      }
    };
    let current: number[] = [];
    let at = 0;
    enter(current, start, 0);
    while (!matched && at < text.length) {
      const code = text.charCodeAt(at++);
      const following: number[] = [];
      for (const s of current) if (states[s]!.test!(code)) enter(following, states[s]!.next, at);
      // A match may begin at any position.
      enter(following, start, at);
      current = following;
    }
    return matched;
  };
}
