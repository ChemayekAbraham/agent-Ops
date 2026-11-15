import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageCircle, MessageSquare, Share2 } from 'lucide-react';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { rpc } from './reviewApi';
import { LABEL } from './deskTheme';
import { fmt } from './format';
import { EmptyState, ErrorLine, LoadingRows, Sheet, pctWhole, stackLayout } from './ui';
import { plainError, smsHref, waHref } from './arrears/arrearsApi';
import { ACTION_BUTTON, CallButtons } from './arrears/ArrearsParts';

/**
 * Landlord Ops · Referral landlords (E107): landlords whose tenants have paid
 * at least 80% of what is due so far, each with a referral code. "Share code"
 * sends the landlord a thank-you with the code and the tenant apply link
 * (/tenants-onboarding, which reads a landlord code from ?ref=).
 */

export const MIN_PCT = 80;
/** The tenant self-apply page; it takes a landlord code as ?ref=CODE. */
export const APPLY_PATH = '/tenants-onboarding';

type Candidate = {
  landlord_id: string;
  name: string | null;
  phone: string | null;
  village: string | null;
  district: string | null;
  plans: number;
  pct: number | null;
  code: string;
  referred: number;
};

export function referralMessage(code: string, origin: string = getPublicOrigin()): string {
  const link = `${origin}${APPLY_PATH}`;
  return `Welile: thank you, your tenants pay well. Share code ${code} with people who need rent support — they apply at ${link}?ref=${code}.`;
}

export function useReferralCandidates() {
  return useQuery({
    queryKey: ['desk-feed', 'landlord-referrals', MIN_PCT],
    queryFn: async () => {
      const { data, error } = await rpc('landlord_referral_candidates', { p_min_pct: MIN_PCT });
      if (error) throw error;
      const d = (data ?? {}) as { landlords?: Candidate[]; rule?: string };
      return { landlords: Array.isArray(d.landlords) ? d.landlords : [], rule: d.rule ?? null };
    },
    staleTime: 60_000,
    retry: 1,
  });
}

function ShareSheet({ landlord, onClose }: { landlord: Candidate; onClose: () => void }) {
  const text = referralMessage(landlord.code);
  const [copied, setCopied] = useState(false);
  return (
    <Sheet title={`Share code ${landlord.code}`} onClose={onClose}>
      <div style={stackLayout(12)}>
        <p className="rounded-md bg-[var(--desk-surface)] p-3 text-sm text-foreground" style={{ margin: 0, overflowWrap: 'anywhere' }} data-share-text>
          {text}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {landlord.phone ? (
            <>
              <a href={smsHref(landlord.phone, text)} className={ACTION_BUTTON} data-share-sms>
                <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                SMS
              </a>
              <a href={waHref(landlord.phone, text)} target="_blank" rel="noreferrer" className={ACTION_BUTTON} data-share-whatsapp>
                <MessageCircle className="h-3.5 w-3.5" aria-hidden />
                WhatsApp
              </a>
            </>
          ) : (
            <span className={LABEL}>No phone on file for this landlord.</span>
          )}
          <button
            type="button"
            className={ACTION_BUTTON}
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? 'Copied' : 'Copy message'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

export function ReferralLandlords({ board: _board }: { board: boolean }) {
  const q = useReferralCandidates();
  const [sharing, setSharing] = useState<Candidate | null>(null);
  return (
    <section aria-label="Referral landlords" data-referral-landlords style={stackLayout(12)}>
      {q.isLoading ? (
        <LoadingRows rows={4} label="Loading the referral landlords" />
      ) : q.error ? (
        <ErrorLine>{plainError(q.error, { LANDLORD_OPS_ONLY: 'Only Landlord Ops, the COO and the Command Centre can see referral landlords.' })}</ErrorLine>
      ) : (
        <>
          {q.data?.rule && (
            <p className={LABEL} style={{ margin: 0 }}>
              {q.data.rule}
            </p>
          )}
          {!q.data || q.data.landlords.length === 0 ? (
            <EmptyState>No landlord's tenants have paid {MIN_PCT}% of what is due yet.</EmptyState>
          ) : (
            <ul style={{ ...stackLayout(10), margin: 0, padding: 0, listStyle: 'none' }} aria-label="Landlords whose tenants pay well">
              {q.data.landlords.map((l) => (
                <li key={l.landlord_id} className="desk-panel min-w-0" style={{ ...stackLayout(8), padding: 14 }} data-landlord={l.landlord_id}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      <span className="text-base font-semibold text-foreground">{l.name ?? '—'}</span>
                      {l.phone && <span className="ml-2 font-mono text-xs text-muted-foreground">{l.phone}</span>}
                    </span>
                    <CallButtons phone={l.phone} who={`landlord ${l.name ?? ''}`.trim()} />
                  </div>
                  <div className="text-sm" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
                    <span className="text-muted-foreground">{[l.village, l.district].filter(Boolean).join(', ') || '—'}</span>
                    <span>
                      <span className={LABEL}>Plans </span>
                      <span className="tabular-nums text-foreground">{fmt('int', l.plans)}</span>
                    </span>
                    <span>
                      <span className={LABEL}>Paid </span>
                      <span className="tabular-nums text-foreground">{pctWhole(l.pct)}</span>
                    </span>
                    <span>
                      <span className={LABEL}>Code </span>
                      <span className="font-mono text-foreground" data-code>
                        {l.code}
                      </span>
                    </span>
                    <span>
                      <span className={LABEL}>Referred </span>
                      <span className="tabular-nums text-foreground">{fmt('int', l.referred)}</span>
                    </span>
                  </div>
                  <div>
                    <button type="button" className={ACTION_BUTTON} onClick={() => setSharing(l)} data-share>
                      <Share2 className="h-3.5 w-3.5" aria-hidden />
                      Share code
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {sharing && <ShareSheet landlord={sharing} onClose={() => setSharing(null)} />}
    </section>
  );
}
