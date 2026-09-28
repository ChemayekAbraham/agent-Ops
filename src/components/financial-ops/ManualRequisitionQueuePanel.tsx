import { useEffect, useState } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, Paperclip, XCircle } from 'lucide-react';

type ReviewStage = 'coo' | 'cfo';

interface ManualRequisition {
  id: string;
  employee_name: string;
  employee_email: string;
  employee_phone: string | null;
  employee_id: string | null;
  department: string | null;
  purpose: string;
  category: string;
  amount: number;
  approved_amount: number | null;
  currency: string;
  priority: string;
  required_by: string | null;
  description: string | null;
  attachment_urls: string[];
  status: string;
  workflow_stage: string;
  submitted_at: string;
  coo_decided_at: string | null;
  rejection_reason: string | null;
  wallet_credit_status: string | null;
}

const stageCopy: Record<ReviewStage, { title: string; status: string; approve: string; empty: string }> = {
  coo: {
    title: 'Manual requisitions awaiting COO review',
    status: 'pending_coo',
    approve: 'Approve & send to CFO',
    empty: 'No manual requisitions are waiting for COO review.',
  },
  cfo: {
    title: 'Manual requisitions awaiting CFO approval',
    status: 'pending_cfo',
    approve: 'Approve & credit wallet',
    empty: 'No manual requisitions are waiting for CFO approval.',
  },
};

export function ManualRequisitionQueuePanel({ stage }: { stage: ReviewStage }) {
  const [rows, setRows] = useState<ManualRequisition[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});
  const [amountEdits, setAmountEdits] = useState<Record<string, string>>({});

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('employee_requisitions')
      .select('*')
      // The staged workflow (`coo` / `cfo`) only ever applies to manual
      // requisitions, so stage alone identifies them — filtering on link_id
      // here hid rows whose link reference failed to save.
      .eq('workflow_stage', stage)
      .eq('status', stageCopy[stage].status)
      .order('submitted_at', { ascending: false })
      .limit(200);
    if (error) toast.error(error.message);
    setRows((data as ManualRequisition[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, [stage]);

  // Polled every 60s (+ on focus). The old Realtime listener was on employee_requisitions, which
  // is not in the publication, so it never fired (doc 147).
  const { lastUpdatedAt, refresh } = usePolling(() => load(), 60_000);

  const decide = async (row: ManualRequisition, action: 'approve' | 'reject') => {
    const reason = rejectReason[row.id]?.trim() ?? '';
    if (action === 'reject' && reason.length < 10) {
      toast.error('Add a rejection reason of at least 10 characters.');
      return;
    }

    const rawAmount = amountEdits[row.id];
    const amount = rawAmount !== undefined && rawAmount !== '' ? Number(rawAmount) : Number(row.amount);
    if (action === 'approve' && (!Number.isFinite(amount) || amount <= 0)) {
      toast.error('Enter a valid approved amount.');
      return;
    }

    setBusyId(row.id);
    const { data, error } = await supabase.functions.invoke('requisition-decide', {
      body: {
        id: row.id,
        action,
        reason: action === 'reject' ? reason : undefined,
        amount: action === 'approve' && Math.abs(amount - Number(row.amount)) > 0.001 ? amount : undefined,
      },
    });
    setBusyId(null);

    const payload = data as { error?: string; message?: string; rolled_back?: boolean } | null;
    if (error || payload?.error || payload?.rolled_back) {
      toast.error('Requisition decision failed', {
        description: payload?.message ?? payload?.error ?? error?.message ?? 'No funds were moved.',
      });
      return;
    }

    toast.success(action === 'approve'
      ? stage === 'coo' ? 'Approved and forwarded to CFO.' : 'Approved and sent to the employee wallet.'
      : 'Manual requisition rejected.');
    setExpanded(null);
    setRejectReason(prev => ({ ...prev, [row.id]: '' }));
    await load();
  };

  const openAttachment = async (path: string) => {
    const { data, error } = await supabase.storage.from('requisition-attachments').createSignedUrl(path, 300);
    if (error) return toast.error(error.message);
    if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{stageCopy[stage].title}</h2>
          <p className="text-xs text-muted-foreground">Shareable-link submissions only · {stage === 'coo' ? 'no wallet credit occurs here' : 'wallet credit happens after this approval'}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()}>Refresh</Button>
      </div>

      {loading ? (
        <div className="py-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">{stageCopy[stage].empty}</Card>
      ) : (
        <div className="space-y-2">
          {rows.map(row => {
            const open = expanded === row.id;
            return (
              <Card key={row.id} className="p-3">
                <button className="w-full text-left" onClick={() => setExpanded(open ? null : row.id)}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{row.employee_name} · {row.currency} {Number(row.amount).toLocaleString()}</p>
                      <p className="truncate text-xs text-muted-foreground">{row.department || 'No department'} · {row.category} · {row.purpose}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">Submitted {new Date(row.submitted_at).toLocaleString()} · {row.priority}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Badge variant="secondary">{stage === 'coo' ? 'COO review' : 'CFO review'}</Badge>
                      {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                    </div>
                  </div>
                </button>

                {open && (
                  <div className="mt-3 space-y-3 border-t border-border pt-3 text-sm">
                    <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                      <div><span className="text-muted-foreground">Email:</span> {row.employee_email}</div>
                      <div><span className="text-muted-foreground">Phone:</span> {row.employee_phone || '—'}</div>
                      <div><span className="text-muted-foreground">Employee ID:</span> {row.employee_id || '—'}</div>
                      <div><span className="text-muted-foreground">Required by:</span> {row.required_by || '—'}</div>
                    </div>
                    {row.description && <p className="whitespace-pre-wrap text-sm"><span className="text-xs text-muted-foreground">Description: </span>{row.description}</p>}
                    {row.attachment_urls?.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {row.attachment_urls.map(path => (
                          <Button key={path} size="sm" variant="outline" onClick={() => void openAttachment(path)}>
                            <Paperclip className="mr-1 h-3.5 w-3.5" /> {path.split('/').pop()}
                          </Button>
                        ))}
                      </div>
                    )}
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Approved amount ({row.currency})</Label>
                      <Input
                        type="number"
                        min={1}
                        step="1"
                        value={amountEdits[row.id] ?? String(row.approved_amount ?? row.amount)}
                        onChange={event => setAmountEdits(prev => ({ ...prev, [row.id]: event.target.value }))}
                        className="h-9"
                      />
                    </div>
                    <Textarea
                      rows={2}
                      placeholder="Rejection reason (required, minimum 10 characters)"
                      value={rejectReason[row.id] ?? ''}
                      onChange={event => setRejectReason(prev => ({ ...prev, [row.id]: event.target.value }))}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" disabled={busyId === row.id} onClick={() => void decide(row, 'approve')}>
                        <CheckCircle2 className="mr-1 h-4 w-4" /> {stageCopy[stage].approve}
                      </Button>
                      <Button size="sm" variant="destructive" disabled={busyId === row.id} onClick={() => void decide(row, 'reject')}>
                        <XCircle className="mr-1 h-4 w-4" /> Reject
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
