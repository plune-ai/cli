/**
 * The context budget of `plune mcp serve`, in estimated tokens (`size.charsPerToken`). Measured 2026-11-10 on the real
 * server's `tools/list` (src/mcp-testing/__tests__/plune-tools-budget.test.ts); each limit is the measure plus
 * `headroom`, rounded up. A limit is also held from below: a measure under `tooLooseShare` of its limit fails too, so
 * the headroom cannot grow unnoticed. A change that moves a measure sets its limit again by the same rule.
 */
const PLUNE_BUDGET = {
  /** A limit is the measure times (1 + headroom), rounded up. */
  headroom: 0.1,
  /** A measure below this share of its limit means the limit is too loose: with 10% headroom a list may shrink ~12%. */
  tooLooseShare: 0.8,
  /** Whole tool lists, outputSchema and annotations included. */
  lists: {
    /** 2025 era, write scope, as listed first: 17 tools, measured 8429 (8327 before the memory rules of plune_project_context). */
    writeFirst: 9272,
    /** 2025 era, write scope, after plune_discover_tools: 22 tools, measured 10841 (10739 before the memory rules). */
    writeAll: 11926,
    /** Read scope, either era: 8 tools, measured 2482 (2380 before the memory rules). */
    read: 2731,
    /** 2026-07-28 era, write scope: 17 tools, the list does not change after discover; measured 8429 (8327 before the memory rules). */
    modernWrite: 9272,
  },
  /** The biggest single tool, plune_strategy_propose, measured 2177. */
  largestTool: 2395,
  /**
   * The text content of an answer, on live answers recorded in plune-budget.fixtures.ts, measured 2026-11-14 with the
   * text unindented (before, with a two-space indent): the beta demo project of 2026-11-10 (cases in Ukrainian) gives
   * plune_project_context with 3 projects, 3 suites, no missions 387 (548); plune_cases_search 7678 (10509) for the
   * whole project of 48 cases (a page of 100 is not reached); plune_review_list of 7 pending entries 695 (895). The demo
   * has no missions, so plune_mission_get reads a mission with 5 sources captured live on a beta test project on
   * 2026-11-14: 455 (585; the synthetic mission it replaced measured 476 indented, under its limit of 524).
   */
  answers: { plune_project_context: 426, plune_cases_search: 8446, plune_review_list: 765, plune_mission_get: 501 },
} as const;

/**
 * Every threshold and word list the lint rules use, in one place: the rule bodies hold no numbers and no words of
 * their own. Word lists are per language; a text in a language that is not listed here makes a word rule stay
 * silent rather than report "no English word found" against it.
 */
export const LINT_THRESHOLDS = {
  description: {
    /** Shorter than this many characters says too little for a model to choose the tool. */
    minLength: 40,
    /** Longer than this many characters costs every request and buries the point. */
    maxLength: 1000,
  },
  names: {
    /** The specification's length bound for a tool name. */
    maxLength: 128,
    /** A naming style is the server's convention when more than this share of its tools use it. */
    majorityShare: 0.5,
  },
  similarity: {
    /** Word-set overlap (Jaccard) of two names, the shared server prefix left out, above which they are confusable. */
    names: 0.75,
    /** Word-set overlap of two descriptions above which a model cannot tell the tools apart. */
    descriptions: 0.6,
    /** Overlap of two descriptions above which the tools are related enough that "when not to use" matters more. */
    related: 0.35,
    /** Words shorter than this are left out of a description's word set. */
    minWordLength: 3,
    /** Decimals an overlap is reported with. */
    decimals: 2,
    /**
     * Tools above which the rules that compare every pair (`tools-similar`, `desc-no-when-not`) do not run and say
     * `could-not-run`: the work grows with the square of a count the server chooses. Measured 2026-11-10 on one
     * desktop core, with no two tools alike (the slowest case: no early stop): at 1000 tools the two rules take 0.25 s
     * with 60-character descriptions and 2.3 s with 1000-character ones (`description.maxLength`); at 4000 short ones,
     * 4.5 s. Well above the tool lists of real servers, which hold tens to hundreds.
     */
    maxTools: 1000,
  },
  schema: {
    /**
     * Levels an input schema may nest (a named property, or an array's items, is one level below the node it is in)
     * for the rules that read every node of it (`required-unknown-property`, `param-example-missing`); deeper, they
     * say `could-not-run` for the tool. The server chooses the depth, and a node's path is as long as its depth.
     * Hand-written and generated schemas nest to about 10-20 levels; 64 leaves three times that, and is the number
     * the `--call` path stops copying an output schema at (counted there in JSON levels, two to a property).
     * Measured 2026-11-10 on one desktop core: the two rules take 0.03 ms on a chain exactly 64 levels deep (0.09 ms
     * with two siblings and an array at every level), and stop within 0.2 ms on a chain of 100 000 levels. The
     * recursive walk this replaced overflowed the call stack at 10 000 levels.
     */
    maxDepth: 64,
  },
  size: {
    /**
     * Estimated tokens of the whole visible tool list above which the list is reported: the limit of our own biggest
     * list (`budget.lists.writeAll`), so a server that costs more than all of ours is told so.
     */
    maxListTokens: PLUNE_BUDGET.lists.writeAll,
    /**
     * The estimate: characters of a tool's JSON divided by this, rounded up, summed over the tools. No tokenizer, no
     * network, the same number in CI on every run; a limit is a measure plus headroom, never an exact token count.
     * Calibrated 2026-11-10 against a provider's token-counting endpoint on two current models (both gave the same
     * counts): the estimate is low. On the same JSON (name, description, input schema: the fields a model API takes) a
     * tool list costs 1.57-1.72 times the estimate, the tool-use preamble of ~320 tokens left out; the largest live
     * answer (JSON with Ukrainian text) 1.84 times. The limits stay in estimated tokens; for real tokens multiply by
     * ~1.7 (English JSON) to ~1.85 (Cyrillic). Table: docs/features/mcp-context-budget/budget.md.
     */
    charsPerToken: 4,
    budget: PLUNE_BUDGET,
  },
  call: {
    /**
     * Estimated tokens of one `tools/call` result (its JSON, as the client receives it) above which the answer is
     * reported: the limit of our own biggest answer (`budget.answers.plune_cases_search`), as `maxListTokens` is for
     * the list.
     */
    maxResultTokens: PLUNE_BUDGET.answers.plune_cases_search,
  },
  language: {
    /**
     * A text is taken to be in a listed language when at least this many of its stop words occur; two, so a lone
     * "a" or "in" of another Latin-script language does not pass for English.
     */
    minStopwords: 2,
  },
  /** Name words that say a tool returns a list, so it should take a page size or cursor. */
  listVerbs: ['list', 'search', 'find', 'query', 'browse'],
  /** Parameter names that page a list. */
  pagingParams: ['limit', 'cursor', 'page', 'offset', 'pagesize', 'perpage', 'per_page', 'page_size', 'pagetoken', 'page_token'],
  /** Name words of a tool that changes something; a read-only hint on such a tool contradicts its name. */
  writeVerbs: ['create', 'add', 'update', 'edit', 'delete', 'remove', 'set', 'write', 'put', 'patch', 'insert', 'replace', 'send'],
  /** Name words of a tool that overwrites or removes, which is not an "additive only" update. */
  overwriteVerbs: ['update', 'edit', 'set', 'replace', 'delete', 'remove', 'overwrite', 'patch', 'clear', 'reset', 'rename', 'move'],
  /** Parameter name words that say the value is not free text. Booleans only by the first word (`isActive`). */
  typedParamWords: {
    number: ['count', 'limit', 'max', 'min', 'size', 'offset', 'total', 'amount', 'number', 'port', 'timeout', 'retries', 'quantity', 'index'],
    boolean: ['is', 'has', 'can', 'should', 'allow', 'enable', 'enabled'],
    date: ['date', 'time', 'timestamp', 'since', 'until', 'deadline'],
    url: ['url', 'uri', 'href', 'link', 'endpoint', 'website'],
  },
  /**
   * Words by language. `script` is the alphabet the language is written in; `letters`, when given, are letters the
   * language has and its neighbours in the same alphabet do not, so a Russian text is not read as Ukrainian.
   * Phrases match at the start of a word, so a stem (`не використов`) covers its inflected forms.
   */
  languages: {
    en: {
      script: 'Latin',
      letters: '',
      stopwords: ['the', 'a', 'an', 'to', 'of', 'and', 'or', 'is', 'are', 'in', 'for', 'with', 'it', 'its', 'as', 'at', 'be', 'not', 'can', 'you', 'your', 'this', 'that', 'them', 'by', 'on', 'from', 'if', 'when', 'each'],
      whenNot: ['do not', "don't", 'instead', 'rather than', 'only', 'not for', 'avoid', 'never'],
      example: ['e.g.', 'for example', 'for instance', 'such as', 'example'],
      closedSet: ['one of', 'either'],
    },
    uk: {
      script: 'Cyrillic',
      letters: 'іїєґ',
      stopwords: ['і', 'й', 'та', 'в', 'у', 'на', 'з', 'із', 'що', 'це', 'до', 'не', 'для', 'як', 'або', 'коли', 'його', 'її', 'від'],
      whenNot: ['не використов', 'не виклик', 'не застосов', 'замість', 'лише', 'тільки', 'не для', 'ніколи'],
      example: ['наприклад', 'напр.', 'приклад', 'зокрема'],
      closedSet: ['одне з', 'один з', 'одна з', 'одне із', 'один із', 'одна із'],
    },
  },
} as const;

export type LanguageCode = keyof typeof LINT_THRESHOLDS.languages;
