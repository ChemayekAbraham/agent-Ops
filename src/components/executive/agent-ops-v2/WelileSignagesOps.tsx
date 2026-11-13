import { SignageEvidence } from '@/components/signages/SignageEvidence';
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
  Clock,
  Eye,
  Loader2,
  RefreshCw,
  Store,
  Home,
  Briefcase,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { findUgDistrictByName, UG_REGIONS, useUgDistricts } from '@/hooks/useUgLocations';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { hapticTap, hapticSuccess } from '@/lib/haptics';
import {
  SIGNAGE_RATES,
  SignageListRecord,
  SignageStatus,
  formatSignageStatus,
  canReviewSignage,
} from '@/lib/welileSignages';
import { useSignageOpsQueue, useReviewSignage } from '@/hooks/useWelileSignages';
import { toast } from 'sonner';

interface WelileSignagesOpsProps {
  onBack: () => void;
  stage?: 'agent_ops' | 'coo';
}

export function WelileSignagesOps({ onBack, stage = 'agent_ops' }: WelileSignagesOpsProps) {
  const { data: signages = [], isLoading, isError, error, refetch, isFetching } = useSignageOpsQueue();
  const reviewMutation = useReviewSignage(stage);

  const [searchQuery, setSearchQuery] = useState('');
  const [regionFilter, setRegionFilter] = useState('all');
  const { data: districts } = useUgDistricts();
  const [statusFilter, setStatusFilter] = useState<string>(stage === 'coo' ? 'awaiting_coo' : 'all');

  // Modal states
  const [selectedSignage, setSelectedSignage] = useState<SignageListRecord | null>(null);
  const [isReviewOpen, setIsReviewOpen] = useState(false);

  // Review decision form
  const [reviewNote, setReviewNote] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [reviewAction, setReviewAction] = useState<'approve' | 'return' | 'reject'>('approve');


  // Filtering
  const filtered = signages.filter((s) => {
    const region = findUgDistrictByName(districts, s.district_name)?.region ?? '';
    const query = searchQuery.trim().toLowerCase();
    const matchesSearch =
      [s.property_name, s.reference_no, s.owner_phone, region, s.district_name,
        s.county_name, s.sub_county_name, s.parish_name, s.village_name,
        s.plot_or_landmark, s.nearby_landmarks]
        .some(value => (value ?? '').toLowerCase().includes(query));

    if (regionFilter !== 'all' && region !== regionFilter) return false;

    if (statusFilter === 'all') return matchesSearch;
    if (statusFilter === 'pending_review') {
      return matchesSearch && canReviewSignage(s.status, 'agent_ops');
    }
    if (statusFilter === 'approved') {
      return matchesSearch && s.status === 'awaiting_cfo';
    }
    if (statusFilter === 'active') {
      return matchesSearch && s.status === 'active';
    }
    return matchesSearch && s.status === statusFilter;
  });

  // Summary counts
  const totalActive = signages.filter((s) => s.status === 'active').length;
  const pendingReview = signages.filter((s) => canReviewSignage(s.status, stage)).length;
  const awaitingCoo = signages.filter((s) => s.status === 'awaiting_coo').length;
  const awaitingCfo = signages.filter((s) => s.status === 'awaiting_cfo').length;
  const monthlyCommitmentUgx = totalActive * SIGNAGE_RATES.OWNER_MONTHLY_UGX;

  // Review submission
  const handleConfirmReview = async () => {
    if (!selectedSignage) return;
    hapticTap();

    if (reviewAction === 'reject' && !rejectionReason.trim()) {
      toast.error('Please enter a rejection reason.');
      return;
    }
    if (stage === 'coo' && reviewAction !== 'approve' && (reviewAction === 'reject' ? rejectionReason : reviewNote).trim().length < 10) {
      toast.error('Please enter a reason of at least 10 characters.');
      return;
    }

    try {
      await reviewMutation.mutateAsync({
        signageId: selectedSignage.id,
        decision: reviewAction,
        notes: reviewNote.trim() || undefined,
        rejectionReason: rejectionReason.trim() || undefined,
      });
    } catch { return; }

    setIsReviewOpen(false);
    setSelectedSignage(null);
    setReviewNote('');
    setRejectionReason('');
  };

  return (
    <div className="space-y-4 w-full pb-16 font-sans">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-card p-4 rounded-2xl border border-border/60 shadow-sm">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} className="h-9 w-9 rounded-full">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Megaphone className="h-5 w-5 text-primary" />
              <h2 className="text-base font-bold text-foreground">{stage === 'coo' ? 'Welile Signages Approvals' : 'Welile Signages Operations'}</h2>
              <Badge variant="secondary" className="text-[10px] bg-primary/10 text-primary font-bold">
                {stage === 'coo' ? 'COO' : 'Agent Ops'}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {stage === 'coo' ? 'Awaiting COO approval' : 'Agent Ops review'}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="rounded-xl text-xs gap-1.5 h-9 shrink-0">
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          <span>Refresh</span>
        </Button>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div className="p-3.5 rounded-2xl bg-card border border-border/60 text-center">
          <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider block">{stage === 'coo' ? 'Awaiting COO' : 'Pending Review'}</span>
          <span className="text-lg font-bold text-amber-600">{pendingReview}</span>
        </div>
        <div className="p-3.5 rounded-2xl bg-card border border-border/60 text-center">
          <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider block">Awaiting CFO</span>
          <span className="text-lg font-bold text-primary">{awaitingCfo}</span>
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
            placeholder="Search property, reference, phone or any location..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-10 rounded-xl text-xs"
          />
        </div>
        {stage === 'agent_ops' && <Select value={regionFilter} onValueChange={setRegionFilter}>
          <SelectTrigger aria-label="Region" className="h-10 w-full rounded-xl text-xs sm:w-40"><SelectValue placeholder="All regions" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All regions</SelectItem>{UG_REGIONS.map(region => <SelectItem key={region} value={region}>{region}</SelectItem>)}</SelectContent>
        </Select>}
        <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0">
          {[
            { id: 'all', label: 'All' },
            ...(stage === 'agent_ops' ? [{ id: 'pending_review', label: `Pending (${pendingReview})` }] : []),
            { id: 'awaiting_coo', label: `Awaiting COO (${awaitingCoo})` },
            { id: 'awaiting_cfo', label: `Awaiting CFO (${awaitingCfo})` },
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
      ) : isError ? (
        <div role="alert" className="py-10 text-center bg-card border border-destructive/40 rounded-2xl p-6 text-xs text-destructive">
          Could not load signage applications: {(error as Error)?.message}. Tap Refresh to try again.
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
                        Ref: <span className="font-bold text-foreground">{item.reference_no}</span> • Agent: {item.agent_name || 'Agent'} ({item.agent_phone || 'N/A'})
                      </p>
                      {item.repeat_owner_phone && (
                        <Badge variant="destructive" className="mt-1 text-[10px]">Repeat owner phone — review</Badge>
                      )}
                      {item.nearby_signage_ref && (
                        <Badge variant="destructive" className="mt-1 ml-1 text-[10px]">
                          {item.nearby_signage_m} m from {item.nearby_signage_ref}: possible duplicate spot
                        </Badge>
                      )}
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
                      <span className="text-foreground">{item.gps_latitude?.toFixed(4)}, {item.gps_longitude?.toFixed(4)}</span>
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
                      <span>Photographic evidence</span>
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
                        <span>{item.status === 'active' ? 'View (read-only)' : 'Inspect & Decide'}</span>
                      </Button>

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
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl font-sans">
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
                  {selectedSignage.status === 'active'
                    ? 'This signage is active and read-only.'
                    : 'Inspect coordinates, photographs, owner consent, and commercial advertising visibility.'}
                </DialogDescription>
              </DialogHeader>

              {/* Photos Gallery */}
              <div>
                <Label className="text-xs font-semibold text-foreground mb-1.5 block">Photographic Evidence</Label>
                {isReviewOpen && <SignageEvidence signageId={selectedSignage.id} fullPhotoPreview={stage === 'agent_ops'} />}
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
                <p className="text-muted-foreground">
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
              {canReviewSignage(selectedSignage.status, stage) && <div className="space-y-3 pt-2 border-t border-border">
                <Label className="text-xs font-bold">{stage === 'coo' ? 'COO Decision' : 'Agent Ops Decision'}</Label>
                <div className="grid grid-cols-3 gap-2">
                  <Button
                    type="button"
                    variant={reviewAction === 'approve' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setReviewAction('approve')}
                    className="rounded-xl text-xs h-9"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1 text-emerald-500" />
                    {stage === 'coo' ? 'Send to CFO' : 'Send to COO'}
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
                      placeholder="Add a note for the CFO..."
                      value={reviewNote}
                      onChange={(e) => setReviewNote(e.target.value)}
                      className="mt-1 text-xs rounded-xl"
                    />
                  </div>
                )}
              </div>}

              <DialogFooter className="pt-2">
                <Button variant="ghost" size="sm" onClick={() => setIsReviewOpen(false)}>
                  Cancel
                </Button>
                {canReviewSignage(selectedSignage.status, stage) && <Button
                  size="sm"
                  onClick={handleConfirmReview}
                  disabled={reviewMutation.isPending}
                  className="rounded-xl text-xs font-bold"
                >
                  {reviewMutation.isPending ? 'Recording...' : 'Confirm Decision'}
                </Button>}
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

    </div>
  );
}
