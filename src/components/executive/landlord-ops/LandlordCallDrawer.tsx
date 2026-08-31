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
import { CheckCircle2, Loader2, MapPin, PhoneCall, PhoneMissed, User } from 'lucide-react';
import {
  LANDLORD_CALL_STATUS_LABEL,
  landlordCallStatusBadgeClass,
  useLogLandlordCall,
  useLandlordCallHistory,
  type LandlordCallStatus,
} from '@/hooks/useLandlordCallReports';
import type { LandlordCallingRow } from '@/hooks/useLandlordCallingList';

const STATUS_OPTIONS: { value: LandlordCallStatus; icon: typeof PhoneCall; active: string; hint: string }[] = [
  { value: 'pending', icon: PhoneCall, active: 'border-amber-500/50 bg-amber-500/10 text-amber-600', hint: 'Follow-up still needed' },
  { value: 'closed', icon: CheckCircle2, active: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600', hint: 'Resolved, no more calls' },
  { value: 'missed', icon: PhoneMissed, active: 'border-destructive/50 bg-destructive/10 text-destructive', hint: 'Landlord not reached' },
];

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-muted/40 p-2">
      <p className="text-[10px] leading-tight text-muted-foreground break-words">{label}</p>
      <p className={cn('mt-0.5 text-sm font-semibold leading-tight tabular-nums break-normal', tone)}>{value}</p>
    </div>
  );
}

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

  const submit = async () => {
    if (!row || !status) return;
    await logCall.mutateAsync({ landlordId: row.landlord_id, status, comment });
    setStatus(null);
    setComment('');
    onClose();
  };

  const place = row ? [row.village, row.district, row.region].filter(Boolean).join(', ') : '';

  const details: { label: string; value: string }[] = row
    ? [
        { label: 'Full name', value: row.landlord_name },
        { label: 'Phone', value: row.phone || '—' },
        { label: 'Registering agent', value: row.agent_name + (row.agent_phone ? ` · ${row.agent_phone}` : '') },
        { label: 'Caretaker', value: row.caretaker_name ? `${row.caretaker_name}${row.caretaker_phone ? ` · ${row.caretaker_phone}` : ''}` : '—' },
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
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        {row && (
          <>
            <SheetHeader className="text-left">
              <SheetTitle className="text-base break-words">{row.landlord_name}</SheetTitle>
              <SheetDescription className="text-xs break-words">
                {row.phone || 'No phone on file'}
                {row.house_category ? ` · ${row.house_category.replace(/_/g, ' ')}` : ''}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ContactActions phone={row.phone} message={`Hello ${row.landlord_name}, this is Welile Landlord Operations.`} showSms showLabels />
              {row.call?.last_status && (
                <Badge variant="outline" className={cn('text-[10px]', landlordCallStatusBadgeClass(row.call.last_status))}>
                  {LANDLORD_CALL_STATUS_LABEL[row.call.last_status]}
                </Badge>
              )}
              <Badge variant={row.verified ? 'secondary' : 'outline'} className="text-[10px]">
                {row.verified ? 'Verified' : 'Unverified'}
              </Badge>
              {row.has_smartphone === false && (
                <Badge variant="outline" className="text-[10px]">No smartphone</Badge>
              )}
            </div>

            {(place || row.property_address) && (
              <p className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground break-words">
                <MapPin className="mt-0.5 h-3 w-3 shrink-0" /> {[place, row.property_address].filter(Boolean).join(' · ')}
              </p>
            )}

            <Separator className="my-3" />

            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Houses</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="Houses listed" value={String(row.houses)} />
              <Stat label="Occupied" value={String(row.occupied_houses)} />
              <Stat label="Empty" value={String(row.empty_houses)} tone={row.empty_houses > 0 ? 'text-amber-600' : undefined} />
              <Stat label="Verified houses" value={String(row.verified_houses)} />
              <Stat label="Declared houses" value={String(row.declared_houses)} />
              <Stat label="Rent on houses" value={formatUGX(row.houses_monthly_rent)} />
            </div>

            <p className="mb-2 mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Rent &amp; payouts</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="Rent plans" value={String(row.plans)} />
              <Stat label="Funded plans" value={String(row.funded_plans)} />
              <Stat label="Plan rent value" value={formatUGX(row.plan_rent_total)} />
              <Stat label="Payouts" value={String(row.payout_count)} />
              <Stat label="Total paid" value={formatUGX(row.paid_total)} tone="text-emerald-600" />
              <Stat label="Monthly rent (declared)" value={formatUGX(row.declared_monthly_rent)} />
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Last payout {row.last_paid_at ? format(new Date(row.last_paid_at), 'dd MMM yyyy') : '—'}
              {' · '}Last rent plan {row.last_plan_at ? format(new Date(row.last_plan_at), 'dd MMM yyyy') : '—'}
            </p>

            <p className="mb-2 mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Payment details</p>
            <div className="space-y-1.5">
              <div className="rounded-lg border border-border/60 p-2">
                <p className="text-[10px] text-muted-foreground">Mobile money</p>
                <p className="text-xs font-medium break-words">
                  {row.mobile_money_number ? `${row.mobile_money_number}${row.mobile_money_name ? ` · ${row.mobile_money_name}` : ''}` : 'Not on file'}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 p-2">
                <p className="text-[10px] text-muted-foreground">Bank</p>
                <p className="text-xs font-medium break-words">
                  {row.bank_name || row.account_number ? `${row.bank_name || '—'} · ${row.account_number || '—'}` : 'Not on file'}
                </p>
              </div>
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
                  <p className="text-[10px] text-muted-foreground">Caretaker</p>
                  <p className="truncate text-xs font-medium">{row.caretaker_name || '—'}</p>
                </div>
                <ContactActions phone={row.caretaker_phone || ''} size="xs" />
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

            <p className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Call history {history?.length ? `(${history.length})` : ''}
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
