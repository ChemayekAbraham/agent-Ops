import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, AlertTriangle, CheckCircle2, Clock, Mail, Wallet } from 'lucide-react';
import { PageHeader, StatTile, Pager } from './FinopsKit';
import { toast } from 'sonner';

interface Row {
  withdrawal_id: string;
  partner_id: string | null;
  partner_name: string | null;
  agent_id: string | null;
  proxy_agent_id: string | null;
  proxy_agent_name: string | null;
  amount: number;
  payout_method: string | null;
  status: string;
  created_at: string;
  proxy_available: number | null;
  total_remaining_in_emails: number;
  bulk_emails_open: number;
  already_allocated: boolean;
  reason_code: string;
  reason: string;
}

const ugx = (n: number | null | undefined) =>
  `UGX ${Math.round(Number(n || 0)).toLocaleString()}`;

const REASON_TONE: Record<string, string> = {
  eligible_pending_run: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  already_allocated: 'bg-sky-500/15 text-sky-700 border-sky-500/30',
  no_proxy_assignment: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
  proxy_insufficient_balance: 'bg-orange-500/15 text-orange-700 border-orange-500/30',
  no_email_capacity: 'bg-rose-500/15 text-rose-700 border-rose-500/30',
  no_open_bulk_email: 'bg-rose-500/15 text-rose-700 border-rose-500/30',
  not_bank_payout: 'bg-muted text-muted-foreground border-border',
};

const PAGE_SIZE = 25;

export function ProxyWithdrawalDiagnosticsPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await (supabase.rpc as any)('diagnose_pending_proxy_withdrawals');
    if (error) toast.error(error.message);
    setRows((data as Row[]) || []);
    setPage(0);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const summary = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.reason_code] = (acc[r.reason_code] || 0) + 1;
    return acc;
  }, {});

  const totalRemaining = rows[0]?.total_remaining_in_emails ?? 0;
  const openEmails = rows[0]?.bulk_emails_open ?? 0;

  const retryAll = async () => {
    setRetrying(true);
    try {
      const { data: emails } = await (supabase.from('gmail_transactions') as any)
        .select('id')
        .eq('is_bulk_bank_payout', true)
        .is('bulk_payout_settled_at', null);
      let triggered = 0;
      for (const e of emails || []) {
        const { error } = await supabase.functions.invoke('auto-settle-bulk-bank-payout', {
          body: { gmail_transaction_id: e.id },
        });
        if (!error) triggered++;
      }
      toast.success(`Re-ran auto-settle on ${triggered} open email(s)`);
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Retry failed');
    } finally {
      setRetrying(false);
    }
  };

  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="space-y-5">
      <PageHeader
        icon={AlertTriangle}
        tone="amber"
        title="Proxy Withdrawal Diagnostics"
        description="Diagnose why each pending proxy partner withdrawal has not auto-settled yet, and re-run the open bulk emails."
        actions={
          <>
            <Button variant="outline" className="min-h-[44px] sm:min-h-[40px]" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button className="min-h-[44px] sm:min-h-[40px]" onClick={retryAll} disabled={retrying || openEmails === 0}>
              {retrying ? 'Re-running…' : 'Retry auto-settle'}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile icon={Clock} tone="amber" label="Pending" value={rows.length.toLocaleString()} note="Proxy withdrawals waiting" />
        <StatTile icon={Mail} tone="primary" label="Open bulk emails" value={openEmails.toLocaleString()} note="Not yet auto-settled" />
        <StatTile icon={Wallet} tone="sky" label="Email capacity left" value={ugx(totalRemaining)} note="Across open emails" />
        <StatTile icon={CheckCircle2} tone="emerald" label="Eligible next run" value={(summary.eligible_pending_run || 0).toLocaleString()} note="Will settle on the next run" />
      </div>

      {Object.keys(summary).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(summary).map(([code, n]) => (
            <Badge key={code} variant="outline" className={REASON_TONE[code] || ''}>
              {code.replace(/_/g, ' ')}: {n}
            </Badge>
          ))}
        </div>
      )}

      <div className="rounded-2xl border bg-card shadow-2xs overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase">
            <tr>
              <th className="text-left p-2.5">Partner</th>
              <th className="text-left p-2.5">Proxy agent</th>
              <th className="text-right p-2.5">Amount</th>
              <th className="text-right p-2.5">Proxy avail.</th>
              <th className="text-left p-2.5">Status</th>
              <th className="text-left p-2.5">Reason</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No pending proxy withdrawals.</td></tr>
            )}
            {pageRows.map((r) => (
              <tr key={r.withdrawal_id} className="border-t hover:bg-muted/30">
                <td className="p-2.5">
                  <div className="font-medium">{r.partner_name || '—'}</div>
                  <div className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</div>
                </td>
                <td className="p-2.5">{r.proxy_agent_name || <span className="text-muted-foreground italic">unassigned</span>}</td>
                <td className="p-2.5 text-right font-mono">{ugx(r.amount)}</td>
                <td className="p-2.5 text-right font-mono">{r.proxy_available != null ? ugx(r.proxy_available) : '—'}</td>
                <td className="p-2.5"><Badge variant="secondary" className="text-xs">{r.status}</Badge></td>
                <td className="p-2.5">
                  <Badge variant="outline" className={`${REASON_TONE[r.reason_code] || ''} mb-1`}>
                    {r.reason_code.replace(/_/g, ' ')}
                  </Badge>
                  <div className="text-xs text-muted-foreground">{r.reason}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {rows.length > PAGE_SIZE && (
          <div className="border-t px-4 py-3">
            <Pager page={page} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} noun="withdrawals" />
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="border rounded-lg p-3 bg-card">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div>
      <div className="text-lg font-bold mt-0.5">{value}</div>
    </div>
  );
}