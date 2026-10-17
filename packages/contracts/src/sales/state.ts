export type ProcessingOrder = {
  status: 'PROCESSING';
  phase: 'confirming' | 'queued' | 'delayed';
};

export type SuccessfulOrder = { status: 'SUCCESS'; orderId: string };

export type AllocatedOrder = ProcessingOrder | SuccessfulOrder;

export type UnconfirmedOrder = {
  status: 'NOT_ORDERED';
  reason: 'confirmation_uncertain';
};

export type OrderState =
  { status: 'NOT_ORDERED'; reason?: 'confirmation_uncertain' } | AllocatedOrder;

export type RejectionReason =
  | 'upcoming'
  | 'ended'
  | 'sold_out'
  | 'invalid_input'
  | 'idempotency_conflict'
  | 'busy'
  | 'unavailable'
  | 'not_found';

export type PurchaseResponse =
  | AllocatedOrder
  | UnconfirmedOrder
  | { status: 'REJECTED'; reason: RejectionReason }
  | {
      status: 'REJECTED';
      reason: 'already_placed';
      existingOrder: AllocatedOrder | UnconfirmedOrder;
    };

export type LookupResponse =
  | { status: 'AVAILABLE'; order: OrderState }
  | { status: 'UNAVAILABLE'; reason: 'unavailable' }
  | { status: 'REJECTED'; reason: 'invalid_input' | 'not_found' };

export interface SaleStatus {
  saleId: string;
  startsAt: string;
  endsAt: string;
  observedAt: string;
  status: 'UPCOMING' | 'OPEN' | 'ENDED' | 'SOLD_OUT';
  remainingStock: number;
}

export type SaleResponse =
  | SaleStatus
  | { status: 'UNAVAILABLE'; reason: 'unavailable' }
  | { status: 'REJECTED'; reason: 'invalid_input' | 'not_found' };

/** Admission must evaluate this predicate with Redis TIME, never the API/client clock. */
export function isAdmissionOpen(
  startsAtMs: number,
  endsAtMs: number,
  redisNowMs: number,
): boolean {
  return startsAtMs <= redisNowMs && redisNowMs < endsAtMs;
}

export function purchaseHttpStatus(response: PurchaseResponse): number {
  if (response.status === 'PROCESSING' || response.status === 'NOT_ORDERED')
    return 202;

  if (response.status === 'SUCCESS') return 200;

  switch (response.reason) {
    case 'invalid_input':
      return 400;
    case 'not_found':
      return 404;
    case 'busy':
      return 429;
    case 'unavailable':
      return 503;
    default:
      return 409;
  }
}

export type InternalSubmissionState =
  | 'unresolved'
  | 'reserved'
  | 'acknowledged'
  | 'persisted'
  | 'rejected'
  | 'lost';

export function canTransitionSubmission(
  from: InternalSubmissionState,
  to: InternalSubmissionState,
): boolean {
  if (from === to) return true;

  switch (from) {
    case 'unresolved':
      return to === 'reserved' || to === 'rejected';
    case 'reserved':
      return to === 'acknowledged' || to === 'persisted' || to === 'lost';
    case 'acknowledged':
      return to === 'persisted' || to === 'lost';
    default:
      return false;
  }
}

/** Rejections describe submissions and never overwrite an identifier's allocation. */
export function reconcileOrder(
  current: OrderState,
  incoming: OrderState | PurchaseResponse,
): OrderState {
  if (incoming.status === 'REJECTED') {
    return incoming.reason === 'already_placed'
      ? reconcileOrder(current, incoming.existingOrder)
      : current;
  }

  if (current.status === 'SUCCESS') return current;

  if (
    current.status === 'PROCESSING' &&
    ((incoming.status === 'NOT_ORDERED' &&
      incoming.reason === 'confirmation_uncertain') ||
      (current.phase !== 'confirming' &&
        incoming.status === 'PROCESSING' &&
        incoming.phase === 'confirming'))
  )
    return current;

  return incoming;
}
