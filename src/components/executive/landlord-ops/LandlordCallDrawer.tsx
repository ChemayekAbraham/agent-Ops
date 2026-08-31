import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { ContactActions } from '@/components/ops/ContactActions';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  CheckCircle2, Loader2, MapPin, PhoneCall, PhoneMissed, User,
  IdCard, Home, Banknote, Users, History, CreditCard,
} from 'lucide-react';
import {
  LANDLORD_CALL_STATUS_LABEL,
  landlordCallStatusBadgeClass,
  useLogLandlordCall,
  useLandlordCallHistory,
  type LandlordCallStatus,
} from '@/hooks/useLandlordCallReports';
import type { LandlordCallingRow } from '@/hooks/useLandlordCallingList';
import { useLandlordTenants } from '@/hooks/useLandlordTenants';
import {
  ContactCard,
  DetailField,
  DetailGrid,
  DrawerSection,
  PersonHeader,
  StatGrid,
  StatTile,
} from '@/components/ops/calling/CallDrawerUi';

const STATUS_OPTIONS: { value: LandlordCallStatus; icon: typeof PhoneCall; active: string; hint: string }[] = [
  { value: 'pending', icon: PhoneCall, active: 'border-amber-500/50 bg-amber-500/10 text-amber-600', hint: 'Follow-up still needed' },
  { value: 'closed', icon: CheckCircle2, active: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600', hint: 'Resolved, no more calls' },
  { value: 'missed', icon: PhoneMissed, active: 'border-destructive/50 bg-destructive/10 text-destructive', hint: 'Landlord not reached' },
];


/** Compact, read-only caller briefing for one landlord + the call log form. */
export function LandlordCallDrawer({
  row,
  open,
  onClose,
}: {
  row: LandlordCallingRow | null;
  open: boolean;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<LandlordCallStatus | null>(null);
  const [comment, setComment] = useState('');
  const logCall = useLogLandlordCall();
  const { data: history, isLoading: histLoading } = useLandlordCallHistory(open && row ? row.landlord_id : null);
  const { data: tenants, isLoading: tenantsLoading } = useLandlordTenants(open && row ? row.landlord_id : null);

  const submit = async () => {
    if (!row || !status) return;
    await logCall.mutateAsync({ landlordId: row.landlord_id, status, comment });
    setStatus(null);
    setComment('');
    onClose();
  };

  const place = row ? [row.village, row.district, row.region].filter(Boolean).join(', ') : '';

  const details: { label: string; value: string; phone?: string | null }[] = row
    ? [
        { label: 'Full name', value: row.landlord_name },
        { label: 'Phone', value: row.phone || '—', phone: row.phone },
        {
          label: 'Registering agent',
          value: row.agent_name + (row.agent_phone ? ` · ${row.agent_phone}` : ''),
          phone: row.agent_phone,
        },
        {
          label: 'Caretaker',
          value: row.caretaker_name ? `${row.caretaker_name}${row.caretaker_phone ? ` · ${row.caretaker_phone}` : ''}` : '—',
          phone: row.caretaker_phone,
        },
        { label: 'House category', value: row.house_category?.replace(/_/g, ' ') || '—' },
        { label: 'Property address', value: row.property_address || '—' },
        { label: 'Location', value: place || '—' },
        { label: 'Verification', value: row.verified ? 'Verified' : 'Unverified' },
        { label: 'Smartphone', value: row.has_smartphone === null ? '—' : row.has_smartphone ? 'Yes' : 'No' },
        { label: 'Registered on', value: row.created_at ? format(new Date(row.created_at), 'dd MMM yyyy') : '—' },
      ].filter(d => d.value && d.value !== '—')
    : [];

  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-4 sm:max-w-lg">
        {row && (
          <>
            <SheetHeader className="sr-only">
              <SheetTitle>{row.landlord_name}</SheetTitle>
              <SheetDescription>Landlord call briefing</SheetDescription>
            </SheetHeader>

            <PersonHeader
              name={row.landlord_name}
              subtitle={[row.phone || 'No phone on file', row.house_category?.replace(/_/g, ' ') || '']
                .filter(Boolean)
                .join(' · ')}
              badges={
                <>
                  {row.call?.last_status && (
                    <Badge
                      variant="outline"
                      className={cn('text-[10px]', landlordCallStatusBadgeClass(row.call.last_status))}
                    >
                      {LANDLORD_CALL_STATUS_LABEL[row.call.last_status]}
                    </Badge>
                  )}
                  <Badge variant={row.verified ? 'secondary' : 'outline'} className="text-[10px]">
                    {row.verified ? 'Verified' : 'Unverified'}
                  </Badge>
                  {row.has_smartphone === false && (
                    <Badge variant="outline" className="text-[10px]">No smartphone</Badge>
                  )}
                </>
              }
            >
              <ContactActions
                phone={row.phone}
                message={`Hello ${row.landlord_name}, this is Welile Landlord Operations.`}
                showSms
                showLabels
              />
            </PersonHeader>

            {(place || row.property_address) && (
              <p className="mt-2 flex items-start gap-1.5 break-words text-[11px] text-muted-foreground">
                <MapPin className="mt-0.5 h-3 w-3 shrink-0" /> {[place, row.property_address].filter(Boolean).join(' · ')}
              </p>
            )}

            <DrawerSection title="Person details" icon={IdCard}>
              <DetailGrid>
                {details.map(d => (
                  <DetailField
                    key={d.label}
                    label={d.label}
                    value={d.value}
                    phone={d.phone}
                    message="Hello, this is Welile Landlord Operations."
                  />
                ))}
              </DetailGrid>
            </DrawerSection>

            <DrawerSection
              title="Their tenants"
              icon={Users}
              action={
                tenants?.length ? (
                  <Badge variant="secondary" className="text-[10px]">{tenants.length}</Badge>
                ) : null
              }
            >
              {tenantsLoading ? (
                <p className="text-[11px] text-muted-foreground">Loading tenants…</p>
              ) : !tenants?.length ? (
                <p className="rounded-xl border border-dashed border-border/60 p-3 text-center text-[11px] text-muted-foreground">
                  No tenants recorded against this landlord.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {tenants.map(t => (
                    <div
                      key={t.rent_request_id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-card px-2.5 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-foreground">{t.tenant_name}</p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          {t.tenant_phone || 'No phone'} · rent {formatUGX(t.rent_amount)}
                          {t.outstanding > 0 ? ` · owes ${formatUGX(t.outstanding)}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-[9px] capitalize">
                          {t.status.replace(/_/g, ' ')}
                        </Badge>
                        <ContactActions
                          phone={t.tenant_phone}
                          size="xs"
                          message={`Hello ${t.tenant_name}, this is Welile Operations.`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </DrawerSection>

            <DrawerSection title="Houses" icon={Home}>
              <StatGrid>
                <StatTile label="Houses listed" value={String(row.houses)} />
                <StatTile label="Occupied" value={String(row.occupied_houses)} />
                <StatTile
                  label="Empty"
                  value={String(row.empty_houses)}
                  tone={row.empty_houses > 0 ? 'text-amber-600' : undefined}
                />
                <StatTile label="Verified houses" value={String(row.verified_houses)} />
                <StatTile label="Declared houses" value={String(row.declared_houses)} />
                <StatTile label="Rent on houses" value={formatUGX(row.houses_monthly_rent)} />
              </StatGrid>
            </DrawerSection>

            <DrawerSection title="Rent &amp; payouts" icon={Banknote}>
              <StatGrid>
                <StatTile label="Rent plans" value={String(row.plans)} />
                <StatTile label="Funded plans" value={String(row.funded_plans)} />
                <StatTile label="Plan rent value" value={formatUGX(row.plan_rent_total)} />
                <StatTile label="Payouts" value={String(row.payout_count)} />
                <StatTile label="Total paid" value={formatUGX(row.paid_total)} tone="text-emerald-600" />
                <StatTile label="Monthly rent (declared)" value={formatUGX(row.declared_monthly_rent)} />
              </StatGrid>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Last payout {row.last_paid_at ? format(new Date(row.last_paid_at), 'dd MMM yyyy') : '—'}
                {' · '}Last rent plan {row.last_plan_at ? format(new Date(row.last_plan_at), 'dd MMM yyyy') : '—'}
              </p>
            </DrawerSection>

            <DrawerSection title="Payment details" icon={CreditCard}>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="rounded-xl border border-border/60 bg-card px-2.5 py-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Mobile money</p>
                  <p className="break-words text-xs font-semibold">
                    {row.mobile_money_number
                      ? `${row.mobile_money_number}${row.mobile_money_name ? ` · ${row.mobile_money_name}` : ''}`
                      : 'Not on file'}
                  </p>
                </div>
                <div className="rounded-xl border border-border/60 bg-card px-2.5 py-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Bank</p>
                  <p className="break-words text-xs font-semibold">
                    {row.bank_name || row.account_number
                      ? `${row.bank_name || '—'} · ${row.account_number || '—'}`
                      : 'Not on file'}
                  </p>
                </div>
              </div>
            </DrawerSection>

            <DrawerSection title="Network" icon={Users}>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <ContactCard
                  role="Agent"
                  name={row.agent_name}
                  phone={row.agent_phone}
                  meta={row.agent_phone || 'No phone on file'}
                  message={`Hello ${row.agent_name}, this is Welile Landlord Operations.`}
                />
                <ContactCard
                  role="Caretaker"
                  name={row.caretaker_name || '—'}
                  phone={row.caretaker_phone}
                  meta={row.caretaker_phone || 'No phone on file'}
                  message="Hello, this is Welile Landlord Operations."
                />
              </div>
            </DrawerSection>


            <Separator className="my-4" />

            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <PhoneCall className="h-3.5 w-3.5" /> Record a call
            </p>
            <div className="grid grid-cols-3 gap-2">
              {STATUS_OPTIONS.map(o => (
                <button
                  key={o.value}
                  onClick={() => setStatus(o.value)}
                  title={o.hint}
                  className={cn(
                    'flex flex-col items-center justify-center gap-1 rounded-xl border py-3 text-[11px] font-medium transition-all hover:bg-accent/60',
                    status === o.value ? o.active : 'border-border text-muted-foreground',
                  )}
                >
                  <o.icon className="h-4 w-4" />
                  {LANDLORD_CALL_STATUS_LABEL[o.value]}
                </button>
              ))}
            </div>
            <Textarea
              placeholder="Comment (optional) — what the landlord said, payment confirmation, agreed date, etc."
              value={comment}
              onChange={e => setComment(e.target.value)}
              rows={3}
              className="mt-2 text-xs"
            />
            <Button onClick={submit} disabled={!status || logCall.isPending} className="mt-2 h-10 w-full text-xs">
              {logCall.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save call record'}
            </Button>

            <p className="mb-1.5 mt-5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <History className="h-3.5 w-3.5" /> Call history {history?.length ? `(${history.length})` : ''}
            </p>

            <div className="space-y-1.5 pb-6">
              {histLoading ? (
                <p className="text-[11px] text-muted-foreground">Loading…</p>
              ) : !history?.length ? (
                <p className="text-[11px] text-muted-foreground">No calls recorded yet.</p>
              ) : (
                history.map(h => (
                  <div key={h.id} className="rounded-lg border border-border/60 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline" className={cn('px-1.5 text-[9px]', landlordCallStatusBadgeClass(h.status))}>
                        {LANDLORD_CALL_STATUS_LABEL[h.status]}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {format(new Date(h.called_at), 'dd MMM yyyy · HH:mm')}
                      </span>
                    </div>
                    {h.comment && <p className="mt-1 text-[11px] break-words">{h.comment}</p>}
                    <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                      <User className="h-2.5 w-2.5" /> logged by staff
                    </p>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
