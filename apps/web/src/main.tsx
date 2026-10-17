import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PurchasePage } from './sales/purchase-page';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PurchasePage />
  </StrictMode>,
);
