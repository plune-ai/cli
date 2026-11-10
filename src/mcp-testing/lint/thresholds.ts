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
  },
  size: {
    /**
     * Estimated tokens of the whole visible tool list above which the list is reported. An estimate; it will be
     * replaced by an exact token count.
     */
    maxListTokens: 12_000,
    /** The estimate: characters of a tool's JSON divided by this, rounded up, summed over the tools. */
    charsPerToken: 4,
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
