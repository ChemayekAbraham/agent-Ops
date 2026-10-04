import { AlertTriangle } from 'lucide-react';

/**
 * RecipientRoutingWarningBanner
 *
 * Explains, in plain language, how `recipient_type` (Wallet Routing v2)
 * decides WHICH wallet bucket actually changes when CFO posts a credit,
 * debit, or retraction. Shown at the top of any retraction / wallet-adjust
 * surface so an operator can't miss it.
 *
 * Why this exists: a CFO retraction posted with
 * `recipient_type: 'operational_wallet'` will land on the user's Float
 * bucket (company money) — NOT their Withdrawable balance — and the user
 * sees no change. This banner prevents that mistake.
 */
export function RecipientRoutingWarningBanner({
  variant = 'default',
}: {
  variant?: 'default' | 'compact';
}) {
  if (variant === 'compact') {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 text-amber-900 px-3 py-2 text-[11px] flex items-start gap-2">
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          <strong>Recipient routing decides the bucket.</strong> &nbsp;
          <span className="text-emerald-800">User Wallet → Withdrawable</span> ·{' '}
          <span className="text-amber-800">Operational Wallet → Float</span>. Pick wrong and the
          user's balance won't change.
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-900 p-3 text-xs space-y-2">
      <div className="flex items-center gap-2 font-semibold text-sm">
        <AlertTriangle className="h-4 w-4" />
        Before you retract: check Recipient Type
      </div>
      <p className="opacity-90 leading-relaxed">
        Wallet Routing v2 uses <strong>Recipient Type</strong> — not the category — to decide which
        of the user's three buckets actually changes. Picking the wrong recipient is the #1 reason a
        debit "posts" but the user's wallet looks untouched.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
        <div className="rounded-md border border-emerald-200 bg-emerald-50/70 p-2">
          <div className="text-[11px] font-semibold text-emerald-800">
            User Wallet → Withdrawable
          </div>
          <div className="text-[10px] text-emerald-700/90 mt-0.5">
            Reduces what the user can cash out. Use this for almost every retraction of money that
            originally belonged to the user.
          </div>
        </div>
        <div className="rounded-md border border-amber-200 bg-amber-100/60 p-2">
          <div className="text-[11px] font-semibold text-amber-800">
            Operational Wallet → Float
          </div>
          <div className="text-[10px] text-amber-700/90 mt-0.5">
            Reduces company-controlled float (e.g. agent float top-ups). The user's withdrawable
            balance will NOT move. If float is 0 the debit lands on nothing.
          </div>
        </div>
      </div>
      <p className="text-[10px] text-amber-900/80 pt-1 border-t border-amber-200/70">
        💡 Always confirm the user's bucket totals on the side panel <em>before</em> approving.
        Mis-routed debits create phantom drift that the 15-min monitor will flag.
      </p>
    </div>
  );
}
