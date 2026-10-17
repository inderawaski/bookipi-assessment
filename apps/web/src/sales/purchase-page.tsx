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
  unavailable,
}: {
  identifier: string;
  session: Session;
  unavailable: string;
}) {
  const order = useOrder(identifier, session);
  const canPurchase =
    !order.sending && order.order.status === 'NOT_ORDERED' && !unavailable;

  return (
    <form
      id="purchase-form"
      onSubmit={(event) => {
        event.preventDefault();

        if (canPurchase) void order.submit();
      }}
    >
      {canPurchase && <button type="submit">Buy Now</button>}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={`order-status order-status--${order.order.status.toLowerCase()} ${!canPurchase ? 'purchase-info' : ''}`}
      >
        {order.order.status === 'NOT_ORDERED' &&
          !order.sending &&
          unavailable && <h3>{unavailable}</h3>}
        {order.order.status === 'SUCCESS' && (
          <>
            <h3>Order confirmed</h3>
            <p className="order-id">Order {order.order.orderId}</p>
          </>
        )}
        {order.order.status === 'PROCESSING' && (
          <>
            <h3>Confirming your order</h3>
            <p>
              {order.order.phase === 'confirming'
                ? 'We’re checking your order. Please wait.'
                : order.order.phase === 'delayed'
                  ? 'This is taking a little longer. We’re still checking.'
                  : 'Your order is being confirmed.'}
            </p>
          </>
        )}
        {!unavailable &&
          !order.sending &&
          !order.checked &&
          !order.uncertain &&
          order.order.status === 'NOT_ORDERED' && <p>Checking your order…</p>}
        {order.sending && <h3>Submitting your order…</h3>}
        {order.message && (
          <p>
            {unavailable && order.uncertain
              ? 'We’re still checking your order.'
              : order.message}
          </p>
        )}
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

  const countdown = [
    Math.floor(seconds / 3600),
    Math.floor((seconds % 3600) / 60),
    seconds % 60,
  ];
  const statusText = error
    ? 'Reconnecting…'
    : sale
      ? {
          UPCOMING: 'Coming soon',
          OPEN: 'Sale is live',
          ENDED: 'Sale ended',
          SOLD_OUT: 'Sold out',
        }[sale.status]
      : 'Loading sale…';
  const showCountdown = sale?.status === 'UPCOMING' || sale?.status === 'OPEN';

  const unavailable = error
    ? 'Buying is temporarily unavailable. Reconnecting…'
    : !sale
      ? 'Checking sale availability…'
      : {
          UPCOMING: 'The sale hasn’t started yet.',
          OPEN: '',
          ENDED: 'This sale has ended.',
          SOLD_OUT: 'This notebook is sold out.',
        }[sale.status];

  return (
    <main className="sale-page">
      <header className="page-header">
        <h1>THE KILLER DEAL</h1>
      </header>
      <section className="sale-timing" aria-label="Sale timing">
        <p
          className={`sale-status ${sale?.status === 'OPEN' && !error ? 'sale-status--live' : ''}`}
          role="status"
        >
          <span className="status-dot" aria-hidden="true" />
          {statusText}
        </p>
        {showCountdown && (
          <div className="countdown">
            <p className="countdown-caption">
              {sale.status === 'UPCOMING' ? 'Starts in' : 'Ends in'}
            </p>
            <div
              className="countdown-digits"
              role="timer"
              aria-label={`${countdown[0]} hours, ${countdown[1]} minutes, ${countdown[2]} seconds`}
            >
              {countdown.map((value, index) => (
                <div className="countdown-unit" key={index}>
                  <span>{String(value).padStart(2, '0')}</span>
                  <span className="countdown-label">
                    {['Hours', 'Min', 'Sec'][index]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {error && (
          <p className="sale-error" role="alert">
            {error}
          </p>
        )}
      </section>
      <section className="product" aria-labelledby="product-title">
        <div className="product-image">
          <img
            src="/images/limited-edition-notebook.png"
            alt="Black Death Note notebook"
            width="798"
            height="776"
          />
        </div>
        <h2 id="product-title">Limited Edition Notebook</h2>
        <p className="product-description">
          The ultimate productivity journal. Get things done. And occasionally,
          people.
        </p>
        <p className="availability" role="status">
          {sale ? `${sale.remainingStock} available` : 'Checking availability…'}
        </p>
      </section>
      <section className="purchase" aria-label="Purchase notebook">
        <label htmlFor="identifier">Username</label>
        <input
          id="identifier"
          form="purchase-form"
          value={input}
          placeholder="Enter your username"
          autoComplete="username"
          spellCheck={false}
          aria-describedby={
            input && !identifier ? 'identifier-error' : undefined
          }
          aria-invalid={Boolean(input && !identifier)}
          onChange={(event) => {
            setInput(event.target.value);
            try {
              localStorage.setItem(`flash-sale:${saleId}`, event.target.value);
            } catch {
              /* Optional convenience storage. */
            }
          }}
        />
        {input && !identifier && (
          <p id="identifier-error" className="validation">
            Please enter a valid username.
          </p>
        )}
        {identifier ? (
          <Purchase
            key={identifier}
            identifier={identifier}
            session={sessions.current.get(identifier)!}
            unavailable={unavailable}
          />
        ) : (
          <div className="purchase-info" role="status">
            {unavailable ||
              (input
                ? 'Enter a valid username to buy.'
                : 'Enter your username to buy.')}
          </div>
        )}
      </section>
    </main>
  );
}
