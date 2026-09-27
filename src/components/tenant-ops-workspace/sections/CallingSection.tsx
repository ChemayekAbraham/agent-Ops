/**
 * Queue and history in one place. Reads the existing cc_ calling engine
 * through its existing RPCs (useCallingQueue / useCallingStateCounts /
 * useCallReveal), called exactly as the current Calling Hub calls them — no
 * cc_ object is altered anywhere in this file. The only new reads are
 * tops_plan_position (money at risk, via the batched
 * tops_calling_money_at_risk) and our own tops_call_outcomes /
 * tops_promises_to_pay / tops_calling_gap.
 */
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { formatUGX } from '@/lib/rentCalculations';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useCallingQueue, useCallingStateCounts, type CcRowState } from '@/hooks/tenantOpsWorkspace/useCallingQueue';
import { useCallReveal } from '@/hooks/tenantOpsWorkspace/useCallReveal';
import { useCloseCall, type TopsCallOutcome } from '@/hooks/tenantOpsWorkspace/useCloseCall';
import { useCallingGap } from '@/hooks/tenantOpsWorkspace/useCallingGap';
import { usePromiseKeptRate } from '@/hooks/tenantOpsWorkspace/usePromiseKeptRate';
import { usePlanPosition } from '@/hooks/tenantOpsWorkspace/usePlanPosition';
import { useCcSubjectCallHistory } from '@/hooks/useCcSubjectCallHistory';
import PositionCard from '../tenant/PositionCard';

const STATE_TABS: { key: CcRowState; label: string }[] = [
  { key: 'to_call', label: 'To call' },
  { key: 'engaged', label: 'Engaged' },
  { key: 'unreachable', label: 'Not reached' },
  { key: 'callback', label: 'Callback' },
  { key: 'parked', label: 'Parked' },
];

const OUTCOMES: { key: TopsCallOutcome; label: string }[] = [
  { key: 'reached', label: 'Reached — no issue' },
  { key: 'promised', label: 'Reached — promised to pay' },
  { key: 'disputes_balance', label: 'Reached — disputes balance' },
  { key: 'refused', label: 'Refused' },
  { key: 'unreachable', label: 'No answer' },
  { key: 'wrong_number', label: 'Wrong number' },
  { key: 'other', label: 'Other' },
];

const todayIso = () => new Date().toISOString().slice(0, 10);
const dayLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—';

function CallPanel({
  cycleRowId,
  tenantId,
  onClose,
}: {
  cycleRowId: string;
  tenantId: string;
  onClose: () => void;
}) {
  const reveal = useCallReveal();
  const closeCall = useCloseCall();
  const [phone, setPhone] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [rentRequestId, setRentRequestId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<TopsCallOutcome | null>(null);
  const [note, setNote] = useState('');
  const [promiseAmount, setPromiseAmount] = useState('');
  const [promiseDate, setPromiseDate] = useState(todayIso());
  const [promiseChannel, setPromiseChannel] = useState<'call' | 'sms' | 'visit' | 'whatsapp'>('call');

  const { data: position } = usePlanPosition(rentRequestId ?? undefined);
  const { data: history } = useCcSubjectCallHistory('tenant', tenantId);
  const lastThree = (history ?? []).slice(0, 3);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rr } = await (supabase as any)
        .from('rent_requests')
        .select('id')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) setRentRequestId(rr?.id ?? null);
      const result = await reveal.mutateAsync(cycleRowId);
      if (!cancelled) {
        setAttemptId(result.attemptId);
        setPhone(result.phone);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleRowId, tenantId]);

  const canClose = !!outcome && (outcome !== 'promised' || (promiseAmount && Number(promiseAmount) > 0));

  const submit = async () => {
    if (!attemptId || !rentRequestId || !outcome) return;
    await closeCall.mutateAsync({
      attemptId,
      rentRequestId,
      tenantUserId: tenantId,
      outcome,
      note,
      promise:
        outcome === 'promised'
          ? { promisedAmountUgx: Number(promiseAmount), promisedDate: promiseDate, channel: promiseChannel }
          : undefined,
    });
    onClose();
  };

  return (
    <div className="space-y-4">
      <Card className="border shadow-sm">
        <CardContent className="py-3">
          <p className="text-xs text-muted-foreground">Phone</p>
          <p className="text-sm font-semibold">{phone ?? (reveal.isPending ? 'Revealing…' : '—')}</p>
        </CardContent>
      </Card>

      {rentRequestId && <PositionCard rentRequestId={rentRequestId} />}

      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Last three contacts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {lastThree.length === 0 ? (
            <p className="text-xs text-muted-foreground">No prior contacts on record.</p>
          ) : (
            lastThree.map((c) => (
              <p key={c.id} className="text-xs text-muted-foreground">
                {dayLabel(c.revealedAt)} · {c.outcome ?? 'unrecorded'} {c.officerName ? `· ${c.officerName}` : ''}
              </p>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Close this call — an outcome is required</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <RadioGroup value={outcome ?? ''} onValueChange={(v) => setOutcome(v as TopsCallOutcome)}>
            {OUTCOMES.map((o) => (
              <div key={o.key} className="flex items-center gap-2">
                <RadioGroupItem value={o.key} id={`outcome-${o.key}`} />
                <Label htmlFor={`outcome-${o.key}`} className="text-xs font-normal">
                  {o.label}
                </Label>
              </div>
            ))}
          </RadioGroup>

          {outcome === 'promised' && (
            <div className="grid grid-cols-1 gap-2 rounded-lg border p-3 sm:grid-cols-3">
              <label className="text-xs">
                Amount (UGX)
                <Input
                  type="number"
                  value={promiseAmount}
                  onChange={(e) => setPromiseAmount(e.target.value)}
                  className="mt-1 h-8"
                />
              </label>
              <label className="text-xs">
                By date
                <Input
                  type="date"
                  value={promiseDate}
                  onChange={(e) => setPromiseDate(e.target.value)}
                  className="mt-1 h-8"
                />
              </label>
              <label className="text-xs">
                Channel
                <select
                  value={promiseChannel}
                  onChange={(e) => setPromiseChannel(e.target.value as typeof promiseChannel)}
                  className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs"
                >
                  <option value="call">Call</option>
                  <option value="sms">SMS</option>
                  <option value="visit">Visit</option>
                  <option value="whatsapp">WhatsApp</option>
                </select>
              </label>
            </div>
          )}

          <Textarea placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="text-xs" />

          <Button size="sm" disabled={!canClose || closeCall.isPending} onClick={submit}>
            {closeCall.isPending ? 'Saving…' : 'Close call'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default function CallingSection() {
  const { user } = useAuth();
  const [state, setState] = useState<CcRowState>('to_call');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [activeRow, setActiveRow] = useState<{ cycleRowId: string; tenantId: string } | null>(null);

  const counts = useCallingStateCounts(search);
  const queue = useCallingQueue(state, search, page);
  const gap = useCallingGap();
  const keptRate = usePromiseKeptRate(todayIso(), todayIso(), user?.id ?? null);

  const changeState = (s: CcRowState) => {
    setState(s);
    setPage(0);
  };

  const totalGapMoney = useMemo(
    () => (gap.data ?? []).reduce((sum, g) => sum + (g.arrears_amount ?? 0), 0),
    [gap.data],
  );

  return (
    <div className="space-y-4">
      <Card className="border shadow-sm">
        <CardContent className="flex flex-wrap items-center gap-3 py-3">
          <Input
            placeholder="Search name or district — spans every state"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            className="h-9 max-w-xs"
          />
          {keptRate.data && (
            <p className="ml-auto text-xs text-muted-foreground">
              Your promise-kept rate today: <strong className="text-foreground">{keptRate.data.kept_rate_pct ?? '—'}%</strong>{' '}
              ({keptRate.data.kept} kept / {keptRate.data.taken} taken)
            </p>
          )}
        </CardContent>
      </Card>

      <Tabs value={state} onValueChange={(v) => changeState(v as CcRowState)}>
        <TabsList className="flex-wrap">
          {STATE_TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className="gap-1.5">
              {t.label}
              <Badge variant="secondary" className="tabular-nums">{counts.data?.[t.key] ?? 0}</Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card className="border shadow-sm">
        <CardContent className="pt-4">
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">Name</TableHead>
                  <TableHead className="text-xs">District</TableHead>
                  <TableHead className="text-xs">Agent</TableHead>
                  <TableHead className="text-xs">Money at risk</TableHead>
                  <TableHead className="text-xs">Attempts</TableHead>
                  <TableHead className="text-xs">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(queue.data?.rows ?? []).map((row) => (
                  <TableRow key={row.cycleRowId}>
                    <TableCell className="text-xs">{row.name}</TableCell>
                    <TableCell className="text-xs">{row.district ?? '—'}</TableCell>
                    <TableCell className="text-xs">{row.linkedAgentName ?? '—'}</TableCell>
                    <TableCell className="text-xs">
                      {row.moneyAtRiskUgx != null ? formatUGX(row.moneyAtRiskUgx) : '—'}
                    </TableCell>
                    <TableCell className="text-xs">{row.attemptsMade}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        onClick={() => setActiveRow({ cycleRowId: row.cycleRowId, tenantId: row.tenantId })}
                      >
                        Call
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between pt-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              Previous
            </Button>
            <p className="text-xs text-muted-foreground">
              Page {page + 1} ({queue.data?.total ?? 0} total)
            </p>
            <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Not in this round</CardTitle>
          <p className="text-xs text-muted-foreground">
            Eligible tenants missing from the currently-open round — the round itself is a snapshot and is never
            changed by this list.
          </p>
        </CardHeader>
        <CardContent>
          {(gap.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">None — every eligible tenant is in the open round.</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {gap.data!.length} tenants, {formatUGX(totalGapMoney)} in arrears, not in this round.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Sheet open={!!activeRow} onOpenChange={(open) => !open && setActiveRow(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Call</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            {activeRow && (
              <CallPanel
                cycleRowId={activeRow.cycleRowId}
                tenantId={activeRow.tenantId}
                onClose={() => setActiveRow(null)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
