type Serializable =
  | string
  | number
  | boolean
  | null
  | Serializable[]
  | { [k: string]: Serializable };

function normalizeValue(value: unknown): Serializable {
  if (value === null) return null;

  if (typeof value === 'boolean') return value;

  if (typeof value === 'number') {
    if (!isFinite(value)) {
      throw new Error(
        `canonicalJson: non-finite number rejected: ${String(value)}`,
      );
    }
    // Serialize -0 as 0 (ADR-TC03)
    return value === 0 ? 0 : value;
  }

  if (typeof value === 'string') {
    // NFC normalization (ADR-TC03)
    return value.normalize('NFC');
  }

  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (typeof value === 'object') {
    // Only PLAIN objects (Object.prototype or null prototype) are serializable. A class
    // instance (e.g. Date, Map) has no own enumerable keys or carries hidden state, so a
    // naive key-bag would collapse distinct values to the same bytes — a silent identity
    // collision. Reject it, consistent with the throw-on-unsupported policy (ADR-TC03).
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== null && proto !== Object.prototype) {
      const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
      throw new Error(
        `canonicalJson: unsupported non-plain object (${name}) — only plain objects, arrays, and primitives are serializable`,
      );
    }
    const obj = value as Record<string, unknown>;
    const sorted: { [k: string]: Serializable } = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = normalizeValue(obj[key]);
    }
    return sorted;
  }

  throw new Error(
    `canonicalJson: unsupported value type: ${typeof value}`,
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}
