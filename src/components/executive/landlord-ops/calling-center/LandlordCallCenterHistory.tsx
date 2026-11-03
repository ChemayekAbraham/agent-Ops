import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Download, Search, RefreshCw, Phone, MessageSquare, Send, Eye } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import {
  CC_OUTCOME_LABEL,
  isAnsweredOutcome,
  useCcCallHistory,
  type CcHistoryRow,
} from '@/hooks/useCcCallHistory';
import { type CcCallingHub } from '@/hooks/useCcCallingHub';
import { LandlordForwardConcernDialog } from './LandlordForwardConcernDialog';
import { LandlordCallDetailsDialog } from './LandlordCallDetailsDialog';
import { formatHumanLabel } from './ccUi';

export function LandlordCallCenterHistory({
  hub,
}: {
  cycleId?: string | null;
  hub: CcCallingHub;
}) {
  const [outcome, setOutcome] = useState<string>('all');
  const [days, setDays] = useState<number>(30);
  const [search, setSearch] = useState<string>('');
  const [forwarding, setForwarding] = useState<CcHistoryRow | null>(null);
  const [viewing, setViewing] = useState<CcHistoryRow | null>(null);

  const history = useCcCallHistory('landlord', days);
  const allRows = history.data ?? [];

  const rows = useMemo(() => {
    const byOutcome =
      outcome === 'all' ? allRows : allRows.filter((r) => r.outcome === outcome);
    const q = search.trim().toLowerCase();
    if (!q) return byOutcome;
    return byOutcome.filter((r) =>
      [
        r.subjectName,
        r.subjectPhone ?? '',
        r.officer ?? '',
        r.categoryLabel ?? '',
        r.comment ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [allRows, outcome, search]);

  const summary = useMemo(() => {
    const total = rows.length;
    const engaged = rows.filter((r) => isAnsweredOutcome(r.outcome)).length;
    const noAnswer = rows.filter(
      (r) => r.outcome === 'no_answer' || r.outcome === 'phone_off',
    ).length;
    const withFeedback = rows.filter((r) => r.comment?.trim()).length;
    const uniqueCallers = new Set(rows.map((r) => r.officer).filter(Boolean)).size;
    return { total, engaged, noAnswer, withFeedback, uniqueCallers };
  }, [rows]);

  const exportCsv = () => {
    if (rows.length === 0) return;
    const headers = [
      'Called At',
      'Landlord',
      'Phone',
      'Caller',
      'Outcome',
      'Feedback Category',
      'Feedback Notes',
      'Follow-up Due',
    ];
    const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      headers.join(','),
      ...rows.map((r) =>
        [
          r.recordedAt || r.revealedAt,
          r.subjectName,
          r.subjectPhone,
          r.officer,
          r.outcome ? CC_OUTCOME_LABEL[r.outcome] : 'Open',
          r.categoryLabel ?? '',
          r.comment ?? r.voidReason ?? '',
          r.followUpDueAt ?? '',
        ]
          .map(escape)
          .join(','),
      ),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `landlord-calls-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Card className="p-2.5">
          <div className="text-[11px] text-muted-foreground">Calls Logged</div>
          <div className="text-lg font-bold tabular-nums">{summary.total}</div>
        </Card>
        <Card className="p-2.5">
          <div className="text-[11px] text-muted-foreground">Engaged / Answered</div>
          <div className="text-lg font-bold tabular-nums text-emerald-600">{summary.engaged}</div>
        </Card>
        <Card className="p-2.5">
          <div className="text-[11px] text-muted-foreground">Unanswered / Off</div>
          <div className="text-lg font-bold tabular-nums text-amber-600">{summary.noAnswer}</div>
        </Card>
        <Card className="p-2.5">
          <div className="text-[11px] text-muted-foreground">With Feedback</div>
          <div className="text-lg font-bold tabular-nums">{summary.withFeedback}</div>
        </Card>
        <Card className="p-2.5 col-span-2 sm:col-span-1">
          <div className="text-[11px] text-muted-foreground">Active Callers</div>
          <div className="text-lg font-bold tabular-nums">{summary.uniqueCallers}</div>
        </Card>
      </div>

      <Card className="p-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search landlord, phone, caller, feedback…"
            className="pl-8 h-8 text-xs"
          />
        </div>
        <Select value={outcome} onValueChange={setOutcome}>
          <SelectTrigger className="h-8 text-xs w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Outcomes</SelectItem>
            <SelectItem value="engaged">Engaged</SelectItem>
            <SelectItem value="callback_booked">Callback Booked</SelectItem>
            <SelectItem value="no_answer">No Answer</SelectItem>
            <SelectItem value="phone_off">Phone Off</SelectItem>
            <SelectItem value="wrong_number">Wrong Number</SelectItem>
            <SelectItem value="refused">Refused</SelectItem>
          </SelectContent>
        </Select>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="h-8 text-xs w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 Days</SelectItem>
            <SelectItem value="30">Last 30 Days</SelectItem>
            <SelectItem value="90">Last 90 Days</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => history.refetch()}
          disabled={history.isFetching}
          className="h-8 text-xs gap-1"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${history.isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="h-8 text-xs gap-1"
        >
          <Download className="h-3.5 w-3.5" /> CSV
        </Button>
      </Card>

      <Card className="hidden md:block overflow-hidden">
        <div className="max-h-[540px] overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow>
                <TableHead className="text-xs">When</TableHead>
                <TableHead className="text-xs">Landlord</TableHead>
                <TableHead className="text-xs">Caller</TableHead>
                <TableHead className="text-xs">Outcome</TableHead>
                <TableHead className="text-xs">Feedback & Notes</TableHead>
                <TableHead className="text-xs text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-8">
                    {history.isLoading ? 'Loading call log…' : 'No landlord calls match your filters.'}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => {
                  const when = r.recordedAt || r.revealedAt;
                  const outLabel = r.outcome
                    ? CC_OUTCOME_LABEL[r.outcome]
                    : 'Open (not yet recorded)';
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs whitespace-nowrap">
                        <div>{formatDistanceToNow(new Date(when), { addSuffix: true })}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {format(new Date(when), 'dd MMM HH:mm')}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="font-medium">{r.subjectName || 'Landlord'}</div>
                        {r.subjectPhone && (
                          <div className="text-[11px] text-muted-foreground font-mono">
                            {r.subjectPhone}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{r.officer ?? '—'}</TableCell>
                      <TableCell className="text-xs">
                        <Badge
                          variant={r.outcome === 'engaged' ? 'default' : 'outline'}
                          className="text-[10px]"
                        >
                          {outLabel}
                        </Badge>
                        {r.categoryLabel && (
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {r.categoryLabel}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs max-w-[320px]">
                        {r.comment ? (
                          <p className="line-clamp-2 whitespace-pre-wrap">{r.comment}</p>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          {r.subjectId && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs gap-1"
                              onClick={() => setViewing(r)}
                            >
                              <Eye className="h-3 w-3" /> Details
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs gap-1"
                            onClick={() => setForwarding(r)}
                          >
                            <Send className="h-3 w-3" /> Forward
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Mobile card list */}
      <div className="md:hidden space-y-2">
        {rows.length === 0 ? (
          <Card className="p-6 text-center text-xs text-muted-foreground">
            {history.isLoading ? 'Loading call log…' : 'No landlord calls match your filters.'}
          </Card>
        ) : (
          rows.map((r) => {
            const when = r.recordedAt || r.revealedAt;
            return (
              <Card key={r.id} className="p-3 space-y-1.5 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{r.subjectName || 'Landlord'}</div>
                    {r.subjectPhone && (
                      <div className="text-[11px] text-muted-foreground font-mono flex items-center gap-0.5">
                        <Phone className="h-2.5 w-2.5" /> {r.subjectPhone}
                      </div>
                    )}
                  </div>
                  <Badge variant={r.outcome === 'engaged' ? 'default' : 'outline'} className="text-[10px]">
                    {r.outcome ? CC_OUTCOME_LABEL[r.outcome] : 'Open'}
                  </Badge>
                </div>
                {r.comment && (
                  <div className="rounded bg-muted/50 p-2 text-[11px] flex gap-1.5">
                    <MessageSquare className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                    <span className="whitespace-pre-wrap">{r.comment}</span>
                  </div>
                )}
                <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-0.5">
                  <span>By {r.officer ?? '—'}</span>
                  <span>{formatDistanceToNow(new Date(when), { addSuffix: true })}</span>
                </div>
                <div className="flex items-center justify-end gap-1.5 pt-1 border-t">
                  {r.subjectId && (
                    <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => setViewing(r)}>
                      <Eye className="h-3 w-3" /> Details
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setForwarding(r)}>
                    <Send className="h-3 w-3" /> Forward
                  </Button>
                </div>
              </Card>
            );
          })
        )}
      </div>

      {forwarding && (
        <LandlordForwardConcernDialog
          open={!!forwarding}
          onOpenChange={(v) => !v && setForwarding(null)}
          defaultSubjectId={forwarding.subjectId}
          defaultSubjectName={forwarding.subjectName || 'Landlord'}
          defaultSubjectPhone={forwarding.subjectPhone}
          defaultAgentName={forwarding.agentName}
          defaultSummary={`Call follow-up: ${forwarding.subjectName || 'Landlord'} (${formatHumanLabel(forwarding.categoryLabel || forwarding.outcome)})`}
          defaultDetails={forwarding.comment}
          cycleRowId={forwarding.cycleRowId}
        />
      )}

      {viewing && (
        <LandlordCallDetailsDialog
          subjectId={viewing.subjectId}
          subjectName={viewing.subjectName}
          subjectPhone={viewing.subjectPhone}
          agentName={viewing.agentName}
          open={!!viewing}
          onOpenChange={(v) => !v && setViewing(null)}
          hub={hub}
        />
      )}
    </div>
  );
}
