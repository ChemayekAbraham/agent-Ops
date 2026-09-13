/**
 * National ID rejection reminder.
 *
 * When Financial Ops rejects a payout destination (wrong ID, name mismatch,
 * unreachable on the phone), the person must send their National ID details
 * again before any withdrawal can be released. This shows the reason they were
 * given, reminds them once per decision with a toast, and lets them resubmit
 * on the spot. Read-only + RPC submit; nothing here writes wallet state.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useMyPayoutDestinations, type MyPayoutDestination } from '@/hooks/usePayoutVerification';
import NationalIdPrompt from '@/components/wallet/NationalIdPrompt';

const REMINDED_KEY = 'welile-nid-rejection-reminded';

function labelFor(d: MyPayoutDestination): string {
  if (d.destination_type === 'mobile_money') {
    return `${d.provider ?? 'Mobile money'} ${d.momo_number ?? ''}`.trim();
  }
  return `${d.bank_name ?? 'Bank account'} ${d.bank_account_number ?? ''}`.trim();
}

/** Marks are stored per rejection so a new decision reminds again. */
function markKey(d: MyPayoutDestination): string {
  return `${d.id}:${d.decided_at ?? ''}`;
}

function alreadyReminded(keys: string[]): Set<string> {
  try {
    const raw = localStorage.getItem(REMINDED_KEY);
    const seen = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    return seen;
  } catch {
    return new Set<string>(keys.length ? [] : []);
  }
}

export default function NationalIdRejectedReminder({ className }: { className?: string }) {
  const { user } = useAuth();
  const { data } = useMyPayoutDestinations(user?.id);
  const [open, setOpen] = useState(false);

  const rejected = useMemo(() => (data ?? []).filter((d) => d.status === 'rejected'), [data]);

  // One toast per rejection decision, so people are nudged even if they never
  // scroll down to the card.
  useEffect(() => {
    if (!rejected.length) return;
    const seen = alreadyReminded(rejected.map(markKey));
    const fresh = rejected.filter((d) => !seen.has(markKey(d)));
    if (!fresh.length) return;
    toast.error('Your National ID was not accepted', {
      description: 'Send your National ID number and the name on it again to unlock withdrawals.',
      duration: 10_000,
      action: { label: 'Fix it', onClick: () => setOpen(true) },
    });
    fresh.forEach((d) => seen.add(markKey(d)));
    try {
      localStorage.setItem(REMINDED_KEY, JSON.stringify([...seen].slice(-50)));
    } catch {
      /* storage full or blocked — the card below is still shown */
    }
  }, [rejected]);

  if (!rejected.length) return null;

  return (
    <div className={`rounded-2xl border-2 border-destructive/50 bg-destructive/5 p-4 space-y-3 ${className ?? ''}`}>
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-xl bg-destructive/15 flex items-center justify-center shrink-0">
          <AlertTriangle className="h-5 w-5 text-destructive" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-foreground">Your National ID was not accepted</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            You cannot be paid until this is fixed. Send your National ID number and the exact name
            printed on it again.
          </p>
          <ul className="mt-2 space-y-1">
            {rejected.map((d) => (
              <li key={d.id} className="text-xs">
                <span className="font-semibold text-foreground">{labelFor(d)}</span>
                {d.decision_reason ? (
                  <span className="text-muted-foreground"> — {d.decision_reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <Button
        variant={open ? 'outline' : 'default'}
        className="w-full h-11"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronUp className="h-4 w-4 mr-1.5" /> : <ChevronDown className="h-4 w-4 mr-1.5" />}
        {open ? 'Hide' : 'Send my National ID again'}
      </Button>
      {open && (
        <NationalIdPrompt
          allowResubmit
          blocking
          withdrawableBalance={1}
          title="Send your National ID again"
          description="Check every character against your card. The name must match the name on your mobile money number or bank account."
        />
      )}
    </div>
  );
}
