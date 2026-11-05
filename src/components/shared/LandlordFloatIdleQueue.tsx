import { Fragment, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { formatDistanceToNowStrict, format } from 'date-fns';
import {
  Loader2,
  RefreshCw,
  AlertTriangle,
  Undo2,
  Check,
  MessageSquare,
  Clock,
  Phone,
  Search,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  ShieldAlert,
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
 * teams who own this problem from different ends.
 * Rendered in an executive, high-density professional table format.
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

function severityBadge(row: IdleFloatRow) {
  if (row.severity === 'overdue') {
    return (
      <Badge variant="destructive" className="text-[10px] px-1.5 py-0 font-semibold">
        Overdue
      </Badge>
    );
  }
  if (row.severity === 'warning') {
    return (
      <Badge
        variant="outline"
        className="text-[10px] px-1.5 py-0 bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 font-semibold"
      >
        Warning
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-medium">
      {row.severity}
    </Badge>
  );
}

function whyNotAuto(row: IdleFloatRow): string | null {
  if (row.resolved_at) return null;
  if (row.payout_attempted) {
    return 'A payout was raised and failed. The agent did their part, so the system will never cancel this automatically — it needs Finance Operations review.';
  }
  if (!row.in_scope_for_recall) {
    return 'Funded before the 24-hour recall rule started. The system will never act on this by itself; it is listed for executive review.';
  }
  return null;
}

export function LandlordFloatIdleQueue() {
  const { toast } = useToast();
  const {
    scope,
    setScope,
    rows,
    summary,
    goLive,
    canAct,
    loading,
    error,
    refresh,
    act,
    acting,
  } = useLandlordFloatIdleQueue('open');

  const [openRow, setOpenRow] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirmRecall, setConfirmRecall] = useState<IdleFloatRow | null>(null);

  const counts = useMemo<Record<IdleFloatScope, number>>(
    () => ({
      open: summary.open_count,
      backlog: summary.backlog_count,
      escalated: summary.escalated_count,
      resolved: summary.resolved_count,
      all: summary.open_count + summary.backlog_count + summary.escalated_count,
    }),
    [summary],
  );

  const filteredRows = useMemo(() => {
    if (!searchTerm.trim()) return rows;
    const q = searchTerm.toLowerCase();
    return rows.filter((r) => {
      const landlord = (r.landlord_name ?? '').toLowerCase();
      const tenant = (r.tenant_name ?? '').toLowerCase();
      const agent = (r.agent_name ?? '').toLowerCase();
      const phone = (r.agent_phone ?? '').toLowerCase();
      return landlord.includes(q) || tenant.includes(q) || agent.includes(q) || phone.includes(q);
    });
  }, [rows, searchTerm]);

  const filteredTotalAmount = useMemo(
    () => filteredRows.reduce((s, r) => s + (r.amount || 0), 0),
    [filteredRows],
  );

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
      description:
        action === 'recall_now'
          ? `${formatUGX(row.amount)} returned. The Rent Plan for ${
              row.tenant_name || 'the tenant'
            } is cancelled and they owe nothing.`
          : `Recorded against ${row.landlord_name || 'this case'}.`,
    });
    setNotes((n) => {
      const c = { ...n };
      delete c[row.id];
      return c;
    });
    setOpenRow(null);
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="p-4 sm:p-5 border-b border-border/60">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-base font-bold flex items-center gap-2">
              <Undo2 className="h-4 w-4 text-primary" />
              Idle Landlord Float &amp; Recall Register
            </CardTitle>
            <CardDescription className="text-xs mt-0.5 max-w-3xl">
              Rent released to an agent that has not yet reached the landlord.{' '}
              {goLive && (
                <>
                  The 24-hour recall rule applies to float funded from{' '}
                  <strong className="text-foreground">{format(new Date(goLive), 'EEEE d MMMM, HH:mm')}</strong>.
                  Anything funded prior is classified under &ldquo;Before the rule&rdquo; and requires manual CFO/Ops decision.
                </>
              )}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
            className="h-8 gap-1.5 text-xs font-medium self-start sm:self-center"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>

        {/* 4-Stat Metric Strip */}
        <div className="grid grid-cols-2 gap-2.5 pt-3 sm:grid-cols-4">
          <Stat label="Idle Right Now" value={formatUGX(summary.idle_total)} tone="text-amber-700 dark:text-amber-400" />
          <Stat label="Needs Action" value={`${summary.open_count} · ${formatUGX(summary.open_amount)}`} />
          <Stat label="Before the Rule" value={`${summary.backlog_count} · ${formatUGX(summary.backlog_amount)}`} />
          <Stat
            label="Oldest Outstanding"
            value={summary.oldest_funded_at ? format(new Date(summary.oldest_funded_at), 'd MMM yyyy') : '—'}
          />
        </div>

        {!canAct && (
          <Alert className="mt-3">
            <AlertDescription className="text-xs">
              You can see this register and leave notes. Recalling float is limited to the CFO,
              Landlord Operations, the CTO and Super Admins.
            </AlertDescription>
          </Alert>
        )}

        {/* Scope Tabs & Search Bar */}
        <div className="flex flex-col gap-2.5 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <Tabs value={scope} onValueChange={(v) => { setScope(v as IdleFloatScope); setOpenRow(null); }}>
            <TabsList className="bg-muted/60 p-1 flex-wrap h-auto gap-1">
              {SCOPES.map((s) => (
                <TabsTrigger key={s.key} value={s.key} className="text-xs font-semibold gap-1.5 py-1 px-3">
                  {s.label}
                  {counts[s.key] > 0 && (
                    <Badge
                      variant="secondary"
                      className={`ml-1 px-1.5 py-0 text-[10px] font-mono ${
                        s.key === 'backlog'
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                          : ''
                      }`}
                    >
                      {counts[s.key]}
                    </Badge>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search landlord, tenant, or agent..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {error && (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          </div>
        )}

        {loading && rows.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin text-primary mb-2" />
            <p className="text-sm font-medium">Loading register…</p>
          </div>
        )}

        {!loading && rows.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 text-emerald-600 mb-2" />
            <p className="font-semibold text-foreground">Nothing pending in this queue</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Every landlord in this scope has been paid or successfully resolved.
            </p>
          </div>
        )}

        {!loading && rows.length > 0 && filteredRows.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
            <Search className="h-10 w-10 text-muted-foreground/40 mb-2" />
            <p className="font-semibold text-foreground">No matching records found</p>
            <p className="text-xs text-muted-foreground mt-0.5">Try clearing or changing your search keywords.</p>
          </div>
        )}

        {!loading && filteredRows.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40 text-xs">
                  <TableHead className="font-semibold text-foreground min-w-[150px]">Landlord</TableHead>
                  <TableHead className="font-semibold text-foreground min-w-[150px]">Tenant &amp; Agent</TableHead>
                  <TableHead className="text-right font-semibold text-foreground">Amount (UGX)</TableHead>
                  <TableHead className="font-semibold text-foreground min-w-[130px]">Funded / Aging</TableHead>
                  <TableHead className="font-semibold text-foreground min-w-[200px]">Status &amp; Diagnostics</TableHead>
                  <TableHead className="text-right font-semibold text-foreground">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((row) => {
                  const autoNotice = whyNotAuto(row);
                  const expanded = openRow === row.id;
                  const busy = acting === row.id;

                  return (
                    <Fragment key={row.id}>
                      <TableRow className={`hover:bg-muted/30 transition-colors text-xs ${expanded ? 'bg-muted/20' : ''}`}>
                        {/* Landlord Name & Badges */}
                        <TableCell className="align-top">
                          <div>
                            <p className="font-semibold text-sm text-foreground leading-tight">
                              {row.landlord_name || 'Landlord Not Named'}
                            </p>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
                              {!row.in_scope_for_recall && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] px-1.5 py-0 bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 font-semibold"
                                >
                                  Before the Rule
                                </Badge>
                              )}
                              {severityBadge(row)}
                              {row.payout_attempted && (
                                <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-medium">
                                  Payout Attempted
                                </Badge>
                              )}
                              {row.return_requested && (
                                <Badge
                                  variant="secondary"
                                  className="text-[10px] px-1.5 py-0 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 font-medium"
                                >
                                  Return Requested
                                </Badge>
                              )}
                              {row.resolved_at && (
                                <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-medium capitalize">
                                  {row.outcome || 'Closed'}
                                </Badge>
                              )}
                            </div>
                          </div>
                        </TableCell>

                        {/* Tenant & Agent */}
                        <TableCell className="align-top">
                          <div>
                            <p className="font-medium text-foreground">{row.tenant_name || 'Tenant'}</p>
                            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-0.5">
                              <span>Agent: {row.agent_name || 'Unknown'}</span>
                              {row.agent_phone && (
                                <a
                                  href={`tel:${row.agent_phone}`}
                                  className="inline-flex items-center gap-0.5 text-primary hover:underline font-mono"
                                  title="Call agent"
                                >
                                  <Phone className="h-2.5 w-2.5" />
                                  {row.agent_phone}
                                </a>
                              )}
                            </div>
                          </div>
                        </TableCell>

                        {/* Amount */}
                        <TableCell className="text-right align-top font-mono font-bold text-sm text-foreground">
                          {formatUGX(row.amount)}
                        </TableCell>

                        {/* Aging */}
                        <TableCell className="align-top text-muted-foreground">
                          <div>
                            <span className="font-medium text-foreground block">
                              {Math.round(row.hours_outstanding)}h outstanding
                            </span>
                            <span className="text-[11px] block mt-0.5">
                              Funded {formatDistanceToNowStrict(new Date(row.funded_at))} ago
                            </span>
                          </div>
                        </TableCell>

                        {/* Diagnostics & Notes */}
                        <TableCell className="align-top">
                          <div className="space-y-1">
                            {row.last_payout_error && (
                              <p className="text-[11px] font-semibold text-destructive flex items-center gap-1">
                                <AlertTriangle className="h-3 w-3 shrink-0" />
                                {row.last_payout_error}
                              </p>
                            )}
                            {autoNotice && (
                              <p className="text-[11px] text-muted-foreground leading-relaxed">
                                {autoNotice}
                              </p>
                            )}
                            {row.review_note && (
                              <div className="rounded-md bg-muted/40 p-1.5 text-[11px] text-foreground italic border border-border/60">
                                &ldquo;{row.review_note}&rdquo;
                                <span className="block text-[10px] text-muted-foreground not-italic mt-0.5 font-medium">
                                  — {row.reviewed_by_name || 'Reviewer'}
                                  {row.reviewed_at && <> · {format(new Date(row.reviewed_at), 'd MMM HH:mm')}</>}
                                </span>
                              </div>
                            )}
                          </div>
                        </TableCell>

                        {/* Action Trigger */}
                        <TableCell className="text-right align-top">
                          {!row.resolved_at ? (
                            <Button
                              variant={expanded ? 'secondary' : 'outline'}
                              size="sm"
                              className="h-7 text-xs font-medium gap-1"
                              onClick={() => setOpenRow(expanded ? null : row.id)}
                            >
                              {expanded ? 'Close' : 'Act on this'}
                              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                            </Button>
                          ) : (
                            <Badge variant="outline" className="text-[10px] text-muted-foreground">
                              Resolved
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>

                      {/* Expandable Decision Drawer Sub-row */}
                      {expanded && !row.resolved_at && (
                        <TableRow className="bg-muted/15 hover:bg-muted/15">
                          <TableCell colSpan={6} className="p-4 border-b border-border/80">
                            <div className="rounded-xl border border-border/80 bg-background p-4 shadow-xs space-y-3">
                              <div>
                                <p className="text-xs font-bold text-foreground">Record Action or Float Recall</p>
                                <p className="text-[11px] text-muted-foreground mt-0.5">
                                  State what you found and what action was taken. Your note is permanently recorded in the audit log.
                                </p>
                              </div>

                              <Textarea
                                placeholder="Explain what you investigated and what decision was made (min 10 characters)..."
                                value={notes[row.id] || ''}
                                onChange={(e) => setNotes((n) => ({ ...n, [row.id]: e.target.value }))}
                                rows={2}
                                className="text-xs"
                              />

                              <div className="flex flex-wrap items-center gap-2 pt-1">
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  className="h-8 text-xs font-medium gap-1.5"
                                  disabled={busy}
                                  onClick={() => void run(row, 'acknowledge')}
                                >
                                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                  I am working this
                                </Button>

                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 text-xs font-medium gap-1.5"
                                  disabled={busy}
                                  onClick={() => void run(row, 'note')}
                                >
                                  <MessageSquare className="h-3.5 w-3.5" /> Just record note
                                </Button>

                                {canAct && (
                                  <>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 text-xs font-medium"
                                      disabled={busy}
                                      onClick={() => void run(row, 'dismiss')}
                                    >
                                      Close without returning
                                    </Button>

                                    <Button
                                      size="sm"
                                      variant="destructive"
                                      className="h-8 text-xs font-medium gap-1.5 ml-auto"
                                      disabled={busy}
                                      onClick={() => {
                                        if ((notes[row.id] || '').trim().length < 10) {
                                          toast({
                                            title: 'Say why',
                                            description: 'A recall cancels the tenant\'s Rent Plan. Give a reason of at least 10 characters.',
                                            variant: 'destructive',
                                          });
                                          return;
                                        }
                                        setConfirmRecall(row);
                                      }}
                                    >
                                      <Undo2 className="h-3.5 w-3.5" /> Return Float Now
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
              <TableFooter className="bg-muted/40 font-semibold text-xs border-t border-border/80">
                <TableRow>
                  <TableCell colSpan={2} className="text-foreground font-bold">
                    Total in Scope ({filteredRows.length} {filteredRows.length === 1 ? 'case' : 'cases'})
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold text-foreground">
                    {formatUGX(filteredTotalAmount)}
                  </TableCell>
                  <TableCell colSpan={3} />
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}
      </CardContent>

      {/* Confirmation Dialog for Recall */}
      <AlertDialog open={!!confirmRecall} onOpenChange={(o) => !o && setConfirmRecall(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Return this float and cancel the Rent Plan?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  <strong className="text-foreground">{formatUGX(confirmRecall?.amount || 0)}</strong> comes out of{' '}
                  <strong className="text-foreground">{confirmRecall?.agent_name || 'the agent'}</strong>&rsquo;s landlord float
                  and returns back to company treasury.
                </p>
                <p>
                  <strong className="text-foreground">{confirmRecall?.tenant_name || 'The tenant'}</strong>&rsquo;s Rent Plan
                  is cancelled and they are texted that nothing is owed by them. The access and registration fees are unwound
                  with it so the general ledger stays in balance.
                </p>
                <p className="font-semibold text-destructive">This action cannot be undone.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it as it is</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
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

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border/80 bg-card p-3 shadow-xs">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-base font-bold sm:text-lg ${tone || 'text-foreground'}`}>{value}</div>
    </div>
  );
}

export default LandlordFloatIdleQueue;
