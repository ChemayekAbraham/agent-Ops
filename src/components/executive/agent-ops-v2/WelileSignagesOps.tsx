import React, { useState } from 'react';
import {
  ArrowLeft,
  Megaphone,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Search,
  Filter,
  MapPin,
  Camera,
  Coins,
  Building2,
  Calendar,
  ExternalLink,
  ShieldCheck,
  Clock,
  Eye,
  Loader2,
  FileCheck,
  RefreshCw,
  Store,
  Home,
  Briefcase,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { hapticTap, hapticSuccess } from '@/lib/haptics';
import {
  SIGNAGE_RATES,
  SignageRecord,
  SignageStatus,
  formatSignageStatus,
} from '@/lib/welileSignages';
import { useSignageOpsQueue, useReviewSignage, useVerifyInstallation } from '@/hooks/useWelileSignages';
import { toast } from 'sonner';

interface WelileSignagesOpsProps {
  onBack: () => void;
}

export function WelileSignagesOps({ onBack }: WelileSignagesOpsProps) {
  const { data: signages = [], isLoading, refetch } = useSignageOpsQueue();
  const reviewMutation = useReviewSignage();
  const verifyMutation = useVerifyInstallation();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Modal states
  const [selectedSignage, setSelectedSignage] = useState<SignageRecord | null>(null);
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [isVerifyOpen, setIsVerifyOpen] = useState(false);

  // Review decision form
  const [reviewNote, setReviewNote] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [reviewAction, setReviewAction] = useState<'approve' | 'return' | 'reject'>('approve');

  // Installation verification form
  const [installerName, setInstallerName] = useState('');
  const [installedAt, setInstalledAt] = useState(new Date().toISOString().split('T')[0]);
  const [verificationNotes, setVerificationNotes] = useState('');

  // Filtering
  const filtered = signages.filter((s) => {
    const matchesSearch =
      s.property_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.reference_no.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.owner_phone.includes(searchQuery) ||
      s.district_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.village_name.toLowerCase().includes(searchQuery.toLowerCase());

    if (statusFilter === 'all') return matchesSearch;
    if (statusFilter === 'pending_review') {
      return matchesSearch && ['submitted', 'under_review'].includes(s.status);
    }
    if (statusFilter === 'approved') {
      return matchesSearch && ['approved_for_installation', 'pending_installation'].includes(s.status);
    }
    if (statusFilter === 'active') {
      return matchesSearch && s.status === 'active';
    }
    return matchesSearch && s.status === statusFilter;
  });

  // Summary counts
  const totalActive = signages.filter((s) => s.status === 'active').length;
  const pendingReview = signages.filter((s) => ['submitted', 'under_review'].includes(s.status)).length;
  const awaitingInstallation = signages.filter((s) => ['approved_for_installation', 'pending_installation'].includes(s.status)).length;
  const monthlyCommitmentUgx = totalActive * SIGNAGE_RATES.OWNER_MONTHLY_UGX;

  // Review submission
  const handleConfirmReview = async () => {
    if (!selectedSignage) return;
    hapticTap();

    if (reviewAction === 'reject' && !rejectionReason.trim()) {
      toast.error('Please enter a rejection reason.');
      return;
    }

    await reviewMutation.mutateAsync({
      signageId: selectedSignage.id,
      decision: reviewAction,
      notes: reviewNote.trim() || undefined,
      rejectionReason: rejectionReason.trim() || undefined,
    });

    setIsReviewOpen(false);
    setSelectedSignage(null);
    setReviewNote('');
    setRejectionReason('');
  };

  // Installation verification submission
  const handleConfirmVerification = async () => {
    if (!selectedSignage) return;
    hapticTap();

    if (!installerName.trim()) {
      toast.error('Please enter the installer name.');
      return;
    }

    await verifyMutation.mutateAsync({
      signageId: selectedSignage.id,
      installerName: installerName.trim(),
      installedAt,
      verificationNotes: verificationNotes.trim() || undefined,
    });

    setIsVerifyOpen(false);
    setSelectedSignage(null);
    setInstallerName('');
    setVerificationNotes('');
  };

  return (
    <div className="space-y-4 w-full pb-16">
      {/* Top Header */}
      <div className="flex items-center justify-between gap-3 bg-card p-4 rounded-2xl border border-border/60 shadow-sm">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} className="h-9 w-9 rounded-full">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <Megaphone className="h-5 w-5 text-primary" />
              <h2 className="text-base font-bold text-foreground">Welile Signages Operations</h2>
              <Badge variant="secondary" className="text-[10px] bg-primary/10 text-primary font-bold">
                Admin Ops
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Review locations, verify physical installations, and manage monthly owner obligations.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="rounded-xl text-xs gap-1.5 h-9">
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Refresh</span>
        </Button>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div className="p-3.5 rounded-2xl bg-card border border-border/60 text-center">
          <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider block">Pending Review</span>
          <span className="text-lg font-bold text-amber-600">{pendingReview}</span>
        </div>
        <div className="p-3.5 rounded-2xl bg-card border border-border/60 text-center">
          <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider block">Awaiting Installation</span>
          <span className="text-lg font-bold text-primary">{awaitingInstallation}</span>
        </div>
        <div className="p-3.5 rounded-2xl bg-card border border-border/60 text-center">
          <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider block">Active Signages</span>
          <span className="text-lg font-bold text-emerald-600">{totalActive}</span>
        </div>
        <div className="p-3.5 rounded-2xl bg-card border border-border/60 text-center">
          <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider block">Monthly Owner Dues</span>
          <span className="text-lg font-bold text-foreground">UGX {monthlyCommitmentUgx.toLocaleString()}</span>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="flex flex-col sm:flex-row items-center gap-2">
        <div className="relative flex-1 w-full">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by property, reference, owner phone, district..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-10 rounded-xl text-xs"
          />
        </div>
        <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0">
          {[
            { id: 'all', label: 'All' },
            { id: 'pending_review', label: `Pending (${pendingReview})` },
            { id: 'approved', label: `Approved (${awaitingInstallation})` },
            { id: 'active', label: `Active (${totalActive})` },
          ].map((f) => (
            <Button
              key={f.id}
              variant={statusFilter === f.id ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatusFilter(f.id)}
              className="rounded-xl text-xs h-9 shrink-0"
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Queue Table / Cards */}
      {isLoading ? (
        <div className="py-16 text-center text-xs text-muted-foreground flex flex-col items-center gap-2">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <span>Loading Signage Operations Queue...</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center bg-card border border-border/60 rounded-2xl p-6 space-y-2">
          <Megaphone className="h-10 w-10 text-muted-foreground/30 mx-auto" />
          <h4 className="text-sm font-semibold">No Signage Applications Found</h4>
          <p className="text-xs text-muted-foreground">Applications submitted by agents will appear in this queue.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((item) => {
            const statusMeta = formatSignageStatus(item.status);
            return (
              <Card key={item.id} className="rounded-2xl border-border/60 shadow-sm overflow-hidden hover:border-primary/40 transition-colors">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-foreground">{item.property_name}</span>
                        <Badge variant="outline" className="text-[10px] capitalize">
                          {item.property_type.replace('_', ' ')}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Ref: <span className="font-mono font-bold text-foreground">{item.reference_no}</span> • Agent: {item.agent_name || 'Agent'} ({item.agent_phone || 'N/A'})
                      </p>
                    </div>
                    <Badge variant={statusMeta.variant as any} className="text-[10px] shrink-0">
                      {statusMeta.label}
                    </Badge>
                  </div>

                  {/* Location & Suitability Row */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 p-3 rounded-xl bg-muted/30 text-xs">
                    <div>
                      <span className="text-[10px] text-muted-foreground block font-medium">Administrative Locality:</span>
                      <span className="font-medium text-foreground">{item.village_name}, {item.district_name}</span>
                      {item.plot_or_landmark && <p className="text-[10px] text-muted-foreground truncate">{item.plot_or_landmark}</p>}
                    </div>
                    <div>
                      <span className="text-[10px] text-muted-foreground block font-medium">GPS Verification:</span>
                      <span className="font-mono text-foreground">{item.gps_latitude?.toFixed(4)}, {item.gps_longitude?.toFixed(4)}</span>
                      <p className="text-[10px] text-emerald-600 font-medium">Accuracy ±{Math.round(item.gps_accuracy_meters)}m</p>
                    </div>
                    <div>
                      <span className="text-[10px] text-muted-foreground block font-medium">Owner Payout:</span>
                      <span className="font-bold text-foreground">{item.owner_full_name}</span>
                      <p className="text-[10px] text-muted-foreground">{item.owner_phone} • {item.owner_payment_method.toUpperCase()}</p>
                    </div>
                  </div>

                  {/* Actions Row */}
                  <div className="flex items-center justify-between pt-1 gap-2 border-t border-border/40">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Camera className="h-3.5 w-3.5" />
                      <span>{item.photos?.length ?? 0} photos attached</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedSignage(item);
                          setIsReviewOpen(true);
                        }}
                        className="rounded-xl text-xs h-8 gap-1"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        <span>Inspect & Decide</span>
                      </Button>

                      {['approved_for_installation', 'pending_installation'].includes(item.status) && (
                        <Button
                          size="sm"
                          onClick={() => {
                            setSelectedSignage(item);
                            setIsVerifyOpen(true);
                          }}
                          className="rounded-xl text-xs h-8 gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                        >
                          <FileCheck className="h-3.5 w-3.5" />
                          <span>Verify Installation</span>
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── MODAL 1: INSPECTION & DECISION DIALOG ── */}
      <Dialog open={isReviewOpen} onOpenChange={setIsReviewOpen}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl">
          {selectedSignage && (
            <div className="space-y-4">
              <DialogHeader className="pr-8">
                <div className="flex items-center justify-between gap-3">
                  <DialogTitle className="text-base font-bold">
                    Review Signage: {selectedSignage.reference_no}
                  </DialogTitle>
                  <Badge variant={formatSignageStatus(selectedSignage.status).variant as any} className="text-xs shrink-0">
                    {formatSignageStatus(selectedSignage.status).label}
                  </Badge>
                </div>
                <DialogDescription className="text-xs">
                  Inspect coordinates, photographs, owner consent, and commercial advertising visibility.
                </DialogDescription>
              </DialogHeader>

              {/* Photos Gallery */}
              <div>
                <Label className="text-xs font-semibold text-foreground mb-1.5 block">Photographic Evidence</Label>
                {selectedSignage.photos?.length > 0 ? (
                  <div className="grid grid-cols-2 gap-2">
                    {selectedSignage.photos.map((photo, i) => (
                      <div key={photo.id || i} className="relative aspect-video rounded-xl overflow-hidden border border-border bg-black/10">
                        <img src={photo.url} alt={photo.caption} className="w-full h-full object-cover" />
                        <span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-black/60 text-[9px] text-white font-medium">
                          {photo.category?.replace('_', ' ').toUpperCase()}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground p-3 bg-muted/40 rounded-xl text-center">
                    No photographs provided.
                  </p>
                )}
              </div>

              {/* Location & Coordinates Audit */}
              <div className="p-3 rounded-xl bg-muted/40 border border-border text-xs space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-foreground">GPS Location Match</span>
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
                  District: <strong className="text-foreground">{selectedSignage.district_name}</strong> • Village: <strong className="text-foreground">{selectedSignage.village_name}</strong>
                </p>
              </div>

              {/* Suitability Details */}
              <div className="p-3 rounded-xl border border-border text-xs space-y-1">
                <p><strong>Foot Traffic:</strong> <span className="capitalize">{selectedSignage.foot_traffic}</span></p>
                {selectedSignage.road_visibility && <p><strong>Road Visibility:</strong> {selectedSignage.road_visibility}</p>}
                {selectedSignage.proposed_surface && <p><strong>Proposed Surface:</strong> {selectedSignage.proposed_surface}</p>}
              </div>

              {/* Decision Section */}
              <div className="space-y-3 pt-2 border-t border-border">
                <Label className="text-xs font-bold">Ops Decision</Label>
                <div className="grid grid-cols-3 gap-2">
                  <Button
                    type="button"
                    variant={reviewAction === 'approve' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setReviewAction('approve')}
                    className="rounded-xl text-xs h-9"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1 text-emerald-500" />
                    Approve
                  </Button>
                  <Button
                    type="button"
                    variant={reviewAction === 'return' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setReviewAction('return')}
                    className="rounded-xl text-xs h-9"
                  >
                    <AlertCircle className="h-3.5 w-3.5 mr-1 text-amber-500" />
                    Need Changes
                  </Button>
                  <Button
                    type="button"
                    variant={reviewAction === 'reject' ? 'destructive' : 'outline'}
                    size="sm"
                    onClick={() => setReviewAction('reject')}
                    className="rounded-xl text-xs h-9"
                  >
                    <XCircle className="h-3.5 w-3.5 mr-1" />
                    Reject
                  </Button>
                </div>

                {reviewAction === 'reject' ? (
                  <div>
                    <Label className="text-xs font-medium">Rejection Reason *</Label>
                    <Textarea
                      placeholder="Explain why this location was rejected (e.g. low visibility, unauthorized property, duplicate spot)..."
                      value={rejectionReason}
                      onChange={(e) => setRejectionReason(e.target.value)}
                      className="mt-1 text-xs rounded-xl"
                      required
                    />
                  </div>
                ) : (
                  <div>
                    <Label className="text-xs font-medium">Ops Review Notes (Optional)</Label>
                    <Textarea
                      placeholder="Add instructions for the installation team..."
                      value={reviewNote}
                      onChange={(e) => setReviewNote(e.target.value)}
                      className="mt-1 text-xs rounded-xl"
                    />
                  </div>
                )}
              </div>

              <DialogFooter className="pt-2">
                <Button variant="ghost" size="sm" onClick={() => setIsReviewOpen(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleConfirmReview}
                  disabled={reviewMutation.isPending}
                  className="rounded-xl text-xs font-bold"
                >
                  {reviewMutation.isPending ? 'Recording...' : 'Confirm Decision'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── MODAL 2: INSTALLATION VERIFICATION & ACTIVATION DIALOG ── */}
      <Dialog open={isVerifyOpen} onOpenChange={setIsVerifyOpen}>
        <DialogContent className="max-w-md rounded-2xl">
          {selectedSignage && (
            <div className="space-y-4">
              <DialogHeader className="pr-8">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-emerald-600" />
                  <DialogTitle className="text-base font-bold">Verify Physical Installation</DialogTitle>
                </div>
                <DialogDescription className="text-xs">
                  Confirm the signage has been physically mounted at {selectedSignage.property_name}. This independently activates the recurring owner payments and the agent reward.
                </DialogDescription>
              </DialogHeader>

              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs space-y-1 text-emerald-800 dark:text-emerald-300">
                <p className="font-bold">⚡ Financial Actions Triggered by Verification:</p>
                <p>• Unlocks <strong>UGX 3,000</strong> one-time agent reward for {selectedSignage.agent_name || 'Agent'}.</p>
                <p>• Starts <strong>UGX 10,000/month</strong> recurring rent obligation for property owner {selectedSignage.owner_full_name}.</p>
              </div>

              <div className="space-y-3">
                <div>
                  <Label className="text-xs font-medium">Installer Name / Field Officer *</Label>
                  <Input
                    placeholder="Name of person or team who mounted signage"
                    value={installerName}
                    onChange={(e) => setInstallerName(e.target.value)}
                    className="mt-1 h-10 text-xs rounded-xl"
                    required
                  />
                </div>

                <div>
                  <Label className="text-xs font-medium">Date Installed *</Label>
                  <Input
                    type="date"
                    value={installedAt}
                    onChange={(e) => setInstalledAt(e.target.value)}
                    className="mt-1 h-10 text-xs rounded-xl"
                    required
                  />
                </div>

                <div>
                  <Label className="text-xs font-medium">Verification Notes</Label>
                  <Textarea
                    placeholder="Confirm placement height, visibility, and condition..."
                    value={verificationNotes}
                    onChange={(e) => setVerificationNotes(e.target.value)}
                    className="mt-1 text-xs rounded-xl"
                  />
                </div>
              </div>

              <DialogFooter className="pt-2">
                <Button variant="ghost" size="sm" onClick={() => setIsVerifyOpen(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleConfirmVerification}
                  disabled={verifyMutation.isPending || !installerName.trim()}
                  className="rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {verifyMutation.isPending ? 'Activating...' : 'Verify & Activate Signage'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
