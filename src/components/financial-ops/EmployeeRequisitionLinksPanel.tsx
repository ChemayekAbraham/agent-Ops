import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Copy, Link2, MessageCircle, Loader2, Ban, Plus } from 'lucide-react';

interface Row {
  id: string;
  token: string;
  label: string | null;
  department: string | null;
  expires_at: string | null;
  max_submissions: number | null;
  submission_count: number;
  is_active: boolean;
  revoked_at: string | null;
  created_at: string;
}

function buildUrl(token: string) {
  return `${window.location.origin}/requisition/new?t=${token}`;
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function EmployeeRequisitionLinksPanel() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ label: '', department: '', expires_in_days: '30', max_submissions: '' });

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('requisition_links')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) toast.error(error.message);
    setRows((data as Row[]) ?? []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!user) return;
    setCreating(true);
    const days = Math.max(1, Number(form.expires_in_days) || 30);
    const expires_at = new Date(Date.now() + days * 86400_000).toISOString();
    const max = form.max_submissions.trim() ? Math.max(1, Number(form.max_submissions)) : null;
    const { error } = await supabase.from('requisition_links').insert({
      token: generateToken(),
      created_by: user.id,
      label: form.label.trim() || null,
      department: form.department.trim() || null,
      expires_at,
      max_submissions: max,
    });
    setCreating(false);
    if (error) return toast.error(error.message);
    toast.success('Requisition link created');
    setForm({ label: '', department: '', expires_in_days: '30', max_submissions: '' });
    load();
  };

  const revoke = async (id: string) => {
    if (!confirm('Revoke this link? Employees will no longer be able to submit with it.')) return;
    const { error } = await supabase
      .from('requisition_links')
      .update({ is_active: false, revoked_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return toast.error(error.message);
    load();
  };

  const copy = (token: string) => {
    navigator.clipboard.writeText(buildUrl(token));
    toast.success('Link copied');
  };

  const whatsapp = (row: Row) => {
    const msg =
      `Hello Team,\n\nPlease use the following link whenever you need to submit a financial requisition.\n\n${buildUrl(row.token)}\n\nThank you.`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  };

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Plus className="h-4 w-4" />
          <h3 className="font-semibold">Create Requisition Link</h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Label</Label>
            <Input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="e.g. Marketing Requisitions" />
          </div>
          <div>
            <Label>Department</Label>
            <Input value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))} placeholder="e.g. Marketing" />
          </div>
          <div>
            <Label>Expires in (days)</Label>
            <Input type="number" min={1} value={form.expires_in_days} onChange={e => setForm(f => ({ ...f, expires_in_days: e.target.value }))} />
          </div>
          <div>
            <Label>Max submissions (optional)</Label>
            <Input type="number" min={1} value={form.max_submissions} onChange={e => setForm(f => ({ ...f, max_submissions: e.target.value }))} />
          </div>
        </div>
        <Button onClick={create} disabled={creating}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
          Generate secure link
        </Button>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold flex items-center gap-2"><Link2 className="h-4 w-4" /> Active Links</h3>
          <Button variant="ghost" size="sm" onClick={load}>Refresh</Button>
        </div>
        {loading ? (
          <div className="py-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No links yet. Create one above.</p>
        ) : (
          <ul className="space-y-3">
            {rows.map(r => {
              const expired = r.expires_at && new Date(r.expires_at) < new Date();
              const exhausted = r.max_submissions && r.submission_count >= r.max_submissions;
              const status = !r.is_active || r.revoked_at ? 'Revoked' : expired ? 'Expired' : exhausted ? 'Exhausted' : 'Active';
              const tone = status === 'Active' ? 'default' : 'secondary';
              return (
                <li key={r.id} className="border border-border rounded-lg p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{r.label ?? 'Requisition link'}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {r.department ? `${r.department} • ` : ''}
                        {r.submission_count}{r.max_submissions ? ` / ${r.max_submissions}` : ''} submissions
                        {r.expires_at ? ` • expires ${new Date(r.expires_at).toLocaleDateString()}` : ''}
                      </p>
                    </div>
                    <Badge variant={tone as never}>{status}</Badge>
                  </div>
                  <div className="text-xs font-mono bg-muted rounded px-2 py-1 truncate">{buildUrl(r.token)}</div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => copy(r.token)}>
                      <Copy className="h-3.5 w-3.5 mr-1" /> Copy
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => whatsapp(r)}>
                      <MessageCircle className="h-3.5 w-3.5 mr-1" /> WhatsApp
                    </Button>
                    {r.is_active && !r.revoked_at && (
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => revoke(r.id)}>
                        <Ban className="h-3.5 w-3.5 mr-1" /> Revoke
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
