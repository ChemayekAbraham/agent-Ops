import { SignageEvidence } from '@/components/signages/SignageEvidence';
import React, { useRef, useState } from 'react';
import {
  Megaphone,
  CheckCircle2,
  Clock,
  RefreshCw,
  Search,
  Building2,
  ExternalLink,
  Coins,
  MapPin,
  Camera,
  ShieldCheck,
  Send,
  Eye,
  Check,
  Wallet,
  Phone,
  User,
  ArrowRight,
  Filter,
  AlertCircle,
  FileCheck,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  SIGNAGE_RATES,
  SignageListRecord,
  formatSignageStatus,
  canPayAgentReward,
  canPayOwner,
  canTerminateSignage,
} from '@/lib/welileSignages';
import { useSignageCfoQueue, useCfoDisburseSignage, useCfoReturnSignage, useCfoTerminateSignage } from '@/hooks/useWelileSignages';
import { Textarea } from '@/components/ui/textarea';
import { hapticTap, hapticSuccess } from '@/lib/haptics';
import { toast } from 'sonner';

export function CFOSignagesDesk() {
  const { data: signages = [], isLoading, isError, error, refetch } = useSignageCfoQueue();
  const disburseMutation = useCfoDisburseSignage();
  const returnMutation = useCfoReturnSignage();
  const terminateMutation = useCfoTerminateSignage();
  const [actionModal, setActionModal] = useState<{ signage: SignageListRecord; kind: 'return' | 'terminate' } | null>(null);
  const [actionReason, setActionReason] = useState('');

  const [search, setSearch] = useState('');
  const [filterTab, setFilterTab] = useState<'pending_payout' | 'active' | 'pipeline' | 'disbursed' | 'all'>('all');
  const [selectedSignage, setSelectedSignage] = useState<SignageListRecord | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [disburseModal, setDisburseModal] = useState<{
    signage: SignageListRecord;
    type: 'agent_reward' | 'owner_rent';
  } | null>(null);
  const paymentLock = useRef(false);

  // Money moves only here. The board is already installed when the agent applies. The agent is paid once
  // after Ops and COO approval (that payment activates the signage); the owner is paid monthly from one
  // month after activation until the contract is terminated.
  const approvedSignages = signages.filter((s) => ['awaiting_cfo', 'active', 'removed'].includes(s.status));

  const pendingAgentRewards = approvedSignages.filter(canPayAgentReward);
  const pendingOwnerRents = approvedSignages.filter(canPayOwner);

  const totalActive = approvedSignages.filter((s) => s.status === 'active').length;
  const totalApprovedAwaitingInstall = approvedSignages.filter((s) => !['active', 'removed'].includes(s.status)).length;
  const totalDisbursedCount = approvedSignages.filter(
    (s) => s.agent_reward_status === 'paid' || s.owner_rent_status === 'paid'
  ).length;

  const totalPendingRewardsUgx = pendingAgentRewards.length * SIGNAGE_RATES.AGENT_REWARD_UGX;
  const totalMonthlyOwnerDuesUgx = totalActive * SIGNAGE_RATES.OWNER_MONTHLY_UGX;

  // Filtered list
  const filtered = approvedSignages.filter((item) => {
    const q = search.toLowerCase();
    const matchesSearch =
      !search.trim() ||
      item.reference_no.toLowerCase().includes(q) ||
      item.property_name.toLowerCase().includes(q) ||
      item.owner_full_name.toLowerCase().includes(q) ||
      item.owner_phone.includes(q) ||
      (item.agent_name && item.agent_name.toLowerCase().includes(q)) ||
      item.district_name.toLowerCase().includes(q) ||
      item.village_name.toLowerCase().includes(q);

    if (!matchesSearch) return false;

    if (filterTab === 'pending_payout') {
      return canPayAgentReward(item) || canPayOwner(item);
    }
    if (filterTab === 'active') {
      return item.status === 'active';
    }
    if (filterTab === 'pipeline') {
      return !['active', 'removed'].includes(item.status);
    }
    if (filterTab === 'disbursed') {
      return item.agent_reward_status === 'paid' || item.owner_rent_status === 'paid';
    }
    return true;
  });

  const handleOpenDisburse = (signage: SignageListRecord, type: 'agent_reward' | 'owner_rent') => {
    hapticTap();
    setDisburseModal({ signage, type });
  };

  const handleConfirmDisburse = async () => {
    if (!disburseModal || paymentLock.current) return;
    const { signage, type } = disburseModal;

    const amountUgx =
      type === 'agent_reward' ? SIGNAGE_RATES.AGENT_REWARD_UGX : SIGNAGE_RATES.OWNER_MONTHLY_UGX;
    const recipientPhone =
      type === 'agent_reward' ? signage.agent_phone || '' : signage.owner_payment_number || signage.owner_phone;
    const recipientName =
      type === 'agent_reward' ? signage.agent_name || 'Agent' : signage.owner_payment_name || signage.owner_full_name;

    paymentLock.current = true;
    try {
      await disburseMutation.mutateAsync({
        signageId: signage.id,
        payoutType: type,
        recipientPhone,
        recipientName,
        amountUgx,
        periodIndex: type === 'agent_reward' ? 0 : signage.owner_rent_period_index ?? 0,
      });

      hapticSuccess();
      setDisburseModal(null);
    } catch { /* Mutation displays the server refusal; keep the confirmation open. */ }
    finally { paymentLock.current = false; }
  };

  const handleConfirmAction = async () => {
    if (!actionModal) return;
    const mutation = actionModal.kind === 'return' ? returnMutation : terminateMutation;
    try {
      await mutation.mutateAsync({ signageId: actionModal.signage.id, reason: actionReason });
      setActionModal(null);
      setActionReason('');
    } catch { /* The mutation reports the refusal. */ }
  };

  return (
    <div className="space-y-5 w-full pb-16">
      {/* ── Top Header ── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-card p-5 rounded-2xl border border-border/60 shadow-sm">
        <div className="flex items-center gap-3.5">
          <div className="h-11 w-11 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
            <Megaphone className="h-5 w-5 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-foreground">Welile Signages Disbursement Desk</h1>
              <Badge variant="secondary" className="text-[10px] bg-emerald-500/10 text-emerald-600 font-bold border-emerald-500/20">
                CFO Treasury
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Paying the agent's one-time reward makes the signage Active. Owners are paid monthly from one month after activation, until you terminate.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            className="rounded-xl text-xs gap-1.5 h-9"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Refresh</span>
          </Button>
        </div>
      </div>

      {/* ── Metric Cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="p-4 rounded-2xl bg-card border border-border/60 shadow-sm">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold text-muted-foreground">Active Signages</span>
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          </div>
          <div className="text-2xl font-bold text-foreground">{totalActive}</div>
          <p className="text-[10px] text-muted-foreground mt-1">
            {totalApprovedAwaitingInstall} awaiting your payment
          </p>
        </div>

        <div className="p-4 rounded-2xl bg-card border border-border/60 shadow-sm">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold text-muted-foreground">Pending Agent Rewards</span>
            <Coins className="h-4 w-4 text-amber-500" />
          </div>
          <div className="text-2xl font-bold text-amber-600">UGX {totalPendingRewardsUgx.toLocaleString()}</div>
          <p className="text-[10px] text-muted-foreground mt-1">
            {pendingAgentRewards.length} approved, awaiting payment
          </p>
        </div>

        <div className="p-4 rounded-2xl bg-card border border-border/60 shadow-sm">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold text-muted-foreground">Monthly Owner Dues</span>
            <Building2 className="h-4 w-4 text-primary" />
          </div>
          <div className="text-2xl font-bold text-foreground">UGX {totalMonthlyOwnerDuesUgx.toLocaleString()}</div>
          <p className="text-[10px] text-muted-foreground mt-1">
            UGX 10,000/mo per active premise
          </p>
        </div>

        <div className="p-4 rounded-2xl bg-card border border-border/60 shadow-sm">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold text-muted-foreground">Disbursed Batches</span>
            <Wallet className="h-4 w-4 text-emerald-600" />
          </div>
          <div className="text-2xl font-bold text-emerald-600">{totalDisbursedCount}</div>
          <p className="text-[10px] text-muted-foreground mt-1">
            Processed via CFO Mobile Money / Ledger
          </p>
        </div>
      </div>

      {/* ── Search & Filter Tabs ── */}
      <div className="flex flex-col sm:flex-row items-center gap-2">
        <div className="relative flex-1 w-full">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by reference, property, owner phone, agent..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-10 rounded-xl text-xs"
          />
        </div>

        <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0">
          {[
            { id: 'pending_payout', label: `Ready for Payout (${pendingAgentRewards.length + pendingOwnerRents.length})` },
            { id: 'active', label: `Active (${totalActive})` },
            { id: 'pipeline', label: `In Field (${totalApprovedAwaitingInstall})` },
            { id: 'disbursed', label: 'Disbursed' },
            { id: 'all', label: `All (${approvedSignages.length})` },
          ].map((tab) => (
            <Button
              key={tab.id}
              variant={filterTab === tab.id ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilterTab(tab.id as any)}
              className="rounded-xl text-xs h-9 shrink-0"
            >
              {tab.label}
            </Button>
          ))}
        </div>
      </div>

      {/* ── Queue Listing ── */}
      {isLoading ? (
        <div className="py-20 text-center text-xs text-muted-foreground flex flex-col items-center gap-2">
          <RefreshCw className="h-6 w-6 animate-spin text-primary" />
          <span>Loading CFO Signages Payables Queue...</span>
        </div>
      ) : isError ? (
        <div role="alert" className="p-4 text-sm text-destructive">Could not load Signages payments: {(error as Error)?.message}</div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center bg-card border border-border/60 rounded-2xl p-8 space-y-2">
          <Megaphone className="h-10 w-10 text-muted-foreground/30 mx-auto" />
          <h4 className="text-sm font-semibold">No Signages in this Queue</h4>
          <p className="text-xs text-muted-foreground">
            Applications appear here after COO approval. Check the installed-signage photo before paying.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((item) => {
            const statusMeta = formatSignageStatus(item.status);
            const isRewardPaid = item.agent_reward_status === 'paid';
            const ownerMonth = (item.owner_rent_period_index ?? 0) + 2;

            return (
              <Card key={item.id} className="rounded-2xl border-border/60 shadow-sm overflow-hidden hover:border-primary/40 transition-colors">
                <CardContent className="p-4 sm:p-5 space-y-3.5">
                  {/* Top Line */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm text-foreground">{item.property_name}</span>
                        <Badge variant="outline" className="text-[10px] capitalize">
                          {item.property_type.replace('_', ' ')}
                        </Badge>
                        <Badge variant={statusMeta.variant as any} className="text-[10px]">
                          {statusMeta.label}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Ref: <span className="font-mono font-bold text-foreground">{item.reference_no}</span> • Locality: {item.village_name}, {item.district_name}
                      </p>
                      {(item.nearby_signage_ref || item.repeat_owner_phone) && (
                        <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5 flex items-center gap-1">
                          <AlertCircle className="h-3 w-3" />
                          {item.nearby_signage_ref ? `Only ${item.nearby_signage_m} m from ${item.nearby_signage_ref}. Check it is not the same spot. ` : ''}
                          {item.repeat_owner_phone ? 'Owner phone is used on another signage.' : ''}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 self-start sm:self-center">
                      {item.status === 'awaiting_cfo' && (
                        <Button size="sm" variant="outline" className="rounded-xl text-xs h-8" onClick={() => { setActionReason(''); setActionModal({ signage: item, kind: 'return' }); }}>
                          Return to agent
                        </Button>
                      )}
                      {canTerminateSignage(item) && (
                        <Button size="sm" variant="ghost" className="rounded-xl text-xs h-8 text-destructive hover:bg-destructive/10" onClick={() => { setActionReason(''); setActionModal({ signage: item, kind: 'terminate' }); }}>
                          Terminate contract
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSelectedSignage(item);
                          setIsDetailOpen(true);
                        }}
                        className="rounded-xl text-xs h-8 gap-1.5"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        <span>Inspect Evidence</span>
                      </Button>
                    </div>
                  </div>

                  {/* Dual Beneficiary Payout Strip */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 rounded-xl bg-muted/40 border border-border/60 text-xs">
                    {/* Agent Reward Box */}
                    <div className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-background border border-border/50">
                      <div>
                        <div className="flex items-center gap-1.5 text-muted-foreground text-[10px] font-semibold uppercase">
                          <User className="h-3.5 w-3.5 text-primary" />
                          <span>Field Agent Reward</span>
                        </div>
                        <p className="font-bold text-foreground mt-0.5">{item.agent_name || 'Agent'}</p>
                        <p className="text-[10px] text-muted-foreground">{item.agent_phone || 'No phone recorded'}</p>
                        <span className="font-mono font-bold text-emerald-600 block mt-0.5">
                          UGX {SIGNAGE_RATES.AGENT_REWARD_UGX.toLocaleString()}
                        </span>
                      </div>

                      <div>
                        {isRewardPaid ? (
                          <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-[10px] gap-1">
                            <Check className="h-3 w-3" />
                            <span>Disbursed</span>
                          </Badge>
                        ) : canPayAgentReward(item) ? (
                          <Button
                            size="sm"
                            disabled={disburseMutation.isPending}
                            onClick={() => handleOpenDisburse(item, 'agent_reward')}
                            className="rounded-xl text-xs h-8 font-bold bg-primary hover:bg-primary/90 text-primary-foreground gap-1"
                          >
                            <Send className="h-3 w-3" />
                            <span>Pay Agent & Activate</span>
                          </Button>
                        ) : (
                          <span className="text-[10px] text-muted-foreground italic">
                            {item.status === 'removed' ? 'Contract terminated' : 'Awaiting COO approval'}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Property Owner Rent Box */}
                    <div className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-background border border-border/50">
                      <div>
                        <div className="flex items-center gap-1.5 text-muted-foreground text-[10px] font-semibold uppercase">
                          <Building2 className="h-3.5 w-3.5 text-primary" />
                          <span>Owner Space Rent</span>
                        </div>
                        <p className="font-bold text-foreground mt-0.5">{item.owner_full_name}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {item.owner_account_id
                            ? `Welile wallet: ${item.owner_account_name || 'owner account'}`
                            : item.owner_account_issue || `Phone ${item.owner_phone}`}
                        </p>
                        <span className="font-mono font-bold text-foreground block mt-0.5">
                          UGX {SIGNAGE_RATES.OWNER_MONTHLY_UGX.toLocaleString()} / mo
                        </span>
                      </div>

                      <div>
                        {canPayOwner(item) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={disburseMutation.isPending}
                            onClick={() => handleOpenDisburse(item, 'owner_rent')}
                            className="rounded-xl text-xs h-8 font-bold border-primary text-primary hover:bg-primary/10 gap-1"
                          >
                            <Send className="h-3 w-3" />
                            <span>Pay Owner (month {ownerMonth})</span>
                          </Button>
                        ) : (
                          <span className="text-[10px] text-muted-foreground italic">
                            {item.status === 'removed' ? 'Contract terminated'
                              : item.status !== 'active' ? 'Starts one month after activation'
                              : item.owner_rent_payable && item.owner_account_issue ? 'Blocked: owner wallet not ready'
                              : item.owner_rent_due_at ? `Month ${ownerMonth} due ${new Date(item.owner_rent_due_at).toLocaleDateString()}` : 'Not due yet'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Verification Footer Notes */}
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1">
                    <div className="flex items-center gap-2">
                      <Camera className="h-3.5 w-3.5" />
                      <span>Photographic evidence</span>
                      {item.installer_name && (
                        <span>• Installer: <strong className="text-foreground">{item.installer_name}</strong></span>
                      )}
                    </div>
                    {item.activated_at && (
                      <span>Activated: {new Date(item.activated_at).toLocaleDateString()}</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!actionModal} onOpenChange={(open) => { if (!open && !returnMutation.isPending && !terminateMutation.isPending) setActionModal(null); }}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>{actionModal?.kind === 'return' ? 'Return to agent' : 'Terminate contract'}</DialogTitle>
            <DialogDescription>
              {actionModal?.kind === 'return'
                ? `${actionModal?.signage.reference_no}: no payment is made. The agent fixes the application and it goes through Ops and the COO again.`
                : `${actionModal?.signage.reference_no}: no further owner payouts will be made. This cannot be undone.`}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={actionReason} onChange={(e) => setActionReason(e.target.value)} placeholder="Reason (at least 10 characters)" className="rounded-xl text-sm" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionModal(null)} disabled={returnMutation.isPending || terminateMutation.isPending}>Cancel</Button>
            <Button variant={actionModal?.kind === 'terminate' ? 'destructive' : 'default'} onClick={handleConfirmAction}
              disabled={actionReason.trim().length < 10 || returnMutation.isPending || terminateMutation.isPending}>
              {actionModal?.kind === 'return' ? 'Send back to agent' : 'Terminate contract'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── MODAL 1: INSPECTION & PHOTO EVIDENCE ── */}
      <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl">
          {selectedSignage && (
            <div className="space-y-4">
              <DialogHeader className="pr-8">
                <div className="flex items-center justify-between gap-3">
                  <DialogTitle className="text-base font-bold">
                    CFO Audit: {selectedSignage.reference_no}
                  </DialogTitle>
                  <Badge variant={formatSignageStatus(selectedSignage.status).variant as any} className="text-xs shrink-0">
                    {formatSignageStatus(selectedSignage.status).label}
                  </Badge>
                </div>
                <DialogDescription className="text-xs">
                  Verify mounting evidence, GPS match, and mobile money recipient authorization.
                </DialogDescription>
              </DialogHeader>

              {/* Photos Gallery */}
              <div>
                <Label className="text-xs font-semibold text-foreground mb-1.5 block">Photos & Physical Evidence</Label>
                {isDetailOpen && <SignageEvidence signageId={selectedSignage.id} />}
              </div>

              {/* GPS & Locality */}
              <div className="p-3 rounded-xl bg-muted/40 border border-border text-xs space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-foreground">GPS Coordinates</span>
                  <a
                    href={`https://www.google.com/maps?q=${selectedSignage.gps_latitude},${selectedSignage.gps_longitude}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary text-[11px] font-semibold flex items-center gap-1 hover:underline"
                  >
                    <span>Open in Maps</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <p className="font-mono text-muted-foreground">
                  Lat: {selectedSignage.gps_latitude}, Lng: {selectedSignage.gps_longitude} (Accuracy: ±{Math.round(selectedSignage.gps_accuracy_meters)}m)
                </p>
                <p className="text-muted-foreground">
                  Locality: <strong className="text-foreground">{selectedSignage.village_name}, {selectedSignage.district_name}</strong>
                </p>
              </div>

              {/* Ops & Installation Audit Notes */}
              <div className="p-3 rounded-xl border border-border text-xs space-y-1">
                <p><strong>Property Name:</strong> {selectedSignage.property_name}</p>
                {selectedSignage.installer_name && (
                  <p><strong>Verified Installer:</strong> {selectedSignage.installer_name} ({selectedSignage.installed_at || 'Date N/A'})</p>
                )}
                {selectedSignage.verification_notes && (
                  <p><strong>Field Notes:</strong> {selectedSignage.verification_notes}</p>
                )}
              </div>

              <DialogFooter className="pt-2">
                <Button variant="ghost" size="sm" onClick={() => setIsDetailOpen(false)}>
                  Close
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── MODAL 2: CONFIRM DISBURSEMENT DIALOG ── */}
      <Dialog open={!!disburseModal} onOpenChange={(open) => !open && setDisburseModal(null)}>
        <DialogContent className="max-w-md rounded-2xl">
          {disburseModal && (
            <div className="space-y-4">
              <DialogHeader className="pr-8">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-emerald-600" />
                  <DialogTitle className="text-base font-bold">
                    Authorize CFO Disbursement
                  </DialogTitle>
                </div>
                <DialogDescription className="text-xs">
                  {disburseModal.type === 'agent_reward'
                    ? `Pay the agent's one-time reward for ${disburseModal.signage.reference_no}. This makes the signage Active. Check the installed-signage photo first.`
                    : `Pay the owner for month ${(disburseModal.signage.owner_rent_period_index ?? 0) + 2} of ${disburseModal.signage.reference_no} to their own Welile wallet.`}
                </DialogDescription>
              </DialogHeader>

              <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Disbursement Amount:</span>
                  <span className="font-mono font-bold text-base text-emerald-700 dark:text-emerald-400">
                    UGX {disburseModal.type === 'agent_reward'
                      ? SIGNAGE_RATES.AGENT_REWARD_UGX.toLocaleString()
                      : SIGNAGE_RATES.OWNER_MONTHLY_UGX.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Recipient Name:</span>
                  <span className="font-bold text-foreground">
                    {disburseModal.type === 'agent_reward'
                      ? disburseModal.signage.agent_name || 'Agent'
                      : disburseModal.signage.owner_account_name || disburseModal.signage.owner_full_name}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Payment Target:</span>
                  <span className="font-bold text-foreground">
                    {disburseModal.type === 'agent_reward'
                      ? 'Agent Welile wallet'
                      : 'Owner Welile wallet'}
                  </span>
                </div>
              </div>

              <p className="text-xs text-muted-foreground">The payment reference is recorded automatically. Each payment can be made only once.</p>

              <DialogFooter className="pt-2">
                <Button variant="ghost" size="sm" onClick={() => setDisburseModal(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleConfirmDisburse}
                  disabled={disburseMutation.isPending}
                  className="rounded-xl text-xs font-bold"
                >
                  {disburseMutation.isPending ? 'Processing...' : 'Confirm & Disburse'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
export default CFOSignagesDesk;
