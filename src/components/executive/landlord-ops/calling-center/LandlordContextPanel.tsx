import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  Clock,
  ExternalLink,
  Home,
  Loader2,
  MapPin,
  Phone,
  ShieldCheck,
  Smartphone,
  UserCheck,
  Users,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { useLandlordRegistryEntry } from './useLandlordRegistryBatch';
import { CcPill, formatHumanLabel } from './ccUi';

export interface LandlordContextPanelProps {
  subjectId: string;
  fallbackName?: string | null;
  fallbackPhone?: string | null;
  fallbackDistrict?: string | null;
  fallbackAgentName?: string | null;
  onOpenTimeline?: () => void;
}

export function LandlordContextPanel({
  subjectId,
  fallbackName,
  fallbackPhone,
  fallbackDistrict,
  fallbackAgentName,
  onOpenTimeline,
}: LandlordContextPanelProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const registryQuery = useLandlordRegistryEntry(subjectId, Boolean(subjectId));
  const registry = registryQuery.data;
  const effectiveLandlordId = registry?.landlord_id ?? subjectId;

  // Read-only landlord profile details (payout number, verification, mobile money name)
  const landlordDetailsQuery = useQuery({
    queryKey: ['landlord-context-details', effectiveLandlordId],
    enabled: Boolean(effectiveLandlordId),
    staleTime: 30_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('landlords')
        .select(
          'id, name, phone, mobile_money_number, mobile_money_name, bank_name, account_number, property_address, verified, verified_at, number_of_houses, monthly_rent',
        )
        .eq('id', effectiveLandlordId)
        .maybeSingle();
      return data;
    },
  });

  // Read-only houses list for this landlord
  const housesQuery = useQuery({
    queryKey: ['landlord-context-houses', effectiveLandlordId],
    enabled: Boolean(effectiveLandlordId),
    staleTime: 30_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('house_listings')
        .select('id, title, address, region, district, monthly_rent, daily_rate, number_of_rooms, status, verified')
        .eq('landlord_id', effectiveLandlordId)
        .order('created_at', { ascending: false })
        .limit(20);
      return data ?? [];
    },
  });

  // Read-only Rent Plans & Tenants for this landlord
  const rentPlansQuery = useQuery({
    queryKey: ['landlord-context-rent-plans', effectiveLandlordId],
    enabled: Boolean(effectiveLandlordId),
    staleTime: 30_000,
    queryFn: async () => {
      const { data: requests } = await supabase
        .from('rent_requests')
        .select('id, tenant_id, rent_amount, amount_repaid, total_repayment, status, created_at')
        .eq('landlord_id', effectiveLandlordId)
        .order('created_at', { ascending: false })
        .limit(20);

      const list = requests ?? [];
      const tenantIds = Array.from(new Set(list.map((r: any) => r.tenant_id).filter(Boolean)));
      let tenantMap: Record<string, { full_name: string | null; phone: string | null }> = {};
      if (tenantIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', tenantIds);
        for (const p of profiles ?? []) {
          tenantMap[p.id] = { full_name: p.full_name, phone: p.phone };
        }
      }

      return list.map((r: any) => ({
        ...r,
        tenantName: tenantMap[r.tenant_id]?.full_name || 'Tenant',
        tenantPhone: tenantMap[r.tenant_id]?.phone || null,
      }));
    },
  });

  // Existing payout-number review RPC flow (never a direct table update)
  const confirmPayoutMutation = useMutation({
    mutationFn: async (input: { landlordId: string; number: string; reason: string }) => {
      const { data, error } = await (supabase.rpc as any)('confirm_landlord_payout_number', {
        p_landlord_id: input.landlordId,
        p_number: input.number,
        p_reason: input.reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['landlord-context-details', effectiveLandlordId] });
      qc.invalidateQueries({ queryKey: ['landlord-registry-entry', subjectId] });
    },
  });

  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [proposedNumber, setProposedNumber] = useState('');
  const [reviewReason, setReviewReason] = useState('');

  const landlord = landlordDetailsQuery.data;
  const displayName = registry?.full_name || landlord?.name || fallbackName || 'Landlord';
  const displayPhones =
    registry?.phones && registry.phones.length > 0
      ? registry.phones
      : [landlord?.phone || fallbackPhone].filter(Boolean);
  const currentPayoutNumber =
    landlord?.mobile_money_number || landlord?.phone || displayPhones[0] || '';

  const verificationStatus =
    registry?.verification_status || (landlord?.verified ? 'verified' : 'unverified');

  const openPayoutNumberFlow = () => {
    setProposedNumber(currentPayoutNumber);
    setReviewReason('');
    setReviewDialogOpen(true);
  };

  const handleConfirmPayoutNumber = async () => {
    if (!effectiveLandlordId) {
      toast.error('No landlord record linked for payout review.');
      return;
    }
    if (!proposedNumber.trim()) {
      toast.error('Enter the payout phone number to submit for review.');
      return;
    }
    try {
      await confirmPayoutMutation.mutateAsync({
        landlordId: effectiveLandlordId,
        number: proposedNumber.trim(),
        reason: reviewReason.trim() || 'Confirmed during Landlord Calling Center call',
      });
      toast.success('Payout number submitted through the Payout Review flow.');
      setReviewDialogOpen(false);
    } catch (e: any) {
      toast.error(e?.message || 'Could not submit payout number review');
    }
  };

  return (
    <div className="space-y-4">
      {/* Identity & Registry Summary */}
      <div className="rounded-xl border border-border/70 bg-muted/20 p-3.5 space-y-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-sm font-bold text-foreground truncate">{displayName}</h4>
              <CcPill
                tone={verificationStatus === 'verified' ? 'emerald' : 'amber'}
                icon={ShieldCheck}
              >
                {formatHumanLabel(verificationStatus)}
              </CcPill>
              {registry?.needs_review && (
                <CcPill tone="rose" icon={AlertTriangle}>
                  Needs Identity Review
                </CcPill>
              )}
              {!registry?.user_id && (
                <Badge variant="outline" className="text-[10px]">
                  Handset / WhatsApp Only
                </Badge>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {displayPhones.length > 0 && (
                <span className="inline-flex items-center gap-1 font-mono text-foreground">
                  <Phone className="h-3 w-3 text-primary" />
                  {displayPhones.join(' · ')}
                </span>
              )}
              {(registry?.region || registry?.district || fallbackDistrict) && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  {[registry?.region, registry?.district ?? fallbackDistrict]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
              {(registry?.registering_agent_name || fallbackAgentName) && (
                <span className="inline-flex items-center gap-1">
                  <UserCheck className="h-3 w-3" />
                  Agent: {registry?.registering_agent_name || fallbackAgentName}
                </span>
              )}
            </div>
          </div>

          {onOpenTimeline && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1.5"
              onClick={onOpenTimeline}
            >
              <Clock className="h-3.5 w-3.5" /> Full Call Timeline
            </Button>
          )}
        </div>

        {/* 4 Summary Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
          <div className="rounded-lg border bg-card p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Active Rent Plans
            </div>
            <div className="text-base font-bold tabular-nums mt-0.5">
              {registry?.active_rent_plans ?? 0}
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              {formatUGX(Number(registry?.plan_rent_total ?? 0))}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Houses Listed
            </div>
            <div className="text-base font-bold tabular-nums mt-0.5">
              {registry?.houses_count ?? housesQuery.data?.length ?? 0}
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              {landlord?.property_address || 'Registered properties'}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Total Paid Out
            </div>
            <div className="text-base font-bold tabular-nums text-emerald-700 dark:text-emerald-400 mt-0.5">
              {formatUGX(Number(registry?.total_paid_out_ugx ?? 0))}
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              Cumulative landlord payouts
            </div>
          </div>

          <div className="rounded-lg border bg-card p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Last Payout
            </div>
            <div className="text-sm font-semibold mt-0.5">
              {registry?.last_payout_at
                ? format(new Date(registry.last_payout_at), 'dd MMM yyyy')
                : 'None yet'}
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              {registry?.registered_at
                ? `Registered ${format(new Date(registry.registered_at), 'dd MMM yyyy')}`
                : 'Registry member'}
            </div>
          </div>
        </div>
      </div>

      {/* Payout Number & Verification Card */}
      <div className="rounded-xl border border-border/70 bg-card p-3.5 space-y-2.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="h-7 w-7 rounded-lg bg-emerald-500/12 text-emerald-600 flex items-center justify-center">
              <Smartphone className="h-4 w-4" />
            </span>
            <div>
              <div className="text-xs font-semibold text-foreground">
                Payout Number & Verification
              </div>
              <div className="text-[11px] text-muted-foreground">
                Read-only payout destination — corrections go through the Payout Review flow
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1"
              onClick={openPayoutNumberFlow}
            >
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              Review / Confirm Payout Number
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs gap-1"
              onClick={() => navigate('/landlord-ops/payouts/review')}
            >
              Payout Review Queue <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          <div className="rounded-lg bg-muted/40 p-2.5">
            <div className="text-[10px] uppercase text-muted-foreground">Mobile Money Number</div>
            <div className="font-mono font-semibold text-foreground mt-0.5">
              {currentPayoutNumber || 'Not set'}
            </div>
            {landlord?.mobile_money_name && (
              <div className="text-[11px] text-muted-foreground truncate">
                Registered name: {landlord.mobile_money_name}
              </div>
            )}
          </div>

          <div className="rounded-lg bg-muted/40 p-2.5">
            <div className="text-[10px] uppercase text-muted-foreground">Verification Status</div>
            <div className="font-medium text-foreground mt-0.5 flex items-center gap-1.5">
              <Badge
                variant={verificationStatus === 'verified' ? 'default' : 'secondary'}
                className="text-[10px]"
              >
                {formatHumanLabel(verificationStatus)}
              </Badge>
            </div>
          </div>

          <div className="rounded-lg bg-muted/40 p-2.5">
            <div className="text-[10px] uppercase text-muted-foreground">Bank / Alternative</div>
            <div className="font-medium text-foreground mt-0.5 truncate">
              {landlord?.bank_name
                ? `${landlord.bank_name} · ${landlord.account_number || ''}`
                : 'Mobile Money Primary'}
            </div>
          </div>
        </div>
      </div>

      {/* Houses List (read-only) */}
      <div className="rounded-xl border border-border/70 bg-card p-3.5 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <Home className="h-4 w-4 text-primary" />
            Listed Houses ({housesQuery.data?.length ?? 0})
          </div>
          {landlord?.monthly_rent ? (
            <span className="text-[11px] text-muted-foreground">
              Base monthly rent: {formatUGX(Number(landlord.monthly_rent))}
            </span>
          ) : null}
        </div>

        {housesQuery.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading listed houses…
          </div>
        ) : (housesQuery.data ?? []).length === 0 ? (
          <div className="text-xs text-muted-foreground py-2">
            No individual house listings recorded for this landlord yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(housesQuery.data ?? []).map((h: any) => (
              <div
                key={h.id}
                className="rounded-lg border border-border/60 bg-muted/20 p-2.5 text-xs space-y-1"
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span className="font-semibold text-foreground truncate">
                    {h.title || h.address || 'House Listing'}
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    {formatHumanLabel(h.status || 'listed')}
                  </Badge>
                </div>
                <div className="text-[11px] text-muted-foreground flex items-center justify-between">
                  <span className="truncate">
                    {[
                      h.district || h.region,
                      h.number_of_rooms ? `${h.number_of_rooms} rooms` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="font-semibold text-foreground">
                    {formatUGX(Number(h.monthly_rent ?? 0))}/mo
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tenants & Rent Plans (read-only) */}
      <div className="rounded-xl border border-border/70 bg-card p-3.5 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <Users className="h-4 w-4 text-primary" />
            Tenants & Rent Plans ({rentPlansQuery.data?.length ?? 0})
          </div>
        </div>

        {rentPlansQuery.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading tenants and Rent Plans…
          </div>
        ) : (rentPlansQuery.data ?? []).length === 0 ? (
          <div className="text-xs text-muted-foreground py-2">
            No Rent Plans linked to this landlord yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(rentPlansQuery.data ?? []).map((rp: any) => (
              <div
                key={rp.id}
                className="rounded-lg border border-border/60 bg-muted/20 p-2.5 text-xs space-y-1"
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span className="font-semibold text-foreground truncate">{rp.tenantName}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {formatHumanLabel(rp.status)}
                  </Badge>
                </div>
                <div className="text-[11px] text-muted-foreground flex items-center justify-between">
                  <span className="font-mono">{rp.tenantPhone || '—'}</span>
                  <span className="font-semibold text-foreground">
                    {formatUGX(Number(rp.rent_amount ?? 0))}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Payout Number Review Flow Dialog */}
      <Dialog open={reviewDialogOpen} onOpenChange={setReviewDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Banknote className="h-4 w-4 text-emerald-600" />
              Review / Confirm Landlord Payout Number
            </DialogTitle>
            <DialogDescription className="text-xs">
              Submits through the audited Landlord Payout Number Review workflow for{' '}
              <span className="font-medium text-foreground">{displayName}</span>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="payout-number-input" className="text-xs">
                Confirmed Payout Mobile Money Number
              </Label>
              <Input
                id="payout-number-input"
                value={proposedNumber}
                onChange={(e) => setProposedNumber(e.target.value)}
                placeholder="e.g. 0772123456 or 256772123456"
                className="font-mono text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="payout-reason-input" className="text-xs">
                Verification / Change Note
              </Label>
              <Textarea
                id="payout-reason-input"
                rows={3}
                value={reviewReason}
                onChange={(e) => setReviewReason(e.target.value)}
                placeholder="Record how the landlord confirmed this number during the call…"
                className="text-xs"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setReviewDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={confirmPayoutMutation.isPending}
              onClick={handleConfirmPayoutNumber}
            >
              {confirmPayoutMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              )}
              Submit to Payout Review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
