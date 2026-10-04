import { useState }  from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import {
  Loader2, Home, MapPin, User, UserCog, Building2, Droplet, Zap, Shield, Car, Sofa,
  Calendar, Hash, EyeOff, CheckCircle2, Image as ImageIcon, Phone, Tag, ZoomIn,
  ChevronLeft, ChevronRight, X, Share2, MessageCircle, Copy,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { ImageZoomLightbox } from './ImageZoomLightbox';

interface Props {
  houseId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function HouseDetailsDialog({ houseId, onOpenChange }: Props) {
  const open = !!houseId;
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    enabled: open,
    queryKey: ['landlord-ops-house-full', houseId],
    queryFn: async () => {
      const { data: house, error } = await supabase
        .from('house_listings')
        .select('*')
        .eq('id', houseId!)
        .maybeSingle();
      if (error) throw error;
      if (!house) return null;
      const ids = [house.agent_id, house.landlord_id, house.tenant_id].filter(Boolean) as string[];
      let profiles: Record<string, { name: string; phone: string | null }> = {};
      if (ids.length) {
        const { data: profs } = await supabase
          .from('profiles').select('id,full_name,phone').in('id', ids);
        for (const p of (profs ?? []) as any[]) {
          profiles[p.id] = { name: p.full_name || 'Unnamed', phone: p.phone ?? null };
        }
      }
      // Share analytics for this listing
      const { data: shareRows } = await supabase
        .from('house_share_events')
        .select('share_method')
        .eq('listing_id', houseId!);
      const shares = { total: 0, native: 0, whatsapp: 0, copy: 0 };
      for (const r of (shareRows ?? []) as Array<{ share_method: string }>) {
        shares.total += 1;
        if (r.share_method === 'native') shares.native += 1;
        else if (r.share_method === 'whatsapp') shares.whatsapp += 1;
        else if (r.share_method === 'copy') shares.copy += 1;
      }
      return { house, profiles, shares };
    },
  });

  const house: any = data?.house;
  const profs = data?.profiles ?? {};
  const shares = data?.shares ?? { total: 0, native: 0, whatsapp: 0, copy: 0 };
  const agent = house?.agent_id ? profs[house.agent_id] : null;
  const landlord = house?.landlord_id ? profs[house.landlord_id] : null;
  const tenant = house?.tenant_id ? profs[house.tenant_id] : null;

  const amenityChips: Array<{ icon: any; label: string; on: boolean }> = house ? [
    { icon: Droplet, label: 'Water',       on: !!house.has_water },
    { icon: Zap,     label: 'Electricity', on: !!house.has_electricity },
    { icon: Shield,  label: 'Security',    on: !!house.has_security },
    { icon: Car,     label: 'Parking',     on: !!house.has_parking },
    { icon: Sofa,    label: 'Furnished',   on: !!house.is_furnished },
  ] : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Home className="h-5 w-5 text-primary" />
            {house?.title || 'House details'}
          </DialogTitle>
          <DialogDescription>
            Everything the listing agent registered about this property.
          </DialogDescription>
        </DialogHeader>

        {isLoading || !house ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            {/* Status badges */}
            <div className="flex flex-wrap gap-1.5">
              <Badge variant={house.tenant_id ? 'default' : 'secondary'}>
                {house.tenant_id ? 'Occupied' : 'Vacant'}
              </Badge>
              <Badge variant="outline">{house.status}</Badge>
              {house.verified && (
                <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200 gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Verified
                </Badge>
              )}
              {house.is_hidden && (
                <Badge className="bg-amber-100 text-amber-800 border-amber-200 gap-1">
                  <EyeOff className="h-3 w-3" /> Hidden from tenants
                </Badge>
              )}
              {house.house_category && (
                <Badge variant="outline" className="gap-1">
                  <Tag className="h-3 w-3" /> {house.house_category}
                </Badge>
              )}
              {house.short_code && (
                <Badge variant="outline" className="gap-1">
                  <Hash className="h-3 w-3" /> {house.short_code}
                </Badge>
              )}
            </div>

            {/* Photos */}
            {Array.isArray(house.image_urls) && house.image_urls.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {house.image_urls.map((u: string, i: number) => (
                  <button
                    key={i}
                    onClick={() => setZoomIndex(i)}
                    className="relative group overflow-hidden rounded-md border"
                  >
                    <img
                      src={u}
                      alt={`${house.title} photo ${i + 1}`}
                      loading="lazy"
                      className="h-28 w-full object-cover transition group-hover:scale-105"
                    />
                    <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30 transition">
                      <ZoomIn className="h-6 w-6 text-white opacity-1 group-hover:opacity-100" />
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-md border bg-muted/30 py-6 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
                <ImageIcon className="h-4 w-4" /> No photos uploaded by agent
              </div>
            )}

            {/* Zoom lightbox */}
            <ImageZoomLightbox
              images={house.image_urls || []}
              startIndex={zoomIndex}
              open={zoomIndex !== null}
              onClose={() => setZoomIndex(null)}
              altPrefix={house.title}
            />

            {/* Description */}
            {house.description && (
              <Section title="Description">
                <p className="whitespace-pre-wrap text-muted-foreground leading-relaxed">
                  {house.description}
                </p>
              </Section>
            )}

            {/* Location */}
            <Section title="Location" icon={MapPin}>
              <Row k="Address" v={house.address || '—'} />
              <Row k="Region" v={house.region || '—'} />
              <Row k="District" v={house.district || '—'} />
              <Row k="Sub-county / Ward" v={house.sub_county || '—'} />
              <Row k="Village" v={house.village || '—'} />
              {house.latitude && house.longitude && (
                <Row
                  k="GPS"
                  v={
                    <a
                      href={`https://www.google.com/maps?q=${house.latitude},${house.longitude}`}
                      target="_blank" rel="noreferrer"
                      className="text-primary underline"
                    >
                      {Number(house.latitude).toFixed(5)}, {Number(house.longitude).toFixed(5)} (open in Maps)
                    </a>
                  }
                />
              )}
            </Section>

            {/* Property */}
            <Section title="Property" icon={Building2}>
              <Row k="Rooms" v={house.number_of_rooms?.toString() ?? '—'} />
              <Row k="Category" v={house.house_category || '—'} />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {amenityChips.map(a => {
                  const Icon = a.icon;
                  return (
                    <Badge
                      key={a.label}
                      variant={a.on ? 'default' : 'outline'}
                      className={`gap-1 text-[10px] ${a.on ? '' : 'opacity-50 line-through'}`}
                    >
                      <Icon className="h-3 w-3" /> {a.label}
                    </Badge>
                  );
                })}
              </div>
              {Array.isArray(house.amenities) && house.amenities.length > 0 && (
                <div className="pt-2">
                  <p className="text-[11px] font-medium mb-1">Extra amenities</p>
                  <div className="flex flex-wrap gap-1">
                    {house.amenities.map((a: string) => (
                      <Badge key={a} variant="secondary" className="text-[10px]">{a}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </Section>

            {/* Pricing */}
            <Section title="Pricing (UGX)" icon={Tag}>
              <Row k="Monthly rent" v={formatUGX(house.monthly_rent)} />
              <Row k="Access fee" v={formatUGX(house.access_fee || 0)} />
              <Row k="Platform fee" v={formatUGX(house.platform_fee || 0)} />
              <Row k="Total monthly cost" v={<strong>{formatUGX(house.total_monthly_cost || house.monthly_rent)}</strong>} />
              <Row k="Daily rate" v={formatUGX(house.daily_rate)} />
            </Section>

            {/* People */}
            <Section title="People" icon={User}>
              <PersonRow icon={UserCog} label="Listing agent" name={agent?.name} phone={agent?.phone} id={house.agent_id} />
              <PersonRow icon={Building2} label="Landlord" name={landlord?.name} phone={landlord?.phone} id={house.landlord_id} />
              <PersonRow icon={User} label="Tenant" name={tenant?.name} phone={tenant?.phone} id={house.tenant_id} />
            </Section>

            {/* Meta */}
            <Section title="Registration" icon={Calendar}>
              <Row k="Listed on" v={new Date(house.created_at).toLocaleString()} />
              {house.updated_at && <Row k="Last updated" v={new Date(house.updated_at).toLocaleString()} />}
              <Row k="Listing ID" v={<code className="text-[10px]">{house.id}</code>} />
            </Section>

            {/* Sharing */}
            <Section title="Sharing" icon={Share2}>
              <Row k="Total shares" v={<strong>{shares.total.toLocaleString()}</strong>} />
              <div className="flex flex-wrap gap-1.5 pt-1">
                <Badge variant="outline" className="gap-1 text-[10px]">
                  <Share2 className="h-3 w-3" /> Native {shares.native}
                </Badge>
                <Badge variant="outline" className="gap-1 text-[10px]">
                  <MessageCircle className="h-3 w-3" /> WhatsApp {shares.whatsapp}
                </Badge>
                <Badge variant="outline" className="gap-1 text-[10px]">
                  <Copy className="h-3 w-3" /> Copy link {shares.copy}
                </Badge>
              </div>
            </Section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon?: any; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <p className="font-semibold text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1.5 mb-2">
        {Icon && <Icon className="h-3.5 w-3.5" />} {title}
      </p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-[12px]">
      <span className="text-muted-foreground shrink-0">{k}</span>
      <span className="text-right break-words">{v}</span>
    </div>
  );
}

function PersonRow({ icon: Icon, label, name, phone, id }: any) {
  return (
    <div className="flex items-start gap-2 text-[12px]">
      <Icon className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-[11px]">{label}</p>
        {id ? (
          <>
            <p className="font-medium truncate">{name || 'Unnamed'}</p>
            {phone && (
              <a href={`tel:${phone}`} className="text-primary text-[11px] flex items-center gap-1">
                <Phone className="h-3 w-3" /> {phone}
              </a>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">—</p>
        )}
      </div>
    </div>
  );
}