import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ExplanationDemandOverlay } from '@/components/ExplanationDemandOverlay';
import { AuthContext } from '@/hooks/useAuth';

const HER_ID = '59d45ad2-0d44-433c-b4ec-20927a25c281';
const PREFIX = 'Explanation for CASHREQ-2660d454 (UGX 1,005,000,000) from Nankambo sharimah +256708269084:';

function renderAs(user: unknown) {
  return render(
    <AuthContext.Provider value={{ user } as never}>
      <ExplanationDemandOverlay />
    </AuthContext.Provider>,
  );
}

function demand() {
  return document.body.querySelector('[role="alertdialog"]');
}

function sendLink() {
  return Array.from(document.body.querySelectorAll('a')).find((a) => a.textContent?.includes('Send explanation to CEO'));
}

describe('explanation demand overlay', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('shows nothing to any other signed-in account', () => {
    renderAs({ id: '11111111-1111-1111-1111-111111111111', phone: '+256700000000', user_metadata: {} });
    expect(demand()).toBeNull();
  });

  it('shows nothing while signed out', () => {
    renderAs(null);
    expect(demand()).toBeNull();
  });

  it('shows the red demand to her account with the full message', () => {
    renderAs({ id: HER_ID, phone: '+256708269084', user_metadata: { full_name: 'Nankambo sharimah' } });
    const box = demand();
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain('URGENT: EXPLANATION REQUIRED');
    expect(box?.textContent).toContain('A cash float deposit of UGX 1,005,000,000 (CASHREQ-2660d454)');
    expect(box?.textContent).toContain('UGX 100,000,000 was sent from it to Cherotich Kabbale Sherry');
    expect(box?.textContent).toContain('Benjamin Muhanguzi, CEO');
    expect(box?.querySelector('.bg-red-700')).not.toBeNull();
  });

  it('also recognises her by phone written the local way', () => {
    renderAs({ id: '22222222-2222-2222-2222-222222222222', phone: '0708269084', user_metadata: {} });
    expect(demand()).not.toBeNull();
  });

  it('opens WhatsApp to the CEO with the explanation prefilled and prefixed', () => {
    renderAs({ id: HER_ID, phone: '+256708269084', user_metadata: {} });
    fireEvent.change(document.body.querySelector('textarea')!, {
      target: { value: 'The deposit was mine and I can account for it.' },
    });

    const link = sendLink();
    expect(link).toBeDefined();
    const href = link!.getAttribute('href') ?? '';
    expect(href.startsWith('https://wa.me/256783673998?text=')).toBe(true);

    const decoded = decodeURIComponent(href.replace('https://wa.me/256783673998?text=', ''));
    expect(decoded.startsWith(PREFIX)).toBe(true);
    expect(decoded).toContain('The deposit was mine and I can account for it.');
    expect(link!.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('refuses to send until she has written at least 10 characters', () => {
    renderAs({ id: HER_ID, phone: '+256708269084', user_metadata: {} });
    fireEvent.change(document.body.querySelector('textarea')!, { target: { value: 'short' } });

    const link = sendLink();
    expect(link).toBeDefined();
    expect(link!.getAttribute('aria-disabled')).toBe('true');
    expect(link!.getAttribute('href') ?? '').not.toContain('short');
  });
});
