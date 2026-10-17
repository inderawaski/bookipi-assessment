import { describe, it, expect } from 'vitest';
import {
  normalizeIdentifier,
  normalizePurchase,
  compareSubmission,
} from './identity.js';
import {
  canTransitionSubmission,
  isAdmissionOpen,
  purchaseHttpStatus,
  reconcileOrder,
  type PurchaseResponse,
} from './state.js';

describe('sale identity and submission contract', () => {
  it('normalizes whitespace and case without imposing email/username rules', () => {
    expect(normalizeIdentifier(' \tAlice@Example.COM.\n')).toBe(
      'alice@example.com.',
    );
    expect(normalizeIdentifier(' . @ ')).toBe('. @');
    expect(normalizeIdentifier('\u00a0ÄİΣ\u00a0')).toBe('äi\u0307ς');
    expect(normalizeIdentifier('É')).not.toBe(normalizeIdentifier('E\u0301'));
    expect(normalizeIdentifier('ß')).not.toBe(normalizeIdentifier('SS'));
  });
  it('enforces UTF-8 storage limits after normalization', () => {
    expect(normalizeIdentifier('é'.repeat(512))).toHaveLength(512);
    for (const value of ['', ' \n', 'a\0b', 'é'.repeat(513)])
      expect(() => normalizeIdentifier(value)).toThrow();
  });
  it('replays normalized payloads, conflicts on changed identifiers and scopes keys to a sale', () => {
    const original = normalizePurchase(' Sale ', {
      identifier: 'Alice',
      idempotencyKey: 'key',
    });
    expect(
      compareSubmission(
        original,
        normalizePurchase('sale', {
          identifier: ' ALICE ',
          idempotencyKey: 'key',
        }),
      ),
    ).toBe('replay');
    expect(
      compareSubmission(
        original,
        normalizePurchase('sale', { identifier: 'bob', idempotencyKey: 'key' }),
      ),
    ).toBe('conflict');
    expect(
      compareSubmission(
        original,
        normalizePurchase('sale2', {
          identifier: 'bob',
          idempotencyKey: 'key',
        }),
      ),
    ).toBe('new');
    expect(
      compareSubmission(
        original,
        normalizePurchase('sale', {
          identifier: 'alice',
          idempotencyKey: 'new-key',
        }),
      ),
    ).toBe('new');
    for (const key of ['', 'key\n', 'a b', 'é', 'k'.repeat(129)])
      expect(() =>
        normalizePurchase('sale', { identifier: 'alice', idempotencyKey: key }),
      ).toThrow();
  });
});

describe('state safety', () => {
  it('includes opening and excludes closing with Redis time', () => {
    expect(
      [99, 100, 199, 200].map((now) => isAdmissionOpen(100, 200, now)),
    ).toEqual([false, true, true, false]);
  });
  it('allows acknowledgement loss before commit while committed orders remain final', () => {
    expect(canTransitionSubmission('unresolved', 'rejected')).toBe(true);
    expect(canTransitionSubmission('reserved', 'acknowledged')).toBe(true);
    expect(canTransitionSubmission('acknowledged', 'persisted')).toBe(true);
    for (const state of ['reserved', 'acknowledged', 'persisted'] as const)
      expect(canTransitionSubmission(state, 'rejected')).toBe(false);
    expect(canTransitionSubmission('reserved', 'persisted')).toBe(true);
    expect(canTransitionSubmission('acknowledged', 'lost')).toBe(true);
    expect(canTransitionSubmission('persisted', 'lost')).toBe(false);
    expect(canTransitionSubmission('persisted', 'reserved')).toBe(false);
  });
  it('keeps committed orders final and permits fresh absence to clear a provisional reservation', () => {
    const success = { status: 'SUCCESS', orderId: 'order-1' } as const;
    const queued = { status: 'PROCESSING', phase: 'queued' } as const;
    const rejected = { status: 'REJECTED', reason: 'sold_out' } as const;
    expect(reconcileOrder(success, rejected)).toEqual(success);
    expect(reconcileOrder(queued, rejected)).toEqual(queued);
    expect(reconcileOrder(success, queued)).toEqual(success);
    expect(reconcileOrder(queued, { status: 'NOT_ORDERED' })).toEqual({
      status: 'NOT_ORDERED',
    });
    expect(
      reconcileOrder(queued, {
        status: 'NOT_ORDERED',
        reason: 'confirmation_uncertain',
      }),
    ).toEqual(queued);
    expect(
      reconcileOrder(success, {
        status: 'NOT_ORDERED',
        reason: 'confirmation_uncertain',
      }),
    ).toEqual(success);
    expect(
      reconcileOrder(queued, { status: 'PROCESSING', phase: 'confirming' }),
    ).toEqual(queued);
    expect(
      reconcileOrder(
        { status: 'NOT_ORDERED' },
        {
          status: 'REJECTED',
          reason: 'already_placed',
          existingOrder: success,
        },
      ),
    ).toEqual(success);
  });
  it('maps uncertainty separately from definite pre-admission rejection', () => {
    const cases: [PurchaseResponse, number][] = [
      [{ status: 'PROCESSING', phase: 'confirming' }, 202],
      [{ status: 'NOT_ORDERED', reason: 'confirmation_uncertain' }, 202],
      [{ status: 'SUCCESS', orderId: '1' }, 200],
      ...(
        ['upcoming', 'ended', 'sold_out', 'idempotency_conflict'] as const
      ).map(
        (reason) =>
          [{ status: 'REJECTED', reason }, 409] as [PurchaseResponse, number],
      ),
      [{ status: 'REJECTED', reason: 'invalid_input' }, 400],
      [{ status: 'REJECTED', reason: 'busy' }, 429],
      [{ status: 'REJECTED', reason: 'unavailable' }, 503],
      [
        {
          status: 'REJECTED',
          reason: 'already_placed',
          existingOrder: { status: 'PROCESSING', phase: 'delayed' },
        },
        409,
      ],
    ];
    for (const [response, code] of cases)
      expect(purchaseHttpStatus(response)).toBe(code);
  });
});
