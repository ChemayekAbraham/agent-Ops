import { useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { formatDistanceToNowStrict, format } from 'date-fns';
import {
  Loader2, RefreshCw, AlertTriangle, Undo2, Check, MessageSquare, Clock, Phone,
} from 'lucide-react';
import {
  useLandlordFloatIdleQueue,
  type IdleFloatAction,
  type IdleFloatRow,
  type IdleFloatScope,
} from '@/hooks/useLandlordFloatIdleQueue';

/**
 * Landlord money sitting in an agent's wallet, unpaid.
 *
 * Shared by the CFO dashboard and the Landlord Operations console — the two
 * teams who own this problem from different ends. The roles who may actually
 * pull the money back (CFO, Landlord Ops, CTO, Super Admin) come from the RPC
 * as `can_act`; everyone else who can open the page sees the register and can
 * leave a note, but the buttons that move money are not rendered and would be
 * refused server-side anyway.
 *
 * The agent's own route is unchanged and lives elsewhere: they request a return
 * and someone here decides.
 */

const SCOPES: Array<{ key: IdleFloatScope; label: string }> = [
  { key: 'open', label: 'Needs action' },
  { key: 'backlog', label: 'Before the rule' },
  { key: 'escalated', label: 'Payout failed' },
  { key: 'resolved', label: 'Closed' },
];

const ACTION_LABEL: Record<IdleFloatAction, string> = {
  acknowledge: 'Acknowledged',
  note: 'Note saved',
  recall_now: 'Float recalled',
  dismiss: 'Case closed',
};

function severityTone(row: IdleFloatRow): 'destructive' | 'secondary' | 'outline' {
  if (row.severity === 'overdue') return 'destructive';
  if (row.severity === 'warning') return 'secondary';
  return 'outline';
}

function whyNotAuto(row: IdleFloatRow): string | null {
  if (row.resolved_at) return null;
  if (row.payout_attempted) {
    return 'A payout was raised and it failed. The agent did their part, so the system will never cancel this on its own — it needs Finance Operations.';
  }
  if (!row.in_scope_for_recall) {
    return 'Funded before the 24-hour rule started. The system will never act on this by itself; it is here for a person to decide.';
  }
  return null;
}

export function LandlordFloatIdleQueue() {
  const { toast } = useToast();
  const {
    scope, setScope, rows, summary, goLive, canAct, loading, error, refresh, act, acting,
  } = useLandlordFloatIdleQueue('open');

  const [openRow, setOpenRow] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirmRecall, setConfirmRecall] = useState<IdleFloatRow | null>(null);

  const counts = useMemo<Record<IdleFloatScope, number>>(() => ({
    open: summary.open_count,
    backlog: summary.backlog_count,
    escalated: summary.escalated_count,
    resolved: summary.resolved_count,
    all: summary.open_count + summary.backlog_count + summary.escalated_count,
  }), [summary]);

  const run = async (row: IdleFloatRow, action: IdleFloatAction) => {
    const note = (notes[row.id] || '').trim();
    if (note.length < 10) {
      toast({
        title: 'Say what you decided',
        description: 'At least 10 characters. It is kept on the record against this case.',
        variant: 'destructive',
      });
      return;
    }
    const failure = await act(row.id, action, note);
    if (failure) {
      toast({ title: 'Not saved', description: failure, variant: 'destructive' });
      return;
    }
    toast({
      title: ACTION_LABEL[action],
      description: action === 'recall_now'
        ? `${formatUGX(row.amount)} returned. The Rent Plan for ${row.tenant_name || 'the tenant'} is cancelled and they owe nothing.`
        : `Recorded against ${row.landlord_name || 'this case'}.`,
    });
    setNotes((n) => { const c = { ...n }; delete c[row.id]; return c; });
    setOpenRow(null);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Undo2 className="h-5 w-5 text-primary" />
            Landlord Float Not Yet Paid Out
          </CardTitle>
          <CardDescription>
            Rent released to an agent that has not reached the landlord.{' '}
            {goLive && (
              <>The 24-hour recall applies to float funded from{' '}
                <strong>{format(new Date(goLive), 'EEEE d MMMM, HH:mm')}</strong>. Anything older is
                listed for a person and is never acted on automatically.</>
            )}
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading} className="gap-1.5">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Idle right now" value={formatUGX(summary.idle_total)} />
          <Stat label="Needs action" value={`${summary.open_count} · ${formatUGX(summary.open_amount)}`} />
          <Stat label="Before the rule" value={`${summary.backlog_count} · ${formatUGX(summary.backlog_amount)}`} />
          <Stat
            label="Oldest"
            value={summary.oldest_funded_at ? format(new Date(summary.oldest_funded_at), 'd MMM yyyy') : '—'}
          />
        </div>

        {!canAct && (
          <Alert>
            <AlertDescription>
              You can see this register and leave notes. Returning float is limited to the CFO,
              Landlord Operations, the CTO and Super Admins.
            </AlertDescription>
          </Alert>
        )}

        <Tabs value={scope} onValueChange={(v) => setScope(v as IdleFloatScope)}>
          <TabsList className="flex-wrap">
            {SCOPES.map((s) => (
              <TabsTrigger key={s.key} value={s.key} className="gap-1.5">
                {s.label}
                {counts[s.key] > 0 && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{counts[s.key]}</Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading && rows.length === 0 && (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}

        {!loading && rows.length === 0 && !error && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Nothing here. Every landlord in this bucket has been paid or dealt with.
          </p>
        )}

        <div className="space-y-3">
          {rows.map((row) => {
            const note = whyNotAuto(row);
            const expanded = openRow === row.id;
            const busy = acting === row.id;

            return (
              <div key={row.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{row.landlord_name || 'Landlord not named'}</span>
                      <Badge variant={severityTone(row)}>{row.severity}</Badge>
                      {row.payout_attempted && <Badge variant="outline">payout attempted</Badge>}
                      {!row.in_scope_for_recall && <Badge variant="outline">before the rule</Badge>}
                      {row.return_requested && <Badge variant="secondary">return requested</Badge>}
                      {row.resolved_at && <Badge variant="outline">{row.outcome || 'closed'}</Badge>}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      For {row.tenant_name || 'a tenant'} · agent {row.agent_name || 'unknown'}
                      {row.agent_phone && (
                        <a href={`tel:${row.agent_phone}`} className="ml-1 inline-flex items-center gap-1 underline">
                          <Phone className="h-3 w-3" />{row.agent_phone}
                        </a>
                      )}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      Funded {formatDistanceToNowStrict(new Date(row.funded_at))} ago
                      {' · '}{Math.round(row.hours_outstanding)}h outstanding
                      {row.last_payout_status && <> · last payout: {row.last_payout_status}</>}
                    </p>
                    {row.last_payout_error && (
                      <p className="mt-0.5 text-xs text-destructive">{row.last_payout_error}</p>
                    )}
                    {row.review_note && (
                      <p className="mt-1 text-xs italic text-muted-foreground">
                        “{row.review_note}”
                        {row.reviewed_by_name && <> — {row.reviewed_by_name}</>}
                        {row.reviewed_at && <> · {format(new Date(row.reviewed_at), 'd MMM HH:mm')}</>}
                      </p>
                    )}
                  </div>

                  <div className="text-right">
                    <div className="text-lg font-semibold">{formatUGX(row.amount)}</div>
                    {!row.resolved_at && (
                      <Button
                        variant="outline" size="sm" className="mt-1"
                        onClick={() => setOpenRow(expanded ? null : row.id)}
                      >
                        {expanded ? 'Close' : 'Act on this'}
                      </Button>
                    )}
                  </div>
                </div>

                {note && (
                  <Alert className="mt-2">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-xs">{note}</AlertDescription>
                  </Alert>
                )}

                {expanded && !row.resolved_at && (
                  <div className="mt-3 space-y-2 border-t pt-3">
                    <Textarea
                      placeholder="What did you find, and what are you doing about it? Kept on the record."
                      value={notes[row.id] || ''}
                      onChange={(e) => setNotes((n) => ({ ...n, [row.id]: e.target.value }))}
                      rows={2}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(row, 'acknowledge')}>
                        {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                        I am working this
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(row, 'note')}>
                        <MessageSquare className="mr-1.5 h-3.5 w-3.5" /> Just record a note
                      </Button>
                      {canAct && (
                        <>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(row, 'dismiss')}>
                            Close without returning
                          </Button>
                          <Button
                            size="sm" variant="destructive" disabled={busy}
                            onClick={() => {
                              if ((notes[row.id] || '').trim().length < 10) {
                                toast({
                                  title: 'Say why',
                                  description: 'A recall cancels a tenant\'s Rent Plan. Give a reason of at least 10 characters.',
                                  variant: 'destructive',
                                });
                                return;
                              }
                              setConfirmRecall(row);
                            }}
                          >
                            <Undo2 className="mr-1.5 h-3.5 w-3.5" /> Return the float now
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>

      <AlertDialog open={!!confirmRecall} onOpenChange={(o) => !o && setConfirmRecall(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Return this float and cancel the Rent Plan?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  {formatUGX(confirmRecall?.amount || 0)} comes out of{' '}
                  {confirmRecall?.agent_name || 'the agent'}&rsquo;s landlord float and goes back to the CFO.
                </p>
                <p>
                  {confirmRecall?.tenant_name || 'The tenant'}&rsquo;s Rent Plan is cancelled and they are
                  texted that nothing is owed by them and the request can be made again. The access and
                  registration fees are unwound with it, so the books stay balanced.
                </p>
                <p className="font-medium">This cannot be undone from here.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it as it is</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const row = confirmRecall;
                setConfirmRecall(null);
                if (row) void run(row, 'recall_now');
              }}
            >
              Return {formatUGX(confirmRecall?.amount || 0)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold">{value}</div>
    </div>
  );
}

export default LandlordFloatIdleQueue;
