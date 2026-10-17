import { normalizePurchase, type PurchaseInput } from '@flash/contracts';
import { saleKey } from './configuration.js';
import { admissionScript } from './admission-script.js';

export function admissionKeys(
  saleId: string,
): [string, string, string, string, string] {
  const prefix = saleKey(saleId);

  return [
    prefix,
    `${prefix}:identifiers`,
    `${prefix}:requests`,
    `${prefix}:reservations`,
    `${prefix}:stream`,
  ];
}

export interface Reservation {
  requestKey: string;
  admittedAtMs: number;
  streamId: string;
}

/** A primary-memory acknowledgement; it may be lost before persistence/replication. */
export type AdmissionResult =
  | { status: 'reserved'; reservation: Reservation; replay: boolean }
  | { status: 'already_placed'; reservation: Reservation }
  | {
      status: 'rejected';
      reason: 'upcoming' | 'ended' | 'sold_out' | 'idempotency_conflict';
    };

export class AdmissionUncertainError extends Error {
  constructor(cause: unknown) {
    super('Admission outcome uncertain; reconcile before resolving', { cause });
  }
}

/** @internal Volatile evidence only. Public placement and workers must use RedisAdmission. */
export async function admitPurchase(
  redis: { sendCommand(args: string[]): Promise<unknown> },
  saleId: string,
  input: PurchaseInput,
): Promise<AdmissionResult> {
  const payload = normalizePurchase(saleId, input);

  try {
    const result = await redis.sendCommand(purchaseCommand(payload));

    return parseAdmissionReply(result);
  } catch (cause) {
    // Even a timeout can mean the script committed. Never guess a business rejection.
    throw new AdmissionUncertainError(cause);
  }
}

/** Parse after returning the purchase connection to the pool. */
export function parseAdmissionReply(result: unknown): AdmissionResult {
  try {
    if (!Array.isArray(result)) throw new Error('Invalid admission result');

    const [status, key, timestamp, streamId, kind] = result;

    if (
      status === 'rejected' &&
      ['upcoming', 'ended', 'sold_out', 'idempotency_conflict'].includes(key)
    ) {
      return {
        status,
        reason: key as
          'upcoming' | 'ended' | 'sold_out' | 'idempotency_conflict',
      };
    }

    if (
      (status !== 'reserved' && status !== 'already_placed') ||
      typeof key !== 'string' ||
      typeof timestamp !== 'string' ||
      !/^\d+$/.test(timestamp) ||
      !Number.isSafeInteger(Number(timestamp)) ||
      typeof streamId !== 'string' ||
      !/^\d+-\d+$/.test(streamId) ||
      (status === 'reserved' && kind !== 'new' && kind !== 'replay')
    )
      throw new Error('Invalid admission result');

    const reservation = {
      requestKey: key,
      admittedAtMs: Number(timestamp),
      streamId,
    };

    return status === 'reserved'
      ? { status, reservation, replay: kind === 'replay' }
      : { status, reservation };
  } catch (cause) {
    throw new AdmissionUncertainError(cause);
  }
}

export function purchaseCommand(
  payload: PurchaseInput & { saleId: string },
): string[] {
  return [
    'EVAL',
    admissionScript,
    '5',
    ...admissionKeys(payload.saleId),
    payload.identifier,
    payload.idempotencyKey,
    payload.saleId,
  ];
}
