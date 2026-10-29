import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useV360GuestTenant, useV360MarkDay, useV360PlanSummary } from '@/hooks/useV360Plan';
import { V360PlanCaptionList } from './V360PlanCaptions';

export interface V360GuestChoice {
  id: string;
  label: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Mark vacant, mark a missed day, or record a guest tenant.
 * Shown only when the server says this Rent Plan is v360.
 */
export function V360AgentDayActions({
  rentRequestId,
  guestChoices = [],
}: {
  rentRequestId: string;
  guestChoices?: V360GuestChoice[];
}) {
  const summary = useV360PlanSummary(rentRequestId);
  const markDay = useV360MarkDay();
  const guestTenant = useV360GuestTenant();
  const [mode, setMode] = useState<'vacant' | 'missed' | 'guest' | null>(null);
  const [reason, setReason] = useState('');
  const [guestId, setGuestId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (summary.isLoading) {
    return <p className="text-[11px] text-muted-foreground">Loading 360-day Rent Plan…</p>;
  }
  if (summary.isError) {
    return <p className="text-[11px] text-destructive">360-day Rent Plan figures are unavailable.</p>;
  }
  if (!summary.data || summary.data.pricing_version !== 'v360') return null;

  const busy = markDay.isPending || guestTenant.isPending;

  const submit = async () => {
    setError(null);
    setMessage(null);
    if (reason.trim().length < 10) {
      setError('Reason must be at least 10 characters.');
      return;
    }
    try {
      if (mode === 'guest') {
        if (!UUID_RE.test(guestId)) {
          setError('Choose the guest tenant.');
          return;
        }
        await guestTenant.mutateAsync({ rentRequestId, guestTenantId: guestId, reason });
        setMessage('Guest tenant recorded. Remaining days are unchanged.');
      } else if (mode === 'vacant' || mode === 'missed') {
        await markDay.mutateAsync({ rentRequestId, kind: mode, reason });
        setMessage(mode === 'vacant' ? 'Vacant day added to the end of the Rent Plan.' : 'Missed day added to the end of the Rent Plan.');
      }
      setMode(null);
      setReason('');
      setGuestId('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this.');
    }
  };

  return (
    <div className="space-y-2" data-testid="v360-agent-day-actions">
      <p className="text-xs font-semibold text-foreground">360-day Rent Plan</p>
      <V360PlanCaptionList summary={summary.data} />
      <div className="grid grid-cols-3 gap-1.5">
        <Button type="button" size="sm" variant="outline" className="h-9 px-1 text-[11px]" onClick={() => { setMode('vacant'); setError(null); }}>
          Mark vacant
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-9 px-1 text-[11px]" onClick={() => { setMode('missed'); setError(null); }}>
          Missed day
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-9 px-1 text-[11px]" onClick={() => { setMode('guest'); setError(null); }}>
          Guest tenant
        </Button>
      </div>
      {mode && (
        <div className="space-y-2 rounded-lg border border-border p-2">
          <p className="text-[11px] text-muted-foreground">
            {mode === 'guest'
              ? 'Records a guest tenant for the days still left. Paid days stay as they are.'
              : 'Adds one day to the end of this Rent Plan. Paid days are not written off.'}
          </p>
          {mode === 'guest' && (
            guestChoices.length > 0 ? (
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={guestId}
                onChange={(e) => setGuestId(e.target.value)}
                aria-label="Guest tenant"
              >
                <option value="">Choose a guest tenant</option>
                {guestChoices.map((g) => (
                  <option key={g.id} value={g.id}>{g.label}</option>
                ))}
              </select>
            ) : (
              <Input
                value={guestId}
                onChange={(e) => setGuestId(e.target.value.trim())}
                placeholder="Guest tenant account id"
                aria-label="Guest tenant account id"
              />
            )
          )}
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (at least 10 characters)"
            className="min-h-[72px] text-sm"
            aria-label="Reason"
          />
          {error && <p className="text-[11px] text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={submit}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setMode(null); setError(null); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {message && <p className="text-[11px] text-muted-foreground">{message}</p>}
    </div>
  );
}
