import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious, type CarouselApi } from '@/components/ui/carousel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UserAvatar } from '@/components/UserAvatar';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { CalendarDays, Home, ImageOff, Landmark, MapPin, Phone, User, X } from 'lucide-react';
import type { SupportedTenant } from '@/hooks/useSupportedTenants';
import { FunderVerifiedPlanPack } from '@/components/supporter/FunderVerifiedPlanPack';

interface Props {
  tenant: SupportedTenant | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const fmtDate = (v?: string | null) =>
  v ? new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

const tel = (phone?: string | null) => (phone ? `tel:${phone.replace(/\s/g, '')}` : null);

/** One line in the details list: icon, small label, value. */
function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <li className="flex items-center gap-3 py-3">
      <span className="grid h-9 w-9 flex-none place-items-center rounded-full bg-primary/10 text-primary">{icon}</span>
      <span className="min-w-0 flex-1 text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 max-w-[60%] break-words text-right text-sm font-semibold">{value}</span>
    </li>
  );
}

/** Quick action tile: icon above a short label. Disabled when there is nothing to call or open. */
function Action({ icon, label, href, external }: { icon: React.ReactNode; label: string; href: string | null; external?: boolean }) {
  const cls = 'flex flex-col items-center gap-1 rounded-2xl py-3 text-xs font-semibold transition';
  if (!href) {
    return <span className={cn(cls, 'bg-muted/30 text-muted-foreground')} aria-disabled>{icon}{label}</span>;
  }
  return (
    <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className={cn(cls, 'bg-muted/50 hover:bg-muted active:scale-[0.97]')}>
      {icon}{label}
    </a>
  );
}

/**
 * A tenant this funder supports, laid out like an app detail screen: photo header, the tenant,
 * repayment progress, quick actions, then Details / Documents tabs.
 */
export function SupportedTenantDrawer({ tenant, open, onOpenChange }: Props) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [api, setApi] = useState<CarouselApi>();
  const [slide, setSlide] = useState(0);

  useEffect(() => {
    if (!api) return;
    const onSelect = () => setSlide(api.selectedScrollSnap());
    onSelect();
    api.on('select', onSelect);
    return () => { api.off('select', onSelect); };
  }, [api]);

  if (!tenant) return null;

  const fundedOn = tenant.funded_at || tenant.created_at;
  const photos = (tenant.house_image_urls ?? []).filter(Boolean);
  const location =
    [tenant.listing_address, tenant.village, tenant.district, tenant.city].filter(Boolean).join(', ')
    || tenant.tenant_address || 'Not provided';
  const endDate = fundedOn && tenant.duration_days
    ? new Date(new Date(fundedOn).getTime() + tenant.duration_days * 86400000).toISOString()
    : null;
  const managed = tenant.funding_mode !== 'self_managed';

  // Repayment progress: what the tenant has paid back against the total to repay.
  const total = Number(tenant.total_repayment || 0);
  const repaid = Number(tenant.amount_repaid || 0);
  const pct = total > 0 ? Math.min(100, Math.round((repaid / total) * 100)) : null;

  // Plan time elapsed, for the date bar.
  const start = fundedOn ? new Date(fundedOn).getTime() : null;
  const end = endDate ? new Date(endDate).getTime() : null;
  const timePct = start && end && end > start ? Math.min(100, Math.max(0, Math.round(((Date.now() - start) / (end - start)) * 100))) : null;

  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[92vh] overflow-y-auto rounded-t-[28px] p-0 [&>button]:hidden">
        <SheetHeader className="sr-only">
          <SheetTitle>Tenant details</SheetTitle>
        </SheetHeader>

        {/* Photo header, edge to edge, with its own close button. */}
        <div className="relative h-56 w-full overflow-hidden bg-muted">
          {photos.length > 0 ? (
            <Carousel setApi={setApi} className="h-56 w-full" opts={{ loop: photos.length > 1 }}>
              <CarouselContent className="ml-0 h-56">
                {photos.map((url, i) => (
                  <CarouselItem key={`${url}-${i}`} className="basis-full pl-0">
                    <button type="button" onClick={() => setLightboxIndex(i)} aria-label={`Expand house photo ${i + 1}`} className="block h-56 w-full">
                      <img src={url} alt={`House photo ${i + 1}`} loading="lazy" className="h-full w-full object-cover" />
                    </button>
                  </CarouselItem>
                ))}
              </CarouselContent>
            </Carousel>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
              <ImageOff className="h-6 w-6" />
              <p className="text-xs font-medium">No house photos uploaded</p>
            </div>
          )}
          {photos.length > 1 && (
            <div className="absolute inset-x-0 bottom-8 flex justify-center gap-1" aria-hidden>
              {photos.map((_, i) => (
                <span key={i} className={cn('h-1.5 rounded-full bg-white shadow transition-all', i === slide ? 'w-4' : 'w-1.5 opacity-60')} />
              ))}
            </div>
          )}
          <button type="button" onClick={() => onOpenChange(false)} aria-label="Close"
            className="absolute right-3 top-3 z-10 grid h-10 w-10 place-items-center rounded-full bg-background/90 text-foreground shadow-md backdrop-blur active:scale-95">
            <X className="h-5 w-5" />
          </button>
        </div>

        <Dialog open={lightboxIndex !== null} onOpenChange={(v) => !v && setLightboxIndex(null)}>
          <DialogContent className="max-w-3xl overflow-hidden p-0">
            <DialogHeader className="sr-only"><DialogTitle>House photo</DialogTitle></DialogHeader>
            {lightboxIndex !== null && (
              <Carousel className="w-full" opts={{ loop: photos.length > 1, startIndex: lightboxIndex }}>
                <CarouselContent className="ml-0">
                  {photos.map((url, i) => (
                    <CarouselItem key={`lb-${url}-${i}`} className="basis-full pl-0">
                      <img src={url} alt={`House photo ${i + 1} enlarged`} className="max-h-[75vh] w-full bg-muted object-contain" />
                    </CarouselItem>
                  ))}
                </CarouselContent>
                {photos.length > 1 && (<><CarouselPrevious className="left-3" /><CarouselNext className="right-3" /></>)}
              </Carousel>
            )}
          </DialogContent>
        </Dialog>

        {/* Content panel overlapping the photo. */}
        <div className="relative -mt-5 space-y-4 rounded-t-[28px] bg-background px-4 pb-8 pt-5">
          <div className="flex items-center gap-3">
            <UserAvatar avatarUrl={tenant.tenant_avatar_url} fullName={tenant.tenant_name} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="break-words text-lg font-bold leading-tight">{tenant.tenant_name}</p>
              <p className="mt-0.5 flex items-start gap-1 text-xs text-muted-foreground">
                <MapPin className="mt-px h-3.5 w-3.5 shrink-0 text-red-600" aria-hidden /><span className="line-clamp-2">{location}</span>
              </p>
              <span className={cn('mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold', managed ? 'bg-primary/10 text-primary' : 'bg-muted text-foreground')}>
                {managed ? 'Managed' : 'Self managed'}
              </span>
            </div>
          </div>

          {/* Repayment: the one number a funder checks first. */}
          <section className="rounded-3xl border border-border/70 bg-card p-4 shadow-sm">
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">You funded</p>
                <p className="mt-0.5 truncate text-lg font-bold tabular-nums">{formatUGX(Number(tenant.rent_amount || 0))}</p>
              </div>
              <div className="min-w-0 border-l border-border/60 pl-3">
                <p className="text-xs text-muted-foreground">Daily repayment</p>
                <p className="mt-0.5 truncate text-lg font-bold tabular-nums">{tenant.daily_repayment ? formatUGX(Number(tenant.daily_repayment)) : '—'}</p>
              </div>
            </div>
            {pct !== null && (
              <div className="mt-3 space-y-1.5">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">Repaid {formatUGX(repaid)} of {formatUGX(total)}</span>
                  <span className="font-bold text-success">{pct}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Repaid so far">
                  <div className="h-full rounded-full bg-success transition-all" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )}
            <div className="mt-3 flex items-center gap-2 rounded-2xl bg-muted/50 px-3 py-2 text-xs">
              <CalendarDays className="h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{fmtDate(fundedOn)}</span>
                <span className="text-muted-foreground"> to </span>
                <span className="font-semibold">{fmtDate(endDate)}</span>
              </span>
              {timePct !== null && <span className="shrink-0 text-muted-foreground">{timePct}% of the plan</span>}
            </div>
          </section>

          {/* Quick actions. */}
          <div className="grid grid-cols-3 gap-2">
            <Action icon={<Phone className="h-5 w-5 text-primary" />} label="Call tenant" href={tel(tenant.tenant_phone)} />
            <Action icon={<Phone className="h-5 w-5 text-primary" />} label="Call landlord" href={tel(tenant.landlord_phone)} />
            <Action icon={<MapPin className="h-5 w-5 text-red-600" />} label="Location" href={mapUrl} external />
          </div>

          <Tabs defaultValue="details" className="w-full">
            <TabsList className="grid h-11 w-full grid-cols-2 rounded-full bg-muted p-1">
              <TabsTrigger value="details" className="rounded-full">Details</TabsTrigger>
              <TabsTrigger value="documents" className="rounded-full">Documents</TabsTrigger>
            </TabsList>
            <TabsContent value="details" className="mt-3">
              <ul className="divide-y divide-border/60 rounded-3xl border border-border/70 bg-card px-4">
                <Row icon={<Home className="h-4 w-4" />} label="House" value={tenant.house_category ? tenant.house_category.replace(/[_-]/g, ' ') : 'Not specified'} />
                <Row icon={<User className="h-4 w-4" />} label="Landlord" value={tenant.landlord_name || 'Not linked'} />
                <Row icon={<User className="h-4 w-4" />} label="Field agent" value={tenant.agent_name || 'Not assigned'} />
                <Row icon={<Phone className="h-4 w-4" />} label="Tenant phone" value={tenant.tenant_phone || 'Not provided'} />
                <Row icon={<Landmark className="h-4 w-4" />} label="Funding" value={managed ? 'Managed by Welile' : 'Self managed'} />
              </ul>
            </TabsContent>
            <TabsContent value="documents" className="mt-3">
              <FunderVerifiedPlanPack rentRequestId={tenant.rent_request_id} />
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}
