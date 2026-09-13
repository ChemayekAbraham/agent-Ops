import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  AlertTriangle, ShieldCheck, ClipboardList, Loader2, Download, BarChart3,
} from 'lucide-react';

const fmt = (n: number) => `UGX ${Math.round(n || 0).toLocaleString()}`;
const when = (s: string | null) =>
  s ? new Date(s).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

type Approval = {
  id: string; requested_by: string | null; requested_by_name: string | null;
  target_user_id: string; target_name: string | null; target_phone: string | null;
  amount: number; bucket: string; reason_code: string; reason_detail: string | null;
  business_justification: string; reference_number: string | null;
  commission_component: number; required_approvals: number; approvals_count: number;
  status: string; created_at: string; decisions: unknown;
};

type Alert = {
  id: string; alert_type: string; severity: string; operator_name: string | null;
  target_name: string | null; amount: number; bucket: string; reason_code: string;
  reference_number: string | null; details: Record<string, unknown> | null;
  acknowledged_at: string | null; created_at: string;
};

type AuditRow = {
  id: string; created_at: string; operator_name: string | null; operator_roles: string[] | null;
  target_name: string | null; target_phone: string | null; amount: number; bucket: string;
  reason_code: string; business_justification: string | null; reference_number: string | null;
  withdrawable_before: number | null; withdrawable_after: number | null;
  float_before: number | null; float_after: number | null; commission_component: number | null;
  commission_acknowledged: boolean | null; platform_destination: string | null;
  client_ip: string | null; device: string | null; browser: string | null;
  status: string; ledger_group_id: string | null;
};

const severityTone: Record<string, string> = {
  critical: 'bg-destructive/15 text-destructive border-destructive/40',
  high: 'bg-warning/15 text-warning-foreground border-warning/40',
  medium: 'bg-muted text-muted-foreground border-border',
};

/**
 * CFO-facing governance surface for FinOps wallet error corrections:
 * approvals queue, high-risk alerts, exhaustive audit register and reporting.
 */
export function ErrorCorrectionAuditPanel() {
  const qc = useQueryClient();
  const [days, setDays] = useState(30);
  const [search, setSearch] = useState('');
  const [decision, setDecision] = useState<{ row: Approval; action: 'approve' | 'reject' } | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const since = useMemo(
    () => new Date(Date.now() - days * 86_400_000).toISOString(),
    [days],
  );

  const approvals = useQuery({
    queryKey: ['error-correction-approvals'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('error_correction_approvals')
        .select('*')
        .in('status', ['pending', 'partially_approved'])
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as Approval[];
    },
  });

  const alerts = useQuery({
    queryKey: ['error-correction-alerts', days],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('error_correction_alerts')
        .select('*')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as Alert[];
    },
  });

  const audit = useQuery({
    queryKey: ['error-correction-audit', days],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('error_correction_audit')
        .select('*')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as unknown as AuditRow[];
    },
  });

  const report = useQuery({
    queryKey: ['error-correction-report', days],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_error_correction_report', {
        p_from: since,
        p_to: new Date().toISOString(),
      });
      if (error) throw error;
      return data as {
        totals: Record<string, number>;
        by_operator: Array<{ operator_name: string | null; corrections: number; total_amount: number }>;
        by_reason: Array<{ reason_code: string; corrections: number; total_amount: number }>;
      };
    },
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return audit.data ?? [];
    return (audit.data ?? []).filter((r) =>
      [r.operator_name, r.target_name, r.target_phone, r.reason_code, r.reference_number]
        .some((v) => (v ?? '').toLowerCase().includes(q)),
    );
  }, [audit.data, search]);

  const pendingAlerts = (alerts.data ?? []).filter((a) => !a.acknowledged_at);

  const submitDecision = async () => {
    if (!decision) return;
    if (decision.action === 'reject' && note.trim().length < 10) {
      toast.error('A rejection note of at least 10 characters is required');
      return;
    }
    setSaving(true);
    const { error } = await supabase.rpc('decide_error_correction_approval', {
      p_approval_id: decision.row.id,
      p_decision: decision.action,
      p_note: note.trim() || null,
    });
    setSaving(false);
    if (error) {
      toast.error('Decision failed', { description: error.message });
      return;
    }
    toast.success(decision.action === 'approve' ? 'Correction approved' : 'Correction rejected');
    setDecision(null);
    setNote('');
    qc.invalidateQueries({ queryKey: ['error-correction-approvals'] });
  };

  const acknowledge = async (id: string) => {
    const { error } = await supabase.rpc('acknowledge_error_correction_alert', { p_alert_id: id });
    if (error) {
      toast.error('Could not acknowledge', { description: error.message });
      return;
    }
    qc.invalidateQueries({ queryKey: ['error-correction-alerts'] });
  };

  const exportCsv = () => {
    const header = [
      'date', 'operator', 'target', 'phone', 'amount', 'bucket', 'reason_code',
      'reference', 'justification', 'commission_component', 'commission_acknowledged',
      'withdrawable_before', 'withdrawable_after', 'float_before', 'float_after',
      'destination', 'device', 'browser', 'ip', 'status',
    ];
    const lines = rows.map((r) => [
      r.created_at, r.operator_name ?? '', r.target_name ?? '', r.target_phone ?? '',
      r.amount, r.bucket, r.reason_code, r.reference_number ?? '',
      (r.business_justification ?? '').replace(/[\r\n",]/g, ' '),
      r.commission_component ?? 0, r.commission_acknowledged ? 'yes' : 'no',
      r.withdrawable_before ?? '', r.withdrawable_after ?? '',
      r.float_before ?? '', r.float_after ?? '',
      r.platform_destination ?? '', r.device ?? '', r.browser ?? '', r.client_ip ?? '', r.status,
    ].join(','));
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const filename = `error-corrections-last-${days}d.csv`;
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    // Bulk export of every wallet correction in the window -- amounts,
    // before/after balances, target phone numbers -- not logged before
    // this (each underlying row records its own IP, but the export action
    // itself did not). Plain client-side insert so the audit_logs
    // IP-capture trigger sees the real browser IP directly. Never blocks
    // the actual download.
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        await supabase.from('audit_logs').insert({
          user_id: user?.id ?? null,
          action_type: 'csv_exported',
          table_name: 'error_correction_audit',
          record_id: null,
          metadata: { filename, row_count: rows.length },
        });
      } catch (e) {
        console.warn('[ErrorCorrectionAuditPanel] audit log insert failed:', e);
      }
    })();
  };

  const totals = report.data?.totals;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">Wallet Error Corrections</h1>
          <p className="text-sm text-muted-foreground">
            Every FinOps recovery from a user wallet, who authorised it, and why.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {[7, 30, 90].map((d) => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? 'default' : 'outline'}
              onClick={() => setDays(d)}
            >
              {d}d
            </Button>
          ))}
          <Button size="sm" variant="outline" onClick={exportCsv} className="gap-1">
            <Download className="h-4 w-4" /> CSV
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Corrections', value: String(totals?.corrections ?? 0) },
          { label: 'Total recovered', value: fmt(totals?.total_amount ?? 0) },
          { label: 'Earned commission removed', value: fmt(totals?.commission_amount ?? 0) },
          { label: 'Users affected', value: String(totals?.distinct_users ?? 0) },
        ].map((k) => (
          <Card key={k.label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{k.label}</p>
              <p className="text-lg font-bold text-foreground">{k.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="approvals">
        <TabsList className="flex-wrap">
          <TabsTrigger value="approvals" className="gap-1">
            <ShieldCheck className="h-4 w-4" /> Approvals
            {(approvals.data?.length ?? 0) > 0 && (
              <Badge variant="secondary">{approvals.data?.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="alerts" className="gap-1">
            <AlertTriangle className="h-4 w-4" /> Alerts
            {pendingAlerts.length > 0 && <Badge variant="destructive">{pendingAlerts.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="register" className="gap-1">
            <ClipboardList className="h-4 w-4" /> Register
          </TabsTrigger>
          <TabsTrigger value="report" className="gap-1">
            <BarChart3 className="h-4 w-4" /> Report
          </TabsTrigger>
        </TabsList>

        <TabsContent value="approvals" className="space-y-3 pt-3">
          {approvals.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
          {!approvals.isLoading && (approvals.data?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">No corrections are awaiting approval.</p>
          )}
          {(approvals.data ?? []).map((a) => (
            <Card key={a.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
                  <span>{fmt(a.amount)} from {a.target_name ?? 'user'}</span>
                  <Badge variant="outline">
                    {a.approvals_count}/{a.required_approvals} approvals
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <p className="text-muted-foreground">
                  {a.bucket} bucket · {a.reason_code} · ref {a.reference_number ?? '—'} ·
                  requested by {a.requested_by_name ?? 'operator'} on {when(a.created_at)}
                </p>
                <p className="text-foreground">{a.business_justification}</p>
                {a.commission_component > 0 && (
                  <p className="text-destructive font-medium">
                    Includes {fmt(a.commission_component)} of earned commission.
                  </p>
                )}
                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={() => { setDecision({ row: a, action: 'approve' }); setNote(''); }}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setDecision({ row: a, action: 'reject' }); setNote(''); }}
                  >
                    Reject
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="alerts" className="space-y-2 pt-3">
          {(alerts.data?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">No alerts in this window.</p>
          )}
          {(alerts.data ?? []).map((al) => (
            <div
              key={al.id}
              className={`rounded-lg border p-3 text-xs ${severityTone[al.severity] ?? severityTone.medium}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">
                  {al.alert_type.replace(/_/g, ' ')} — {fmt(al.amount)}
                </span>
                <span>{when(al.created_at)}</span>
              </div>
              <p className="mt-1 text-muted-foreground">
                {al.operator_name ?? 'operator'} → {al.target_name ?? 'user'} · {al.bucket} ·{' '}
                {al.reason_code} · ref {al.reference_number ?? '—'}
              </p>
              {al.acknowledged_at ? (
                <p className="mt-1">Acknowledged {when(al.acknowledged_at)}</p>
              ) : (
                <Button size="sm" variant="outline" className="mt-2" onClick={() => acknowledge(al.id)}>
                  Acknowledge
                </Button>
              )}
            </div>
          ))}
        </TabsContent>

        <TabsContent value="register" className="space-y-3 pt-3">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search operator, user, phone, reason or reference"
          />
          {audit.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
          {rows.length === 0 && !audit.isLoading && (
            <p className="text-sm text-muted-foreground">No corrections recorded in this window.</p>
          )}
          {rows.map((r) => (
            <Card key={r.id}>
              <CardContent className="space-y-1 p-4 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {fmt(r.amount)} · {r.bucket}
                  </span>
                  <Badge variant={r.status === 'posted' ? 'secondary' : 'outline'}>{r.status}</Badge>
                </div>
                <p className="text-muted-foreground">
                  {when(r.created_at)} · {r.operator_name ?? 'operator'}
                  {r.operator_roles?.length ? ` (${r.operator_roles.join(', ')})` : ''} →{' '}
                  {r.target_name ?? 'user'} {r.target_phone ? `· ${r.target_phone}` : ''}
                </p>
                <p className="text-muted-foreground">
                  {r.reason_code} · ref {r.reference_number ?? '—'} · to{' '}
                  {r.platform_destination ?? 'Welile Platform'}
                </p>
                {r.business_justification && <p className="text-foreground">{r.business_justification}</p>}
                <p className="text-muted-foreground">
                  Withdrawable {fmt(r.withdrawable_before ?? 0)} → {fmt(r.withdrawable_after ?? 0)} ·
                  Float {fmt(r.float_before ?? 0)} → {fmt(r.float_after ?? 0)}
                </p>
                {(r.commission_component ?? 0) > 0 && (
                  <p className="text-destructive">
                    Earned commission touched: {fmt(r.commission_component ?? 0)}
                    {r.commission_acknowledged ? ' (acknowledged)' : ''}
                  </p>
                )}
                <p className="text-muted-foreground">
                  {[r.device, r.browser, r.client_ip].filter(Boolean).join(' · ') || 'No device data'}
                </p>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="report" className="space-y-4 pt-3">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">By operator</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-xs">
              {(report.data?.by_operator ?? []).map((o, i) => (
                <div key={i} className="flex justify-between">
                  <span className="text-muted-foreground">{o.operator_name ?? 'operator'}</span>
                  <span className="font-semibold text-foreground">
                    {o.corrections} · {fmt(o.total_amount)}
                  </span>
                </div>
              ))}
              {(report.data?.by_operator ?? []).length === 0 && (
                <p className="text-muted-foreground">No data.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">By reason code</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-xs">
              {(report.data?.by_reason ?? []).map((o, i) => (
                <div key={i} className="flex justify-between">
                  <span className="text-muted-foreground">{o.reason_code}</span>
                  <span className="font-semibold text-foreground">
                    {o.corrections} · {fmt(o.total_amount)}
                  </span>
                </div>
              ))}
              {(report.data?.by_reason ?? []).length === 0 && (
                <p className="text-muted-foreground">No data.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AlertDialog open={!!decision} onOpenChange={(o) => { if (!o) setDecision(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {decision?.action === 'approve' ? 'Approve correction' : 'Reject correction'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  {fmt(decision?.row.amount ?? 0)} from{' '}
                  <span className="font-semibold">{decision?.row.target_name ?? 'user'}</span>'s{' '}
                  {decision?.row.bucket} balance.
                </p>
                <p className="text-muted-foreground">{decision?.row.business_justification}</p>
                <div>
                  <Label htmlFor="ec-note" className="text-xs">
                    Note {decision?.action === 'reject' ? '(required, min 10 characters)' : '(optional)'}
                  </Label>
                  <Textarea
                    id="ec-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    className="mt-1"
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); submitDecision(); }} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default ErrorCorrectionAuditPanel;