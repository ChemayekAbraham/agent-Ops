/**
 * Explains, on screen, exactly why a case sits under Double submissions:
 * which account holds the National ID or phone number first, how the two IDs
 * compare once look-alike characters are folded, and how the two phone numbers
 * compare on their last nine digits. Display only — the rule lives in the database.
 */
import { AlertTriangle, IdCard, Smartphone, UserCheck } from 'lucide-react';
import { format } from 'date-fns';
import { useDoubleSubmissionReason } from '@/hooks/useDoubleSubmissionReason';
import {
  foldedCharacters,
  normalizeNationalIdFuzzy,
  phoneLastNine,
} from '@/lib/doubleSubmission';

type Props = {
  userId: string;
  thisName: string | null;
  thisPhone: string | null;
  thisNationalId: string | null;
  kind: 'national_id' | 'phone' | null;
  firstName: string | null;
};

function Compare({
  Icon,
  title,
  matched,
  leftLabel,
  leftRaw,
  leftNorm,
  rightLabel,
  rightRaw,
  rightNorm,
  note,
}: {
  Icon: typeof IdCard;
  title: string;
  matched: boolean;
  leftLabel: string;
  leftRaw: string;
  leftNorm: string;
  rightLabel: string;
  rightRaw: string;
  rightNorm: string;
  note?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <p className="flex items-center gap-1.5 text-xs font-bold">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {title}
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
            matched
              ? 'bg-destructive/15 text-destructive'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          {matched ? 'Same' : 'Different'}
        </span>
      </p>
      <dl className="mt-2 space-y-1.5 text-xs">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-muted-foreground">{leftLabel}</dt>
          <dd className="font-mono font-semibold">{leftRaw || '—'}</dd>
          {leftNorm && leftNorm !== leftRaw.toUpperCase() && (
            <dd className="font-mono text-muted-foreground">→ {leftNorm}</dd>
          )}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-muted-foreground">{rightLabel}</dt>
          <dd className="font-mono font-semibold">{rightRaw || '—'}</dd>
          {rightNorm && rightNorm !== rightRaw.toUpperCase() && (
            <dd className="font-mono text-muted-foreground">→ {rightNorm}</dd>
          )}
        </div>
      </dl>
      {note && <p className="mt-2 text-[11px] font-medium text-muted-foreground">{note}</p>}
    </div>
  );
}

export function DoubleSubmissionReasonPanel({
  userId,
  thisName,
  thisPhone,
  thisNationalId,
  kind,
  firstName,
}: Props) {
  const reason = useDoubleSubmissionReason(userId);
  const first = reason.data;

  const myIdNorm = normalizeNationalIdFuzzy(thisNationalId);
  const firstIdNorm = normalizeNationalIdFuzzy(first?.first_national_id);
  const idSame = !!myIdNorm && myIdNorm === firstIdNorm;
  const myPhone9 = phoneLastNine(thisPhone);
  const firstPhone9 = phoneLastNine(first?.first_phone);
  const phoneSame = !!myPhone9 && myPhone9 === firstPhone9;

  const what = kind === 'phone' ? 'phone number' : 'National ID';
  const holder = first?.first_name || firstName || 'an earlier account';
  const folded = foldedCharacters(thisNationalId);

  return (
    <div
      role="alert"
      className="mx-5 mt-1 space-y-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-4"
    >
      <div>
        <p className="flex items-center gap-1.5 text-sm font-bold text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          Double submission — cannot be verified
        </p>
        <p className="mt-1 text-xs font-medium text-destructive/90">
          This {what} is already used by {holder}. One {what} verifies one account only, and only the
          account that submitted first may be verified.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-background p-3">
        <p className="flex items-center gap-1.5 text-xs font-bold">
          <UserCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          Who submitted first
        </p>
        <p className="mt-1 text-xs">
          <span className="font-semibold">{holder}</span>
          {first?.first_phone ? <span className="text-muted-foreground"> · {first.first_phone}</span> : null}
          {first?.first_created_at ? (
            <span className="text-muted-foreground">
              {' '}
              · joined {format(new Date(first.first_created_at), 'd MMM yyyy')}
            </span>
          ) : null}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          This case: <span className="font-semibold text-foreground">{thisName || '—'}</span>
          {thisPhone ? ` · ${thisPhone}` : ''}
        </p>
      </div>

      {reason.isLoading ? (
        <p className="text-xs font-medium text-muted-foreground">Checking the match…</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <Compare
            Icon={IdCard}
            title="National ID comparison"
            matched={idSame}
            leftLabel="This account"
            leftRaw={(thisNationalId || '').toUpperCase()}
            leftNorm={myIdNorm}
            rightLabel={holder}
            rightRaw={(first?.first_national_id || '').toUpperCase()}
            rightNorm={firstIdNorm}
            note={
              idSame
                ? folded.length
                  ? `Same ID once look-alike characters are treated as equal (${folded.join(', ')}).`
                  : 'Both accounts carry the same National ID.'
                : 'The two IDs are not the same.'
            }
          />
          <Compare
            Icon={Smartphone}
            title="Phone number comparison"
            matched={phoneSame}
            leftLabel="This account"
            leftRaw={myPhone9}
            leftNorm={myPhone9}
            rightLabel={holder}
            rightRaw={firstPhone9}
            rightNorm={firstPhone9}
            note={
              phoneSame
                ? 'Both accounts use the same number (compared on the last 9 digits, so country codes and spaces do not matter).'
                : 'The last 9 digits of the two numbers differ.'
            }
          />
        </div>
      )}

      <p className="text-[11px] font-medium text-destructive/80">
        Grouped because the {what} matched. Verify is switched off for this case; only Reject is possible.
      </p>
    </div>
  );
}
