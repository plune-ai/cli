// Public surface of the providers module — what the orchestrator (and CLI) import.

export { getProvider, createProviderRegistry, createDefaultRegistry } from './registry.js';
export type { ProviderRegistry, ProviderFactory } from './registry.js';

export { AuthError, ProviderError, classifyError, redactSecrets } from './errors.js';
export type { ErrorClass } from './errors.js';

export { computeCost } from './cost.js';
export type { Usage } from './cost.js';

export { PRICE_TABLE } from './prices.js';
