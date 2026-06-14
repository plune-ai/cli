export class ConfigNotFoundError extends Error {
  readonly code = 'CFG_NOT_FOUND' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ConfigNotFoundError';
  }
}

export class YamlParseError extends Error {
  readonly code = 'YAML_PARSE_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'YamlParseError';
  }
}

export class ConfigValidationError extends Error {
  readonly code = 'CONFIG_VALIDATION_ERROR' as const;
  readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

export class NonTtyError extends Error {
  constructor() {
    super('runInitWizard requires an interactive terminal (TTY)');
    this.name = 'NonTtyError';
  }
}
