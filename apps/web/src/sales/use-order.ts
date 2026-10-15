import { useEffect, useRef, useState } from 'react';
import { reconcileOrder, type OrderState, type RejectionReason } from '@flash/contracts';
import { getOrder, placeOrder, pollDelay } from './client';

export interface Session {
  order: OrderState;
  checked: boolean;
  key?: string;
  uncertain: boolean;
  sending: boolean;
  message: string;
  lookupMessage: string;
}
export function createSession(): Session {
  return { order: { status: 'NOT_ORDERED' }, checked: false, uncertain: false, sending: false, message: '', lookupMessage: '' };
}
const rejections: Record<RejectionReason, string> = {
  upcoming: 'The sale has not opened yet.', ended: 'The sale has ended.', sold_out: 'The sale is sold out.',
  busy: 'The service is busy. Please try again.', unavailable: 'The service is unavailable. Please try again.',
  invalid_input: 'The identifier could not be accepted.', idempotency_conflict: 'Request conflict. Check your order status before trying again.',
  not_found: 'Sale not found. Check the sale link.',
};

// The component is keyed by normalized identity. Sessions retain retry keys only in memory.
export function useOrder(identifier: string, session: Session) {
  const [, render] = useState(0);
  const active = useRef(false);
  const lookupVersion = useRef(0);
  const notify = () => { if (active.current) render(value => value + 1); };
  useEffect(() => {
    active.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    async function lookup() {
      const version = lookupVersion.current;
      try {
        const result = await getOrder(identifier);
        if (!active.current) return;
        if (version === lookupVersion.current) {
          if (result.status === 'AVAILABLE') {
            session.checked = true;
            session.order = reconcileOrder(session.order, result.order);
            if (result.order.status !== 'NOT_ORDERED' && session.uncertain) {
              session.uncertain = false; session.message = '';
            }
            session.lookupMessage = '';
          } else session.lookupMessage = result.status === 'UNAVAILABLE' ? 'Order status unavailable. Reconnecting…' : rejections[result.reason];
          notify();
        }
      } catch {
        if (!active.current) return;
        if (version === lookupVersion.current) { session.lookupMessage = 'Connection lost. Checking your order again shortly.'; notify(); }
      }
      if (!active.current) return;
      // Completed orders need no polling. Pending work continues after sale closure.
      if (session.order.status !== 'SUCCESS') timer = setTimeout(() => void lookup(), pollDelay(attempt++));
    }
    timer = setTimeout(() => void lookup(), 300);
    return () => { active.current = false; clearTimeout(timer); };
  }, [identifier, session]);

  async function submit() {
    if (session.sending) return;
    session.sending = true; session.message = ''; lookupVersion.current++;
    if (!session.uncertain || !session.key) session.key = crypto.randomUUID();
    notify();
    try {
      const result = await placeOrder(identifier, session.key);
      session.order = reconcileOrder(session.order, result);
      session.uncertain = false;
      if (result.status === 'REJECTED') {
        session.message = result.reason === 'already_placed' ? 'Already placed: this identifier already has an order.' : rejections[result.reason];
      }
      session.key = undefined;
    } catch {
      // Delivery may have reached Redis. Only replay this key; never guess rejection.
      session.uncertain = true;
      session.message = 'Confirmation uncertain. We are checking your order. Retry confirmation safely with the same request.';
    } finally {
      session.sending = false; lookupVersion.current++; notify();
    }
  }
  return { ...session, submit };
}
