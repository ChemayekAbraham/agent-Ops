/**
 * Switch Landlord — independent of, and never mounted alongside a write to,
 * TenantAssignAgentDialog. Two-step (search/select+reason -> review ->
 * confirm) following the ReassignAgentDialog pattern, backed by the new
 * list_eligible_landlords_for_rent_request / ops_transfer_tenant_landlord
 * RPCs. Only the final "Confirm Landlord Switch" click ever calls the write
 * RPC — search, selection and the review step are pure reads.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Loader2, Home, Search, X, AlertTriangle, CheckCircle2, Ban } from 'lucide-react';
import { FieldError, FormErrorBanner, reasonError, parseRpcError } from '@/components/shared/FormFeedback';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

const anyDb = supabase as any;

export interface EligibleLandlord {
  id: string;
  name: string;
  phone: string | null;
  property_address: string | null;
  district: string | null;
  village: string | null;
  verified: boolean;
  payout_ready: boolean;
  eligible: boolean;
  block_reason: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  rentRequestId: string | null;
  tenantId: string | null;
  tenantName: string;
  currentLandlordId: string | null;
  currentLandlordName: string | null;
  currentLandlordPhone: string | null;
  rentPlanStatus: string | null;
  houseListingId: string | null;
  onSaved?: () => void;
}

export default function TenantAssignLandlordDialog({
  open, onOpenChange, rentRequestId, tenantId, tenantName,
  currentLandlordId, currentLandlordName, currentLandlordPhone, rentPlanStatus, houseListingId,
  onSaved,
}: Props) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<EligibleLandlord | null>(null);
  const [reason, setReason] = useState('');
  const [reasonTouched, setReasonTouched] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSearch(''); setSelected(null); setReason(''); setReasonTouched(false);
      setSubmitAttempted(false); setConfirming(false); setFormError(null); setDropdownOpen(false);
    }
  }, [open, rentRequestId]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const { data: results = [], isFetching: searching } = useQuery({
    queryKey: ['switch-landlord-search', rentRequestId, debouncedSearch],
    enabled: open && !!rentRequestId,
    // Keep the previous result list mounted while a new search resolves.
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error } = await anyDb.rpc('list_eligible_landlords_for_rent_request', {
        p_rent_request_id: rentRequestId,
        p_search: debouncedSearch || null,
        p_limit: 50,
      });
      if (error) throw error;
      return (data || []) as EligibleLandlord[];
    },
  });

  // Does this plan have an open, zero-paid allocation that will follow the
  // switch? Derived from the search RPC's own per-row blocking context
  // (it flags this via block_reason on any non-payout-ready row) rather than
  // a second round trip.
  const planHasOpenAllocation = useMemo(() => results.some((l) => !!l.block_reason), [results]);

  const switchMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await anyDb.rpc('ops_transfer_tenant_landlord', {
        p_rent_request_id: rentRequestId,
        p_new_landlord_id: selected?.id,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      return data as { allocation_updated: boolean; pending_otps_cancelled: number };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant-detail', tenantId] });
      qc.invalidateQueries({ queryKey: ['tenant-landlord-transfer-history', tenantId] });
      onSaved?.();
      onOpenChange(false);
    },
    onError: (e: any) => {
      setFormError(parseRpcError(e));
    },
  });

  const errors = {
    landlord: !selected
      ? 'Pick a landlord to switch to.'
      : selected.id === currentLandlordId
        ? 'New landlord must be different from the current landlord.'
        : !selected.eligible
          ? (selected.block_reason || 'This landlord cannot be selected for this rent plan.')
          : null,
    reason: reasonError(reason),
  };
  const reasonErrText = (reasonTouched || submitAttempted) ? errors.reason : null;
  const canReview = !errors.landlord && !errors.reason;

  const handleClose = (next: boolean) => {
    if (!next && switchMutation.isPending) return; // disable closing while the request is in flight
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Home className="h-5 w-5 text-primary" />
            Switch Landlord — {tenantName}
          </DialogTitle>
          <DialogDescription>
            Rent Plan {rentPlanStatus ? `(${rentPlanStatus})` : ''} — moves this plan's landlord, payout destination
            and linked property where safe to do so.
          </DialogDescription>
        </DialogHeader>

        {!confirming ? (
          <div className="space-y-4">
            <FormErrorBanner message={formError} />

            <div className="rounded-md border bg-muted/30 p-2.5 text-xs">
              <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Current landlord</p>
              <p className="font-medium">{currentLandlordName || 'Unknown'}</p>
              {currentLandlordPhone ? <p className="text-muted-foreground">{currentLandlordPhone}</p> : null}
            </div>

            <div className="space-y-1.5" ref={pickerRef}>
              <Label className="text-xs">New landlord</Label>
              {selected ? (
                <div className="flex items-start gap-2 p-2.5 rounded-md border border-primary/40 bg-primary/5">
                  <Home className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{selected.name}</p>
                    {selected.phone ? <p className="text-xs text-muted-foreground truncate">{selected.phone}</p> : null}
                    {selected.property_address || selected.district || selected.village ? (
                      <p className="text-xs text-muted-foreground truncate">
                        {[selected.property_address, selected.village, selected.district].filter(Boolean).join(', ')}
                      </p>
                    ) : null}
                    <div className="flex items-center gap-1.5 mt-1">
                      {selected.verified && (
                        <Badge variant="outline" className="text-[10px] gap-1"><CheckCircle2 className="h-3 w-3" /> Verified</Badge>
                      )}
                      {selected.payout_ready ? (
                        <Badge variant="outline" className="text-[10px] gap-1 border-emerald-500/40 text-emerald-700 dark:text-emerald-400">
                          Payout ready
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] gap-1 border-amber-500/40 text-amber-700 dark:text-amber-400">
                          No approved payout number
                        </Badge>
                      )}
                    </div>
                  </div>
                  <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs"
                    onClick={() => { setSelected(null); setSearch(''); setDropdownOpen(true); }}>
                    Change
                  </Button>
                </div>
              ) : (
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <Input
                    placeholder="Search landlords by name or phone…"
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setDropdownOpen(true); }}
                    onFocus={() => setDropdownOpen(true)}
                    className="pl-9 pr-9"
                  />
                  {searching ? (
                    <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
                  ) : search ? (
                    <button type="button" onClick={() => setSearch('')} className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground" aria-label="Clear search">
                      <X className="h-4 w-4" />
                    </button>
                  ) : null}
                  {dropdownOpen && (
                    <div className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-lg max-h-72 overflow-y-auto">
                      {results.length === 0 ? (
                        <div className="px-3 py-2.5 text-sm text-muted-foreground">
                          {searching ? 'Searching…' : 'No verified landlords match.'}
                        </div>
                      ) : (
                        results.map((l) => (
                          <button
                            key={l.id}
                            type="button"
                            disabled={!l.eligible}
                            title={l.block_reason || undefined}
                            className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-accent transition-colors disabled:opacity-50 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                            onClick={() => {
                              if (!l.eligible) return;
                              setSelected(l);
                              setSearch('');
                              setDropdownOpen(false);
                            }}
                          >
                            {l.eligible ? <Home className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" /> : <Ban className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{l.name}</p>
                              {l.phone ? <p className="text-xs text-muted-foreground truncate">{l.phone}</p> : null}
                              {!l.eligible && l.block_reason ? (
                                <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5">{l.block_reason}</p>
                              ) : null}
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
              {submitAttempted && <FieldError message={errors.landlord} />}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Reason (min 10 characters)</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onBlur={() => setReasonTouched(true)}
                maxLength={500}
                aria-invalid={!!reasonErrText}
                placeholder="e.g. Property sold; new landlord confirmed with tenant"
                rows={3}
              />
              <p className="text-[11px] text-muted-foreground">{reason.trim().length}/10</p>
              <FieldError message={reasonErrText} />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <FormErrorBanner message={formError} />
            <div className="rounded-md border-2 border-amber-500/50 bg-amber-500/10 p-3 text-sm space-y-2">
              <p className="font-semibold flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" /> Confirm landlord switch?
              </p>
              <div className="text-xs space-y-1">
                <p><span className="text-muted-foreground">Tenant:</span> {tenantName}</p>
                <p><span className="text-muted-foreground">Rent Plan:</span> {rentRequestId} {rentPlanStatus ? `(${rentPlanStatus})` : ''}</p>
                <p><span className="text-muted-foreground">From:</span> {currentLandlordName || 'Unknown'}</p>
                <p><span className="text-muted-foreground">To:</span> {selected?.name}</p>
                {houseListingId && (
                  <p><span className="text-muted-foreground">Linked property:</span> will move to the new landlord if it safely and exclusively belongs to this tenant.</p>
                )}
                {planHasOpenAllocation && (
                  <p>An unpaid landlord float allocation on this plan will follow to the new landlord.</p>
                )}
                <p>Any pending payout confirmation (OTP) for the current landlord will be cancelled automatically.</p>
                <p className="font-medium">Landlord funds already paid out for this rent plan cannot be moved by this action.</p>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {confirming ? (
            <>
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={switchMutation.isPending}>
                Go back
              </Button>
              <Button onClick={() => switchMutation.mutate()} disabled={switchMutation.isPending}>
                {switchMutation.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                Confirm Landlord Switch
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button
                onClick={() => {
                  setSubmitAttempted(true);
                  setReasonTouched(true);
                  if (canReview) setConfirming(true);
                }}
              >
                Review switch
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
