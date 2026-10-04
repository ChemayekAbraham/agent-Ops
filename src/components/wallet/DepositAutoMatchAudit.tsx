import { BadgeCheck, Mail, Clock, AlertCircle } from 'lucide-react';

export interface DepositAutoMatchAuditPayload {
  outcome?:
    | 'linked'
    | 'duplicate_cancelled'
    | 'pending'
    | 'no_tid'
    | 'race_lost'
    | string;
  normalized_tid?: string | null;
  raw_tid?: string | null;
  gmail_transaction_id?: string | null;
  original_deposit_id?: string | null;
  auto_match_method?: string | null;
  checked_at?: string | null;
  note?: string | null;
}

const OUTCOME_META: Record<
  string,
  {
    label: string;
    body: string;
    tone: string;
    Icon: typeof BadgeCheck;
  }
> = {
  linked: {
    label: 'Linked to mobile-money receipt',
    body: 'Your in-app entry was matched to an email receipt and auto-verified.',
    tone:
      'bg-emerald-500/10 border-emerald-500/20 text-emerald-800',
    Icon: BadgeCheck,
  },
  duplicate_cancelled: {
    label: 'Cancelled as duplicate',
    body: 'This reference was already credited on a previous deposit. No new credit was issued.',
    tone: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-800',
    Icon: BadgeCheck,
  },
  pending: {
    label: 'Waiting for matching receipt',
    body: 'We checked but no mobile-money receipt with this reference has arrived yet. The auto-matcher will keep watching.',
    tone: 'bg-amber-500/10 border-amber-500/20 text-amber-800',
    Icon: Clock,
  },
  no_tid: {
    label: 'No transaction reference provided',
    body: 'Auto-matching skipped because no mobile-money reference was attached to this deposit.',
    tone: 'bg-muted text-muted-foreground border-border',
    Icon: AlertCircle,
  },
  race_lost: {
    label: 'Receipt claimed by another deposit',
    body: 'A matching receipt existed but was linked to a different deposit moments before yours was checked.',
    tone: 'bg-amber-500/10 border-amber-500/20 text-amber-800',
    Icon: AlertCircle,
  },
};

/**
 * Per-deposit audit trail showing what the Gmail auto-matcher saw at
 * submission time: the normalized transaction reference (digits only,
 * carrier prefix like MTN "MP" / Airtel "AT" stripped) and whether the
 * deposit was linked to a receipt, cancelled as a duplicate, or left
 * pending for the background matcher.
 *
 * Source: `deposit_requests.auto_match_audit` (jsonb) written by
 * `try_link_gmail_for_deposit`.
 */
export function DepositAutoMatchAudit({
  audit,
}: {
  audit?: DepositAutoMatchAuditPayload | null;
}) {
  if (!audit || !audit.outcome) return null;

  const meta = OUTCOME_META[audit.outcome] ?? {
    label: audit.outcome,
    body: audit.note ?? '',
    tone: 'bg-muted text-muted-foreground border-border',
    Icon: AlertCircle,
  };

  const { Icon } = meta;
  const checkedAt = audit.checked_at
    ? new Date(audit.checked_at).toLocaleString()
    : null;

  return (
    <div className={`mt-2 p-2 rounded border text-xs ${meta.tone}`}>
      <p className="font-medium flex items-center gap-1">
        <Icon className="h-3.5 w-3.5" />
        Auto-match: {meta.label}
      </p>
      <p className="mt-0.5 opacity-90">{meta.body}</p>
      {audit.normalized_tid && (
        <p className="mt-1 font-mono text-[11px] flex items-center gap-1 opacity-90">
          <Mail className="h-3 w-3" />
          TID&nbsp;{audit.normalized_tid}
          {audit.raw_tid && audit.raw_tid !== audit.normalized_tid && (
            <span className="opacity-70">(you entered “{audit.raw_tid}”)</span>
          )}
        </p>
      )}
      {checkedAt && (
        <p className="mt-0.5 opacity-70 text-[10px]">Checked {checkedAt}</p>
      )}
    </div>
  );
}