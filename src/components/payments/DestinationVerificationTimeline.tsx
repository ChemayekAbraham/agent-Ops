import { Check, Clock, X } from 'lucide-react';
import type { MyPayoutDestination } from '@/hooks/usePayoutVerification';

/**
 * Plain-language history of one payout account's automatic verification:
 * when it was added, when the National ID arrived, how the name on the ID
 * compared with the name on this account, and when it passed — or the exact
 * reason it is still blocked.
 *
 * Read-only. Every value comes from `payout_destination_verifications`;
 * nothing here decides anything.
 */

type StepState = 'done' | 'pending' | 'failed';

function when(value?: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Dot({ state }: { state: StepState }) {
  const base = 'w-6 h-6 rounded-full flex items-center justify-center shrink-0';
  if (state === 'done')
    return (
      <div className={`${base} bg-primary/15 text-primary`}>
        <Check className="w-3.5 h-3.5" />
      </div>
    );
  if (state === 'failed')
    return (
      <div className={`${base} bg-destructive/15 text-destructive`}>
        <X className="w-3.5 h-3.5" />
      </div>
    );
  return (
    <div className={`${base} bg-amber-500/15 text-amber-600`}>
      <Clock className="w-3.5 h-3.5" />
    </div>
  );
}

interface Step {
  title: string;
  detail?: string | null;
  at?: string | null;
  state: StepState;
}

export default function DestinationVerificationTimeline({
  destination,
  accountName,
}: {
  destination: MyPayoutDestination | null;
  /** Name typed on the withdrawal form, used when the row has none yet. */
  accountName?: string | null;
}) {
  const d = destination;
  const nameOnAccount = d?.account_name || accountName || null;
  const idName = d?.national_id_name || null;
  const score = typeof d?.name_match_score === 'number' ? Number(d.name_match_score) : null;
  const mismatchTokens = Array.isArray(d?.name_mismatch_tokens)
    ? (d?.name_mismatch_tokens as unknown[]).map((t) => String(t)).filter(Boolean)
    : [];

  const steps: Step[] = [];

  steps.push({
    title: 'Payout account added',
    detail: nameOnAccount ? `In the name ${nameOnAccount}` : null,
    at: when(d?.first_seen_at ?? d?.created_at),
    state: d ? 'done' : 'pending',
  });

  steps.push({
    title: 'National ID received',
    detail: idName ? `Name read on the ID: ${idName}` : d ? 'Waiting for your National ID photo and selfie' : null,
    at: when(d?.national_id_submitted_at),
    state: idName || d?.national_id ? 'done' : 'pending',
  });

  const namesMatch = d?.status === 'verified' || (score !== null && score >= 1);
  steps.push({
    title: 'Name check',
    detail: !idName
      ? 'Runs by itself as soon as your ID is read'
      : namesMatch
        ? 'The name on your ID matches the name on this account'
        : mismatchTokens.length
          ? `These parts are different: ${mismatchTokens.join(', ')}`
          : 'The name on your ID is not the same as the name on this account',
    state: !idName ? 'pending' : namesMatch ? 'done' : 'failed',
  });

  steps.push({
    title:
      d?.status === 'verified'
        ? 'Verified automatically'
        : d?.status === 'rejected'
          ? 'Not accepted'
          : 'Not verified yet',
    detail:
      d?.status === 'verified'
        ? 'You can withdraw to this account from now on.'
        : d?.status === 'rejected'
          ? d?.decision_reason || 'Use an account in the exact name on your National ID.'
          : !idName
            ? 'Send your National ID photo and selfie to finish this by itself.'
            : namesMatch
              ? 'Checking — tap "Check again" in a moment.'
              : 'Use an account in the exact name on your National ID, or send a clearer ID photo.',
    at: when(d?.decided_at),
    state: d?.status === 'verified' ? 'done' : d?.status === 'rejected' ? 'failed' : 'pending',
  });

  return (
    <div className="rounded-lg border border-border/60 bg-background/60 p-3">
      <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
        Verification history
      </p>
      <ol className="space-y-3">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <div className="flex flex-col items-center">
              <Dot state={s.state} />
              {i < steps.length - 1 && <span className="flex-1 w-px bg-border mt-1" />}
            </div>
            <div className="pb-1">
              <p className="text-sm font-medium leading-tight">{s.title}</p>
              {s.detail && <p className="text-xs text-muted-foreground mt-0.5">{s.detail}</p>}
              {s.at && <p className="text-[11px] text-muted-foreground mt-0.5">{s.at}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
