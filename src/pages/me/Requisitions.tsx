import { useCallback, useEffect, useMemo, useState } from 'react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  Loader2, Plus, Clock, CheckCircle2, XCircle, HelpCircle, Building2, Wallet, Paperclip, Upload, X, FileText,
  Landmark,
} from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { staffLoanSchedule, MONTH_WORDS, STAFF_LOAN_MAX_MONTHS } from '@/lib/staffLoanSchedule';

type RequestKind = 'requisition' | 'staff_loan';

interface LoanEligibility {
  eligible: boolean;
  monthly_rate?: number;
  max_months?: number;
  active_loans?: number;
  outstanding?: number;
}

interface StaffLoan {
  id: string;
  requisition_id: string;
  principal: number;
  months: number;
  monthly_rate: number;
  outstanding_principal: number;
  accrued_interest: number;
  total_repaid: number;
  status: string;
  started_on: string;
  due_on: string | null;
}

interface Requisition {
  id: string;
  requisition_code: string;
  title: string;
  amount: number;
  approved_amount: number | null;
  reason: string;
  category: string | null;
  needed_by: string | null;
  stage: string;
  current_approver_role: string | null;
  final_stage: string;
  rejection_reason: string | null;
  wallet_credit_status: string | null;
  credited_at: string | null;
  created_at: string;
  attachment_urls: string[] | null;
  request_kind: RequestKind | null;
  loan_months: number | null;
}

interface ReqEvent {
  id: string;
  requisition_id: string;
  actor_name: string | null;
  action: string;
  stage: string | null;
  comment: string | null;
  created_at: string;
}

interface UsageReport {
  id: string;
  requisition_id: string;
  amount_used: number;
  summary: string;
  submitted_at: string | null;
  attachment_paths: string[] | null;
}

interface RouteInfo {
  department_id: string | null;
  department_key: string | null;
  department_name: string | null;
  stage: string;
  approver_role: string | null;
  final_stage: string;
}

const STAGE_LABEL: Record<string, string> = {
  supervisor: 'Department head',
  coo: 'COO',
  cfo: 'CFO',
  ceo: 'CEO',
  approved: 'Approved',
  rejected: 'Declined',
  returned: 'Needs your update',
};

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function StatusPill({ row }: { row: Requisition }) {
  if (row.stage === 'approved') {
    return (
      <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700">
        <CheckCircle2 className="mr-1 h-3 w-3" /> Approved
      </Badge>
    );
  }
  if (row.stage === 'rejected') {
    return (
      <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-700">
        <XCircle className="mr-1 h-3 w-3" /> Declined
      </Badge>
    );
  }
  if (row.stage === 'returned') {
    return (
      <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-blue-700">
        <HelpCircle className="mr-1 h-3 w-3" /> Needs your update
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700">
      <Clock className="mr-1 h-3 w-3" /> With {STAGE_LABEL[row.stage] || row.stage}
    </Badge>
  );
}

const EMPTY_FORM = {
  title: '',
  amount: '',
  category: '',
  needed_by: '',
  reason: '',
};

const MyRequisitions = () => {
  const [rows, setRows] = useState<Requisition[]>([]);
  const [events, setEvents] = useState<Record<string, ReqEvent[]>>({});
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [resubmitId, setResubmitId] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [viewingPath, setViewingPath] = useState<string | null>(null);
  const [usageReports, setUsageReports] = useState<Record<string, UsageReport>>({});
  const [kind, setKind] = useState<RequestKind>('requisition');
  const [months, setMonths] = useState(3);
  const [loanInfo, setLoanInfo] = useState<LoanEligibility | null>(null);
  const [loans, setLoans] = useState<StaffLoan[]>([]);

  const fetchRows = useCallback(async () => {
    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes.user?.id;
    if (!uid) { setLoading(false); return; }

    const [reqRes, routeRes] = await Promise.all([
      supabase
        .from('staff_requisitions')
        .select('*')
        .eq('requester_id', uid)
        .order('created_at', { ascending: false }),
      supabase.rpc('staff_requisition_route', { _user_id: uid }),
    ]);

    if (reqRes.error) {
      toast.error('Could not load your requisitions', { description: reqRes.error.message });
    } else {
      const list = (reqRes.data || []) as unknown as Requisition[];
      setRows(list);

      // One batched read for the accountability reports of every listed requisition.
      if (list.length) {
        const { data: reports } = await supabase
          .from('staff_requisition_usage_reports')
          .select('id, requisition_id, amount_used, summary, submitted_at, attachment_paths')
          .in('requisition_id', list.map((r) => r.id));
        const map: Record<string, UsageReport> = {};
        for (const rep of (reports || []) as unknown as UsageReport[]) map[rep.requisition_id] = rep;
        setUsageReports(map);
      } else {
        setUsageReports({});
      }
    }
    if (!routeRes.error && routeRes.data) {
      const r = Array.isArray(routeRes.data) ? routeRes.data[0] : routeRes.data;
      setRoute(r as unknown as RouteInfo);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void fetchRows(); }, [fetchRows]);

  // Who may borrow, and what they already owe.
  const fetchLoans = useCallback(async () => {
    const { data: elig } = await supabase.rpc('my_staff_loan_eligibility');
    setLoanInfo((elig ?? null) as unknown as LoanEligibility | null);
    const { data: loanRows } = await supabase
      .from('staff_loans')
      .select('id, requisition_id, principal, months, monthly_rate, outstanding_principal, accrued_interest, total_repaid, status, started_on, due_on')
      .order('created_at', { ascending: false });
    setLoans((loanRows || []) as unknown as StaffLoan[]);
  }, []);

  useEffect(() => { void fetchLoans(); }, [fetchLoans]);

  useEffect(() => {
    const channel = supabase
      .channel('my-staff-requisitions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'staff_requisitions' }, () => { void fetchRows(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [fetchRows]);

  const loadEvents = useCallback(async (id: string) => {
    if (events[id]) return;
    const { data } = await supabase
      .from('staff_requisition_events')
      .select('*')
      .eq('requisition_id', id)
      .order('created_at', { ascending: true });
    setEvents((prev) => ({ ...prev, [id]: (data || []) as unknown as ReqEvent[] }));
  }, [events]);

  const routeLine = useMemo(() => {
    if (!route) return null;
    const stages = ['supervisor', 'coo', 'cfo', 'ceo'];
    const startIdx = Math.max(0, stages.indexOf(route.stage));
    const endIdx = route.final_stage === 'ceo' ? stages.indexOf('ceo') : stages.indexOf('cfo');
    const supervisorLabel = route.approver_role
      ? route.approver_role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      : STAGE_LABEL.supervisor;
    const chain = stages
      .slice(startIdx, endIdx + 1)
      .map((s) => (s === 'supervisor' ? supervisorLabel : STAGE_LABEL[s] || s));
    return chain.join(' → ');
  }, [route]);


  const startNew = (nextKind: RequestKind = 'requisition') => {
    setResubmitId(null);
    setKind(nextKind);
    setMonths(3);
    setForm(EMPTY_FORM);
    setSelectedFiles([]);
    setOpen(true);
  };

  const startResubmit = (row: Requisition) => {
    setResubmitId(row.id);
    setKind(row.request_kind === 'staff_loan' ? 'staff_loan' : 'requisition');
    setMonths(row.loan_months ?? 3);
    setSelectedFiles([]);
    setForm({
      title: row.title,
      amount: String(row.amount),
      category: row.category ?? '',
      needed_by: row.needed_by ?? '',
      reason: row.reason,
    });
    setOpen(true);
  };

  const handleFilesChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const valid: File[] = [];
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024) {
        toast.error(`File "${f.name}" is larger than 10MB`);
        continue;
      }
      valid.push(f);
    }
    setSelectedFiles((prev) => [...prev, ...valid].slice(0, 10));
    e.target.value = '';
  };

  const removeSelectedFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const submit = async () => {
    const amount = Number(form.amount);
    if (!form.title.trim()) return toast.error('Enter a short title');
    if (!Number.isFinite(amount) || amount <= 0) return toast.error('Enter a valid amount');
    if (form.reason.trim().length < 10) return toast.error('Explain the request in at least 10 characters');

    setSubmitting(true);
    const { data, error } = await invokeEdgeFunction<{ ok: boolean; requisition?: { id: string } }>('staff-requisition-submit', {
      body: {
        ...(resubmitId ? { requisition_id: resubmitId } : {}),
        title: form.title.trim(),
        amount,
        category: form.category.trim() || null,
        needed_by: form.needed_by || null,
        reason: form.reason.trim(),
        request_kind: kind,
        ...(kind === 'staff_loan' ? { loan_months: months } : {}),
      },
      errorTitle: kind === 'staff_loan' ? 'Could not submit your loan request' : 'Could not submit your requisition',
    });

    if (!error) {
      const targetId = resubmitId || data?.requisition?.id;
      if (targetId && selectedFiles.length > 0) {
        for (const file of selectedFiles) {
          const formData = new FormData();
          formData.append('requisition_id', targetId);
          formData.append('file', file);
          await invokeEdgeFunction('staff-requisition-add-attachment', {
            body: formData,
            errorTitle: `Could not attach ${file.name}`,
            silent: true,
          });
        }
      }

      toast.success(
        resubmitId
          ? 'Request resubmitted'
          : kind === 'staff_loan' ? 'Loan request submitted for review' : 'Requisition submitted for review',
      );
      setOpen(false);
      setForm(EMPTY_FORM);
      setSelectedFiles([]);
      setResubmitId(null);
      await fetchRows();
      await fetchLoans();
    }
    setSubmitting(false);
  };

  const uploadReceipt = async (row: Requisition, file: File) => {
    setUploadingId(row.id);
    const form = new FormData();
    form.append('requisition_id', row.id);
    form.append('file', file);
    const { error } = await invokeEdgeFunction('staff-requisition-add-attachment', {
      body: form,
      errorTitle: 'Could not attach receipt',
    });
    setUploadingId(null);
    if (!error) {
      toast.success('Receipt attached');
      await fetchRows();
    }
  };

  const viewAttachment = async (row: Requisition, path: string) => {
    setViewingPath(path);
    const { data, error } = await invokeEdgeFunction<{ url: string }>('staff-requisition-attachment-url', {
      body: { requisition_id: row.id, path },
      errorTitle: 'Could not open receipt',
    });
    setViewingPath(null);
    if (!error && data?.url) window.open(data.url, '_blank');
  };

  return (
    <PersonalLayout title="Make a requisition">
      <div className="space-y-4">
        <Card className="rounded-2xl p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <Building2 className="h-4 w-4 text-primary" />
                {route?.department_name || 'Your department'}
              </p>
              <p className="text-sm text-muted-foreground">
                {routeLine
                  ? `Your requests are reviewed in this order: ${routeLine}.`
                  : 'Your request is reviewed by your department head, then the COO, then the CFO.'}
              </p>
              <p className="text-xs text-muted-foreground">
                On final approval the amount is credited straight to your wallet.
              </p>
            </div>
            <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setResubmitId(null); }}>
              <div className="flex flex-wrap gap-2">
                <DialogTrigger asChild>
                  <Button onClick={() => startNew('requisition')}>
                    <Plus className="mr-2 h-4 w-4" /> New requisition
                  </Button>
                </DialogTrigger>
                {loanInfo?.eligible && (
                  <DialogTrigger asChild>
                    <Button variant="outline" onClick={() => startNew('staff_loan')}>
                      <Landmark className="mr-2 h-4 w-4" /> Request a loan
                    </Button>
                  </DialogTrigger>
                )}
              </div>
              <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>
                    {resubmitId
                      ? 'Update and resubmit'
                      : kind === 'staff_loan' ? 'Request a loan' : 'New requisition'}
                  </DialogTitle>
                  <DialogDescription>
                    {kind === 'staff_loan'
                      ? 'Reviewed by your department head, then the COO, then the CFO — the same as a requisition. Charged 30% a month on what you still owe.'
                      : 'Approvers see your department budget alongside the request.'}
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="req-title">What is it for</Label>
                    <Input
                      id="req-title"
                      value={form.title}
                      onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                      placeholder="Field data bundles for September"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="req-amount">Amount (UGX)</Label>
                      <Input
                        id="req-amount"
                        inputMode="numeric"
                        value={form.amount}
                        onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value.replace(/[^0-9.]/g, '') }))}
                        placeholder="250000"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="req-needed">Needed by (optional)</Label>
                      <Input
                        id="req-needed"
                        type="date"
                        value={form.needed_by}
                        onChange={(e) => setForm((f) => ({ ...f, needed_by: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="req-category">Category (optional)</Label>
                    <Input
                      id="req-category"
                      value={form.category}
                      onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                      placeholder="Operations, marketing, travel…"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="req-reason">Why do you need it</Label>
                    <Textarea
                      id="req-reason"
                      rows={3}
                      value={form.reason}
                      onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                      placeholder="Explain the need, what it covers and the expected outcome (min 10 characters)"
                    />
                  </div>
                  {/* Optional File Attachments */}
                  <div className="space-y-2">
                    <Label className="flex items-center justify-between text-xs sm:text-sm">
                      <span>Attachments / Receipts <span className="text-xs text-muted-foreground font-normal">(optional)</span></span>
                      <span className="text-[11px] text-muted-foreground">PDF, PNG, JPG (max 10MB)</span>
                    </Label>
                    <div className="border border-dashed border-border rounded-xl p-3 bg-muted/20 hover:bg-muted/30 transition-colors text-center">
                      <label className="cursor-pointer flex flex-col items-center justify-center gap-1">
                        <Upload className="h-4 w-4 text-muted-foreground" />
                        <span className="text-xs font-semibold text-primary">
                          Click to attach supporting documents or receipts
                        </span>
                        <input
                          type="file"
                          multiple
                          accept="application/pdf,image/jpeg,image/png,image/webp"
                          className="hidden"
                          onChange={handleFilesChosen}
                        />
                      </label>
                    </div>

                    {selectedFiles.length > 0 && (
                      <div className="space-y-1.5 pt-1">
                        {selectedFiles.map((file, idx) => (
                          <div
                            key={idx}
                            className="flex items-center justify-between p-2 rounded-lg bg-background border border-border text-xs"
                          >
                            <div className="flex items-center gap-2 min-w-0 pr-2">
                              <FileText className="h-4 w-4 text-primary shrink-0" />
                              <span className="truncate font-medium text-foreground">{file.name}</span>
                              <span className="text-[10px] text-muted-foreground shrink-0">
                                ({(file.size / (1024 * 1024) >= 1) ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(file.size / 1024)} KB`})
                              </span>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeSelectedFile(idx)}
                              className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0"
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>Cancel</Button>
                  <Button onClick={() => void submit()} disabled={submitting}>
                    {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {resubmitId ? 'Resubmit' : 'Submit for review'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </Card>

        {loading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading your requisitions…
          </div>
        ) : rows.length === 0 ? (
          <Card className="rounded-2xl p-8 text-center text-sm text-muted-foreground">
            You have not raised a requisition yet.
          </Card>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => (
              <Card key={row.id} className="rounded-2xl p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{row.requisition_code}</span>
                      <StatusPill row={row} />
                    </div>
                    <p className="font-semibold">{row.title}</p>
                    <p className="text-xs text-muted-foreground">Raised {fmtDate(row.created_at)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold">{formatUGX(Number(row.approved_amount ?? row.amount))}</p>
                    {row.approved_amount != null && Number(row.approved_amount) !== Number(row.amount) && (
                      <p className="text-xs text-muted-foreground">Requested {formatUGX(Number(row.amount))}</p>
                    )}
                  </div>
                </div>

                <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{row.reason}</p>

                {row.stage === 'approved' && (
                  <p className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm text-emerald-700">
                    <Wallet className="h-4 w-4" />
                    {row.wallet_credit_status === 'credited'
                      ? `Credited to your wallet ${fmtDate(row.credited_at)}`
                      : 'Approved — the wallet credit is being processed.'}
                  </p>
                )}

                {row.rejection_reason && (
                  <p className="mt-3 rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-700">
                    {row.rejection_reason}
                  </p>
                )}

                {usageReports[row.id] && (
                  <div className="mt-3 rounded-xl border bg-muted/30 p-3">
                    <p className="flex items-center gap-2 text-sm font-semibold">
                      <FileText className="h-4 w-4 text-emerald-600" /> Usage report submitted
                    </p>
                    <p className="mt-1 text-sm">
                      Used {formatUGX(Number(usageReports[row.id].amount_used))} • {fmtDate(usageReports[row.id].submitted_at)}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                      {usageReports[row.id].summary}
                    </p>
                    {(usageReports[row.id].attachment_paths?.length ?? 0) > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {usageReports[row.id].attachment_paths!.map((path, i) => (
                          <Button
                            key={path}
                            size="sm"
                            variant="outline"
                            disabled={viewingPath === path}
                            onClick={() => void viewAttachment(row, path)}
                          >
                            {viewingPath === path
                              ? <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                              : <Paperclip className="mr-2 h-3 w-3" />}
                            Report receipt {i + 1}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {(row.attachment_urls?.length ?? 0) > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {row.attachment_urls!.map((path) => (
                      <Button
                        key={path}
                        size="sm"
                        variant="outline"
                        disabled={viewingPath === path}
                        onClick={() => void viewAttachment(row, path)}
                      >
                        {viewingPath === path
                          ? <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                          : <Paperclip className="mr-2 h-3 w-3" />}
                        Receipt {row.attachment_urls!.indexOf(path) + 1}
                      </Button>
                    ))}
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => void loadEvents(row.id)}>
                    View progress
                  </Button>
                  {row.stage === 'returned' && (
                    <Button size="sm" variant="outline" onClick={() => startResubmit(row)}>
                      Update and resubmit
                    </Button>
                  )}
                  <span className="inline-flex items-center gap-2 text-sm">
                    {uploadingId === row.id
                      ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                      : <Upload className="h-3 w-3 text-muted-foreground" />}
                    <input
                      type="file"
                      accept="application/pdf,image/*"
                      className="text-xs"
                      disabled={uploadingId === row.id || (row.attachment_urls?.length ?? 0) >= 10}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.currentTarget.value = '';
                        if (file) void uploadReceipt(row, file);
                      }}
                    />
                  </span>
                </div>

                {(events[row.id]?.length ?? 0) > 0 && (
                  <div className="mt-3 space-y-2 rounded-xl border p-3">
                    {events[row.id].map((e) => (
                      <div key={e.id} className="text-xs">
                        <span className="font-medium capitalize">{e.action.replace(/_/g, ' ')}</span>
                        {e.stage ? ` • ${STAGE_LABEL[e.stage] || e.stage}` : ''} • {e.actor_name || 'System'} • {fmtDate(e.created_at)}
                        {e.comment && <p className="text-muted-foreground">{e.comment}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </PersonalLayout>
  );
};

export default MyRequisitions;
