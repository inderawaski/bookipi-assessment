export const operationalLimits = {
  bodyBytes: 16384,
  requestTargetBytes: 8192,
  identifierBytes: 1024,
  idempotencyKeyBytes: 128,
} as const;

/** ECMAScript trim + locale-independent lowercase; deliberately no NFC/case folding. */
export function normalizeIdentifier(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    normalized.includes('\0') ||
    new TextEncoder().encode(normalized).length >
      operationalLimits.identifierBytes
  ) {
    throw new Error(
      'Identifier must be nonempty, contain no NUL, and fit within 1024 UTF-8 bytes',
    );
  }
  return normalized;
}

export interface PurchaseInput {
  identifier: string;
  idempotencyKey: string;
}
export interface PurchasePayload extends PurchaseInput {
  saleId: string;
}
export function normalizePurchase(
  saleId: string,
  input: PurchaseInput,
): PurchasePayload {
  if (
    !input.idempotencyKey ||
    input.idempotencyKey.length > operationalLimits.idempotencyKeyBytes ||
    /[^\x21-\x7e]/.test(input.idempotencyKey)
  )
    throw new Error('Invalid idempotency key');
  return {
    saleId: normalizeIdentifier(saleId),
    identifier: normalizeIdentifier(input.identifier),
    idempotencyKey: input.idempotencyKey,
  };
}
export function compareSubmission(
  original: PurchasePayload,
  incoming: PurchasePayload,
): 'new' | 'replay' | 'conflict' {
  if (
    original.saleId !== incoming.saleId ||
    original.idempotencyKey !== incoming.idempotencyKey
  )
    return 'new';
  return original.identifier === incoming.identifier ? 'replay' : 'conflict';
}
