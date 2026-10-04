import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, CheckCircle2, XCircle, Clock, Phone, MapPin, User, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/businessAdvanceCalculations';

type Dept = 'tenant_ops' | 'agent_ops' | 'landlord_ops';

const DEPT_CONFIG: Record<Dept, {
  label: string;
  verifyCol: 'tenant_ops_verified_at' | 'agent_ops_verified_at' | 'landlord_ops_verified_at';
  byCol: 'tenant_ops_verified_by' | 'agent_ops_verified_by' | 'landlord_ops_verified_by';
  angle: string;
}> = {
  tenant_ops: {
    label: 'Tenant Ops verification',
    verifyCol: 'tenant_ops_verified_at',
    byCol: 'tenant_ops_verified_by',
    angle: 'Confirm the tenant actually paid these months. Cross-check with phone calls or messages.',
  },
  agent_ops: {
    label: 'Agent Ops verification',
    verifyCol: 'agent_ops_verified_at',
    byCol: 'agent_ops_verified_by',
    angle: 'Verify with the originating agent and dispatch a nearby agent to physically confirm landlord & property.',
  },
  landlord_ops: {
    label: 'Landlord Ops verification',
    verifyCol: 'landlord_ops_verified_at',
    byCol: 'landlord_ops_verified_by',
    angle: "Call the landlord on the recorded number. Confirm they received this rent for this property.",
  },
};

interface Props {
  dept: Dept;
}

/**
 * Single component reused by Tenant Ops, Agent Ops, and Landlord Ops dashboards.
 * Each ops dept signs off independently — soft-warning model. The advance still
 * progresses through the existing pipeline; verification badges show downstream
 * staff (COO/CFO) how thoroughly the rent history was vetted.
 */
export function RentHistoryVerificationQueue({ dept }: Props) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const cfg = DEPT_CONFIG[dept];
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['rent-history-verify', dept],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('rent_history_records')
        .select('*, tenant:profiles!rent_history_records_tenant_id_fkey(full_name, phone)')
        .in('status', ['pending', 'verified'])
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data || [];
    },
  });

  const verifyMutation = useMutation({
    mutationFn: async ({ id, approve }: { id: string; approve: boolean }) => {
      if (!user?.id) throw new Error('Not signed in');
      const update: any = {
        verification_notes: notes[id] || null,
      };
      if (approve) {
        update[cfg.verifyCol] = new Date().toISOString();
        update[cfg.byCol] = user.id;
        update.status = 'verified';
      } else {
        update.status = 'rejected';
        update.rejection_reason = notes[id] || `Rejected by ${cfg.label}`;
      }
      const { data, error } = await (supabase as any)
        .from('rent_history_records')
        .update(update)
        .eq('id', id)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Action blocked — your role may not have permission.');
    },
    onSuccess: (_, vars) => {
      toast.success(vars.approve ? 'Rent month verified' : 'Rent month rejected');
      qc.invalidateQueries({ queryKey: ['rent-history-verify'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const stats = useMemo(() => {
    const pending = rows.filter((r: any) => !r[cfg.verifyCol]).length;
    const verified = rows.filter((r: any) => !!r[cfg.verifyCol]).length;
    return { pending, verified, total: rows.length };
  }, [rows, cfg.verifyCol]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border bg-card p-4 space-y-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-bold">{cfg.label}</h3>
        </div>
        <p className="text-[11px] text-muted-foreground">{cfg.angle}</p>
        <div className="flex items-center gap-2 pt-1">
          <Badge variant="secondary" className="text-[10px]">
            {stats.pending} awaiting your sign-off
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {stats.verified} signed
          </Badge>
        </div>
      </div>

      {rows.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center">
            <Clock className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No rent history records to verify yet.</p>
          </CardContent>
        </Card>
      )}

      {rows.map((row: any) => {
        const isExpanded = expandedId === row.id;
        const myDeptVerified = !!row[cfg.verifyCol];
        const tenant = row.tenant;
        const startDate = row.start_date ? format(new Date(row.start_date), 'MMM yyyy') : '—';
        return (
          <Card
            key={row.id}
            className={`overflow-hidden transition ${
              myDeptVerified ? 'border-emerald-500/50 bg-emerald-500/5' : ''
            }`}
          >
            <CardContent className="p-4">
              <button onClick={() => setExpandedId(isExpanded ? null : row.id)} className="w-full text-left">
                <div className="flex items-center gap-3">
                  <div
                    className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 ${
                      myDeptVerified ? 'bg-emerald-500/15' : 'bg-primary/10'
                    }`}
                  >
                    {myDeptVerified ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                    ) : (
                      <User className="h-5 w-5 text-primary" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold truncate">{tenant?.full_name || 'Tenant'}</p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {row.landlord_name} · {startDate}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-primary">{formatUGX(Number(row.rent_amount))}</p>
                    <div className="flex gap-1 justify-end mt-0.5">
                      {row.tenant_ops_verified_at && (
                        <span title="Tenant Ops signed" className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                      )}
                      {row.agent_ops_verified_at && (
                        <span title="Agent Ops signed" className="h-1.5 w-1.5 rounded-full bg-purple-500" />
                      )}
                      {row.landlord_ops_verified_at && (
                        <span title="Landlord Ops signed" className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                      )}
                    </div>
                  </div>
                </div>
              </button>

              {isExpanded && (
                <div className="mt-4 space-y-3">
                  <div className="grid grid-cols-2 gap-2 p-3 rounded-xl bg-muted/40 text-xs">
                    <div>
                      <span className="text-muted-foreground">Landlord</span>
                      <br />
                      <span className="font-bold">{row.landlord_name}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground flex items-center gap-1">
                        <Phone className="h-3 w-3" /> Phone
                      </span>
                      <a href={`tel:${row.landlord_phone}`} className="font-bold text-primary underline">
                        {row.landlord_phone}
                      </a>
                    </div>
                    <div className="col-span-2">
                      <span className="text-muted-foreground flex items-center gap-1">
                        <MapPin className="h-3 w-3" /> Property
                      </span>
                      <span className="font-bold">{row.property_location}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Tenant phone</span>
                      <br />
                      <span className="font-bold">{tenant?.phone || '—'}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Status</span>
                      <br />
                      <Badge variant={row.status === 'verified' ? 'default' : 'outline'} className="text-[10px]">
                        {row.status}
                      </Badge>
                    </div>
                  </div>

                  <div className="rounded-xl bg-muted/30 p-3 space-y-1 text-[11px]">
                    <p className="font-bold uppercase tracking-widest text-muted-foreground mb-1">
                      Verification trail
                    </p>
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-blue-500" /> Tenant Ops:{' '}
                      {row.tenant_ops_verified_at
                        ? `signed ${format(new Date(row.tenant_ops_verified_at), 'MMM d, HH:mm')}`
                        : 'pending'}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-purple-500" /> Agent Ops:{' '}
                      {row.agent_ops_verified_at
                        ? `signed ${format(new Date(row.agent_ops_verified_at), 'MMM d, HH:mm')}`
                        : 'pending'}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-amber-500" /> Landlord Ops:{' '}
                      {row.landlord_ops_verified_at
                        ? `signed ${format(new Date(row.landlord_ops_verified_at), 'MMM d, HH:mm')}`
                        : 'pending'}
                    </div>
                  </div>

                  <Textarea
                    placeholder="Verification note (e.g. 'Called landlord, confirmed Jan rent')"
                    value={notes[row.id] || ''}
                    onChange={(e) => setNotes((p) => ({ ...p, [row.id]: e.target.value }))}
                    rows={2}
                    className="text-sm"
                  />

                  <div className="flex gap-2">
                    <Button
                      onClick={() => verifyMutation.mutate({ id: row.id, approve: true })}
                      disabled={verifyMutation.isPending || myDeptVerified}
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      {myDeptVerified ? 'Already signed' : 'Verify this month'}
                    </Button>
                    <Button
                      onClick={() => verifyMutation.mutate({ id: row.id, approve: false })}
                      disabled={verifyMutation.isPending || row.status === 'rejected'}
                      variant="destructive"
                      className="flex-1 gap-1.5"
                    >
                      <XCircle className="h-4 w-4" /> Reject
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
