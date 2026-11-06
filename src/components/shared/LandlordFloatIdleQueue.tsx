import { useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  MoreHorizontal,
  XCircle,
  ShieldAlert,
  ArrowRight,
  User,
  Info,
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
 * Shared by the CFO dashboard and the Landlord Operations console.
 * Rendered in a clean, executive data table with standard 3-dots action menus.
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

const getInitials = (name: string | null | undefined): string => {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
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

  const [searchTerm, setSearchTerm] = useState('');
  const [actionTarget, setActionTarget] = useState<{
    row: IdleFloatRow;
    action: IdleFloatAction;
  } | null>(null);
  const [actionNote, setActionNote] = useState('');

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

  const openActionDialog = (row: IdleFloatRow, action: IdleFloatAction) => {
    setActionTarget({ row, action });
    setActionNote('');
  };

  const handleExecuteAction = async () => {
    if (!actionTarget) return;
    const { row, action } = actionTarget;
    const note = actionNote.trim();

    if (note.length < 10) {
      toast({
        title: 'Note required',
        description: 'Please provide a note of at least 10 characters for the audit log.',
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

    setActionTarget(null);
    setActionNote('');
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
          <Tabs value={scope} onValueChange={(v) => setScope(v as IdleFloatScope)}>
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
                  <TableHead className="font-semibold text-foreground min-w-[180px]">Landlord</TableHead>
                  <TableHead className="font-semibold text-foreground min-w-[170px]">Tenant &amp; Agent</TableHead>
                  <TableHead className="text-right font-semibold text-foreground">Unpaid Float (UGX)</TableHead>
                  <TableHead className="font-semibold text-foreground min-w-[130px]">Aging &amp; Funded</TableHead>
                  <TableHead className="font-semibold text-foreground min-w-[220px]">Diagnostics &amp; Notes</TableHead>
                  <TableHead className="text-right font-semibold text-foreground w-[60px]">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((row) => {
                  const autoNotice = whyNotAuto(row);

                  return (
                    <TableRow key={row.id} className="hover:bg-muted/30 transition-colors text-xs">
                      {/* Landlord Name & Badges */}
                      <TableCell className="align-middle">
                        <div className="flex items-start gap-2.5">
                          <Avatar className="h-8 w-8 rounded-full border border-border shrink-0 mt-0.5">
                            <AvatarFallback className="bg-primary/10 text-primary font-bold text-xs">
                              {getInitials(row.landlord_name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="font-semibold text-sm text-foreground leading-tight truncate">
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
                        </div>
                      </TableCell>

                      {/* Tenant & Agent */}
                      <TableCell className="align-middle">
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
                      <TableCell className="text-right align-middle font-mono font-bold text-sm text-foreground">
                        {formatUGX(row.amount)}
                      </TableCell>

                      {/* Aging */}
                      <TableCell className="align-middle text-muted-foreground">
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
                      <TableCell className="align-middle">
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

                      {/* Actions via Standard 3-Dots Menu */}
                      <TableCell className="text-right align-middle">
                        {!row.resolved_at ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground hover:bg-muted"
                                aria-label="Open action menu"
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                              <DropdownMenuLabel className="text-xs font-semibold text-muted-foreground">
                                Case Actions
                              </DropdownMenuLabel>
                              <DropdownMenuItem
                                className="cursor-pointer text-xs"
                                onClick={() => openActionDialog(row, 'acknowledge')}
                              >
                                <Check className="mr-2 h-3.5 w-3.5 text-emerald-600" />
                                I am working this
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="cursor-pointer text-xs"
                                onClick={() => openActionDialog(row, 'note')}
                              >
                                <MessageSquare className="mr-2 h-3.5 w-3.5 text-blue-600" />
                                Record investigation note
                              </DropdownMenuItem>
                              {canAct && (
                                <>
                                  <DropdownMenuItem
                                    className="cursor-pointer text-xs"
                                    onClick={() => openActionDialog(row, 'dismiss')}
                                  >
                                    <XCircle className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                                    Close without recall
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    className="cursor-pointer text-xs text-destructive focus:text-destructive focus:bg-destructive/10"
                                    onClick={() => openActionDialog(row, 'recall_now')}
                                  >
                                    <Undo2 className="mr-2 h-3.5 w-3.5" />
                                    Return float now
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            Resolved
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
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

      {/* Action Dialog (triggered by 3-dots menu options) */}
      <Dialog open={!!actionTarget} onOpenChange={(open) => !open && setActionTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              {actionTarget?.action === 'recall_now' && <Undo2 className="h-4 w-4 text-destructive" />}
              {actionTarget?.action === 'acknowledge' && <Check className="h-4 w-4 text-emerald-600" />}
              {actionTarget?.action === 'note' && <MessageSquare className="h-4 w-4 text-blue-600" />}
              {actionTarget?.action === 'dismiss' && <XCircle className="h-4 w-4 text-muted-foreground" />}
              {actionTarget?.action === 'recall_now' && 'Recall & Return Float'}
              {actionTarget?.action === 'acknowledge' && 'Acknowledge Case'}
              {actionTarget?.action === 'note' && 'Record Case Note'}
              {actionTarget?.action === 'dismiss' && 'Close Case Without Recall'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              Landlord: <span className="font-semibold text-foreground">{actionTarget?.row.landlord_name || 'Landlord'}</span> · Tenant:{' '}
              <span className="font-semibold text-foreground">{actionTarget?.row.tenant_name || 'Tenant'}</span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2 text-xs">
            {/* Case Details Pill */}
            <div className="rounded-lg border border-border/80 bg-muted/30 p-2.5 space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Unpaid Amount:</span>
                <span className="font-mono font-bold text-foreground">{formatUGX(actionTarget?.row.amount || 0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Agent:</span>
                <span className="font-medium text-foreground">{actionTarget?.row.agent_name || 'Unknown'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Time Idle:</span>
                <span className="font-medium text-foreground">{Math.round(actionTarget?.row.hours_outstanding || 0)}h outstanding</span>
              </div>
            </div>

            {actionTarget?.action === 'recall_now' && (
              <Alert variant="destructive" className="py-2.5">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle className="text-xs font-bold">Permanent Float Reversal</AlertTitle>
                <AlertDescription className="text-xs mt-0.5 leading-relaxed">
                  The amount of <strong className="font-mono">{formatUGX(actionTarget?.row.amount || 0)}</strong> will be deducted from the
                  agent&rsquo;s landlord float and returned to company treasury. The tenant&rsquo;s Rent Plan will be cancelled and
                  associated platform/access fees unwound on the general ledger.
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-1.5">
              <label className="font-semibold text-foreground block">
                Investigation / Decision Note <span className="text-destructive">*</span>
              </label>
              <Textarea
                placeholder="State what you found, why this action is taken, and next steps (min 10 characters)..."
                value={actionNote}
                onChange={(e) => setActionNote(e.target.value)}
                rows={3}
                className="text-xs"
              />
              <p className="text-[10px] text-muted-foreground">
                Minimum 10 characters required for permanent audit trail.
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              className="text-xs h-8"
              onClick={() => setActionTarget(null)}
              disabled={acting === actionTarget?.row.id}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant={actionTarget?.action === 'recall_now' ? 'destructive' : 'default'}
              className="text-xs h-8 gap-1.5"
              disabled={acting === actionTarget?.row.id || actionNote.trim().length < 10}
              onClick={handleExecuteAction}
            >
              {acting === actionTarget?.row.id ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving...
                </>
              ) : actionTarget?.action === 'recall_now' ? (
                <>
                  <Undo2 className="h-3.5 w-3.5" /> Return {formatUGX(actionTarget?.row.amount || 0)}
                </>
              ) : (
                <>
                  <Check className="h-3.5 w-3.5" /> Confirm Decision
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
