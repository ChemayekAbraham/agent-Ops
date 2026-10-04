import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Home, MapPin, DoorOpen, CheckCircle, Clock, AlertTriangle, User, UserCog, Pencil, Calendar, Phone, Building2 } from 'lucide-react';
import { HouseListing } from '@/hooks/useHouseListings';
import { formatUGX } from '@/lib/rentCalculations';
import { HouseActivityTimeline } from '@/components/shared/HouseActivityTimeline';
import { MoveInOfferBadge } from '@/components/house/MoveInOfferBadge';

interface HouseDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listing: HouseListing | null;
  tenant?: { name: string; phone: string | null } | null;
  landlord?: { name: string; phone: string | null } | null;
  activeRequest?: { id: string; agent_id: string | null } | null;
  onChangeTenantProfile?: (tenantId: string) => void;
  onReassignAgent?: (args: { rentRequestId: string; tenantName: string; currentAgentId: string }) => void;
}

function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'available') {
    return <Badge className="gap-1"><CheckCircle className="h-3 w-3" /> Available</Badge>;
  }
  if (status === 'occupied') {
    return <Badge variant="secondary" className="gap-1"><DoorOpen className="h-3 w-3" /> Occupied</Badge>;
  }
  if (status === 'rejected') {
    return <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" /> Rejected</Badge>;
  }
  return <Badge variant="secondary" className="gap-1"><Clock className="h-3 w-3" /> {status}</Badge>;
}

export function HouseDetailSheet({
  open,
  onOpenChange,
  listing,
  tenant,
  landlord,
  activeRequest,
  onChangeTenantProfile,
  onReassignAgent,
}: HouseDetailSheetProps) {
  if (!listing) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[92vh] rounded-t-3xl p-0 flex flex-col">
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border">
          <SheetTitle className="flex items-center gap-2 pr-6">
            <Home className="h-5 w-5 text-primary shrink-0" />
            <span className="truncate">{listing.title}</span>
          </SheetTitle>
          <div className="flex items-center gap-2 pt-1">
            <StatusBadge status={listing.status} />
            {listing.short_code && (
              <span className="text-[11px] font-mono text-muted-foreground">#{listing.short_code}</span>
            )}
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 space-y-5">
          {/* Location */}
          <section className="space-y-1">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Location</p>
            <div className="flex items-start gap-2 text-sm">
              <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <span>{listing.address}{listing.region ? `, ${listing.region}` : ''}</span>
            </div>
          </section>

          {/* Rent */}
          <section className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">Monthly rent</p>
              <p className="font-bold text-sm">{formatUGX(listing.monthly_rent)}</p>
            </div>
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">Daily rate</p>
              <p className="font-bold text-sm text-success">{formatUGX(listing.daily_rate)}</p>
            </div>
          </section>

          {/* Move-in offer — tell tenants their first 7 days are free */}
          <MoveInOfferBadge variant="banner" />

          {/* Tenant */}
          <section className="space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Tenant</p>
            {listing.tenant_id && tenant ? (
              <div className="rounded-xl border border-border bg-card p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <User className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{tenant.name}</span>
                </div>
                {tenant.phone && (
                  <a
                    href={`tel:${tenant.phone}`}
                    className="flex items-center gap-2 text-xs text-primary underline-offset-2 hover:underline"
                  >
                    <Phone className="h-3 w-3" /> {tenant.phone}
                  </a>
                )}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs gap-1"
                    onClick={() => onChangeTenantProfile?.(listing.tenant_id!)}
                  >
                    <Pencil className="h-3 w-3" /> Tenant profile
                  </Button>
                  {activeRequest && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs gap-1"
                      onClick={() => onReassignAgent?.({
                        rentRequestId: activeRequest.id,
                        tenantName: tenant.name,
                        currentAgentId: activeRequest.agent_id ?? (listing.agent_id ?? ''),
                      })}
                    >
                      <UserCog className="h-3 w-3" /> Reassign agent
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                No tenant placed yet
              </div>
            )}
          </section>

          {/* Landlord */}
          {landlord && (
            <section className="space-y-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Landlord</p>
              <div className="rounded-xl border border-border bg-card p-3 space-y-1">
                <div className="flex items-center gap-2 text-sm">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{landlord.name}</span>
                </div>
                {landlord.phone && (
                  <a
                    href={`tel:${landlord.phone}`}
                    className="flex items-center gap-2 text-xs text-primary underline-offset-2 hover:underline"
                  >
                    <Phone className="h-3 w-3" /> {landlord.phone}
                  </a>
                )}
              </div>
            </section>
          )}

          {/* Key dates */}
          <section className="space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Key dates</p>
            <div className="rounded-xl border border-border bg-card divide-y">
              <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Calendar className="h-3.5 w-3.5" /> Listed
                </span>
                <span className="font-medium">{fmtDate(listing.created_at)}</span>
              </div>
              {listing.updated_at && listing.updated_at !== listing.created_at && (
                <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Calendar className="h-3.5 w-3.5" /> Last updated
                  </span>
                  <span className="font-medium">{fmtDate(listing.updated_at)}</span>
                </div>
              )}
            </div>
          </section>

          <Separator />

          {/* Timeline */}
          <section className="space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Activity timeline</p>
            <div className="rounded-xl border border-border bg-muted/10 p-2">
              <HouseActivityTimeline houseId={listing.id} />
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}