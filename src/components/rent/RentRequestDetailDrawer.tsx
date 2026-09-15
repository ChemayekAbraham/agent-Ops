import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Loader2, User, Phone, MapPin, Home, Calendar, Clock, Receipt, ArrowDownLeft, ArrowUpRight, Copy, Building, Navigation, Share2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { format, addDays } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { TenantPaymentHistoryCard } from '@/components/executive/TenantPaymentHistoryCard';
import { LandlordAgreementHistory } from '@/components/landlord/agreement';

interface RentRequestDetailDrawerProps {
  requestId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface FullRequestDetail {
  id: string;
  rent_amount: number;
  duration_days: number;
  status: string;
  approved_at: string | null;
  created_at: string;
  house_category: string | null;
  request_city: string | null;
  request_country: string | null;
  access_fee: number;
  request_fee: number;
  total_repayment: number;
  daily_repayment: number;
  amount_repaid: number;
  funded_at: string | null;
  disbursed_at: string | null;
  number_of_payments: number | null;
  tenant_id: string;
  agent_id: string | null;
  supporter_id: string | null;
  landlord_id: string;
  request_latitude: number | null;
  request_longitude: number | null;
  tenant_electricity_meter: string | null;
  tenant_water_meter: string | null;
  tenant_no_smartphone: boolean;
  approval_comment: string | null;
  rejected_reason: string | null;
  schedule_status: string | null;
  /* Everything below was captured at submission time and is what a reviewer
     needs when a request has sat unattended and expired. */
  repayment_frequency: string | null;
  repayment_starts_on: string | null;
  assigned_agent_id: string | null;
  house_listing_id: string | null;
  tenant_photo_url: string | null;
  house_image_urls: string[] | null;
  latest_rent_receipt_url: string | null;
  latest_rent_receipt_uploaded_at: string | null;
}

interface ProfileInfo {
  full_name: string;
  phone: string;
  email: string;
  /** The tenant's own residence, assembled the same way the funder view does. */
  residence?: string | null;
}

interface LandlordInfo {
  name: string;
  phone: string;
  property_address: string;
  mobile_money_number: string | null;
  mobile_money_name: string | null;
}

interface RepaymentEntry {
  id: string;
  amount: number;
  created_at: string;
}

interface LedgerEntry {
  id: string;
  amount: number;
  direction: string;
  category: string;
  description: string | null;
  transaction_date: string;
  reference_id: string | null;
}

export function RentRequestDetailDrawer({ requestId, open, onOpenChange }: RentRequestDetailDrawerProps) {
  const [loading, setLoading] = useState(true);
  const [request, setRequest] = useState<FullRequestDetail | null>(null);
  const [tenant, setTenant] = useState<ProfileInfo | null>(null);
  const [agent, setAgent] = useState<ProfileInfo | null>(null);
  const [supporter, setSupporter] = useState<ProfileInfo | null>(null);
  const [landlord, setLandlord] = useState<LandlordInfo | null>(null);
  const [repayments, setRepayments] = useState<RepaymentEntry[]>([]);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);

  useEffect(() => {
    if (!requestId || !open) return;
    setLoading(true);

    const fetchAll = async () => {
      // Fetch the full rent request
      const { data: req } = await supabase
        .from('rent_requests')
        .select('*')
        .eq('id', requestId)
        .single();

      if (!req) { setLoading(false); return; }
      setRequest(req as any);

      // Fetch related data in parallel
      const profileIds = [req.tenant_id, req.agent_id, req.supporter_id].filter(Boolean) as string[];

      const [profilesRes, landlordRes, repaymentsRes, ledgerRes] = await Promise.all([
        profileIds.length > 0
          ? supabase.from('profiles').select('id, full_name, phone, email').in('id', profileIds)
          : Promise.resolve({ data: [] }),
        supabase.from('landlords').select('name, phone, property_address, mobile_money_number, mobile_money_name').eq('id', req.landlord_id).single(),
        supabase.from('repayments').select('id, amount, created_at').eq('rent_request_id', requestId).order('created_at', { ascending: false }),
        supabase.from('general_ledger').select('id, amount, direction, category, description, transaction_date, reference_id').eq('source_id', requestId).order('transaction_date', { ascending: false }),
      ]);

      const profileMap = new Map((profilesRes.data || []).map((p: any) => [p.id, p]));
      setTenant(profileMap.get(req.tenant_id) || null);
      setAgent(req.agent_id ? profileMap.get(req.agent_id) || null : null);
      setSupporter(req.supporter_id ? profileMap.get(req.supporter_id) || null : null);
      setLandlord(landlordRes.data as any || null);
      setRepayments((repaymentsRes.data || []) as RepaymentEntry[]);
      setLedgerEntries((ledgerRes.data || []) as LedgerEntry[]);
      setLoading(false);
    };

    fetchAll();
  }, [requestId, open]);

  const remaining = request ? Math.max(0, request.total_repayment - request.amount_repaid) : 0;
  const dueDate = request?.approved_at
    ? addDays(new Date(request.approved_at), request.duration_days)
    : null;

  const handleCopyId = async () => {
    if (!requestId) return;
    await navigator.clipboard.writeText(requestId);
    toast.success('Request ID copied');
  };

  const handleRequestLocation = async (targetRole: 'tenant' | 'agent') => {
    if (!request || !requestId) return;
    const targetUserId = targetRole === 'tenant' ? request.tenant_id : request.agent_id;
    if (!targetUserId) { toast.error('No user found for this role'); return; }

    const { data: user } = await supabase.auth.getUser();
    if (!user?.user?.id) return;

    const { data, error } = await supabase
      .from('location_requests')
      .insert({
        rent_request_id: requestId,
        target_role: targetRole,
        target_user_id: targetUserId,
        requested_by: user.user.id,
      })
      .select('token')
      .single();

    if (error || !data) {
      toast.error('Failed to create location request');
      return;
    }

    const link = `${getPublicOrigin()}/share-location?token=${data.token}`;
    const targetName = targetRole === 'tenant' ? (tenant?.full_name || 'Tenant') : (agent?.full_name || 'Agent');
    const shareText = `Hi ${targetName}, please share your live location for rent verification by tapping this link:\n${link}`;

    if (navigator.share) {
      try {
        await navigator.share({ title: 'Share Location', text: shareText });
        toast.success('Link shared!');
      } catch {
        await navigator.clipboard.writeText(shareText);
        toast.success('Link copied to clipboard');
      }
    } else {
      await navigator.clipboard.writeText(shareText);
      toast.success('Link copied to clipboard');
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[90vh] rounded-t-2xl flex flex-col p-5">
        <SheetHeader className="text-left pb-3 shrink-0">
          <SheetTitle className="flex items-center gap-2">
            Request Details
            {request && (
              <Badge variant={request.status === 'funded' ? 'default' : 'secondary'} className="text-xs">
                {request.status}
              </Badge>
            )}
          </SheetTitle>
        </SheetHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12 flex-1">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !request ? (
          <p className="text-center text-muted-foreground py-8">Request not found</p>
        ) : (
          <div className="space-y-5 overflow-y-auto flex-1 pb-6">

            {/* Tenant status first: renewal vs new tenant, with existing payment history */}
            <TenantPaymentHistoryCard tenantId={request.tenant_id} currentRequestId={request.id} />


            <div className="text-center py-4 bg-muted/30 rounded-2xl">
              <p className="text-sm text-muted-foreground">Rent Amount</p>
              <p className="text-3xl font-bold">{formatUGX(request.rent_amount)}</p>
              <div className="flex justify-center gap-4 mt-2 text-xs">
                <span className="text-success">Repaid: {formatUGX(request.amount_repaid)}</span>
                <span className={remaining > 0 ? 'text-warning font-semibold' : 'text-success'}>
                  {remaining > 0 ? `Outstanding: ${formatUGX(remaining)}` : '✓ Fully Paid'}
                </span>
              </div>
            </div>

            {/* Request ID */}
            <button onClick={handleCopyId} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground w-full">
              <Copy className="h-3 w-3" />
              <span className="font-mono truncate">{requestId}</span>
            </button>

            <Separator />

            {/* Tenant */}
            <Section title="Tenant" icon={<User className="h-3.5 w-3.5" />}>
              <DetailRow label="Name" value={tenant?.full_name || 'Unknown'} />
              <DetailRow label="Phone" value={tenant?.phone || '—'} />
              <DetailRow label="Email" value={tenant?.email || '—'} />
              {request.tenant_no_smartphone !== undefined && (
                <DetailRow label="Phone Type" value={request.tenant_no_smartphone ? '📱 No Smartphone' : '📱 Smartphone'} />
              )}
              {request.tenant_electricity_meter && <DetailRow label="Electricity Meter" value={request.tenant_electricity_meter} />}
              {request.tenant_water_meter && <DetailRow label="Water Meter" value={request.tenant_water_meter} />}
              <Button
                size="sm"
                variant="outline"
                className="w-full mt-2 gap-2 text-xs"
                onClick={() => handleRequestLocation('tenant')}
              >
                <Navigation className="h-3.5 w-3.5" />
                Request Tenant's Live Location
              </Button>
            </Section>

            <Separator />

            {/* Landlord */}
            <Section title="Landlord" icon={<Building className="h-3.5 w-3.5" />}>
              <DetailRow label="Name" value={landlord?.name || 'Unknown'} />
              <DetailRow label="Phone" value={landlord?.phone || '—'} />
              <DetailRow label="Property" value={landlord?.property_address || '—'} />
              {landlord?.mobile_money_number && (
                <DetailRow label="MoMo" value={`${landlord.mobile_money_name || ''} ${landlord.mobile_money_number}`} />
              )}
            </Section>
            {request.landlord_id && (
              <LandlordAgreementHistory
                landlordId={request.landlord_id}
                landlordName={landlord?.name || 'Landlord'}
                landlordPhone={landlord?.phone || ''}
                propertyAddress={landlord?.property_address}
                canAdd={false}
              />
            )}

            <Separator />

            {/* Agent & Supporter */}
            {(agent || supporter) && (
              <>
                <Section title="Participants" icon={<User className="h-3.5 w-3.5" />}>
                  {agent && (
                    <>
                      <DetailRow label="Agent" value={`${agent.full_name} (${agent.phone})`} />
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full mt-1 gap-2 text-xs"
                        onClick={() => handleRequestLocation('agent')}
                      >
                        <Navigation className="h-3.5 w-3.5" />
                        Request Agent's Live Location
                      </Button>
                    </>
                  )}
                  {supporter && <DetailRow label="Supporter" value={`${supporter.full_name} (${supporter.phone})`} />}
                </Section>
                <Separator />
              </>
            )}

            {/* Financial Breakdown */}
            <Section title="Fee Breakdown" icon={<Receipt className="h-3.5 w-3.5" />}>
              <DetailRow label="Principal (Rent)" value={formatUGX(request.rent_amount)} />
              <DetailRow label="Access Fee" value={formatUGX(request.access_fee)} highlight="warning" />
              <DetailRow label="Platform Fee" value={formatUGX(request.request_fee)} />
              <DetailRow label="Total Repayment" value={formatUGX(request.total_repayment)} bold />
              <DetailRow label="Daily Repayment" value={formatUGX(request.daily_repayment)} />
            </Section>

            <Separator />

            {/* Timeline */}
            <Section title="Timeline" icon={<Calendar className="h-3.5 w-3.5" />}>
              <DetailRow label="Requested" value={format(new Date(request.created_at), 'dd MMM yyyy, HH:mm')} />
              {request.approved_at && <DetailRow label="Approved" value={format(new Date(request.approved_at), 'dd MMM yyyy, HH:mm')} />}
              {request.funded_at && <DetailRow label="Funded" value={format(new Date(request.funded_at), 'dd MMM yyyy, HH:mm')} />}
              {request.disbursed_at && <DetailRow label="Disbursed" value={format(new Date(request.disbursed_at), 'dd MMM yyyy, HH:mm')} />}
              <DetailRow label="Duration" value={`${request.duration_days} days`} />
              {dueDate && <DetailRow label="Due Date" value={format(dueDate, 'dd MMM yyyy')} highlight="destructive" />}
              {request.approval_comment && <DetailRow label="Approval Note" value={request.approval_comment} />}
            </Section>

            <Separator />

            {/* Location */}
            {(request.request_city || request.house_category) && (
              <>
                <Section title="Property" icon={<Home className="h-3.5 w-3.5" />}>
                  {request.house_category && <DetailRow label="Category" value={request.house_category} />}
                  {request.request_city && <DetailRow label="City" value={request.request_city} />}
                  {request.request_country && <DetailRow label="Country" value={request.request_country} />}
                  {request.request_latitude && request.request_longitude && (
                    <div className="flex justify-between py-0.5">
                      <span className="text-xs text-muted-foreground">GPS</span>
                      <a
                        href={`https://www.google.com/maps?q=${request.request_latitude},${request.request_longitude}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary underline"
                      >
                        📍 Open in Maps
                      </a>
                    </div>
                  )}
                </Section>
                <Separator />
              </>
            )}

            {/* Repayment History */}
            <Section title={`Repayments (${repayments.length})`} icon={<ArrowDownLeft className="h-3.5 w-3.5 text-success" />}>
              {repayments.length === 0 ? (
                <p className="text-xs text-muted-foreground">No repayments recorded</p>
              ) : (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {repayments.map(r => (
                    <div key={r.id} className="flex justify-between text-xs py-1">
                      <span className="text-muted-foreground">{format(new Date(r.created_at), 'dd MMM yyyy, HH:mm')}</span>
                      <span className="font-mono font-semibold text-success">+{formatUGX(r.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Separator />

            {/* Ledger Trail */}
            <Section title={`Ledger Trail (${ledgerEntries.length})`} icon={<Receipt className="h-3.5 w-3.5" />}>
              {ledgerEntries.length === 0 ? (
                <p className="text-xs text-muted-foreground">No ledger entries linked</p>
              ) : (
                <div className="space-y-1.5 max-h-60 overflow-y-auto">
                  {ledgerEntries.map(e => (
                    <div key={e.id} className="flex items-center justify-between text-xs py-1.5 border-b border-border/30 last:border-0">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {e.direction === 'cash_in' ? (
                            <ArrowDownLeft className="h-3 w-3 text-success shrink-0" />
                          ) : (
                            <ArrowUpRight className="h-3 w-3 text-destructive shrink-0" />
                          )}
                          <span className="truncate">{e.category.replace(/_/g, ' ')}</span>
                        </div>
                        <p className="text-[10px] text-muted-foreground/60 ml-4.5">
                          {format(new Date(e.transaction_date), 'dd MMM, HH:mm')}
                          {e.reference_id && ` · ${e.reference_id}`}
                        </p>
                        {e.description && <p className="text-[10px] text-muted-foreground ml-4.5 truncate">{e.description}</p>}
                      </div>
                      <span className={cn(
                        'font-mono font-semibold ml-2 shrink-0',
                        e.direction === 'cash_in' ? 'text-success' : 'text-destructive'
                      )}>
                        {e.direction === 'cash_in' ? '+' : '-'}{formatUGX(e.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        {icon}
        <h4 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</h4>
      </div>
      <div className="space-y-1.5 pl-1">{children}</div>
    </div>
  );
}

function DetailRow({ label, value, bold, highlight }: { label: string; value: string; bold?: boolean; highlight?: 'warning' | 'destructive' }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn(
        'text-xs text-right max-w-[200px]',
        bold && 'font-bold',
        highlight === 'warning' && 'text-warning',
        highlight === 'destructive' && 'text-destructive',
        !highlight && 'font-medium',
      )}>{value}</span>
    </div>
  );
}
