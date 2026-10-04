import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Building2, Gavel, MapPin, Phone, Search, Loader2, ShieldCheck,
  Clock, XCircle, BadgeCheck, Filter,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

type StatusFilter = 'pending' | 'rejected' | 'verified' | 'all';
type Status = 'pending' | 'verified' | 'rejected';

interface Row {
  id: string;
  name: string;
  phone: string | null;
  village: string | null;
  district: string | null;
  verification_status: Status;
  verification_reason: string | null;
  latitude?: number | null;
  longitude?: number | null;
  property_address?: string | null;
}

function StatusBadge({ status }: { status: Status }) {
  if (status === 'verified') return <Badge className="bg-emerald-500/15 text-emerald-700 border-0 text-[10px] font-bold gap-0.5"><BadgeCheck className="h-3 w-3" />Verified</Badge>;
  if (status === 'rejected') return <Badge className="bg-destructive/15 text-destructive border-0 text-[10px] font-bold gap-0.5"><XCircle className="h-3 w-3" />Rejected</Badge>;
  return <Badge className="bg-amber-500/15 text-amber-700 border-0 text-[10px] font-bold gap-0.5"><Clock className="h-3 w-3" />Pending</Badge>;
}

const PAGE = 50;

/**
 * Landlord residence & GPS verification only.
 *
 * LC1 chairperson moderation was removed here (2026-08-04): every LC1 request
 * now flows through the single inbox (`Lc1VerificationInboxPanel`) so no queue
 * can hold LC1 items in parallel.
 */
export function ResidenceVerificationPanel() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  // simple debounce
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // moderation dialog state
  const [target, setTarget] = useState<Row | null>(null);
  const [newStatus, setNewStatus] = useState<Status>('verified');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const entity = 'landlord' as const;
  const queryKey = ['residence-verification', 'landlord', statusFilter, debounced];
  const { data: rows = [], isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      let q = supabase.from('landlords')
        .select('id, name, phone, village, district, verification_status, verification_reason, latitude, longitude, property_address');
      // Records still being vetted by a Service Centre manager are not yet Landlord Ops work.
      q = q.neq('service_center_status', 'pending');
      if (statusFilter !== 'all') q = q.eq('verification_status', statusFilter);
      if (debounced.length >= 2) {
        const digits = debounced.replace(/\D/g, '');
        const parts = [`name.ilike.%${debounced}%`, `phone.ilike.%${debounced}%`];
        if (digits.length >= 3 && digits !== debounced) parts.push(`phone.ilike.%${digits}%`);
        q = q.or(parts.join(','));
      }
      const { data, error } = await q.order('created_at', { ascending: false }).limit(PAGE);
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });

  const openModerate = (row: Row, preset: Status) => {
    setTarget(row);
    setNewStatus(preset);
    setReason('');
  };

  const submit = async () => {
    if (!target || !user) return;
    if (reason.trim().length < 10) { toast.error('Reason must be at least 10 characters'); return; }
    setSaving(true);
    const { data: rpcData, error } = await supabase.rpc('set_landlord_verification' as any, {
      p_landlord_id: target.id, p_status: newStatus, p_reason: reason.trim(),
    } as any);
    setSaving(false);
    if (error) { toast.error(error.message || 'Could not update status'); return; }
    const result = (rpcData ?? {}) as { agent_id?: string | null; agent_charged?: boolean; charge_amount?: number };
    const charged = !!result.agent_charged && (result.charge_amount ?? 0) > 0;
    toast.success(
      `Landlord set to ${newStatus}` +
        (charged ? ` — UGX ${result.charge_amount!.toLocaleString()} penalty charged to registering agent` : '')
    );
    // Fire optional email/SMS alerts to linked borrowers (best-effort).
    supabase.functions.invoke('notify-verification-change', {
      body: { entity, id: target.id, status: newStatus, reason: reason.trim() },
    }).catch((e) => console.error('notify-verification-change failed', e));

    // Web push to the registering agent on REJECTION (mirrors house-listing
    // rejection UX). The RPC already charged UGX 2,000 to their wallet and
    // wrote an in-app notification; this alerts them on their device.
    if (newStatus === 'rejected' && result.agent_id) {
      const noun = 'Landlord';
      const body =
        `The ${noun.toLowerCase()} "${target.name}" you registered was rejected. ` +
        `Reason: ${reason.trim()}.` +
        (charged ? ` UGX ${result.charge_amount!.toLocaleString()} was debited from your wallet.` : '');
      supabase.functions.invoke('send-push-notification', {
        body: {
          userIds: [result.agent_id],
          payload: {
            title: `🚫 ${noun} rejected`,
            body,
            type: 'warning',
            url: '/dashboard/agent',
          },
        },
      }).catch((e) => console.error('send-push-notification (agent rejection) failed', e));
    }

    setTarget(null);
    qc.invalidateQueries({ queryKey: ['residence-verification'] });
    qc.invalidateQueries({ queryKey: ['landlord-ops-pending-verification-count'] });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-muted">
            <ShieldCheck className="h-[18px] w-[18px] text-amber-600" />
          </div>
          <div>
            <p className="font-semibold text-sm leading-tight">Landlord GPS Verification</p>
            <p className="text-[11px] text-muted-foreground leading-snug">Set landlord residence &amp; GPS status — a reason is required</p>
          </div>
        </div>

        {/* Status filter chips */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          <Filter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          {(['pending', 'rejected', 'verified', 'all'] as StatusFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                'px-3 h-7 rounded-full text-[11px] font-bold capitalize whitespace-nowrap transition-colors',
                statusFilter === s ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              )}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or phone" className="h-9 text-sm pl-8" />
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <Card className="border-dashed"><CardContent className="p-8 text-center text-sm text-muted-foreground">No {statusFilter !== 'all' ? statusFilter : ''} records found.</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const noGps = entity === 'landlord' && (row.latitude == null || row.longitude == null);
            return (
              <Card key={row.id} className="border-border/60">
                <CardContent className="p-3.5 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-bold truncate">{row.name}</p>
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1 truncate">
                        <Phone className="h-3 w-3 shrink-0" /> {row.phone || 'No phone'}
                        {row.village ? ` · ${row.village}` : ''}
                      </p>
                    </div>
                    <StatusBadge status={row.verification_status} />
                  </div>

                  {entity === 'landlord' && (
                    <p className="text-[11px] flex items-center gap-1">
                      <MapPin className="h-3 w-3 shrink-0 text-muted-foreground" />
                      {noGps
                        ? <span className="text-amber-600 font-semibold">No GPS captured</span>
                        : <span className="text-muted-foreground">GPS {row.latitude!.toFixed(5)}, {row.longitude!.toFixed(5)}</span>}
                    </p>
                  )}

                  {row.verification_reason && (
                    <p className="text-[11px] text-muted-foreground rounded-lg bg-muted px-2 py-1.5">
                      <span className="font-semibold">Last reason:</span> {row.verification_reason}
                    </p>
                  )}

                  <div className="grid grid-cols-3 gap-1.5 pt-0.5">
                    <Button size="sm" variant="outline" className="h-8 text-[11px] font-bold border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10" disabled={row.verification_status === 'verified'} onClick={() => openModerate(row, 'verified')}>
                      <BadgeCheck className="h-3.5 w-3.5 mr-1" /> Verify
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-[11px] font-bold border-amber-500/40 text-amber-700 hover:bg-amber-500/10" disabled={row.verification_status === 'pending'} onClick={() => openModerate(row, 'pending')}>
                      <Clock className="h-3.5 w-3.5 mr-1" /> Pending
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-[11px] font-bold border-destructive/40 text-destructive hover:bg-destructive/10" disabled={row.verification_status === 'rejected'} onClick={() => openModerate(row, 'rejected')}>
                      <XCircle className="h-3.5 w-3.5 mr-1" /> Reject
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {rows.length === PAGE && (
            <p className="text-center text-[10px] text-muted-foreground py-2">Showing first {PAGE} — refine with search or filters.</p>
          )}
        </div>
      )}

      {/* Moderation dialog */}
      <Dialog open={!!target} onOpenChange={(o) => { if (!o) setTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              {entity === 'landlord' ? <Building2 className="h-4 w-4 text-primary" /> : <Gavel className="h-4 w-4 text-primary" />}
              Set status — {target?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              {(['verified', 'pending', 'rejected'] as Status[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setNewStatus(s)}
                  className={cn(
                    'h-10 rounded-xl border text-[11px] font-bold capitalize transition-colors',
                    newStatus === s
                      ? s === 'verified' ? 'bg-emerald-500 text-white border-emerald-500'
                        : s === 'rejected' ? 'bg-destructive text-white border-destructive'
                        : 'bg-amber-500 text-white border-amber-500'
                      : 'bg-background border-border text-muted-foreground',
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            <div>
              <Label className="text-xs">Reason (required, min 10 chars) *</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                className="text-sm resize-none mt-1"
                placeholder={newStatus === 'rejected' ? 'Why is this being rejected? (shown to the user)' : 'Reason for this status change'}
              />
              <p className="text-[10px] text-muted-foreground mt-1">{reason.trim().length}/10 characters minimum</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setTarget(null)} disabled={saving}>Cancel</Button>
            <Button size="sm" disabled={saving || reason.trim().length < 10} onClick={submit}>
              {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
