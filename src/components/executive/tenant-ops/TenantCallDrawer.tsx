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

  const details: { label: string; value: string }[] = row
    ? [
        { label: 'Full name', value: row.tenant_name },
        { label: 'Phone', value: row.phone || '—' },
        { label: 'Email', value: row.email || '—' },
        { label: 'National ID', value: row.national_id || '—' },
        { label: 'Assigned agent', value: row.agent_name + (row.agent_phone ? ` · ${row.agent_phone}` : '') },
        { label: 'Landlord', value: row.landlord_name + (row.landlord_phone ? ` · ${row.landlord_phone}` : '') },
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
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        {row && (
          <>
            <SheetHeader className="text-left">
              <SheetTitle className="text-base break-words">{row.tenant_name}</SheetTitle>
              <SheetDescription className="text-xs break-words">
                {row.phone || 'No phone on file'}
                {row.national_id ? ` · ID ${row.national_id}` : ''}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ContactActions phone={row.phone} message={`Hello ${row.tenant_name}, this is Welile Tenant Operations.`} showSms showLabels />
              {row.call?.last_status && (
                <Badge variant="outline" className={cn('text-[10px]', callStatusBadgeClass(row.call.last_status))}>
                  {TENANT_CALL_STATUS_LABEL[row.call.last_status]}
                </Badge>
              )}
              {row.status && <Badge variant="secondary" className="text-[10px] capitalize">{row.status.replace(/_/g, ' ')}</Badge>}
            </div>

            {place && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground break-words">
                <MapPin className="h-3 w-3 shrink-0" /> {place}
              </p>
            )}

            <Separator className="my-3" />

            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Person details</p>
            <div className="grid grid-cols-1 gap-x-3 gap-y-1.5 rounded-lg border border-border/60 bg-muted/30 p-2.5 sm:grid-cols-2">
              {details.map(d => (
                <div key={d.label} className="min-w-0">
                  <p className="text-[10px] leading-tight text-muted-foreground">{d.label}</p>
                  <p className="text-xs font-medium leading-tight break-words">{d.value}</p>
                </div>
              ))}
            </div>
            {row.ops_note && (
              <p className="mt-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] break-words">
                <span className="font-semibold">Ops note: </span>{row.ops_note}
              </p>
            )}

            <p className="mb-2 mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Money</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="Rent" value={formatUGX(row.rent_amount)} />
              <Stat label="Expected daily" value={formatUGX(row.daily_repayment)} />
              <Stat label="Amount owed" value={formatUGX(row.outstanding_balance)} tone="text-destructive" />
              <Stat label="Repaid" value={formatUGX(row.amount_repaid)} />
              <Stat label="Days missed" value={String(row.missed_days)} tone={row.missed_days > 0 ? 'text-destructive' : undefined} />
              <Stat label="Repayment" value={`${row.repayment_pct}%`} />
            </div>

            <p className="mb-2 mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Network</p>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 p-2">
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">Agent</p>
                  <p className="truncate text-xs font-medium">{row.agent_name}</p>
                </div>
                <ContactActions phone={row.agent_phone} size="xs" />
              </div>
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 p-2">
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">Landlord</p>
                  <p className="truncate text-xs font-medium">{row.landlord_name}</p>
                </div>
                <ContactActions phone={row.landlord_phone} size="xs" />
              </div>
              <div className="rounded-lg border border-border/60 p-2">
                <p className="text-[10px] text-muted-foreground">Plan started</p>
                <p className="text-xs font-medium">
                  {row.start_at ? `${format(new Date(row.start_at), 'dd MMM yyyy')} · day ${row.days_since_start}` : '—'}
                </p>
              </div>
            </div>

            <Separator className="my-3" />

            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Record a call</p>
            <div className="grid grid-cols-3 gap-2">
              {STATUS_OPTIONS.map(o => (
                <button
                  key={o.value}
                  onClick={() => setStatus(o.value)}
                  title={o.hint}
                  className={cn(
                    'flex flex-col items-center justify-center gap-1 rounded-lg border py-2.5 text-[11px] font-medium transition-all',
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

            <p className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Call history {history?.length ? `(${history.length})` : ''}
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
