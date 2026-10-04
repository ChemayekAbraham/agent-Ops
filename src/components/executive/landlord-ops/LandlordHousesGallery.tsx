import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Loader2, Image as ImageIcon, ZoomIn, EyeOff, Eye, Home,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { ImageZoomLightbox } from './ImageZoomLightbox';

interface HouseRow {
  id: string;
  title: string | null;
  image_urls: string[] | null;
  is_hidden: boolean | null;
  status: string | null;
}

interface Props {
  landlordId: string;
  landlordName: string;
}

/**
 * Shown inside the expanded landlord card on the Landlords & Tenants view.
 * Loads the landlord's house listings, displays every uploaded photo, and
 * lets an operator remove (hide) / restore (unhide) the whole landlord from
 * the tenant-facing browse — all tenant/public listing queries respect
 * `house_listings.is_hidden`.
 */
export function LandlordHousesGallery({ landlordId, landlordName }: Props) {
  const { user } = useAuth();
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);
  const [toggling, setToggling] = useState(false);

  const { data: houses = [], isLoading, refetch } = useQuery({
    queryKey: ['landlord-ops-landlord-houses', landlordId],
    queryFn: async (): Promise<HouseRow[]> => {
      const { data, error } = await supabase
        .from('house_listings')
        .select('id, title, image_urls, is_hidden, status')
        .eq('landlord_id', landlordId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as HouseRow[];
    },
    staleTime: 30_000,
  });

  // Flatten every photo across the landlord's houses for the gallery.
  const photos = useMemo(() => {
    const out: { url: string; title: string }[] = [];
    for (const h of houses) {
      if (Array.isArray(h.image_urls)) {
        for (const u of h.image_urls) {
          if (u) out.push({ url: u, title: h.title || 'House' });
        }
      }
    }
    return out;
  }, [houses]);

  const liveHouses = houses.filter(
    (h) => h.status !== 'rejected' && h.status !== 'delisted',
  );
  const hiddenCount = liveHouses.filter((h) => h.is_hidden).length;
  const allHidden = liveHouses.length > 0 && hiddenCount === liveHouses.length;

  const toggleVisibility = async () => {
    if (liveHouses.length === 0) {
      toast.error('This landlord has no listings to hide.');
      return;
    }
    const nextHidden = !allHidden;
    const action = nextHidden ? 'remove from' : 'restore to';
    const reason = window.prompt(
      `Reason to ${action} the tenants dashboard for "${landlordName}" (min 10 characters):`,
      nextHidden ? 'Removed from tenant browse by operator' : 'Restored to tenant browse by operator',
    );
    if (reason === null) return;
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      toast.error('Please enter at least 10 characters for the reason.');
      return;
    }
    setToggling(true);
    try {
      const { error } = await supabase
        .from('house_listings')
        .update({ is_hidden: nextHidden })
        .eq('landlord_id', landlordId)
        .not('status', 'in', '(rejected,delisted)');
      if (error) throw error;

      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: nextHidden ? 'landlord_hidden_from_tenants' : 'landlord_restored_to_tenants',
        table_name: 'house_listings',
        record_id: landlordId,
        metadata: { reason: trimmed, landlord_name: landlordName, houses_affected: liveHouses.length },
      });

      toast.success(
        nextHidden
          ? `${landlordName} removed from tenants dashboard (${liveHouses.length} listing${liveHouses.length === 1 ? '' : 's'}).`
          : `${landlordName} is visible to tenants again.`,
      );
      await refetch();
    } catch (err: any) {
      console.error('toggle landlord visibility failed', err);
      toast.error(err?.message || 'Could not update visibility.');
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="rounded-lg border bg-background p-2.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Home className="h-3.5 w-3.5" /> Houses
          {liveHouses.length > 0 && (
            <span className="font-normal normal-case">
              · {liveHouses.length} listing{liveHouses.length === 1 ? '' : 's'}
            </span>
          )}
        </p>
        {allHidden && liveHouses.length > 0 && (
          <Badge className="bg-amber-100 text-amber-800 border-amber-200 gap-1 text-[10px]">
            <EyeOff className="h-3 w-3" /> Hidden from tenants
          </Badge>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : photos.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {photos.map((p, i) => (
            <button
              key={`${p.url}-${i}`}
              onClick={() => setZoomIndex(i)}
              className="relative group overflow-hidden rounded-lg border"
            >
              <img
                src={p.url}
                alt={`${p.title} photo ${i + 1}`}
                loading="lazy"
                className="h-32 w-full object-cover transition group-hover:scale-105"
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30 transition">
                <ZoomIn className="h-6 w-6 text-white opacity-0 group-hover:opacity-100" />
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-md border bg-muted/30 py-5 text-center text-[11px] text-muted-foreground flex items-center justify-center gap-2">
          <ImageIcon className="h-4 w-4" /> No house photos uploaded yet
        </div>
      )}

      <ImageZoomLightbox
        images={photos.map((p) => p.url)}
        startIndex={zoomIndex}
        open={zoomIndex !== null}
        onClose={() => setZoomIndex(null)}
        altPrefix={landlordName}
      />

      <Button
        size="sm"
        variant={allHidden ? 'outline' : 'destructive'}
        onClick={toggleVisibility}
        disabled={toggling || liveHouses.length === 0}
        className="w-full gap-1.5 text-xs"
      >
        {toggling ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : allHidden ? (
          <Eye className="h-3.5 w-3.5" />
        ) : (
          <EyeOff className="h-3.5 w-3.5" />
        )}
        {allHidden ? 'Restore to tenants dashboard' : 'Remove from tenants dashboard'}
      </Button>
    </div>
  );
}