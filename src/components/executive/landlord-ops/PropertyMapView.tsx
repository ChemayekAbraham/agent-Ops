import { useState, useCallback, useMemo, lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Layers } from 'lucide-react';
import type { ClusterData } from './PropertyMapLeaflet';

const LeafletMap = lazy(() => import('./PropertyMapLeaflet'));

type StatusFilter = 'all' | 'empty' | 'occupied' | 'requested' | 'paid';

const FILTER_OPTIONS: { value: StatusFilter; label: string; color: string; dot: string }[] = [
  { value: 'all', label: 'All', color: 'bg-muted text-foreground', dot: 'bg-foreground' },
  { value: 'empty', label: 'Empty', color: 'bg-red-500/10 text-red-700', dot: 'bg-red-500' },
  { value: 'occupied', label: 'Occupied', color: 'bg-blue-500/10 text-blue-700', dot: 'bg-blue-500' },
  { value: 'requested', label: 'Rent Requested', color: 'bg-amber-500/10 text-amber-700', dot: 'bg-amber-500' },
  { value: 'paid', label: 'Rent Paid', color: 'bg-green-500/10 text-green-700', dot: 'bg-green-500' },
];

interface ViewportBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export function PropertyMapView() {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [viewport, setViewport] = useState<ViewportBounds | null>(null);
  const [zoom, setZoom] = useState(7);

  // Lightweight total counts (no geo filter)
  const { data: counts } = useQuery({
    queryKey: ['property-counts'],
    queryFn: async () => {
      const { data } = await supabase.rpc('get_property_status_counts');
      if (data && Array.isArray(data) && data.length > 0) {
        const row = data[0] as any;
        return {
          all: Number(row.total_count || 0),
          empty: Number(row.empty_count || 0),
          occupied: Number(row.occupied_count || 0),
          requested: 0,
          paid: 0,
          withGps: Number(row.with_gps || 0),
        };
      }
      return { all: 0, empty: 0, occupied: 0, requested: 0, paid: 0, withGps: 0 };
    },
    staleTime: 60000,
  });

  // Viewport-based cluster/property query
  const { data: mapData = [], isFetching } = useQuery({
    queryKey: ['property-clusters', viewport?.minLat, viewport?.maxLat, viewport?.minLng, viewport?.maxLng, zoom, filter],
    queryFn: async () => {
      if (!viewport) return [];
      const { data, error } = await supabase.rpc('get_property_clusters', {
        min_lat: viewport.minLat,
        max_lat: viewport.maxLat,
        min_lng: viewport.minLng,
        max_lng: viewport.maxLng,
        zoom_level: zoom,
        status_filter: filter === 'all' ? null : filter,
      });
      if (error) {
        console.error('Cluster RPC error:', error);
        return [];
      }
      return (data || []) as ClusterData[];
    },
    enabled: !!viewport,
    staleTime: 30000,
    placeholderData: (prev) => prev,
  });

  const handleViewportChange = useCallback((bounds: ViewportBounds, z: number) => {
    setViewport(bounds);
    setZoom(z);
  }, []);

  const visibleCount = useMemo(() => {
    if (!mapData.length) return 0;
    return mapData.reduce((sum, d) => sum + (d.property_count || 1), 0);
  }, [mapData]);

  return (
    <div className="space-y-3">
      {/* Filter Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold text-muted-foreground">Filter:</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTER_OPTIONS.map(opt => (
            <Button
              key={opt.value}
              size="sm"
              variant={filter === opt.value ? 'default' : 'outline'}
              className={`h-7 text-[11px] gap-1.5 px-2.5 ${filter === opt.value ? '' : opt.color}`}
              onClick={() => setFilter(opt.value)}
            >
              <span className={`h-2.5 w-2.5 rounded-full ${opt.dot}`} />
              {opt.label}
              {counts && (
                <Badge variant="secondary" className="text-[9px] h-4 px-1 ml-0.5 bg-background/50">
                  {counts[opt.value].toLocaleString()}
                </Badge>
              )}
            </Button>
          ))}
        </div>
      </div>

      {/* Map */}
      <div className="rounded-2xl overflow-hidden border-2 border-border shadow-lg" style={{ height: 'calc(100vh - 280px)', minHeight: '400px' }}>
        <Suspense fallback={
          <div className="flex items-center justify-center h-full bg-muted/10">
            <div className="text-center space-y-3">
              <div className="h-8 w-8 border-3 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="text-sm text-muted-foreground">Loading map…</p>
            </div>
          </div>
        }>
          <LeafletMap
            data={mapData}
            onViewportChange={handleViewportChange}
            isLoading={isFetching}
          />
        </Suspense>
      </div>

      {/* Summary */}
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground justify-center">
        <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-full bg-red-500" /> Empty: {counts?.empty.toLocaleString() || '—'}</span>
        <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-full bg-blue-500" /> Occupied: {counts?.occupied.toLocaleString() || '—'}</span>
        <span className="font-semibold text-foreground">
          Total: {counts?.all.toLocaleString() || '—'} | GPS: {counts?.withGps.toLocaleString() || '—'} | Viewing: {visibleCount.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
