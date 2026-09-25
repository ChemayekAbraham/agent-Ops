import { useState, useEffect } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { getEffectiveRentRequestAmounts } from '@/lib/rentRequestAmounts';
import { VerifyTenantButton, VerifyLandlordButton } from '@/components/verification';
import {
  FileText, User, Building, MapPin, Calendar, Banknote,
  Clock, CheckCircle, XCircle, Shield, ShieldCheck, RefreshCw,
  ExternalLink, ChevronDown, ChevronUp, FileDown, MessageCircle, Loader2, Trash2,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { format, eachDayOfInterval, startOfDay, isSameDay } from 'date-fns';
import { hapticTap } from '@/lib/haptics';
import { motion, AnimatePresence } from 'framer-motion';
import { downloadRepaymentPdf, shareRepaymentPdfWhatsApp } from '@/lib/repaymentSchedulePdf';
import { useToast } from '@/hooks/use-toast';
import { AgentRejectedRequestsSection } from './AgentRejectedRequestsSection';

interface AgentRentRequest {
  id: string;
  rent_amount: number;
  total_repayment: number;
  amount_repaid: number | null;
  duration_days: number;
  daily_repayment: number;
  status: string | null;
  created_at: string;
  tenant_id: string;
  landlord_id: string;
  agent_id?: string | null;
  house_listing_id?: string | null;
  registration_type?: string | null;
  initial_outstanding_balance?: number | null;
  outstanding_grace_days?: number | null;
  agent_verified: boolean | null;
  manager_verified: boolean | null;
  request_latitude: number | null;
  request_longitude: number | null;
  request_city: string | null;
  request_country: string | null;
  tenant?: { full_name: string; phone: string; city: string | null } | null;
  landlord?: {
    id: string;
    name: string;
    property_address: string;
    verified: boolean | null;
    ready_to_receive: boolean | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
}

interface AgentMyRentRequestsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Build projected schedule days (no actual repayment data)
function buildScheduleDays(createdAt: string, durationDays: number) {
  const start = startOfDay(new Date(createdAt));
  const end = new Date(start);
  end.setDate(end.getDate() + durationDays - 1);
  const today = startOfDay(new Date());
  const allDays = eachDayOfInterval({ start, end });
  return allDays.map((day, i) => ({
    day: i + 1,
    date: day,
    status: (isSameDay(day, today) ? 'today' : day < today ? 'missed' : 'upcoming') as 'today' | 'missed' | 'upcoming',
    expected: 0,
    paid: 0,
  }));
}

export function AgentMyRentRequestsSheet({ open, onOpenChange }: AgentMyRentRequestsSheetProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [requests, setRequests] = useState<AgentRentRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedSchedule, setExpandedSchedule] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<AgentRentRequest | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  useEffect(() => {
    if (open && user) fetchRequests();
  }, [open, user]);

  const fetchRequests = async () => {
    if (!user) return;
    if (!loading) setRefreshing(true);

    const { data, error } = await supabase
      .from('rent_requests')
      .select('id, rent_amount, total_repayment, amount_repaid, duration_days, daily_repayment, status, created_at, tenant_id, landlord_id, agent_id, house_listing_id, registration_type, initial_outstanding_balance, outstanding_grace_days, agent_verified, manager_verified, request_latitude, request_longitude, request_city, request_country')
      .or(`agent_id.eq.${user.id},agent_verified_by.eq.${user.id}`)
      .neq('status', 'deleted_by_agent')
      .order('created_at', { ascending: false });

    if (error) {
      setLoading(false);
      setRefreshing(false);
      return;
    }

    const rows = data || [];
    const tenantIds = [...new Set(rows.map(r => r.tenant_id))];
    const landlordIds = [...new Set(rows.map(r => r.landlord_id))];

    const [{ data: profiles }, { data: landlords }] = await Promise.all([
      tenantIds.length > 0
        ? supabase.from('profiles').select('id, full_name, phone, city').in('id', tenantIds)
        : Promise.resolve({ data: [] as any[] }),
      landlordIds.length > 0
        ? supabase.from('landlords').select('id, name, property_address, verified, ready_to_receive, latitude, longitude').in('id', landlordIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);

    const enriched: AgentRentRequest[] = rows.map(r => {
      const effective = getEffectiveRentRequestAmounts(r as AgentRentRequest);
      return {
        ...r,
        total_repayment: effective.totalRepayment,
        daily_repayment: effective.dailyRepayment,
        tenant: profiles?.find((p: any) => p.id === r.tenant_id) || null,
        landlord: landlords?.find((l: any) => l.id === r.landlord_id) || null,
      };
    });

    setRequests(enriched);
    setLoading(false);
    setRefreshing(false);
  };

  const buildPdfData = (req: AgentRentRequest) => ({
    tenantName: req.tenant?.full_name || 'Tenant',
    phone: req.tenant?.phone,
    propertyAddress: req.landlord?.property_address,
    landlordName: req.landlord?.name,
    rentAmount: req.rent_amount,
    totalRepayment: req.total_repayment,
    dailyRepayment: req.daily_repayment,
    durationDays: req.duration_days,
    status: req.status || 'pending',
    paidAmount: 0,
    startDate: req.created_at,
    schedule: buildScheduleDays(req.created_at, req.duration_days),
  });

  const handleDownloadPdf = async (req: AgentRentRequest) => {
    setPdfLoading(req.id);
    try {
      await downloadRepaymentPdf(buildPdfData(req));
      toast({ title: 'PDF Downloaded', description: 'Repayment schedule saved.' });
    } catch {
      toast({ title: 'Error', description: 'Could not generate PDF.', variant: 'destructive' });
    } finally {
      setPdfLoading(null);
    }
  };

  const handleWhatsApp = (req: AgentRentRequest) => {
    shareRepaymentPdfWhatsApp(buildPdfData(req), req.tenant?.phone);
  };

  // An agent may cancel/delete a request they own only before any money has
  // moved (i.e. not funded/disbursed/completed). Ownership = agent_id is them.
  const canCancel = (req: AgentRentRequest) =>
    !!user &&
    req.agent_id === user.id &&
    ['pending', 'approved', 'rejected'].includes(req.status || '');

  const handleCancel = async () => {
    if (!cancelTarget || !user) return;
    if (cancelReason.trim().length < 10) {
      toast({
        title: 'Reason required',
        description: 'Please give at least 10 characters explaining why you are cancelling.',
        variant: 'destructive',
      });
      return;
    }
    setCancelling(true);
    try {
      const { error } = await (supabase as any).rpc('agent_cancel_rent_request', {
        p_request_id: cancelTarget.id,
        p_reason: cancelReason.trim(),
      });
      if (error) throw error;

      setRequests(prev => prev.filter(r => r.id !== cancelTarget.id));
      toast({ title: 'Request cancelled', description: 'The rent request has been removed.' });
      setCancelTarget(null);
      setCancelReason('');
    } catch (e: any) {
      toast({
        title: 'Could not cancel',
        description: e?.message || 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setCancelling(false);
    }
  };

  const getStatusBadge = (status: string | null) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="bg-warning/10 text-warning border-warning/30 gap-1"><Clock className="h-3 w-3" />Pending</Badge>;
      case 'approved':
        return <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30 gap-1"><CheckCircle className="h-3 w-3" />Approved</Badge>;
      case 'funded':
      case 'disbursed':
        return <Badge variant="outline" className="bg-success/10 text-success border-success/30 gap-1"><Banknote className="h-3 w-3" />Funded</Badge>;
      case 'completed':
        return <Badge className="bg-success text-success-foreground gap-1"><CheckCircle className="h-3 w-3" />Done</Badge>;
      case 'rejected':
        return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />Rejected</Badge>;
      default:
        return <Badge variant="secondary">{status || 'Unknown'}</Badge>;
    }
  };

  // Defensive: only show "Done" when the rent has actually been fully repaid.
  const getStatusBadgeForRequest = (req: { status: string | null; amount_repaid?: number | null; total_repayment?: number | null }) => {
    if (req.status === 'completed') {
      const repaid = Number(req.amount_repaid ?? 0);
      const total = Number(req.total_repayment ?? 0);
      if (total > 0 && repaid < total) {
        return <Badge variant="outline" className="bg-chart-5/10 text-chart-5 border-chart-5/30 gap-1"><Banknote className="h-3 w-3" />Active</Badge>;
      }
    }
    return getStatusBadge(req.status);
  };

  const openGoogleMaps = (lat: number, lng: number) => {
    window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank');
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[90vh] rounded-t-2xl p-0 flex flex-col"
        onPointerDownOutside={(e) => {
          // Nested Radix Dialog/AlertDialog (e.g. AgentEditRentRequestDialog,
          // the delete confirmation) portals to <body>. On Android, the same
          // tap that opens the inner overlay also fires a pointerdown on this
          // Sheet which Radix interprets as "outside" and closes Submissions,
          // dumping the user back to the agent dashboard.
          const target = e.target as HTMLElement | null;
          if (target?.closest('[role="dialog"], [role="alertdialog"]')) {
            e.preventDefault();
          }
        }}
        onInteractOutside={(e) => {
          const target = e.target as HTMLElement | null;
          if (target?.closest('[role="dialog"], [role="alertdialog"]')) {
            e.preventDefault();
          }
        }}
      >
        <SheetHeader className="p-4 pb-2 border-b">
          <div className="flex items-center justify-between">
            <SheetTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              My Rent Requests
            </SheetTitle>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => { hapticTap(); fetchRequests(); }}
              disabled={refreshing}
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Requests you posted · Verify tenant, landlord &amp; location
          </p>
        </SheetHeader>

        <ScrollArea className="flex-1 px-4 py-3">
          <div className="mb-4">
            <AgentRejectedRequestsSection />
          </div>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-48 w-full rounded-xl" />)}
            </div>
          ) : requests.length === 0 ? (
            <p className="text-center text-muted-foreground py-12">No rent requests posted yet</p>
          ) : (
            <AnimatePresence>
              <div className="space-y-4 pb-6">
                {requests.map((req, idx) => (
                  <motion.div
                    key={req.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.04 }}
                  >
                    <Card className="border-border/60 overflow-hidden">
                      <CardContent className="p-0">
                        {/* Header with status */}
                        <div className="flex items-center justify-between p-4 pb-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <User className="h-4 w-4 text-primary shrink-0" />
                            <span className="font-semibold truncate">
                              {req.tenant?.full_name || 'Unknown Tenant'}
                            </span>
                          </div>
                          {getStatusBadgeForRequest(req)}
                        </div>

                        {/* Landlord verification status banner */}
                        {req.landlord?.verified ? (
                          <div className="mx-4 mb-1 flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
                            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                            <span className="font-medium">Landlord verified</span>
                          </div>
                        ) : (
                          <div className="mx-4 mb-1 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                            <span className="font-medium">Landlord verification pending</span>
                          </div>
                        )}

                        {/* Details */}
                        <div className="px-4 pb-3 space-y-1 text-sm text-muted-foreground">
                          <div className="flex items-center gap-2">
                            <Banknote className="h-3.5 w-3.5 shrink-0" />
                            <span className="font-bold text-foreground">{formatUGX(req.rent_amount)}</span>
                            <span>· {req.duration_days} days</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Building className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{req.landlord?.name || 'Unknown Landlord'}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <MapPin className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{req.landlord?.property_address || 'No address'}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Calendar className="h-3.5 w-3.5 shrink-0" />
                            <span>{format(new Date(req.created_at), 'MMM d, yyyy h:mm a')}</span>
                          </div>
                        </div>

                        {/* ═══ REPAYMENT SCHEDULE ═══ */}
                        <div className="border-t">
                          <button
                            onClick={() => setExpandedSchedule(expandedSchedule === req.id ? null : req.id)}
                            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors"
                          >
                            <div className="flex items-center gap-2">
                              <Calendar className="h-4 w-4 text-primary" />
                              <span>Repayment Schedule</span>
                              <Badge variant="outline" className="text-xs">
                                {formatUGX(req.daily_repayment)}/day
                              </Badge>
                            </div>
                            {expandedSchedule === req.id
                              ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                              : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                          </button>

                          <AnimatePresence>
                            {expandedSchedule === req.id && (
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden"
                              >
                                <div className="px-4 pb-4 space-y-3">
                                  {/* Summary */}
                                  <div className="grid grid-cols-3 gap-2 text-center">
                                    <div className="p-2 rounded-lg bg-muted/50">
                                      <p className="text-xs text-muted-foreground">Rent</p>
                                      <p className="text-sm font-bold">{formatUGX(req.rent_amount)}</p>
                                    </div>
                                    <div className="p-2 rounded-lg bg-muted/50">
                                      <p className="text-xs text-muted-foreground">Total Due</p>
                                      <p className="text-sm font-bold">{formatUGX(req.total_repayment)}</p>
                                    </div>
                                    <div className="p-2 rounded-lg bg-primary/10">
                                      <p className="text-xs text-muted-foreground">Daily</p>
                                      <p className="text-sm font-bold text-primary">{formatUGX(req.daily_repayment)}</p>
                                    </div>
                                  </div>

                                  {/* Mini schedule table */}
                                  <div className="rounded-lg border overflow-hidden">
                                    <div className="grid grid-cols-3 bg-muted px-3 py-1.5 text-xs font-semibold text-muted-foreground">
                                      <span>Day</span>
                                      <span>Date</span>
                                      <span className="text-right">Amount</span>
                                    </div>
                                    <div className="divide-y max-h-48 overflow-y-auto">
                                      {Array.from({ length: Math.min(req.duration_days, 10) }, (_, i) => {
                                        const day = new Date(req.created_at);
                                        day.setDate(day.getDate() + i);
                                        return (
                                          <div key={i} className="grid grid-cols-3 px-3 py-1.5 text-xs">
                                            <span className="text-muted-foreground">Day {i + 1}</span>
                                            <span>{format(day, 'MMM d, yyyy')}</span>
                                            <span className="text-right font-medium">{formatUGX(req.daily_repayment)}</span>
                                          </div>
                                        );
                                      })}
                                      {req.duration_days > 10 && (
                                        <div className="px-3 py-1.5 text-xs text-center text-muted-foreground italic">
                                          +{req.duration_days - 10} more days — download PDF for full schedule
                                        </div>
                                      )}
                                    </div>
                                  </div>

                                  {/* PDF + WhatsApp */}
                                  <div className="grid grid-cols-2 gap-2">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="gap-2 text-xs"
                                      disabled={pdfLoading === req.id}
                                      onClick={() => handleDownloadPdf(req)}
                                    >
                                      {pdfLoading === req.id
                                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        : <FileDown className="h-3.5 w-3.5" />}
                                      Download PDF
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="gap-2 text-xs text-success border-success/30 hover:bg-success/10"
                                      onClick={() => handleWhatsApp(req)}
                                    >
                                      <MessageCircle className="h-3.5 w-3.5" />
                                      WhatsApp
                                    </Button>
                                  </div>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>

                        {/* ═══ VERIFICATION SECTION ═══ */}
                        <div className="border-t bg-muted/30 p-4 space-y-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                            <Shield className="h-3.5 w-3.5" />
                            Verification Checklist
                          </p>

                          {/* 1. Tenant */}
                          <div className="flex items-center justify-between p-3 rounded-lg border bg-background">
                            <div className="flex items-center gap-2 text-sm">
                              <User className="h-4 w-4 text-primary" />
                              <span className="font-medium">Tenant</span>
                            </div>
                            <VerifyTenantButton
                              requestId={req.id}
                              landlordId={req.landlord_id}
                              agentVerified={req.agent_verified ?? false}
                              managerVerified={req.manager_verified ?? false}
                              onVerified={fetchRequests}
                              variant="agent"
                            />
                          </div>

                          {/* 2. Landlord */}
                          <div className="flex items-center justify-between p-3 rounded-lg border bg-background">
                            <div className="flex items-center gap-2 text-sm">
                              <Building className="h-4 w-4 text-amber-600" />
                              <span className="font-medium">Landlord</span>
                            </div>
                            <VerifyLandlordButton
                              landlordId={req.landlord_id}
                              landlordName={req.landlord?.name || 'Unknown'}
                              verified={req.landlord?.verified ?? false}
                              readyToReceive={req.landlord?.ready_to_receive ?? false}
                              onVerified={fetchRequests}
                            />
                          </div>

                          {/* 3. Location */}
                          <div className="p-3 rounded-lg border bg-background space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2 text-sm">
                                <MapPin className="h-4 w-4 text-success" />
                                <span className="font-medium">Location</span>
                              </div>
                              {req.request_latitude && req.request_longitude ? (
                                <Badge variant="outline" className="bg-success/10 text-success border-success/30 gap-1">
                                  <CheckCircle className="h-3 w-3" />
                                  Captured
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="bg-warning/10 text-warning border-warning/30 gap-1">
                                  <Clock className="h-3 w-3" />
                                  Not captured
                                </Badge>
                              )}
                            </div>

                            {req.request_city && (
                              <p className="text-xs text-muted-foreground">
                                📍 {req.request_city}{req.request_country ? `, ${req.request_country}` : ''}
                              </p>
                            )}

                            {req.request_latitude && req.request_longitude && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="w-full gap-2 text-xs"
                                onClick={() => openGoogleMaps(req.request_latitude!, req.request_longitude!)}
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                                View on Google Maps
                              </Button>
                            )}

                            {req.landlord?.latitude && req.landlord?.longitude && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="w-full gap-2 text-xs text-muted-foreground"
                                onClick={() => openGoogleMaps(req.landlord!.latitude!, req.landlord!.longitude!)}
                              >
                                <Building className="h-3.5 w-3.5" />
                                Landlord Property Location
                              </Button>
                            )}
                          </div>

                          {req.manager_verified && (
                            <div className="flex items-center gap-2 text-xs text-primary">
                              <ShieldCheck className="h-3.5 w-3.5" />
                              <span className="font-medium">Manager verified</span>
                            </div>
                          )}
                        </div>

                        {/* ═══ CANCEL / DELETE ═══ */}
                        {canCancel(req) && (
                          <div className="border-t p-4">
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full gap-2 text-xs text-destructive border-destructive/30 hover:bg-destructive/10"
                              onClick={() => { hapticTap(); setCancelTarget(req); }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {req.status === 'rejected' ? 'Delete Request' : 'Cancel Request'}
                            </Button>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </div>
            </AnimatePresence>
          )}
        </ScrollArea>
      </SheetContent>

      <AlertDialog
        open={!!cancelTarget}
        onOpenChange={(o) => { if (!o && !cancelling) { setCancelTarget(null); setCancelReason(''); } }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this rent request?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelTarget?.tenant?.full_name
                ? `This will remove the rent request for ${cancelTarget.tenant.full_name}. `
                : 'This will remove the rent request. '}
              A reason is required and is recorded against your name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Why are you cancelling? e.g. duplicate submission, wrong rent amount captured…"
              rows={3}
              disabled={cancelling}
            />
            <p className="text-xs text-muted-foreground">
              {cancelReason.trim().length}/10 characters minimum
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelling}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleCancel(); }}
              disabled={cancelling || cancelReason.trim().length < 10}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 gap-2"
            >
              {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Yes, cancel
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
