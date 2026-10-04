import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import { Loader2, Upload, CheckCircle2, AlertCircle } from 'lucide-react';
import ScreenLoader from '@/components/common/ScreenLoader';

type Validation =
  | { state: 'loading' }
  | { state: 'invalid'; reason: string }
  | { state: 'ok'; label: string | null; department: string | null; expires_at: string | null };

const REASONS: Record<string, string> = {
  invalid_token: 'This link is invalid.',
  not_found: 'This link is not recognized.',
  revoked: 'This link has been revoked by the Finance department.',
  expired: 'This link has expired.',
  exhausted: 'This link has reached its submission limit.',
  server_error: 'Something went wrong. Please try again shortly.',
};

const CATEGORIES = [
  'Office Supplies', 'Equipment', 'Software', 'Travel', 'Meals',
  'Utilities', 'Rent', 'Marketing', 'Staff Welfare', 'Repairs', 'Other',
];

export default function PublicRequisitionForm() {
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';
  const [validation, setValidation] = useState<Validation>({ state: 'loading' });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [attachments, setAttachments] = useState<Array<{ path: string; name: string }>>([]);
  // Captured in parts; `form.employee_name` stays the single submitted string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const applyNameParts = (next: PersonNameParts) => {
    setNameParts(next);
    setForm(f => ({ ...f, employee_name: joinPersonName(next) }));
  };

  const [form, setForm] = useState({
    employee_name: '',
    employee_id: '',
    department: '',
    employee_phone: '',
    employee_email: '',
    purpose: '',
    category: '',
    amount: '',
    currency: 'UGX',
    priority: 'normal' as 'low' | 'normal' | 'high' | 'urgent',
    required_by: '',
    description: '',
  });

  useEffect(() => {
    (async () => {
      if (!token) {
        setValidation({ state: 'invalid', reason: 'invalid_token' });
        return;
      }
      const { data, error } = await supabase.functions.invoke('requisition-link-validate', {
        method: 'GET' as never,
        body: undefined as never,
        headers: undefined as never,
      }).catch(() => ({ data: null, error: new Error('network') }));
      // functions.invoke doesn't support query params easily — call fetch directly:
      try {
        const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID;
        const res = await fetch(
          `https://${projectRef}.supabase.co/functions/v1/requisition-link-validate?token=${encodeURIComponent(token)}`,
          { headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY } },
        );
        const j = await res.json();
        if (!j.valid) {
          setValidation({ state: 'invalid', reason: j.reason ?? 'invalid_token' });
        } else {
          setValidation({ state: 'ok', label: j.label, department: j.department, expires_at: j.expires_at });
          if (j.department) setForm(f => ({ ...f, department: j.department }));
        }
      } catch {
        setValidation({ state: 'invalid', reason: 'server_error' });
      }
      // suppress unused
      void data; void error;
    })();
  }, [token]);

  const canSubmit = useMemo(() => {
    return (
      validatePersonNameParts(nameParts).valid &&
      form.employee_email.includes('@') &&
      form.purpose.trim().length >= 3 &&
      form.category &&
      Number(form.amount) > 0 &&
      !submitting
    );
  }, [form, nameParts, submitting]);

  const onFile = async (file: File) => {
    setUploading(true);
    try {
      const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const fd = new FormData();
      fd.append('token', token);
      fd.append('file', file);
      const res = await fetch(
        `https://${projectRef}.supabase.co/functions/v1/requisition-upload`,
        { method: 'POST', headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY }, body: fd },
      );
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? 'upload_failed');
      setAttachments(a => [...a, { path: j.path, name: j.name }]);
      toast.success('Attachment uploaded');
    } catch (e) {
      toast.error(`Upload failed: ${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  const onSubmit = async () => {
    setSubmitting(true);
    try {
      const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const res = await fetch(
        `https://${projectRef}.supabase.co/functions/v1/requisition-submit`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({
            token,
            ...form,
            amount: Number(form.amount),
            required_by: form.required_by || null,
            attachment_urls: attachments.map(a => a.path),
          }),
        },
      );
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(REASONS[j.error] ?? j.error ?? 'Submission failed');
      setDone(true);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (validation.state === 'loading') {
    return (
      <ScreenLoader />
    );
  }

  if (validation.state === 'invalid') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="max-w-md w-full p-6 text-center space-y-3">
          <AlertCircle className="h-10 w-10 text-destructive mx-auto" />
          <h1 className="text-lg font-bold">Link unavailable</h1>
          <p className="text-sm text-muted-foreground">
            {REASONS[validation.reason] ?? 'This requisition link is no longer active.'}
          </p>
          <p className="text-xs text-muted-foreground">
            Please contact your Finance Department for a new link.
          </p>
        </Card>
      </div>
    );
  }

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="max-w-md w-full p-6 text-center space-y-3">
          <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto" />
          <h1 className="text-lg font-bold">Requisition submitted</h1>
          <p className="text-sm text-muted-foreground">
            Your requisition has been sent to the COO for review first, then to the CFO for final approval. You will be notified by email as it moves through the process.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-4">
        <div>
          <h1 className="text-2xl font-bold">Submit a Requisition</h1>
          <p className="text-sm text-muted-foreground">
            {validation.label ? `${validation.label} — ` : ''}Fill in the details below. Your request will go to the COO first, then the CFO.
          </p>
        </div>

        <Card className="p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Full Name *</Label>
              <PersonNameFields idPrefix="requisition" value={nameParts} onChange={applyNameParts} />
            </div>
            <div>
              <Label>Department</Label>
              <Input value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))} />
            </div>
            <div>
              <Label>Phone</Label>
              <Input value={form.employee_phone} onChange={e => setForm(f => ({ ...f, employee_phone: e.target.value }))} />
            </div>
            <div className="sm:col-span-2">
              <Label>Email *</Label>
              <Input type="email" value={form.employee_email} onChange={e => setForm(f => ({ ...f, employee_email: e.target.value }))} />
            </div>
            <div className="sm:col-span-2">
              <Label>Purpose *</Label>
              <Input value={form.purpose} onChange={e => setForm(f => ({ ...f, purpose: e.target.value }))} placeholder="Short summary" />
            </div>
            <div>
              <Label>Category *</Label>
              <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v }))}>
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Amount (UGX) *</Label>
              <Input type="number" min={1} value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
            </div>
            <div>
              <Label>Priority</Label>
              <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v as typeof form.priority }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Required By</Label>
              <Input type="date" value={form.required_by} onChange={e => setForm(f => ({ ...f, required_by: e.target.value }))} />
            </div>
            <div className="sm:col-span-2">
              <Label>Description</Label>
              <Textarea rows={4} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Add context, quotes, vendor info…" />
            </div>
            <div className="sm:col-span-2">
              <Label>Attachments (PDF or image, up to 10MB each)</Label>
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="file"
                  accept="application/pdf,image/*"
                  onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = ''; }}
                  className="text-sm"
                  disabled={uploading || attachments.length >= 10}
                />
                {uploading && <Loader2 className="h-4 w-4 animate-spin" />}
              </div>
              {attachments.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {attachments.map(a => (
                    <li key={a.path} className="flex items-center gap-1">
                      <Upload className="h-3 w-3" /> {a.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <Button className="w-full" disabled={!canSubmit} onClick={onSubmit}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Submit Requisition
          </Button>
          <p className="text-[11px] text-muted-foreground text-center">
            By submitting, you confirm the information above is accurate. Fraudulent submissions may result in disciplinary action.
          </p>
        </Card>
      </div>
    </div>
  );
}
