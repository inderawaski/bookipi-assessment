import { useEffect, useState } from 'react';
import type { SaleStatus } from '@flash/contracts';
import { getSale } from './client';

export function useSale() {
  const [sale, setSale] = useState<SaleStatus>();
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    async function refresh() {
      let delay = 5000;

      try {
        const response = await getSale();

        if (stopped) return;

        if ('saleId' in response) {
          setSale(response);
          setError('');

          if (response.status === 'ENDED' || response.status === 'SOLD_OUT')
            delay = 30000;
        } else
          setError(
            response.status === 'REJECTED'
              ? 'Sale not found. Check the sale link.'
              : 'Sale status unavailable. Reconnecting…',
          );
      } catch {
        if (!stopped) setError('Sale status unavailable. Reconnecting…');
      }

      if (!stopped) timer = setTimeout(() => void refresh(), delay);
    }

    void refresh();

    const clock = setInterval(() => setNow(Date.now()), 1000);

    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, []);

  return { sale, error, now };
}
