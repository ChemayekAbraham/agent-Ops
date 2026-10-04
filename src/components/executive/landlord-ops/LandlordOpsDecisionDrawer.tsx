import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, CheckCircle2, AlertCircle, Info, Loader2, Clock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { toast } from 'sonner';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { formatUGX } from '@/lib/rentCalculations';
import {
  LISTING_REJECTION_CHARGE,
  LISTING_VERIFICATION_BONUS,
} from '@/hooks/useLandlordOpsToday';

interface DecisionDrawerProps {
  onClose?: () => void;
  className?: string;
}

/** Shape of the single listing the drawer decides on. Declared explicitly so the
 *  generated Supabase types don't have to be inferred through the embed. */
interface DrawerListing {
  id: string;
  title: string | null;
  house_category: string | null;
  monthly_rent: number | null;
  address: string | null;
  district: string | null;
  village: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  image_urls: string[] | null;
  created_at: string | null;
  status: string | null;
  verified: boolean | null;
  agent_id: string | null;
  agent: { full_name?: string | null; phone?: string | null } | null;
}


export function LandlordOpsDecisionDrawer({ onClose, className }: DecisionDrawerProps) {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const decideId = params.get('decide');

  const [activeTab, setActiveTab] = useState<'details' | 'history'>('details');
  const [decision, setDecision] = useState<'verify' | 'reject'>('verify');
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Evidence checklist state
  const [checklist, setChecklist] = useState({
    photos: true,
    gps: true,
    address: true,
    unitDetails: true,
    noIssues: false,
  });

  const handleClose = () => {
    const next = new URLSearchParams(params);
    next.delete('decide');
    setParams(next);
    onClose?.();
  };

  // `?decide=` carries a house_listings UUID. Anything else is a bad link — we
  // show a not-found state rather than inventing a listing to decide on.
  const isUuid = !!decideId && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(decideId);
  const { data: realListing, isLoading } = useQuery<DrawerListing | null>({
    queryKey: ['landlord-ops-drawer-item', decideId],
    enabled: isUuid,
    queryFn: async () => {
      const { data, error } = await (supabase as unknown as {
        from: (t: string) => {
          select: (s: string) => {
            eq: (c: string, v: string) => {
              maybeSingle: () => Promise<{ data: DrawerListing | null; error: { message: string } | null }>;
            };
          };
        };
      })
        .from('house_listings')
        .select(`
          id, title, house_category, monthly_rent, address, district, village, region,
          latitude, longitude, image_urls, created_at, status, verified, agent_id,
          agent:profiles!house_listings_agent_id_fkey(full_name, phone)
        `)
        .eq('id', decideId!)
        .maybeSingle();

      if (error) throw error;
      return (data as unknown as DrawerListing | null) ?? null;
    },
  });


  const displayItem = realListing
    ? {
        id: realListing.id,
        code: `#${realListing.id.slice(0, 8).toUpperCase()}`,
        title: realListing.title || `${realListing.house_category || 'Residential'} property`,
        location:
          [realListing.village, realListing.district, realListing.region].filter(Boolean).join(', ') ||
          realListing.address ||
          '—',
        agentName: (realListing.agent as { full_name?: string } | null)?.full_name || '—',
        submittedAt: realListing.created_at
          ? new Date(realListing.created_at).toLocaleDateString('en-GB', {
              day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
            })
          : '—',
        photosCount: ((realListing.image_urls as string[] | null) ?? []).length,
        imageUrl: ((realListing.image_urls as string[] | null) ?? [])[0] ?? null,
        status: realListing.verified ? 'Verified' : realListing.status || 'Pending',
        hasGps: realListing.latitude != null && realListing.longitude != null,
        hasAddress: !!(realListing.address || realListing.village || realListing.district),
        hasUnitDetails: Number(realListing.monthly_rent) > 0 && !!realListing.house_category,
      }
    : null;

  /** Photos, GPS, address and unit details are checks, not claims — each is read
   *  off the listing so a thin submission cannot present as fully evidenced. */
  const REQUIRED_PHOTOS = 3;
  const checks = displayItem
    ? [
        {
          label: `Property photos (minimum ${REQUIRED_PHOTOS})`,
          pass: displayItem.photosCount >= REQUIRED_PHOTOS,
          detail: `${displayItem.photosCount}/${REQUIRED_PHOTOS}`,
        },
        {
          label: 'Location/GPS captured',
          pass: displayItem.hasGps,
          detail: displayItem.hasGps ? 'present' : 'missing',
        },
        {
          label: 'Address on file',
          pass: displayItem.hasAddress,
          detail: displayItem.hasAddress ? 'present' : 'missing',
        },
        {
          label: 'Unit details (category, rent)',
          pass: displayItem.hasUnitDetails,
          detail: displayItem.hasUnitDetails ? 'present' : 'incomplete',
        },
      ]
    : [];

  /**
   * Runs the same two paths the verification queue uses, so a decision made here
   * has exactly the same effect as one made there:
   *   verify → `credit-listing-bonus` (marks verified AND credits the agent bonus)
   *   reject → `reject_house_listing` RPC, then the rejection notification
   * Nothing about the wallet is claimed in the UI until the call has returned.
   */
  const handleDecisionSubmit = async () => {
    if (!displayItem) return;
    if (reason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters.');
      return;
    }

    setIsSubmitting(true);
    try {
      if (decision === 'verify') {
        const { data, error } = await supabase.functions.invoke('credit-listing-bonus', {
          body: { listing_id: displayItem.id, notes: reason.trim() },
        });
        if (error) {
          const { extractFromErrorObject } = await import('@/lib/extractEdgeFunctionError');
          throw new Error(await extractFromErrorObject(error, 'Verification failed'));
        }
        if (data?.error) throw new Error(data.error);
        toast.success(`Verified ${displayItem!.code} — listing bonus credited to the agent`);
      } else {
        const { data, error } = await supabase.rpc('reject_house_listing', {
          p_listing_id: displayItem.id,
          p_reason: reason.trim(),
        });
        if (error) throw error;
        if (data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)) {
          throw new Error(String((data as Record<string, unknown>).error));
        }
        // Web-push only — the RPC already wrote the in-app notification.
        await invokeEdgeFunction('notify-listing-rejected', {
          body: { listing_id: displayItem.id, reason: reason.trim() },
          silent: true,
        });
        // The RPC reports whether the rejection charge actually posted; it
        // swallows a ledger failure rather than failing the rejection.
        const result = (data ?? {}) as { charged?: boolean; charge_amount?: number };
        toast.success(
          result.charged
            ? `Rejected ${displayItem!.code} — UGX ${(result.charge_amount ?? 0).toLocaleString()} charged to the agent`
            : `Rejected ${displayItem!.code} — no charge was applied`,
        );
      }

      // Refresh every surface that counts or lists this listing.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['exec-house-listings-pending-count'] }),
        qc.invalidateQueries({ queryKey: ['exec-house-listings-pending'] }),
        qc.invalidateQueries({ queryKey: ['exec-house-listings-ops'] }),
        qc.invalidateQueries({ queryKey: ['landlord-ops-today-activity'] }),
        qc.invalidateQueries({ queryKey: ['landlord-ops-today-recent-decisions'] }),
        qc.invalidateQueries({ queryKey: ['landlord-ops-today-wallet-impact'] }),
        qc.invalidateQueries({ queryKey: ['landlord-ops-verification-timeline'] }),
      ]);
      handleClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Verification decision failed';
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!decideId) return null;

  if (!isLoading && !displayItem) {
    return (
      <aside className={`w-[360px] xl:w-[380px] shrink-0 border-l border-border bg-card flex flex-col h-full z-20 shadow-lg ${className || ''}`}>
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="font-bold text-sm text-foreground">Listing not found</h3>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={handleClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Info className="h-5 w-5 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            No house listing matches <span className="font-mono">{decideId}</span>. It may have been delisted, or
            the link is stale.
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={`w-[360px] xl:w-[380px] shrink-0 border-l border-border bg-card flex flex-col h-full z-20 shadow-lg animate-in slide-in-from-right-6 duration-200 ${className || ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div>
          <h3 className="font-bold text-sm text-foreground">Verify listing</h3>
          <p className="text-xs text-muted-foreground">House listing verification {displayItem?.code ?? ''}</p>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={handleClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border px-4 text-xs font-semibold">
        <button
          onClick={() => setActiveTab('details')}
          className={`py-2.5 mr-6 border-b-2 transition-colors ${
            activeTab === 'details'
              ? 'border-emerald-600 text-emerald-700 dark:text-emerald-500'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Details
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`py-2.5 border-b-2 transition-colors ${
            activeTab === 'history'
              ? 'border-emerald-600 text-emerald-700 dark:text-emerald-500'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          History
        </button>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : activeTab === 'details' ? (
          <>
            {/* Property Summary Card */}
            <div className="flex gap-3 p-2.5 rounded-xl border border-border bg-muted/30">
              {displayItem!.imageUrl ? (
                <img
                  src={displayItem!.imageUrl}
                  alt={displayItem!.title}
                  className="w-16 h-16 rounded-lg object-cover shrink-0 border border-border"
                />
              ) : (
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-[10px] text-muted-foreground">
                  No photo
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-1">
                  <h4 className="font-semibold text-xs truncate text-foreground">{displayItem!.title}</h4>
                  <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-700 border-purple-200 shrink-0">
                    {displayItem!.status}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground truncate flex items-center gap-1 mt-0.5">
                  <span>📍</span> {displayItem!.location}
                </p>
                <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                  Listed by: <span className="font-medium text-foreground">{displayItem!.agentName}</span>
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Submitted: {displayItem!.submittedAt}
                </p>
              </div>
            </div>

            {/* Evidence Checklist */}
            <div className="space-y-2.5">
              <h4 className="font-bold text-xs text-foreground tracking-tight">Evidence checklist</h4>
              <div className="space-y-2 rounded-xl border border-border p-3 bg-card text-xs">
                {checks.map((check) => (
                  <div key={check.label} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {check.pass ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
                      )}
                      <span className={check.pass ? undefined : 'text-amber-700 dark:text-amber-500'}>
                        {check.label}
                      </span>
                    </div>
                    <span
                      className={`text-[11px] font-semibold ${
                        check.pass ? 'text-emerald-600' : 'text-amber-600'
                      }`}
                    >
                      {check.detail}
                    </span>
                  </div>
                ))}

                <div className="flex items-center justify-between pt-1 border-t border-border/60">
                  <label htmlFor="noIssues" className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground">
                    <Checkbox
                      id="noIssues"
                      checked={checklist.noIssues}
                      onCheckedChange={(c) => setChecklist((prev) => ({ ...prev, noIssues: !!c }))}
                    />
                    <span>No obvious issues (duplicates, illegal, etc.)</span>
                  </label>
                </div>
              </div>
            </div>

            {/* Decision Radio Group */}
            <div className="space-y-2.5">
              <h4 className="font-bold text-xs text-foreground tracking-tight">Decision</h4>
              <RadioGroup value={decision} onValueChange={(v) => setDecision(v as 'verify' | 'reject')} className="space-y-2">
                <label
                  htmlFor="decide-verify"
                  className={`flex items-start gap-2.5 p-2.5 rounded-xl border cursor-pointer transition-all ${
                    decision === 'verify'
                      ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20'
                      : 'border-border bg-card hover:bg-muted/40'
                  }`}
                >
                  <RadioGroupItem value="verify" id="decide-verify" className="mt-0.5 text-emerald-600" />
                  <div className="space-y-0.5 text-xs">
                    <p className="font-semibold text-foreground">Verify and credit agent</p>
                    <p className="text-[11px] text-emerald-600 font-medium">
                      Agent wallet: + {formatUGX(LISTING_VERIFICATION_BONUS)}
                    </p>
                  </div>
                </label>

                <label
                  htmlFor="decide-reject"
                  className={`flex items-start gap-2.5 p-2.5 rounded-xl border cursor-pointer transition-all ${
                    decision === 'reject'
                      ? 'border-rose-500 bg-rose-50/50 dark:bg-rose-950/20'
                      : 'border-border bg-card hover:bg-muted/40'
                  }`}
                >
                  <RadioGroupItem value="reject" id="decide-reject" className="mt-0.5 text-rose-600" />
                  <div className="space-y-0.5 text-xs">
                    <p className="font-semibold text-foreground">Reject and charge</p>
                    <p className="text-[11px] text-rose-600 font-medium">
                      Agent wallet: - {formatUGX(LISTING_REJECTION_CHARGE)}
                    </p>
                  </div>
                </label>
              </RadioGroup>
            </div>

            {/* Reason Mandatory Textarea */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <h4 className="font-bold text-foreground tracking-tight">Reason (mandatory)</h4>
                <span className="text-[10px] text-muted-foreground">{reason.length}/500</span>
              </div>
              <Textarea
                placeholder="Enter verification notes (minimum 10 characters)..."
                value={reason}
                onChange={(e) => setReason(e.target.value.slice(0, 500))}
                className="text-xs min-h-[75px] resize-none"
              />
            </div>
          </>
        ) : (
          <div className="space-y-3 text-xs">
            <div className="flex items-start gap-2 p-2 rounded-lg border bg-muted/20">
              <Clock className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div>
                <p className="font-medium text-foreground">Listing created</p>
                <p className="text-[11px] text-muted-foreground">
                  {displayItem!.submittedAt}
                  {displayItem!.agentName !== '—' ? ` by ${displayItem!.agentName}` : ''}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2 p-2 rounded-lg border bg-muted/20">
              <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div>
                <p className="font-medium text-foreground">Current status</p>
                <p className="text-[11px] text-muted-foreground">
                  {displayItem!.status} · {displayItem!.photosCount} photo
                  {displayItem!.photosCount === 1 ? '' : 's'} on file · {displayItem!.location}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Action Footer */}
      <div className="p-4 border-t border-border bg-card space-y-2">
        <Button
          onClick={handleDecisionSubmit}
          disabled={isSubmitting || reason.trim().length < 10}
          className={`w-full text-xs font-semibold py-2.5 h-auto transition-all ${
            decision === 'verify'
              ? 'bg-[#0FA958] hover:bg-[#0c8c48] text-white'
              : 'bg-rose-600 hover:bg-rose-700 text-white'
          }`}
        >
          {isSubmitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : decision === 'verify' ? (
            'Verify & credit listing bonus'
          ) : (
            'Reject listing'
          )}
        </Button>

        <Button variant="ghost" size="sm" onClick={handleClose} className="w-full text-xs h-8 text-muted-foreground hover:text-foreground">
          Cancel
        </Button>

        <div className="flex items-start gap-1.5 pt-1 text-[10px] text-muted-foreground leading-tight">
          <Info className="h-3 w-3 text-sky-500 shrink-0 mt-0.5" />
          <span>
            {decision === 'verify'
              ? `Marks the listing verified and credits ${formatUGX(
                  LISTING_VERIFICATION_BONUS,
                )} to the field agent's commission wallet.`
              : `Marks the listing rejected, notifies the agent and applies the standard ${formatUGX(
                  LISTING_REJECTION_CHARGE,
                )} rejection charge to their wallet.`}
          </span>
        </div>
      </div>
    </aside>
  );
}
