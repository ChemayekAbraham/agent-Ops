/**
 * CFO payroll release entry point.
 *
 * This panel writes no money logic of its own. It reuses the existing payroll
 * API exactly as the run detail page does: previewRelease, listDisbursements,
 * runRelease and markRunPaid from ./api/release, plus myApprovals from
 * ./api/workflow.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  previewRelease,
  listDisbursements,
  runRelease,
  markRunPaid,
  type DisbursementRow,
  type ReleasePreviewRow,
} from './api/release';
import { myApprovals } from './api/workflow';

interface ApprovalItem {
  item_type: string;
  item_id: string;
  title: string;
  detail: string | null;
  action_required: string | null;
}

function formatAmount(value: number): string {
  return `UGX ${Math.round(Number(value ?? 0)).toLocaleString('en-US')}`;
}

function ReleaseItem({ item }: { item: ApprovalItem }) {
  const runId = item.item_id;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReleasePreviewRow[]>([]);
  const [dry, setDry] = useState<{
    payslip_count: number;
    total_net: number;
    items: Array<{ staff_ref: string | null; amount: number; blocker: string | null }>;
  } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [released, setReleased] = useState(false);
  const [disbursements, setDisbursements] = useState<DisbursementRow[]>([]);
  const [paidError, setPaidError] = useState<string | null>(null);
  const [paidDone, setPaidDone] = useState(false);

  const loadDisbursements = useCallback(async () => {
    try {
      setDisbursements(await listDisbursements(runId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [runId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const [rows, disb] = await Promise.all([previewRelease(runId), listDisbursements(runId)]);
        if (cancelled) return;
        setPreview(rows);
        setDisbursements(disb);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, runId]);

  const doDryRun = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await runRelease(runId, true);
      setDry({
        payslip_count: Number(res?.payslip_count ?? 0),
        total_net: Number(res?.total_net ?? 0),
        items: Array.isArray(res?.items) ? res.items : [],
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doRelease = async () => {
    setBusy(true);
    setError(null);
    try {
      await runRelease(runId, false);
      setReleased(true);
      setConfirmOpen(false);
      setTyped('');
      await loadDisbursements();
      toast.success('Release processed.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const counts = useMemo(
    () =>
      disbursements.reduce(
        (acc, d) => ({
          posted: acc.posted + (d.status === 'posted' ? 1 : 0),
          failed: acc.failed + (d.status === 'failed' ? 1 : 0),
          skipped: acc.skipped + (d.status === 'skipped' ? 1 : 0),
        }),
        { posted: 0, failed: 0, skipped: 0 },
      ),
    [disbursements],
  );

  const previewTotal = useMemo(
    () => preview.reduce((sum, r) => sum + Number(r.net ?? 0), 0),
    [preview],
  );

  const headlineAmount = dry ? dry.total_net : previewTotal;
  const headlineCount = dry ? dry.payslip_count : preview.length;

  return (
    <Card className="border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-3 p-4 text-left"
      >
        <div className="min-w-0 space-y-1">
          <p className="truncate text-sm font-semibold text-foreground">{item.title}</p>
          {item.detail && (
            <p className="text-xs text-muted-foreground">{item.detail}</p>
          )}
          <p className="text-sm font-bold text-foreground">{formatAmount(headlineAmount)}</p>
        </div>
        {open ? (
          <ChevronUp className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <CardContent className="space-y-5 border-t border-border pt-4">
          {error && (
            <p role="alert" className="whitespace-pre-wrap text-xs font-medium text-destructive">
              {error}
            </p>
          )}

          {/* 1. Dry run */}
          <div className="space-y-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void doDryRun()}>
              {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Dry run
            </Button>
            <p className="text-xs text-muted-foreground">
              A dry run writes nothing. No wallet is credited and no ledger entry is posted.
            </p>
            {dry && (
              <div className="space-y-2">
                <p className="text-sm font-semibold">
                  {dry.payslip_count} payslips · total {formatAmount(dry.total_net)}
                </p>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Staff ref</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead>Blocker</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dry.items.map((row, index) => (
                        <TableRow key={`${row.staff_ref ?? 'row'}-${index}`}>
                          <TableCell className="font-mono text-xs">{row.staff_ref ?? '—'}</TableCell>
                          <TableCell className="text-right">{formatAmount(row.amount)}</TableCell>
                          <TableCell className="text-xs">
                            {row.blocker ? (
                              <span className="font-medium text-destructive">{row.blocker}</span>
                            ) : (
                              '—'
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>

          {/* 2. Release payment */}
          <div className="space-y-1">
            <Button
              size="sm"
              disabled={busy || !dry}
              title={dry ? 'Release payment' : 'Perform a dry run first.'}
              onClick={() => {
                setTyped('');
                setConfirmOpen(true);
              }}
            >
              Release payment
            </Button>
            {!dry && (
              <p className="text-xs text-muted-foreground">
                Run a dry run first to enable release.
              </p>
            )}
          </div>

          {/* 3. Disbursements */}
          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-sm font-semibold">
              Posted {counts.posted} · Failed {counts.failed} · Skipped {counts.skipped}
            </p>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Staff ref</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Ledger reference</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {disbursements.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-xs text-muted-foreground">
                        No disbursement rows yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    disbursements.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="font-mono text-xs">{d.staff_ref ?? '—'}</TableCell>
                        <TableCell className="text-right">{formatAmount(d.amount)}</TableCell>
                        <TableCell
                          className={
                            d.status === 'posted'
                              ? 'text-xs font-semibold text-emerald-600'
                              : d.status === 'failed'
                                ? 'text-xs font-semibold text-destructive'
                                : 'text-xs font-semibold text-muted-foreground'
                          }
                        >
                          {d.status}
                        </TableCell>
                        <TableCell className="font-mono text-[11px]">
                          {d.ledger_reference_id ?? '—'}
                        </TableCell>
                        <TableCell className="whitespace-pre-wrap text-xs">
                          {d.error_text ?? '—'}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              Retrying is safe. Payments already posted are skipped by their idempotency key.
            </p>
          </div>

          {/* 4. Record payment */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || counts.failed > 0 || paidDone}
                title={
                  counts.failed > 0
                    ? 'Resolve the failed rows before recording payment.'
                    : 'Record that this run has been paid.'
                }
                onClick={() => {
                  setPaidError(null);
                  setBusy(true);
                  void markRunPaid(runId, 'Payment released and recorded.')
                    .then(() => {
                      setPaidDone(true);
                      toast.success('Payment recorded.');
                    })
                    .catch((err) => setPaidError((err as Error).message))
                    .finally(() => setBusy(false));
                }}
              >
                Record payment
              </Button>
              {paidDone && <span className="text-xs text-muted-foreground">Recorded.</span>}
              {released && !paidDone && (
                <span className="text-xs text-muted-foreground">Release processed.</span>
              )}
            </div>
            {paidError && (
              <p role="alert" className="whitespace-pre-wrap text-xs font-medium text-destructive">
                {paidError}
              </p>
            )}
          </div>
        </CardContent>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Release payment</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  {headlineCount} employees · total {formatAmount(headlineAmount)}
                </p>
                <p className="font-medium text-destructive">
                  This credits wallets and posts to the general ledger. There is no automatic
                  reversal.
                </p>
                <p className="text-xs text-muted-foreground">Type RELEASE to confirm.</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="RELEASE"
            autoComplete="off"
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || typed.trim() !== 'RELEASE'}
              onClick={() => void doRelease()}
            >
              {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Confirm release
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function CfoPayrollPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ApprovalItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await myApprovals();
        if (cancelled) return;
        setItems(
          (rows ?? []).filter(
            (r) => String(r.action_required ?? '').trim() === 'Release payment',
          ) as ApprovalItem[],
        );
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-base">Payroll release</CardTitle>
          <p className="text-xs text-muted-foreground">
            Runs approved by the CEO and awaiting payment.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}

          {error && (
            <p role="alert" className="whitespace-pre-wrap text-xs font-medium text-destructive">
              {error}
            </p>
          )}

          {!loading && !error && items.length === 0 && (
            <div className="py-6 text-center">
              <p className="text-sm font-semibold text-foreground">No payroll awaiting release.</p>
              <p className="text-xs text-muted-foreground">
                Runs appear here once the CEO has approved them.
              </p>
            </div>
          )}

          {!loading &&
            items.map((item) => <ReleaseItem key={`${item.item_type}-${item.item_id}`} item={item} />)}
        </CardContent>
      </Card>
    </div>
  );
}