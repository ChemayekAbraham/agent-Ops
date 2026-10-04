import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '@/components/ui/carousel';
import { UserAvatar } from '@/components/UserAvatar';
import { formatUGX } from '@/lib/rentCalculations';
import { MapPin, Phone, Home, CalendarDays, Landmark, ImageOff, User } from 'lucide-react';
import type { SupportedTenant } from '@/hooks/useSupportedTenants';

interface Props {
  tenant: SupportedTenant | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-border/50 last:border-0">
      <div className="mt-0.5 text-muted-foreground">{icon}</div>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{label}</p>
        <p className="text-sm font-semibold text-foreground break-words">{value}</p>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card px-3 py-2.5 min-w-0">
      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{label}</p>
      <p className="text-sm font-black tabular-nums truncate">{value}</p>
    </div>
  );
}

const fmtDate = (v?: string | null) =>
  v ? new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';

export function SupportedTenantDrawer({ tenant, open, onOpenChange }: Props) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  if (!tenant) return null;

  const fundedOn = tenant.funded_at || tenant.created_at;
  const photos = (tenant.house_image_urls ?? []).filter(Boolean);
  const location =
    [tenant.listing_address, tenant.village, tenant.district, tenant.city]
      .filter(Boolean)
      .join(', ') || tenant.tenant_address || 'Not provided';
  const endDate =
    fundedOn && tenant.duration_days
      ? new Date(new Date(fundedOn).getTime() + tenant.duration_days * 86400000).toISOString()
      : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[92vh] overflow-y-auto p-0">
        <SheetHeader className="px-4 pt-5 pb-3">
          <SheetTitle className="text-left text-base">Tenant details</SheetTitle>
        </SheetHeader>

        {/* House photos */}
        <div className="relative mx-4 mb-4 h-48 overflow-hidden rounded-2xl bg-muted">
          {photos.length > 0 ? (
            <Carousel className="h-48 w-full" opts={{ loop: photos.length > 1 }}>
              <CarouselContent className="ml-0 h-48">
                {photos.map((url, i) => (
                  <CarouselItem key={`${url}-${i}`} className="basis-full pl-0">
                    <button
                      type="button"
                      onClick={() => setLightboxIndex(i)}
                      aria-label={`Expand house photo ${i + 1}`}
                      className="block h-48 w-full"
                    >
                      <img src={url} alt={`House photo ${i + 1}`} loading="lazy" className="h-full w-full object-cover" />
                    </button>
                    <span className="absolute bottom-3 right-3 rounded-md bg-foreground/70 px-2 py-1 text-[11px] font-semibold text-background">
                      {i + 1} / {photos.length}
                    </span>
                  </CarouselItem>
                ))}
              </CarouselContent>
              {photos.length > 1 && (
                <>
                  <CarouselPrevious className="left-3 h-8 w-8" />
                  <CarouselNext className="right-3 h-8 w-8" />
                </>
              )}
            </Carousel>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
              <ImageOff className="h-6 w-6" />
              <p className="text-xs font-medium">No house photos uploaded</p>
            </div>
          )}
        </div>

        <Dialog open={lightboxIndex !== null} onOpenChange={v => !v && setLightboxIndex(null)}>
          <DialogContent className="max-w-3xl overflow-hidden p-0">
            <DialogHeader className="sr-only">
              <DialogTitle>House photo</DialogTitle>
            </DialogHeader>
            {lightboxIndex !== null && (
              <Carousel className="w-full" opts={{ loop: photos.length > 1, startIndex: lightboxIndex }}>
                <CarouselContent className="ml-0">
                  {photos.map((url, i) => (
                    <CarouselItem key={`lb-${url}-${i}`} className="basis-full pl-0">
                      <img src={url} alt={`House photo ${i + 1} enlarged`} className="max-h-[75vh] w-full bg-muted object-contain" />
                    </CarouselItem>
                  ))}
                </CarouselContent>
                {photos.length > 1 && (
                  <>
                    <CarouselPrevious className="left-3" />
                    <CarouselNext className="right-3" />
                  </>
                )}
              </Carousel>
            )}
          </DialogContent>
        </Dialog>

        <div className="flex items-center gap-3 px-4 pb-4">
          <UserAvatar avatarUrl={tenant.tenant_avatar_url} fullName={tenant.tenant_name} size="lg" />
          <div className="min-w-0">
            <p className="text-lg font-black text-foreground truncate">{tenant.tenant_name}</p>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="outline" className="text-[10px]">
                {tenant.funding_mode === 'self_managed' ? 'Self managed' : 'Managed'}
              </Badge>
            </div>
          </div>
        </div>

        {/* Money snapshot */}
        <div className="mx-4 mb-4 grid grid-cols-2 gap-2">
          <Stat label="Amount funded" value={formatUGX(Number(tenant.rent_amount || 0))} />
          <Stat label="Daily repayment" value={tenant.daily_repayment ? formatUGX(Number(tenant.daily_repayment)) : '—'} />
        </div>

        {/* Property & plan */}
        <p className="px-4 pb-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Property</p>
        <div className="mx-4 mb-5 rounded-2xl border border-border/60 bg-card">
          <Row icon={<Home className="h-4 w-4" />} label="Property type" value={tenant.house_category ? tenant.house_category.replace(/_/g, ' ') : 'Not specified'} />
          <Row icon={<MapPin className="h-4 w-4" />} label="Location" value={location} />
          <Row icon={<User className="h-4 w-4" />} label="Landlord" value={tenant.landlord_name || 'Not linked'} />
          <Row icon={<Phone className="h-4 w-4" />} label="Landlord phone" value={tenant.landlord_phone || 'Not provided'} />
        </div>

        <p className="px-4 pb-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Tenant & plan</p>
        <div className="mx-4 mb-8 rounded-2xl border border-border/60 bg-card">
          <Row icon={<Phone className="h-4 w-4" />} label="Tenant phone" value={tenant.tenant_phone || 'Not provided'} />
          <Row icon={<MapPin className="h-4 w-4" />} label="Tenant address" value={tenant.tenant_address || tenant.city || 'Not provided'} />
          <Row icon={<User className="h-4 w-4" />} label="Field agent" value={tenant.agent_name || 'Not assigned'} />
          <Row icon={<CalendarDays className="h-4 w-4" />} label="Supported since" value={fmtDate(fundedOn)} />
          <Row icon={<CalendarDays className="h-4 w-4" />} label="Plan length" value={tenant.duration_days ? `${tenant.duration_days} days` : '—'} />
          <Row icon={<CalendarDays className="h-4 w-4" />} label="Expected end" value={fmtDate(endDate)} />
          <Row icon={<Landmark className="h-4 w-4" />} label="Funding mode" value={tenant.funding_mode === 'self_managed' ? 'Self managed' : 'Managed by Welile'} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
