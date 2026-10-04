import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Loader2, Home, User, AlertTriangle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useToast } from '@/hooks/use-toast';
import { FieldError, FormErrorBanner, reasonError, parseRpcError } from '@/components/shared/FormFeedback';

interface BindTenantToHouseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Required: limits the rent requests + houses shown to this landlord. */
  landlordId: string;
  landlordName: string;
  /** Optional preselected house. */
  preselectedHouseId?: string | null;
  /** If the chosen house already has a tenant, a swap is implied — we'll auto-clear first. */
  currentTenantIdOnHouse?: string | null;
  onComplete?: () => void;
}

export function BindTenantToHouseDialog({
  open, onOpenChange, landlordId, landlordName, preselectedHouseId, currentTenantIdOnHouse, onComplete,
}: BindTenantToHouseDialogProps) {
  const { toast } = useToast();
  const [houseId, setHouseId] = useState<string>(preselectedHouseId || '');
  const [requestId, setRequestId] = useState<string>('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [reasonTouched, setReasonTouched] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setHouseId(preselectedHouseId || '');
      setRequestId('');
      setReason('');
      setConfirming(false);
      setSubmitAttempted(false);
      setReasonTouched(false);
      setFormError(null);
    }
  }, [open, preselectedHouseId]);

  const housesQuery = useQuery({
    queryKey: ['landlord-houses-for-bind', landlordId],
    enabled: open && !!landlordId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('house_listings')
        .select('id,title,address,region,status,tenant_id,monthly_rent,daily_rate')
        .eq('landlord_id', landlordId)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });

  const requestsQuery = useQuery({
    queryKey: ['landlord-requests-for-bind', landlordId],
    enabled: open && !!landlordId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rent_requests')
        .select('id,tenant_id,rent_amount,status,created_at')
        .eq('landlord_id', landlordId)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      const tenantIds = Array.from(new Set((data ?? []).map(r => r.tenant_id).filter(Boolean)));
      let tenants: Record<string, { name: string; phone: string | null }> = {};
      if (tenantIds.length) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id,full_name,phone')
          .in('id', tenantIds);
        for (const p of (profs ?? []) as Array<{ id: string; full_name: string | null; phone: string | null }>) {
          tenants[p.id] = { name: p.full_name || 'Unnamed', phone: p.phone ?? null };
        }
      }
      return (data ?? []).map(r => ({ ...r, tenant: tenants[r.tenant_id] }));
    },
  });

  const selectedHouse = useMemo(
    () => housesQuery.data?.find(h => h.id === houseId),
    [housesQuery.data, houseId],
  );
  const isSwap = !!(selectedHouse?.tenant_id || currentTenantIdOnHouse);
  const selectedRequest = useMemo(
    () => (requestsQuery.data ?? []).find((r: any) => r.id === requestId),
    [requestsQuery.data, requestId],
  );

  const errors = {
    house: !houseId ? 'Pick a house to bind.' : null,
    request: !requestId ? 'Pick the tenant\'s rent request.' : null,
    reason: reasonError(reason),
  };
  const reasonErrText = (reasonTouched || submitAttempted) ? errors.reason : null;
  const canSubmit = !errors.house && !errors.request && !errors.reason && !busy;

  const handleSubmit = async () => {
    setSubmitAttempted(true);
    setFormError(null);
    if (!canSubmit) return;
    setBusy(true);
    try {
      // If swap: clear the existing tenant first so the bind is unambiguous.
      if (isSwap) {
        const { error: remErr } = await supabase.rpc('landlord_ops_remove_tenant_from_house', {
          p_house_id: houseId,
          p_reason: `Swap-out preceding new binding: ${reason.trim()}`,
        });
        if (remErr) throw remErr;
      }
      const { error } = await supabase.rpc('landlord_ops_bind_tenant_to_house', {
        p_house_id: houseId,
        p_rent_request_id: requestId,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      toast({
        title: isSwap ? 'Tenant swapped' : 'Tenant bound to house',
        description: 'The house is now occupied by the selected tenant.',
      });
      onComplete?.();
      onOpenChange(false);
    } catch (e: any) {
      const msg = parseRpcError(e);
      setFormError(msg);
      toast({ title: 'Failed', description: msg, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Home className="h-5 w-5 text-primary" />
            {isSwap ? 'Swap tenant on house' : 'Bind tenant to house'}
          </DialogTitle>
          <DialogDescription>
            Connect a tenant from an existing rent request to a house owned by{' '}
            <span className="font-medium">{landlordName}</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormErrorBanner message={formError} />
          <div className="space-y-1.5">
            <Label>House</Label>
            <Select value={houseId} onValueChange={setHouseId} disabled={busy || !!preselectedHouseId}>
              <SelectTrigger><SelectValue placeholder="Pick a house" /></SelectTrigger>
              <SelectContent>
                {(housesQuery.data ?? []).map(h => (
                  <SelectItem key={h.id} value={h.id}>
                    <span className="truncate">
                      {h.title} — {h.address}
                      {h.tenant_id ? ' · occupied' : ' · vacant'}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {housesQuery.isLoading && <p className="text-xs text-muted-foreground">Loading houses…</p>}
            {submitAttempted && <FieldError message={errors.house} />}
          </div>

          {selectedHouse && (
            <div className="rounded-md border bg-muted/30 p-2 text-xs space-y-1">
              <p className="font-medium">{selectedHouse.title}</p>
              <p className="text-muted-foreground">{selectedHouse.address}, {selectedHouse.region}</p>
              <p>Rent {formatUGX(selectedHouse.monthly_rent)}/mo · {formatUGX(selectedHouse.daily_rate)}/day</p>
              {isSwap && (
                <div className="flex items-start gap-1 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    House is currently occupied. Confirming will remove the existing tenant and bind the new one.
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Rent request (tenant)</Label>
            <Select value={requestId} onValueChange={setRequestId} disabled={busy}>
              <SelectTrigger><SelectValue placeholder="Pick a tenant's rent request" /></SelectTrigger>
              <SelectContent>
                {(requestsQuery.data ?? []).map(r => (
                  <SelectItem key={r.id} value={r.id}>
                    <span className="truncate">
                      {(r.tenant as any)?.name ?? 'Unknown'} — {formatUGX(Number(r.rent_amount ?? 0))} · {r.status}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {requestsQuery.isLoading && <p className="text-xs text-muted-foreground">Loading rent requests…</p>}
            {!requestsQuery.isLoading && (requestsQuery.data ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">No rent requests on file for this landlord.</p>
            )}
            {submitAttempted && <FieldError message={errors.request} />}
          </div>

          <div className="space-y-1.5">
            <Label>Reason (min 10 characters)</Label>
            <Textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              onBlur={() => setReasonTouched(true)}
              maxLength={500}
              aria-invalid={!!reasonErrText}
              placeholder="e.g. Tenant signed lease today; binding to confirmed house"
              rows={3}
              disabled={busy}
            />
            <p className="text-[11px] text-muted-foreground">{reason.trim().length}/10</p>
            <FieldError message={reasonErrText} />
          </div>
        </div>

        {confirming && (
          <div className="rounded-md border-2 border-amber-500/50 bg-amber-500/10 p-3 text-sm space-y-1">
            <p className="font-semibold flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" /> Confirm {isSwap ? 'swap' : 'bind'}?
            </p>
            <p className="text-xs">
              You are about to {isSwap ? 'swap the tenant on' : 'bind'}{' '}
              <span className="font-medium">{selectedHouse?.title}</span> to{' '}
              <span className="font-medium">{(selectedRequest as any)?.tenant?.name ?? 'the selected tenant'}</span>.
              This is logged with your reason and cannot be undone silently.
            </p>
          </div>
        )}

        <DialogFooter>
          {confirming ? (
            <>
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy}>Go back</Button>
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                Yes, {isSwap ? 'swap tenant' : 'bind tenant'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button
                onClick={() => {
                  setSubmitAttempted(true);
                  setReasonTouched(true);
                  if (canSubmit) setConfirming(true);
                }}
                disabled={busy}
              >
                {isSwap ? 'Review swap' : 'Review bind'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
