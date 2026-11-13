/**
 * The phrase lists of the heuristic `scan/desc/*` rules, kept as data apart from the rule code and versioned: a finding
 * is read against the list that produced it, so every change to a list raises `version`. Each entry is the source of a
 * regular expression, matched without regard to letter case; a space in it matches any run of white space.
 *
 * English only. A description in another language, or the same request in other words, passes unseen, and a tool that
 * really reads files says so in its description: that is why these rules are advice and name the match, not a verdict.
 */
export const DESCRIPTION_PHRASES = {
  version: 1,
  rules: {
    'scan/desc/override-instruction': [
      '\\b(?:ignore|disregard|forget|override) (?:all |any )?(?:of )?(?:the |your |my )?(?:previous|prior|above|earlier|preceding|other|system) (?:instructions?|prompts?|messages?|rules?|context)',
      '\\b(?:ignore|disregard) (?:all |any )?(?:of )?(?:the |your )?(?:previous|prior|above|earlier|preceding)\\b',
      '\\bnew (?:system )?instructions:',
      '\\byou are now (?:a|an|in)\\b',
    ],
    'scan/desc/sensitive-path': [
      '(?<![\\w.~])(?:~/)?\\.ssh\\b',
      '\\bid_(?:rsa|dsa|ecdsa|ed25519)\\b',
      '(?<![\\w.~])(?:~/)?\\.aws/(?:credentials|config)\\b',
      '(?<![\\w.~])(?:~/)?\\.env\\b',
      '(?<![\\w.~])(?:~/)?\\.(?:npmrc|pypirc|netrc|pgpass|git-credentials)\\b',
      '(?<![\\w.~])(?:~/)?\\.(?:docker/config\\.json|kube/config|gnupg|config/gcloud)\\b',
      '/etc/(?:shadow|passwd)\\b',
      '\\bcredentials\\.json\\b',
      '\\bread (?:the )?(?:contents? of )?(?:the |any |a )?(?:file|files)\\b',
    ],
    'scan/desc/conceal-from-user': [
      "\\b(?:do not|don't|dont|never) (?:tell|inform|notify|alert|mention (?:this |it )?to|reveal (?:this |it )?to|show (?:this |it )?to) (?:the )?user",
      '\\bwithout (?:telling|informing|notifying|alerting) (?:the )?user',
      '\\b(?:hide|conceal|keep) (?:this |it |that )?(?:secret |hidden )?from (?:the )?user',
      '\\bthe user (?:must|should) not (?:know|see|be told)',
    ],
    'scan/desc/call-other-tool-first': [
      '\\b(?:before|prior to) (?:using|calling|invoking|running) this tool,? (?:you )?(?:must |should |always )?(?:first )?(?:call|use|invoke|run)\\b',
      '\\b(?:always |must )?(?:first )?(?:call|invoke|run) (?:the )?[\\w.-]+ (?:tool )?(?:first|beforehand|before (?:this|using this|calling this))\\b',
      '\\binstead of (?:this tool|calling this tool|using this tool),? (?:call|use|invoke)\\b',
    ],
    'scan/desc/param-asks-for-context': [
      '\\b(?:the )?(?:entire|full|whole|complete) (?:conversation|chat|dialog(?:ue)?|history|context|transcript)',
      '\\bconversation history\\b',
      '\\b(?:all |the )?(?:previous|prior|earlier) messages\\b',
      '\\bsystem prompt\\b',
      '\\b(?:contents?|text) of (?:the |any |a )?(?:file|files|document)\\b',
      '\\b(?:output|result|response) (?:of|from) (?:the |another |other |any )?(?:tools?)\\b',
    ],
  },
} as const;
