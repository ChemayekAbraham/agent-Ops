import { useState, useEffect, useCallback, useRef } from 'react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { HandCoins, Loader2, User, Clock, CheckCircle2, Search, X, Plus } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { generateWelileAiId, normalizeAiId, isValidAiId } from '@/lib/welileAiId';
import { logLendingAudit } from '@/lib/lendingAudit';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import BorrowerResidenceGate, { isResidenceComplete } from './BorrowerResidenceGate';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenLendingPortal?: () => void;
}

interface Offer {
  id: string;
  lender_agent_id: string;
  lender_display_name: string | null;
  lender_ai_id: string | null;
  title: string;
  description: string | null;
  min_amount_ugx: number;
  max_amount_ugx: number;
  interest_rate_pct: number;
  min_duration_days: number;
  max_duration_days: number;
  active: boolean;
}

export default function BorrowLoanSheet({ open, onOpenChange, onOpenLendingPortal }: Props) {
  const { user } = useAuth();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const pageRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [myRequests, setMyRequests] = useState<any[]>([]);
  const [me, setMe] = useState<{ full_name: string | null; phone: string | null } | null>(null);
  const [showOwnOffers, setShowOwnOffers] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'published' | 'draft'>('published');

  // Request form state
  const [activeOffer, setActiveOffer] = useState<Offer | null>(null);
  const [amount, setAmount] = useState('');
  const [duration, setDuration] = useState('');
  const [purpose, setPurpose] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Direct request by lender AI ID
  const [lenderAiInput, setLenderAiInput] = useState('');

  // Residence profile gate (landlord + GPS + LC1) — required before requesting
  const [residenceComplete, setResidenceComplete] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const pendingActionRef = useRef<null | (() => void)>(null);

  const myAiId = user ? generateWelileAiId(user.id) : null;
  const PAGE_SIZE = 20;

  const reloadRequests = useCallback(async () => {
    if (!user) return;
    const { data } = await (supabase
      .from('lending_loan_requests' as any)
      .select('*')
      .eq('borrower_user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50) as any);
    if (data) setMyRequests(data);
  }, [user]);

  const loadOffers = useCallback(async (reset: boolean) => {
    if (!user) return;
    const page = reset ? 0 : pageRef.current;
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    if (reset) setLoading(true); else setLoadingMore(true);
    let query = (supabase
      .from('lending_agent_offers' as any)
      .select('*'));
    if (statusFilter !== 'all') {
      query = (query as any).eq('active', statusFilter === 'published');
    }
    if (!showOwnOffers) {
      query = (query as any).neq('lender_agent_id', user.id);
    }
    const { data } = await (query
      .order('created_at', { ascending: false })
      .range(from, to) as any);
    const rows = (data as Offer[]) ?? [];
    setOffers((prev) => (reset ? rows : [...prev, ...rows]));
    setHasMore(rows.length === PAGE_SIZE);
    pageRef.current = page + 1;
    if (reset) setLoading(false); else setLoadingMore(false);
  }, [user, showOwnOffers, statusFilter]);

  useEffect(() => {
    if (!open || !user) return;
    pageRef.current = 0;
    setHasMore(true);
    loadOffers(true);
    (async () => {
      const { data: prof } = await (supabase
        .from('profiles')
        .select('full_name, phone, borrower_landlord_id, borrower_lc1_id')
        .eq('id', user.id)
        .maybeSingle() as any);
      setMe({ full_name: prof?.full_name ?? null, phone: prof?.phone ?? null });
      await refreshResidence(prof);
      reloadRequests();
    })();
  }, [open, user, reloadRequests, loadOffers]);

  // Re-check the borrower's residence profile completeness (landlord w/ GPS + LC1)
  const refreshResidence = useCallback(async (prof?: any) => {
    if (!user) { setResidenceComplete(false); return; }
    let p = prof;
    if (!p) {
      const { data } = await (supabase
        .from('profiles')
        .select('borrower_landlord_id, borrower_lc1_id')
        .eq('id', user.id)
        .maybeSingle() as any);
      p = data;
    }
    if (!p?.borrower_landlord_id || !p?.borrower_lc1_id) { setResidenceComplete(false); return; }
    const { data: ll } = await (supabase
      .from('landlords_directory')
      .select('id, latitude, longitude, verified, verification_status, verification_reason, name, phone, property_address, village, district, registered_by')
      .eq('id', p.borrower_landlord_id)
      .maybeSingle() as any);
    const { data: chair } = await (supabase
      .from('lc1_chairpersons')
      .select('id, name, phone, verified, verification_status, verification_reason, village')
      .eq('id', p.borrower_lc1_id)
      .maybeSingle() as any);
    setResidenceComplete(isResidenceComplete(ll ?? null, chair ?? null));
  }, [user]);

  // Run `action` only when the residence profile is complete; otherwise open the gate.
  const requireResidence = (action: () => void) => {
    if (residenceComplete) { action(); return; }
    pendingActionRef.current = action;
    setGateOpen(true);
  };

  // Infinite scroll: load the next page when the sentinel enters view
  useEffect(() => {
    if (!open || activeOffer) return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && hasMore && !loading && !loadingMore) {
        loadOffers(false);
      }
    }, { rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, activeOffer, hasMore, loading, loadingMore, loadOffers]);

  const openRequest = (offer: Offer) => {
    requireResidence(() => {
      setActiveOffer(offer);
      setAmount(String(offer.min_amount_ugx));
      setDuration(String(offer.min_duration_days));
      setPurpose('');
    });
  };

  const submitRequest = async (opts: { offer?: Offer | null; lenderAgentId?: string; rate?: number | null }) => {
    if (!user) return;
    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0) { toast.error('Enter a valid amount'); return; }
    const lenderAgentId = opts.offer?.lender_agent_id ?? opts.lenderAgentId;
    if (!lenderAgentId) { toast.error('Could not identify the lending agent'); return; }
    if (lenderAgentId === user.id) { toast.error("You can't request a loan from yourself"); return; }

    setSubmitting(true);
    const { data: inserted, error } = await (supabase.from('lending_loan_requests' as any).insert({
      borrower_user_id: user.id,
      lender_agent_id: lenderAgentId,
      offer_id: opts.offer?.id ?? null,
      borrower_ai_id: myAiId,
      borrower_display_name: me?.full_name ?? null,
      borrower_phone: me?.phone ?? null,
      requested_amount_ugx: amountNum,
      requested_duration_days: duration ? Number(duration) : null,
      interest_rate_pct: opts.offer?.interest_rate_pct ?? opts.rate ?? null,
      purpose: purpose.trim() || null,
      status: 'pending',
    }).select('id').single() as any);
    setSubmitting(false);
    if (error) { toast.error('Could not send request: ' + error.message); return; }
    toast.success('Loan request sent — the lending agent will review it');
    await logLendingAudit({
      actorId: user.id,
      actorDisplayName: me?.full_name ?? null,
      actionType: 'request_created',
      entityType: 'request',
      entityId: inserted?.id ?? null,
      borrowerUserId: user.id,
      lenderAgentId: lenderAgentId,
      amountUgx: amountNum,
      newStatus: 'pending',
      details: { offer_id: opts.offer?.id ?? null, purpose: purpose.trim() || null },
    });
    setActiveOffer(null);
    setLenderAiInput('');
    setAmount(''); setDuration(''); setPurpose('');
    reloadRequests();
  };

  const handleDirectRequest = async () => {
    const cleaned = normalizeAiId(lenderAiInput);
    if (!isValidAiId(cleaned)) { toast.error('Enter a valid AI ID e.g. WEL-AB12CD'); return; }
    // Resolve AI ID -> user via public trust profile RPC
    const { data, error } = await (supabase.rpc('get_public_trust_profile', { p_ai_id: cleaned }) as any);
    const profile = data as any;
    if (error || !profile || profile.error || !profile.user_id) {
      toast.error('No user found for that AI ID');
      return;
    }
    setAmount(''); setDuration(''); setPurpose('');
    // Open a generic request form by setting a synthetic active offer
    requireResidence(() => setActiveOffer({
      id: '',
      lender_agent_id: profile.user_id,
      lender_display_name: profile.identity?.full_name ?? cleaned,
      lender_ai_id: cleaned,
      title: `Loan request to ${profile.identity?.full_name ?? cleaned}`,
      description: null,
      min_amount_ugx: 0,
      max_amount_ugx: 0,
      interest_rate_pct: 0,
      min_duration_days: 1,
      max_duration_days: 365,
      active: true,
    }));
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[94vh] overflow-y-auto rounded-t-2xl px-4 pb-8 pt-5">
        <BorrowerResidenceGate
          open={gateOpen}
          onOpenChange={setGateOpen}
          onComplete={() => {
            setResidenceComplete(true);
            const action = pendingActionRef.current;
            pendingActionRef.current = null;
            refreshResidence();
            action?.();
          }}
        />
        <div className="flex items-center gap-2.5 mb-4">
          <div className="h-9 w-9 rounded-full bg-gradient-to-br from-primary to-emerald-500 flex items-center justify-center">
            <HandCoins className="h-4 w-4 text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-foreground tracking-tight">Borrow from a Lending Agent</p>
            <p className="text-[10px] text-muted-foreground">Browse offers or request a specific agent</p>
          </div>
        </div>

        {/* Request form */}
        {activeOffer ? (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-4">
            <Card className="border-primary/30">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-sm">{activeOffer.title}</CardTitle>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setActiveOffer(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </CardHeader>
              <CardContent className="space-y-2 pt-0">
                {activeOffer.max_amount_ugx > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    Range {formatUGX(activeOffer.min_amount_ugx)} – {formatUGX(activeOffer.max_amount_ugx)} · {activeOffer.interest_rate_pct}% · {activeOffer.min_duration_days}-{activeOffer.max_duration_days} days
                  </p>
                )}
                <div>
                  <Label className="text-xs">Amount (UGX) *</Label>
                  <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-9 text-sm" placeholder="100000" />
                </div>
                <div>
                  <Label className="text-xs">Duration (days)</Label>
                  <Input type="number" value={duration} onChange={(e) => setDuration(e.target.value)} className="h-9 text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Purpose</Label>
                  <Textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} className="text-sm resize-none" placeholder="What is the loan for?" />
                </div>
                <Button size="sm" className="w-full" disabled={submitting} onClick={() => submitRequest({ offer: activeOffer.id ? activeOffer : null, lenderAgentId: activeOffer.lender_agent_id, rate: activeOffer.interest_rate_pct })}>
                  {submitting && <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />}
                  Send Loan Request
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        ) : (
          <>
            {/* Direct request by AI ID */}
            <div className="space-y-2 mb-4">
              <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Request a specific agent (AI ID)</Label>
              <div className="flex gap-2">
                <Input value={lenderAiInput} onChange={(e) => setLenderAiInput(e.target.value.toUpperCase())} placeholder="WEL-XXXXXX" className="h-10 text-sm font-mono" onKeyDown={(e) => e.key === 'Enter' && handleDirectRequest()} />
                <Button onClick={handleDirectRequest} className="h-10"><Search className="h-4 w-4" /></Button>
              </div>
            </div>

            {/* Offers list */}
            <div className="space-y-2 mb-4">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Available Loan Offers</Label>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">Show my offers</span>
                  <Switch checked={showOwnOffers} onCheckedChange={setShowOwnOffers} className="scale-75" />
                </div>
              </div>
              <div className="flex items-center justify-end">
                <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as 'all' | 'published' | 'draft')}>
                  <SelectTrigger className="h-8 w-[132px] text-xs bg-background">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="published">Published</SelectItem>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="all">All</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {loading ? (
                <Skeleton className="h-24 w-full rounded-xl" />
              ) : offers.length === 0 ? (
                <Card className="border-dashed">
                  <CardContent className="p-6 text-center space-y-2">
                    {showOwnOffers ? (
                      <>
                        <p className="text-xs text-muted-foreground">
                          {statusFilter === 'published'
                            ? "You have no published loan offers yet. Turn the toggle off to browse other agents’ offers, or publish your own."
                            : statusFilter === 'draft'
                            ? "You have no draft loan offers. Drafts are only visible to you."
                            : "You haven’t created any loan offers yet."}
                        </p>
                        {statusFilter !== 'draft' && onOpenLendingPortal && (
                          <Button size="sm" className="h-9 text-xs font-bold" onClick={onOpenLendingPortal}>
                            <Plus className="h-3.5 w-3.5 mr-1.5" />
                            Create your first offer
                          </Button>
                        )}
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {statusFilter === 'published'
                          ? "No published loan offers available right now. Try requesting an agent by AI ID above."
                          : statusFilter === 'draft'
                          ? "No draft loan offers are visible. Drafts are only visible to their creators."
                          : "No loan offers available right now. Try requesting an agent by AI ID above."}
                      </p>
                    )}
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-2">
                  {offers.map((offer) => {
                    const isOwnOffer = offer.lender_agent_id === user?.id;
                    return (
                      <Card key={offer.id} className="border-border/60">
                        <CardContent className="p-3">
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-sm font-bold truncate">{offer.title}</p>
                            <div className="flex items-center gap-1.5">
                              {isOwnOffer && (
                                <Badge className="bg-primary/15 text-primary border-0 text-[9px] font-bold">Yours</Badge>
                              )}
                              {!offer.active && (
                                <Badge className="bg-amber-500/15 text-amber-700 border-0 text-[9px] font-bold">Draft</Badge>
                              )}
                              <Badge className="bg-emerald-500/15 text-emerald-700 border-0 text-[9px] font-bold">{offer.interest_rate_pct}%</Badge>
                            </div>
                          </div>
                          {offer.description && <p className="text-[11px] text-muted-foreground mb-1 line-clamp-2">{offer.description}</p>}
                          <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                            <User className="h-3 w-3" /> {offer.lender_display_name ?? offer.lender_ai_id ?? 'Lending agent'}
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            {formatUGX(offer.min_amount_ugx)} – {formatUGX(offer.max_amount_ugx)} · {offer.min_duration_days}-{offer.max_duration_days} days
                          </p>
                          <Button
                            size="sm"
                            className="w-full mt-2 h-9 text-xs font-bold"
                            disabled={isOwnOffer}
                            onClick={() => openRequest(offer)}
                          >
                            <HandCoins className="h-3.5 w-3.5 mr-1.5" />
                            {isOwnOffer ? 'Your own offer' : 'Borrow this offer'}
                          </Button>
                        </CardContent>
                      </Card>
                    );
                  })}
                  {/* Infinite-scroll sentinel + loader */}
                  <div ref={sentinelRef} className="h-1 w-full" />
                  {loadingMore && (
                    <div className="flex justify-center py-3">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  )}
                  {!hasMore && offers.length > 0 && (
                    <p className="text-center text-[10px] text-muted-foreground py-2">You've reached the end · {offers.length} offers</p>
                  )}
                </div>
              )}
            </div>

            {/* My requests */}
            <div className="space-y-2">
              <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">My Requests</Label>
              {myRequests.length === 0 ? (
                <p className="text-xs text-muted-foreground">No requests yet.</p>
              ) : (
                myRequests.map((req) => {
                  const statusColor =
                    req.status === 'approved' ? 'bg-emerald-500/15 text-emerald-700' :
                    req.status === 'declined' ? 'bg-destructive/15 text-destructive' :
                    'bg-amber-500/15 text-amber-700';
                  return (
                    <Card key={req.id} className="border-border/60">
                      <CardContent className="p-3 flex items-center justify-between">
                        <div>
                          <p className="text-sm font-bold">{formatUGX(req.requested_amount_ugx)}</p>
                          <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                            {req.status === 'approved' ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                            {new Date(req.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <Badge className={`${statusColor} border-0 text-[9px] font-bold capitalize`}>{req.status}</Badge>
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}