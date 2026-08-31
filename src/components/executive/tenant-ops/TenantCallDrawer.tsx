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
  IdCard, Wallet, Users, History, NotebookPen,
} from 'lucide-react';
import {
  TENANT_CALL_STATUS_LABEL,
  useLogTenantCall,
  useTenantCallHistory,
  type TenantCallStatus,
} from '@/hooks/useTenantCallReports';
import { callStatusBadgeClass } from '../LogTenantCallDialog';
import type { CallingListRow } from '@/hooks/useTenantCallingList';
import {
  ContactCard,
  DetailField,
  DetailGrid,
  DrawerSection,
  PersonHeader,
  StatGrid,
  StatTile,
} from '@/components/ops/calling/CallDrawerUi';

const STATUS_OPTIONS: { value: TenantCallStatus; icon: typeof PhoneCall; active: string; hint: string }[] = [
  { value: 'pending', icon: PhoneCall, active: 'border-amber-500/50 bg-amber-500/10 text-amber-600', hint: 'Follow-up still needed' },
  { value: 'closed', icon: CheckCircle2, active: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600', hint: 'Resolved, no more calls' },
  { value: 'missed', icon: PhoneMissed, active: 'border-destructive/50 bg-destructive/10 text-destructive', hint: 'Tenant not reached' },
];


/** Compact, read-only caller briefing for one tenant + the call log form. */
export function TenantCallDrawer({
  row,
  open,
  onClose,
}: {
  row: CallingListRow | null;
  open: boolean;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<TenantCallStatus | null>(null);
  const [comment, setComment] = useState('');
  const logCall = useLogTenantCall();
  const { data: history, isLoading: histLoading } = useTenantCallHistory(open && row ? row.tenant_id : null);

  const submit = async () => {
    if (!row || !status) return;
    await logCall.mutateAsync({
      tenantId: row.tenant_id,
      status,
      comment,
      rentRequestId: row.rent_request_id,
    });
    setStatus(null);
    setComment('');
    onClose();
  };

  const place = row
    ? [row.village, row.parish, row.sub_county, row.district || row.city, row.region].filter(Boolean).join(', ')
    : '';

  const details: { label: string; value: string; phone?: string | null }[] = row
    ? [
        { label: 'Full name', value: row.tenant_name },
        { label: 'Phone', value: row.phone || '—', phone: row.phone },
        { label: 'Email', value: row.email || '—' },
        { label: 'National ID', value: row.national_id || '—' },
        {
          label: 'Assigned agent',
          value: row.agent_name + (row.agent_phone ? ` · ${row.agent_phone}` : ''),
          phone: row.agent_phone,
        },
        {
          label: 'Landlord',
          value: row.landlord_name + (row.landlord_phone ? ` · ${row.landlord_phone}` : ''),
          phone: row.landlord_phone,
        },
        { label: 'Occupation', value: row.occupation || '—' },
        { label: 'Preferred language', value: row.preferred_language || '—' },
        {
          label: 'Mobile money',
          value: row.mobile_money_number
            ? `${row.mobile_money_number}${row.mobile_money_name ? ` · ${row.mobile_money_name}` : ''}`
            : '—',
        },
        { label: 'House category', value: row.tenant_house_category?.replace(/_/g, ' ') || '—' },
        { label: 'Landmark', value: row.landmark || '—' },
        { label: 'Smartphone', value: row.has_smartphone === null ? '—' : row.has_smartphone ? 'Yes' : 'No' },
        {
          label: 'Last active',
          value: row.last_active_at ? format(new Date(row.last_active_at), 'dd MMM yyyy') : '—',
        },
        { label: 'Tenant status', value: row.tenant_status?.replace(/_/g, ' ') || '—' },
      ].filter(d => d.value && d.value !== '—')
    : [];

  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-4 sm:max-w-lg">
        {row && (
          <>
            <SheetHeader className="sr-only">
              <SheetTitle>{row.tenant_name}</SheetTitle>
              <SheetDescription>Tenant call briefing</SheetDescription>
            </SheetHeader>

            <PersonHeader
              name={row.tenant_name}
              subtitle={[row.phone || 'No phone on file', row.national_id ? `ID ${row.national_id}` : '']
                .filter(Boolean)
                .join(' · ')}
              badges={
                <>
                  {row.call?.last_status && (
                    <Badge variant="outline" className={cn('text-[10px]', callStatusBadgeClass(row.call.last_status))}>
                      {TENANT_CALL_STATUS_LABEL[row.call.last_status]}
                    </Badge>
                  )}
                  {row.status && (
                    <Badge variant="secondary" className="text-[10px] capitalize">
                      {row.status.replace(/_/g, ' ')}
                    </Badge>
                  )}
                  {row.missed_days > 0 && (
                    <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive">
                      {row.missed_days} day{row.missed_days === 1 ? '' : 's'} missed
                    </Badge>
                  )}
                </>
              }
            >
              <ContactActions
                phone={row.phone}
                message={`Hello ${row.tenant_name}, this is Welile Tenant Operations.`}
                showSms
                showLabels
              />
            </PersonHeader>

            {place && (
              <p className="mt-2 flex items-start gap-1.5 break-words text-[11px] text-muted-foreground">
                <MapPin className="mt-0.5 h-3 w-3 shrink-0" /> {place}
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
                    message={`Hello, this is Welile Tenant Operations.`}
                  />
                ))}
              </DetailGrid>
            </DrawerSection>

            {row.ops_note && (
              <p className="mt-2 flex items-start gap-1.5 break-words rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px]">
                <NotebookPen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                <span>
                  <span className="font-semibold">Ops note: </span>
                  {row.ops_note}
                </span>
              </p>
            )}

            <DrawerSection title="Money" icon={Wallet}>
              <StatGrid>
                <StatTile label="Rent" value={formatUGX(row.rent_amount)} />
                <StatTile label="Expected daily" value={formatUGX(row.daily_repayment)} />
                <StatTile label="Amount owed" value={formatUGX(row.outstanding_balance)} tone="text-destructive" />
                <StatTile label="Repaid" value={formatUGX(row.amount_repaid)} />
                <StatTile
                  label="Days missed"
                  value={String(row.missed_days)}
                  tone={row.missed_days > 0 ? 'text-destructive' : undefined}
                />
                <StatTile label="Repayment" value={`${row.repayment_pct}%`} />
              </StatGrid>
            </DrawerSection>

            <DrawerSection title="Network" icon={Users}>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <ContactCard
                  role="Agent"
                  name={row.agent_name}
                  phone={row.agent_phone}
                  meta={row.agent_phone || 'No phone on file'}
                  message={`Hello ${row.agent_name}, this is Welile Tenant Operations.`}
                />
                <ContactCard
                  role="Landlord"
                  name={row.landlord_name}
                  phone={row.landlord_phone}
                  meta={row.landlord_phone || 'No phone on file'}
                  message={`Hello ${row.landlord_name}, this is Welile Tenant Operations.`}
                />
                <div className="rounded-xl border border-border/60 bg-card px-2.5 py-2 sm:col-span-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Plan started</p>
                  <p className="text-xs font-semibold">
                    {row.start_at
                      ? `${format(new Date(row.start_at), 'dd MMM yyyy')} · day ${row.days_since_start}`
                      : '—'}
                  </p>
                </div>
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
                  {TENANT_CALL_STATUS_LABEL[o.value]}
                </button>
              ))}
            </div>
            <Textarea
              placeholder="Comment (optional) — what the tenant said, agreed date, etc."
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
                history.map(h => {
                  const s = (h.status || (h.outcome === 'missed' ? 'missed' : 'pending')) as TenantCallStatus;
                  return (
                    <div key={h.id} className="rounded-lg border border-border/60 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant="outline" className={cn('px-1.5 text-[9px]', callStatusBadgeClass(s))}>
                          {TENANT_CALL_STATUS_LABEL[s]}
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
