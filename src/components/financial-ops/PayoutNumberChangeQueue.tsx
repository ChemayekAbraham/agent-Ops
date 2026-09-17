/**
 * Withdrawal number changes waiting on Financial Ops.
 *
 * Approving here is what actually moves a person's locked withdrawal number,
 * and it also opens their payouts again. Every decision needs a written basis
 * and is recorded against the person's account.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, PhoneCall, ShieldAlert, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useDecideNumberChange,
  useNumberChangeQueue,
  useNumberChangeVetting,
  type NumberChangeRequest,
} from '@/hooks/usePayoutNumberChange';

/** Loose name comparison, only to flag an obvious mismatch for the reviewer. */
function namesLookAlike(a?: string | null, b?: string | null) {
  const parts = (v?: string | null) =>
    (v ?? '')
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);
  const x = parts(a);
  const y = parts(b);
  if (!x.length || !y.length) return false;
  return x.some((w) => y.includes(w));
}

function RequestCard({ r, readOnly }: { r: NumberChangeRequest; readOnly?: boolean }) {
  const decide = useDecideNumberChange();
  const vetting = useNumberChangeVetting(r.id, !readOnly);
  const [reason, setReason] = useState('');
  const [nameProof, setNameProof] = useState('');
  const [nameChecked, setNameChecked] = useState(false);
  const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null);

  const idName = r.full_name ?? '';
  const proofReady = nameChecked && nameProof.trim().length >= 25;
  const looksSame = namesLookAlike(idName, r.requested_name);

  const act = async (decision: 'approved' | 'rejected') => {
    if (reason.trim().length < 10) {
      toast.error('Write at least 10 characters explaining the decision.');
      return;
    }
    if (decision === 'approved' && !proofReady) {
      toast.error(
        'Confirm the number is registered in the names on the National ID, and write the proof statement (25 characters minimum).',
      );
      return;
    }
    setBusy(decision);
    try {
      const note =
        decision === 'approved'
          ? `NAME CHECK on ${r.requested_number} (${(r.requested_provider ?? '').toUpperCase()}) — registered names match National ID ${
              r.national_id ?? 'not recorded'
            } (${idName || 'name not on file'}): ${nameProof.trim()} | Decision: ${reason.trim()}`
          : reason.trim();
      await decide.mutateAsync({ id: r.id, decision, reason: note });
      toast.success(
        decision === 'approved'
          ? 'Approved. Their withdrawal number now points to the new line.'
          : 'Rejected. Their withdrawal number stays as it was.',
      );
      setReason('');
      setNameProof('');
      setNameChecked(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the decision.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="space-y-3 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{r.full_name ?? 'Unnamed account'}</p>
          <p className="text-xs text-muted-foreground">
            {r.phone ?? 'no phone'} · ID {r.national_id ?? 'not recorded'}
          </p>
        </div>
        <Badge variant={r.status === 'pending' ? 'secondary' : r.status === 'approved' ? 'default' : 'destructive'}>
          {r.status}
        </Badge>
      </div>

      <div className="grid gap-2 rounded-lg bg-muted/40 p-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">From</span>
          <span className="font-semibold">{r.current_number ?? 'none on file'}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">To</span>
          <span className="font-bold">
            {r.requested_number} <span className="uppercase text-xs">{r.requested_provider}</span>
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">Name on it</span>
          <span className="truncate text-right font-semibold">{r.requested_name}</span>
        </div>
        <p className="text-xs">
          <span className="font-semibold">Their reason: </span>
          {r.request_reason}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {r.ownership_code_confirmed_at
            ? 'They confirmed the new number with the code sent to it.'
            : 'The new number was not confirmed by code.'}
        </p>
      </div>

      {!readOnly && vetting.data && (
        <div
          className={
            vetting.data.approvable
              ? 'rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-2 text-xs'
              : 'rounded-lg border border-destructive/50 bg-destructive/5 p-2 text-xs font-semibold text-destructive'
          }
        >
          <p>{vetting.data.message}</p>
          {vetting.data.other_holder_name && (
            <p className="mt-0.5">Held by: {vetting.data.other_holder_name}</p>
          )}
          {vetting.data.kind === 'name_or_provider_update' && (
            <p className="mt-0.5 font-semibold">
              Same number — they are correcting the registered name or provider.
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button asChild variant="outline" size="sm" className="flex-1">
          <a href={`tel:${r.phone ?? ''}`}>
            <PhoneCall className="mr-1.5 h-4 w-4" /> Call them
          </a>
        </Button>
        <Button asChild variant="outline" size="sm" className="flex-1">
          <a href={`tel:${r.requested_number}`}>
            <PhoneCall className="mr-1.5 h-4 w-4" /> Call new number
          </a>
        </Button>
      </div>

      {readOnly ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            <span className="font-semibold">Decision: </span>
            {r.decision_reason ?? 'not stated'}
          </p>
          <p>
            {r.decided_by_name ?? 'unknown'} ·{' '}
            {r.decided_at ? new Date(r.decided_at).toLocaleString() : ''}
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-2 rounded-lg border-2 border-amber-500/60 bg-amber-500/10 p-3">
            <p className="text-sm font-bold text-amber-700 dark:text-amber-400">
              Required: is this number in the names on the National ID?
            </p>

            {/* How-to-check guide */}
            <div className="rounded-md border border-amber-500/40 bg-background/70 p-2.5">
              <p className="text-[11px] font-extrabold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                How to check before approving
              </p>
              <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11px] text-foreground">
                <li>
                  On <strong>your own phone</strong>, open {(r.requested_provider ?? 'the mobile money network').toUpperCase()}.
                </li>
                <li>
                  Start <strong>Send Money</strong> and enter <strong>{r.requested_number}</strong>.
                </li>
                <li>
                  <strong>Do not press OK.</strong> Read the registered name shown before confirming.
                </li>
                <li>Compare that name with the National ID name below. It must match.</li>
              </ol>
              <p className="mt-1.5 text-[11px] font-bold text-destructive">
                Do not send any money. This is only a name check.
              </p>
            </div>

            <div className="grid gap-1 text-xs">
              <p>
                <span className="text-muted-foreground">Names on the National ID: </span>
                <span className="font-bold">{idName || 'not on file'}</span>
                {r.national_id ? <span className="text-muted-foreground"> · {r.national_id}</span> : null}
              </p>
              <p>
                <span className="text-muted-foreground">Names registered on {r.requested_number}: </span>
                <span className="font-bold">{r.requested_name}</span>
              </p>
              <p className={looksSame ? 'font-semibold text-emerald-600' : 'font-semibold text-destructive'}>
                {looksSame
                  ? 'The two names share at least one name — still check it yourself on MTN MoMo or Airtel Money.'
                  : 'These names do not match. Do not approve unless the number is genuinely in the ID names.'}
              </p>
            </div>
            <label className="flex cursor-pointer items-start gap-2 text-xs font-semibold">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-amber-600"
                checked={nameChecked}
                onChange={(e) => setNameChecked(e.target.checked)}
              />
              <span>
                I checked {r.requested_number} on {(r.requested_provider ?? 'the network').toUpperCase()} and the
                number is registered in the names on this National ID.
              </span>
            </label>
            <Textarea
              value={nameProof}
              onChange={(e) => setNameProof(e.target.value)}
              rows={2}
              placeholder="Proof statement: how you checked and the exact name the network showed (25 characters minimum)"
            />
            {!proofReady && (
              <p className="text-[11px] font-semibold text-destructive">
                Approve stays locked until this is ticked and the proof statement is written.
              </p>
            )}
          </div>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="What did the call establish? (10 characters minimum)"
          />
          <div className="flex gap-2">
            <Button
              className="flex-1"
              size="sm"
              disabled={!!busy || vetting.data?.approvable === false || !proofReady}
              onClick={() => act('approved')}
            >
              {busy === 'approved' ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
              )}
              Approve change
            </Button>
            <Button
              className="flex-1"
              size="sm"
              variant="destructive"
              disabled={!!busy}
              onClick={() => act('rejected')}
            >
              {busy === 'rejected' ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <XCircle className="mr-1.5 h-4 w-4" />
              )}
              Reject
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

export default function PayoutNumberChangeQueue() {
  const [tab, setTab] = useState<'pending' | 'all'>('pending');
  const queue = useNumberChangeQueue(tab);
  const rows = queue.data ?? [];
  const pending = rows.filter((r) => r.status === 'pending').length;

  if (queue.isLoading && rows.length === 0) return null;
  if (tab === 'pending' && rows.length === 0) return null;

  return (
    <div className="space-y-2 rounded-xl border-2 border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-bold">
          <ShieldAlert className="h-4 w-4 text-amber-600" />
          Withdrawal number changes
          {pending > 0 && <Badge variant="destructive">{pending} waiting</Badge>}
        </p>
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'pending' | 'all')}>
          <TabsList className="h-8">
            <TabsTrigger value="pending" className="text-xs">Waiting</TabsTrigger>
            <TabsTrigger value="all" className="text-xs">Decided</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <p className="text-xs text-muted-foreground">
        Approving a change moves the person's locked withdrawal number and lets their payouts
        continue. Call them first and confirm the new line belongs to them.
      </p>
      <div className="space-y-2">
        {rows
          .filter((r) => (tab === 'pending' ? r.status === 'pending' : r.status !== 'pending'))
          .map((r) => (
            <RequestCard key={r.id} r={r} readOnly={r.status !== 'pending'} />
          ))}
      </div>
    </div>
  );
}
