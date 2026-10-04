import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { Copy, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  requestId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ACTOR_FIELDS: Array<[string, string]> = [
  ['initiated_by', 'Initiated by'],
  ['processed_by', 'Processed by'],
  ['manager_approved_by', 'Manager approved by'],
  ['fin_ops_verified_by', 'Financial Ops verified by'],
  ['fin_ops_approved_by', 'Financial Ops approved by'],
  ['cfo_approved_by', 'CFO approved by'],
  ['coo_approved_by', 'COO approved by'],
  ['processing_started_by', 'Processing started by'],
  ['dispatch_claimed_by', 'Dispatch claimed by'],
  ['assigned_cashout_agent_id', 'Assigned cash-out agent'],
  ['preferred_cashout_agent_id', 'Preferred cash-out agent'],
  ['agent_id', 'Agent'],
  ['linked_party', 'Linked party'],
  ['beneficiary_id', 'Beneficiary'],
  ['proxy_partner_id', 'Proxy partner'],
];

const TIME_FIELDS: Array<[string, string]> = [
  ['created_at', 'Requested'],
  ['manager_approved_at', 'Manager approved'],
  ['fin_ops_verified_at', 'Financial Ops verified'],
  ['fin_ops_approved_at', 'Financial Ops approved'],
  ['cfo_approved_at', 'CFO approved'],
  ['coo_approved_at', 'COO approved'],
  ['processing_started_at', 'Processing started'],
  ['dispatched_at', 'Dispatched'],
  ['dispatch_claimed_at', 'Dispatch claimed'],
  ['processed_at', 'Processed / settled'],
  ['updated_at', 'Last updated'],
];

const Row = ({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) => (
  <div className="flex items-start justify-between gap-3 py-1.5 text-xs">
    <span className="text-muted-foreground shrink-0">{label}</span>
    <span className={`text-right font-medium break-all ${mono ? 'font-mono' : ''}`}>{value}</span>
  </div>
);

export default function WithdrawalRecordDetailDialog({ requestId, open, onOpenChange }: Props) {
  const [loading, setLoading] = useState(false);
  const [record, setRecord] = useState<Record<string, any> | null>(null);
  const [names, setNames] = useState<Record<string, { full_name: string; phone: string | null }>>({});
  const [audit, setAudit] = useState<any[]>([]);

  useEffect(() => {
    if (!open || !requestId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setRecord(null);
      setAudit([]);
      try {
        const { data, error } = await supabase
          .from('withdrawal_requests')
          .select('*')
          .eq('id', requestId)
          .maybeSingle();
        if (error) throw error;
        if (cancelled) return;
        setRecord(data);

        const ids = new Set<string>();
        if (data?.user_id) ids.add(data.user_id);
        ACTOR_FIELDS.forEach(([f]) => { if (data?.[f]) ids.add(data[f]); });

        const [profRes, auditRes] = await Promise.all([
          ids.size
            ? supabase.from('profiles').select('id, full_name, phone').in('id', Array.from(ids))
            : Promise.resolve({ data: [] as any[] }),
          supabase
            .from('audit_logs')
            .select('id, action_type, reason, created_at, performed_by, table_name')
            .eq('record_id', requestId)
            .order('created_at', { ascending: false })
            .limit(20),
        ]);
        if (cancelled) return;
        const map: Record<string, { full_name: string; phone: string | null }> = {};
        (profRes.data || []).forEach((p: any) => { map[p.id] = { full_name: p.full_name, phone: p.phone }; });
        setNames(map);
        setAudit(auditRes.data || []);
      } catch (e: any) {
        toast.error(e?.message || 'Failed to load withdrawal record');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, requestId]);

  const actorLabel = (id: string | null) => {
    if (!id) return null;
    const p = names[id];
    return p ? `${p.full_name}${p.phone ? ` · ${p.phone}` : ''}` : id;
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success('Copied');
  };

  const ts = (v: string | null) => (v ? format(new Date(v), 'MMM d, yyyy • HH:mm:ss') : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Withdrawal record
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-10 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" /></div>
        ) : !record ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Record not found.</p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border p-3 bg-muted/30">
              <div className="flex items-center justify-between">
                <p className="text-xl font-bold">UGX {Number(record.amount).toLocaleString()}</p>
                <Badge variant="outline" className="capitalize text-xs">{String(record.status).replace(/_/g, ' ')}</Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{actorLabel(record.user_id) || 'Unknown requester'}</p>
              <button
                onClick={() => copy(record.id)}
                className="mt-2 flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground hover:text-primary"
              >
                {record.id}<Copy className="h-3 w-3" />
              </button>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Destination</p>
              <Separator className="mb-1" />
              <Row label="Payout method" value={String(record.payout_method || '—').replace(/_/g, ' ')} />
              {record.mobile_money_provider && <Row label="Provider" value={String(record.mobile_money_provider).toUpperCase()} />}
              {record.mobile_money_number && (
                <Row
                  label="Mobile money number"
                  mono
                  value={
                    <button onClick={() => copy(record.mobile_money_number)} className="hover:text-primary inline-flex items-center gap-1">
                      {record.mobile_money_number}<Copy className="h-3 w-3" />
                    </button>
                  }
                />
              )}
              {record.mobile_money_name && <Row label="Account name" value={record.mobile_money_name} />}
              {record.bank_name && <Row label="Bank" value={record.bank_name} />}
              {record.bank_account_number && <Row label="Bank account" value={record.bank_account_number} mono />}
              {record.bank_account_name && <Row label="Bank account name" value={record.bank_account_name} />}
              {record.agent_location && <Row label="Agent location" value={record.agent_location} />}
              {record.payout_code && <Row label="Payout code" value={record.payout_code} mono />}
              {record.transaction_id && <Row label="Transaction ID" value={record.transaction_id} mono />}
              {record.transaction_time && <Row label="Transaction time" value={record.transaction_time} />}
              {record.fin_ops_reference && <Row label="Financial Ops reference" value={record.fin_ops_reference} mono />}
              {record.fin_ops_payment_method && <Row label="Financial Ops channel" value={String(record.fin_ops_payment_method).replace(/_/g, ' ')} />}
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Who touched it</p>
              <Separator className="mb-1" />
              {ACTOR_FIELDS.filter(([f]) => record[f]).map(([f, label]) => (
                <Row key={f} label={label} value={actorLabel(record[f])} />
              ))}
              {ACTOR_FIELDS.every(([f]) => !record[f]) && (
                <p className="text-xs text-muted-foreground py-2">No actor recorded on this request.</p>
              )}
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Timeline</p>
              <Separator className="mb-1" />
              {TIME_FIELDS.filter(([f]) => record[f]).map(([f, label]) => (
                <Row key={f} label={label} value={ts(record[f])} />
              ))}
            </div>

            {(record.reason || record.rejection_reason) && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Notes</p>
                <Separator className="mb-1" />
                {record.reason && <Row label="Reason given" value={record.reason} />}
                {record.rejection_reason && <Row label="Rejection reason" value={record.rejection_reason} />}
              </div>
            )}

            {audit.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Audit log</p>
                <Separator className="mb-1" />
                {audit.map((a) => (
                  <div key={a.id} className="py-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{String(a.action_type).replace(/_/g, ' ')}</span>
                      <span className="text-muted-foreground">{ts(a.created_at)}</span>
                    </div>
                    {a.reason && <p className="text-muted-foreground mt-0.5">{a.reason}</p>}
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => copy(JSON.stringify(record, null, 2))}>
                Copy full record
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}