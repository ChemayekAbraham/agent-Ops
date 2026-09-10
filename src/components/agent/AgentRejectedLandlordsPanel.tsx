import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  XCircle, Phone, Loader2, Pencil, Send, X, AlertTriangle, RotateCcw,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface RejectedRequest {
  id: string;
  landlord_id: string;
  landlord_name: string | null;
  landlord_phone: string | null;
  reject_comment: string | null;
  resolved_at: string | null;
}

interface LandlordEditFields {
  name: string;
  phone: string;
  property_address: string;
  monthly_rent: string;
  mobile_money_number: string;
  mobile_money_name: string;
  caretaker_name: string;
  caretaker_phone: string;
}

const EDIT_FIELDS: Array<{ key: keyof LandlordEditFields; label: string; type?: 'text' | 'number' | 'tel' }> = [
  { key: 'name', label: 'Landlord name' },
  { key: 'phone', label: 'Landlord phone', type: 'tel' },
  { key: 'property_address', label: 'Property address' },
  { key: 'monthly_rent', label: 'Monthly rent (UGX)', type: 'number' },
  { key: 'mobile_money_number', label: 'MoMo number', type: 'tel' },
  { key: 'mobile_money_name', label: 'MoMo name' },
  { key: 'caretaker_name', label: 'Caretaker name' },
  { key: 'caretaker_phone', label: 'Caretaker phone', type: 'tel' },
];

/**
 * Surfaces landlord verification requests this agent raised that Ops rejected.
 * The agent sees the rejection reason and gets two choices:
 *   • "Edit & resubmit" — fix the landlord details and send it back for review.
 *   • "Cancel" — ignore (dismiss) the rejected request.
 */
export function AgentRejectedLandlordsPanel() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [requests, setRequests] = useState<RejectedRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<LandlordEditFields | null>(null);
  const [loadingForm, setLoadingForm] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from('landlord_verification_requests')
      .select('id, landlord_id, landlord_name, landlord_phone, reject_comment, resolved_at')
      .eq('requested_by', user.id)
      .eq('status', 'rejected')
      .order('resolved_at', { ascending: false });
    if (!error) setRequests((data ?? []) as RejectedRequest[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    load();
    if (!user) return;
    const channel = supabase
      .channel('agent-rejected-landlords')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'landlord_verification_requests', filter: `requested_by=eq.${user.id}` },
        () => load(),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load, user]);

  const startEdit = useCallback(async (req: RejectedRequest) => {
    setEditingId(req.id);
    setForm(null);
    setLoadingForm(true);
    const { data } = await supabase
      .from('landlords')
      .select('name, phone, property_address, monthly_rent, mobile_money_number, mobile_money_name, caretaker_name, caretaker_phone')
      .eq('id', req.landlord_id)
      .maybeSingle();
    setForm({
      name: data?.name ?? req.landlord_name ?? '',
      phone: data?.phone ?? req.landlord_phone ?? '',
      property_address: data?.property_address ?? '',
      monthly_rent: data?.monthly_rent != null ? String(data.monthly_rent) : '',
      mobile_money_number: data?.mobile_money_number ?? '',
      mobile_money_name: data?.mobile_money_name ?? '',
      caretaker_name: data?.caretaker_name ?? '',
      caretaker_phone: data?.caretaker_phone ?? '',
    });
    setLoadingForm(false);
  }, []);

  const cancelEdit = () => {
    setEditingId(null);
    setForm(null);
  };

  // "Cancel" = the agent ignores the rejected request (dismiss it).
  const handleCancel = async (req: RejectedRequest) => {
    if (!user) return;
    setBusyId(req.id);
    try {
      const { error } = await supabase
        .from('landlord_verification_requests')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', req.id)
        .eq('requested_by', user.id);
      if (error) throw error;
      toast({ title: 'Request dismissed', description: `${req.landlord_name || 'Landlord'} verification was ignored.` });
      setRequests(prev => prev.filter(r => r.id !== req.id));
    } catch (err: any) {
      toast({ title: 'Could not dismiss', description: err?.message || 'Please try again.', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  // "Edit & resubmit" = save the corrected landlord details, then send the
  // request back to Ops (status -> pending) so it re-appears in their queue.
  const handleResubmit = async (req: RejectedRequest) => {
    if (!user || !form) return;
    if (form.name.trim().length < 2) {
      toast({ title: 'Name required', description: 'Enter the landlord name.', variant: 'destructive' });
      return;
    }
    if (form.phone.trim().length < 7) {
      toast({ title: 'Phone required', description: 'Enter a valid landlord phone.', variant: 'destructive' });
      return;
    }
    setBusyId(req.id);
    try {
      const { error: llErr } = await supabase
        .from('landlords')
        .update({
          name: form.name.trim(),
          phone: form.phone.trim(),
          property_address: form.property_address.trim() || null,
          monthly_rent: form.monthly_rent.trim() ? Number(form.monthly_rent) : null,
          mobile_money_number: form.mobile_money_number.trim() || null,
          mobile_money_name: form.mobile_money_name.trim() || null,
          caretaker_name: form.caretaker_name.trim() || null,
          caretaker_phone: form.caretaker_phone.trim() || null,
        })
        .eq('id', req.landlord_id);
      if (llErr) throw llErr;

      const { error: reqErr } = await supabase
        .from('landlord_verification_requests')
        .update({
          status: 'pending',
          reject_comment: null,
          resolved_by: null,
          resolved_at: null,
          landlord_name: form.name.trim(),
          landlord_phone: form.phone.trim(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', req.id)
        .eq('requested_by', user.id);
      if (reqErr) throw reqErr;

      toast({ title: '✅ Resubmitted for review', description: `${form.name.trim()} was sent back to Landlord Operations.` });
      setRequests(prev => prev.filter(r => r.id !== req.id));
      cancelEdit();
    } catch (err: any) {
      toast({ title: 'Resubmit failed', description: err?.message || 'Please try again.', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  if (loading || requests.length === 0) return null;

  return (
    <div className="rounded-2xl border-2 border-rose-500/50 bg-rose-50/60 dark:bg-rose-500/5 p-4 space-y-3 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="p-2 rounded-xl bg-rose-500/15">
          <XCircle className="h-[18px] w-[18px] text-rose-600 shrink-0" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-sm leading-tight flex items-center gap-2">
            Landlord verification rejected
            <Badge className="bg-rose-600 text-white hover:bg-rose-600">{requests.length}</Badge>
          </p>
          <p className="text-[11px] text-muted-foreground leading-snug">
            Fix the details and resubmit, or dismiss the request.
          </p>
        </div>
      </div>

      <ul className="space-y-2.5">
        {requests.map(req => {
          const isEditing = editingId === req.id;
          const busy = busyId === req.id;
          return (
            <li key={req.id} className="rounded-xl border border-rose-500/40 bg-background p-3 space-y-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-sm text-foreground truncate">
                    {req.landlord_name || 'Unnamed landlord'}
                  </p>
                  {req.landlord_phone && (
                    <a href={`tel:${req.landlord_phone}`} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 truncate">
                      <Phone className="h-3 w-3 shrink-0" /> {req.landlord_phone}
                    </a>
                  )}
                  {req.resolved_at && (
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Rejected {formatDistanceToNow(new Date(req.resolved_at), { addSuffix: true })}
                    </p>
                  )}
                </div>
                <Badge variant="outline" className="shrink-0 border-rose-500/40 text-rose-700 text-[10px]">
                  Rejected
                </Badge>
              </div>

              {/* Rejection reason */}
              <div className="rounded-lg border border-rose-500/30 bg-rose-50/70 dark:bg-rose-500/10 p-2.5">
                <p className="text-[11px] font-semibold text-rose-700 mb-0.5 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> Reason for rejection
                </p>
                <p className="text-xs text-foreground">{req.reject_comment || 'No reason was provided.'}</p>
              </div>

              {!isEditing ? (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={busy}
                    onClick={() => startEdit(req)}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1" /> Edit &amp; resubmit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full border-rose-500/40 text-rose-700 hover:bg-rose-500/10"
                    disabled={busy}
                    onClick={() => handleCancel(req)}
                  >
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><X className="h-3.5 w-3.5 mr-1" /> Cancel</>}
                  </Button>
                </div>
              ) : (
                <div className="space-y-2.5 rounded-xl border border-primary/30 bg-primary/5 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-semibold text-foreground flex items-center gap-1">
                      <Pencil className="h-3 w-3" /> Edit landlord details
                    </p>
                    <Button size="sm" variant="ghost" className="h-6 px-1" onClick={cancelEdit} disabled={busy}>
                      <X className="h-3 w-3" />
                    </Button>
                  </div>

                  {loadingForm || !form ? (
                    <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading details…
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {EDIT_FIELDS.map(f => (
                          <div key={f.key}>
                            <Label className="text-[10px] uppercase text-muted-foreground">{f.label}</Label>
                            <Input
                              type={f.type === 'number' ? 'number' : f.type === 'tel' ? 'tel' : 'text'}
                              value={form[f.key]}
                              onChange={(e) => setForm(s => (s ? { ...s, [f.key]: e.target.value } : s))}
                              className="h-8 text-sm"
                            />
                          </div>
                        ))}
                      </div>
                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <Button
                          size="sm"
                          className="w-full"
                          disabled={busy}
                          onClick={() => handleResubmit(req)}
                        >
                          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Send className="h-3.5 w-3.5 mr-1" />}
                          Resubmit for review
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          disabled={busy}
                          onClick={cancelEdit}
                        >
                          <RotateCcw className="h-3.5 w-3.5 mr-1" /> Discard
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}