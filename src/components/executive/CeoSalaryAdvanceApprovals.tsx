/**
 * Salary advances awaiting the CEO decision, surfaced directly on the CEO dashboard.
 *
 * Stage: HR approves -> CEO approves (here) -> CFO disburses. The database trigger
 * stamps the approver from their position, so this only moves the status.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, HandCoins } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { listAdvances, decideAdvance, type AdvanceRow } from '@/hr/pay/api/advances';

function formatUGX(value: number): string {
  return `UGX ${new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(value)}`;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function CeoSalaryAdvanceApprovals() {
  const [rows, setRows] = useState<AdvanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectRow, setRejectRow] = useState<AdvanceRow | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [rejectError, setRejectError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listAdvances());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = useMemo(() => rows.filter((r) => r.status === 'hr_approved'), [rows]);

  async function approve(row: AdvanceRow) {
    setBusyId(row.id);
    try {
      await decideAdvance(row.id, true, '');
      toast.success('Advance approved. It now goes to the CFO for disbursement.');
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function reject() {
    if (!rejectRow) return;
    if (rejectNote.trim().length < 10) {
      setRejectError('A note of at least 10 characters is required.');
      return;
    }
    setRejectError('');
    setBusyId(rejectRow.id);
    try {
      await decideAdvance(rejectRow.id, false, rejectNote.trim());
      toast.success('Advance rejected.');
      setRejectRow(null);
      setRejectNote('');
      await load();
    } catch (err) {
      setRejectError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (!loading && !error && pending.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <HandCoins className="h-4 w-4 text-primary" />
          Salary advances awaiting your approval
          {pending.length > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
              {pending.length}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && (
          <p className="text-sm text-muted-foreground">
            <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
            Loading…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        )}
        {pending.map((row) => (
          <div
            key={row.id}
            className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold">
                {row.staff_name ?? row.staff_ref ?? 'Staff member'}
                <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                  {row.staff_ref ?? ''}
                </span>
              </p>
              <p className="text-sm font-bold text-primary">{formatUGX(row.principal)}</p>
              <p className="text-xs text-muted-foreground">{row.purpose}</p>
              <p className="text-[11px] text-muted-foreground">
                Recovery {formatUGX(row.recovery_value)} per month
                {row.recovery_months ? ` for ${row.recovery_months} month(s)` : ''} · first recovery{' '}
                {formatDate(row.first_recovery_on)} · HR approved {formatDate(row.hr_approved_at)}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" disabled={busyId === row.id} onClick={() => void approve(row)}>
                {busyId === row.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Approve'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busyId === row.id}
                onClick={() => {
                  setRejectRow(row);
                  setRejectNote('');
                  setRejectError('');
                }}
              >
                Reject
              </Button>
            </div>
          </div>
        ))}
      </CardContent>

      <Dialog open={!!rejectRow} onOpenChange={(open) => !open && setRejectRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject salary advance</DialogTitle>
          </DialogHeader>
          <Textarea
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            placeholder="Why is this advance being rejected? (10 characters minimum)"
            rows={4}
          />
          {rejectError && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {rejectError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectRow(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busyId === rejectRow?.id}
              onClick={() => void reject()}
            >
              Reject advance
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
