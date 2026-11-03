import { useContext, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AuthContext } from '@/hooks/useAuth';

/**
 * Management explanation demand — hardcoded, no database.
 *
 * Shown on every page to exactly one account (Nankambo sharimah,
 * +256 708 269 084). The explanation is handed to the CEO over WhatsApp;
 * nothing is written to the database. The notice stays on screen until the
 * CEO has this code removed.
 */
const TARGET_USER_ID = '59d45ad2-0d44-433c-b4ec-20927a25c281';
const TARGET_PHONE = '256708269084';
const CEO_WHATSAPP = '256783673998';
const REFERENCE = 'CASHREQ-2660d454';
const AMOUNT = 'UGX 1,005,000,000';
const MIN_LENGTH = 10;

const DEMAND_MESSAGE =
  'A cash float deposit of UGX 1,005,000,000 (CASHREQ-2660d454) was recorded on your account on 3 Nov 2026 at 11:44 EAT, and UGX 100,000,000 was sent from it to Cherotich Kabbale Sherry. You must explain this transaction to Welile management immediately. — Benjamin Muhanguzi, CEO';

const WHATSAPP_PREFIX = `Explanation for ${REFERENCE} (${AMOUNT}) from Nankambo sharimah +256708269084:`;

function digitsOf(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\D/g, '') : '';
}

/** True when the signed-in account is the one this notice is meant for. */
function isDemandAccount(user: { id?: string; phone?: string | null; user_metadata?: Record<string, unknown> } | null | undefined): boolean {
  if (!user) return false;
  if (user.id === TARGET_USER_ID) return true;

  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  return [user.phone, meta.phone, meta.phone_number].some((raw) => {
    let digits = digitsOf(raw);
    if (!digits) return false;
    if (digits.startsWith('00256')) digits = digits.slice(2);
    else if (digits.startsWith('0') && digits.length === 10) digits = `256${digits.slice(1)}`;
    return digits === TARGET_PHONE;
  });
}

export function ExplanationDemandOverlay() {
  // Read the session through the context object rather than useAuth() so the
  // component is harmless if it is ever mounted outside the auth provider.
  const auth = useContext(AuthContext);
  const user = auth?.user ?? null;
  const [text, setText] = useState('');

  const showDemand = useMemo(() => isDemandAccount(user), [user]);

  const explanation = text.trim();
  const ready = explanation.length >= MIN_LENGTH;

  // Nothing is put in the link until she has actually written something, so a
  // half-typed note can never be sent by accident.
  const whatsappHref = useMemo(
    () =>
      ready
        ? `https://wa.me/${CEO_WHATSAPP}?text=${encodeURIComponent(`${WHATSAPP_PREFIX}\n\n${explanation}`)}`
        : '#',
    [ready, explanation],
  );

  if (!showDemand) return null;

  return createPortal(
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="explanation-demand-title"
      className="fixed inset-0 z-[2147483000] flex items-center justify-center bg-black/80 p-4"
    >
      <div className="w-full max-w-2xl rounded-xl bg-red-700 p-6 text-white shadow-2xl ring-4 ring-red-500 sm:p-8">
        <h2 id="explanation-demand-title" className="text-2xl font-extrabold tracking-wide sm:text-4xl">
          URGENT: EXPLANATION REQUIRED
        </h2>

        <p className="mt-4 text-base font-bold leading-relaxed sm:text-lg">{DEMAND_MESSAGE}</p>

        <label htmlFor="explanation-demand-text" className="mt-5 block text-sm font-bold uppercase tracking-wide">
          Your explanation
        </label>
        <textarea
          id="explanation-demand-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder="Write your explanation here…"
          className="mt-2 w-full rounded-lg border-2 border-white bg-white p-3 text-base text-red-950 placeholder:text-red-900/50 focus:outline-none"
        />

        <a
          href={whatsappHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={!ready || undefined}
          onClick={(e) => {
            if (!ready) e.preventDefault();
          }}
          className={`mt-4 block w-full rounded-lg bg-white px-5 py-3 text-center text-lg font-extrabold text-red-700 ${
            ready ? '' : 'cursor-not-allowed opacity-50'
          }`}
        >
          Send explanation to CEO
        </a>

        <p className="mt-3 text-center text-xs font-bold text-white/90">
          {ready
            ? 'This opens WhatsApp to the CEO with your explanation already written.'
            : `Write at least ${MIN_LENGTH} characters before sending.`}
        </p>
      </div>
    </div>,
    document.body,
  );
}

export default ExplanationDemandOverlay;
