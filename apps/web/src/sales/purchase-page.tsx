import { useRef, useState } from 'react';
import { normalizeIdentifier } from '@flash/contracts';
import { saleId } from './client';
import { createSession, useOrder, type Session } from './use-order';
import { useSale } from './use-sale';
import './purchase.css';

function rememberedIdentifier() {
  try {
    return localStorage.getItem(`flash-sale:${saleId}`) || '';
  } catch {
    return '';
  }
}
function Purchase({
  identifier,
  session,
  saleOpen,
}: {
  identifier: string;
  session: Session;
  saleOpen: boolean;
}) {
  const order = useOrder(identifier, session);
  return (
    <form
      id="purchase-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (saleOpen || order.uncertain) void order.submit();
      }}
    >
      <button
        type="submit"
        disabled={order.sending || (!saleOpen && !order.uncertain)}
      >
        {order.sending ? 'Submitting…' : 'Buy Now'}
      </button>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="order-status"
      >
        {order.order.status === 'SUCCESS' && (
          <>
            <h3>SUCCESS</h3>
            <p>Your order is confirmed.</p>
            <p className="order-id">Order {order.order.orderId}</p>
          </>
        )}
        {order.order.status === 'PROCESSING' && (
          <>
            <h3>PROCESSING</h3>
            <p>
              {order.order.phase === 'confirming'
                ? 'Confirmation is still pending. Your request may have been placed; we are checking its status.'
                : order.order.phase === 'delayed'
                  ? 'Reservation received. Processing is delayed. We will keep checking.'
                  : 'Reservation received. Waiting for order confirmation.'}
            </p>
          </>
        )}
        {order.order.status === 'NOT_ORDERED' && !order.uncertain && (
          <p>
            {order.checked
              ? 'No order found for this identifier.'
              : 'Checking existing order…'}
          </p>
        )}
        {order.sending && <p>Sending your request…</p>}
        {order.message && <p>{order.message}</p>}
        {order.lookupMessage && <p>{order.lookupMessage}</p>}
      </div>
    </form>
  );
}

export function PurchasePage() {
  const { sale, error, now } = useSale();
  const [input, setInput] = useState(rememberedIdentifier);
  const sessions = useRef(new Map<string, Session>());
  let identifier = '';
  try {
    identifier = normalizeIdentifier(input);
  } catch {
    /* Render the validation hint below. */
  }
  if (identifier && !sessions.current.has(identifier))
    sessions.current.set(identifier, createSession());
  const target =
    sale &&
    Date.parse(sale.status === 'UPCOMING' ? sale.startsAt : sale.endsAt);
  const seconds = target ? Math.max(0, Math.ceil((target - now) / 1000)) : 0;
  return (
    <main>
      <header>
        <p className="eyebrow">ONE PRODUCT · ONE UNIT PER IDENTIFIER</p>
        <h1>Flash sale</h1>
        <p>A limited release. Claim your unit while the sale is open.</p>
      </header>
      <div className="sale-layout">
        <section className="product" aria-labelledby="product-title">
          <div className="product-mark" aria-hidden="true">
            01
          </div>
          <p className="eyebrow">THE RELEASE</p>
          <h2 id="product-title">Limited edition field notebook</h2>
          <p>
            A sturdy everyday notebook for ideas, sketches and plans. One
            notebook per order, with a limited number available.
          </p>
          <p className="muted">
            Prototype purchase: no payment or shipping information required.
          </p>
        </section>
        <section className="purchase" aria-labelledby="purchase-title">
          <h2 id="purchase-title">Reserve your unit</h2>
          <div className="sale-status" role="status">
            <strong>{sale?.status ?? 'Loading sale…'}</strong>
            {sale && <p>{sale.remainingStock} units remaining</p>}
            {error && <p>{error}</p>}
          </div>
          {sale && (sale.status === 'UPCOMING' || sale.status === 'OPEN') && (
            <p className="countdown">
              {sale.status === 'UPCOMING' ? 'Opens' : 'Closes'} in{' '}
              {Math.floor(seconds / 60)}m {seconds % 60}s{' '}
              <span className="muted">(estimate)</span>
            </p>
          )}
          <label htmlFor="identifier">Your identifier</label>
          <input
            id="identifier"
            form="purchase-form"
            value={input}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="identifier-help identifier-error"
            aria-invalid={Boolean(input && !identifier)}
            onChange={(event) => {
              setInput(event.target.value);
              try {
                localStorage.setItem(
                  `flash-sale:${saleId}`,
                  event.target.value,
                );
              } catch {
                /* Optional convenience storage. */
              }
            }}
          />
          <p id="identifier-help" className="muted">
            Use any identifier. Spaces at the edges and letter case are ignored.
            Remembered on this device for convenience; this is not
            authentication.
          </p>
          <p id="identifier-error" className="validation">
            {!identifier
              ? 'Enter a nonempty identifier (up to 1024 UTF-8 bytes, without NUL).'
              : ''}
          </p>
          {identifier ? (
            <Purchase
              key={identifier}
              identifier={identifier}
              session={sessions.current.get(identifier)!}
              saleOpen={sale?.status === 'OPEN' && !error}
            />
          ) : (
            <button disabled>Buy Now</button>
          )}
          <p className="muted">
            The server checks availability when you submit. Pending orders
            continue processing after the sale closes.
          </p>
        </section>
      </div>
    </main>
  );
}
