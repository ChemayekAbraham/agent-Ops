/// <reference types="google.maps" />
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, Home, DoorOpen, Navigation, Loader2, ExternalLink, List } from 'lucide-react';
import { useGoogleMapsLoader } from '@/hooks/useGoogleMapsLoader';
import { formatUGX } from '@/lib/rentCalculations';
import type { HouseListing } from '@/hooks/useHouseListings';

interface HousesMapViewProps {
  listings: HouseListing[];
  userCoords: { lat: number; lng: number } | null;
  onSelectHouse?: (listing: HouseListing) => void;
  onSwitchToList?: () => void;
}

const KAMPALA: google.maps.LatLngLiteral = { lat: 0.3476, lng: 32.5825 };

export function HousesMapView({ listings, userCoords, onSelectHouse, onSwitchToList }: HousesMapViewProps) {
  const navigate = useNavigate();
  const { isReady, isError, hasKey, errorReason } = useGoogleMapsLoader(true);
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const [selected, setSelected] = useState<HouseListing | null>(null);

  const geoListings = useMemo(
    () => listings.filter((l) => typeof l.latitude === 'number' && typeof l.longitude === 'number'),
    [listings]
  );

  // Initialize the map once the API is ready.
  useEffect(() => {
    if (!isReady || !mapEl.current || mapRef.current) return;
    mapRef.current = new google.maps.Map(mapEl.current, {
      center: userCoords ?? geoListings[0]
        ? userCoords ?? { lat: geoListings[0].latitude!, lng: geoListings[0].longitude! }
        : KAMPALA,
      zoom: 12,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      clickableIcons: false,
      gestureHandling: 'greedy',
    });
  }, [isReady, userCoords, geoListings]);

  // Render / refresh markers when listings change.
  useEffect(() => {
    const map = mapRef.current;
    if (!isReady || !map) return;

    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    const bounds = new google.maps.LatLngBounds();

    if (userCoords) {
      const youMarker = new google.maps.Marker({
        position: userCoords,
        map,
        title: 'You are here',
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 7,
          fillColor: '#2563eb',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 3,
        },
        zIndex: 999,
      });
      markersRef.current.push(youMarker);
      bounds.extend(userCoords);
    }

    geoListings.forEach((listing) => {
      const pos = { lat: listing.latitude!, lng: listing.longitude! };
      const marker = new google.maps.Marker({
        position: pos,
        map,
        title: listing.title,
      });
      marker.addListener('click', () => {
        setSelected(listing);
        map.panTo(pos);
      });
      markersRef.current.push(marker);
      bounds.extend(pos);
    });

    if (!bounds.isEmpty()) {
      if (geoListings.length + (userCoords ? 1 : 0) === 1) {
        map.setCenter(bounds.getCenter());
        map.setZoom(15);
      } else {
        map.fitBounds(bounds, 48);
      }
    }
  }, [isReady, geoListings, userCoords]);

  if (!hasKey || isError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 px-6 text-center">
        <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center">
          <MapPin className="h-8 w-8 text-muted-foreground/50" />
        </div>
        <div className="space-y-1 max-w-xs">
          <p className="text-base font-semibold text-foreground">Map unavailable</p>
          <p className="text-sm text-muted-foreground">
            The map couldn't load right now. Switch to the list view to keep browsing houses.
          </p>
          {errorReason === 'referrer' && (
            <p className="text-[11px] text-muted-foreground/70">
              Maps key is not authorised for this website address. A manager can fix this in
              Settings, under Map key.
            </p>
          )}
        </div>
        {onSwitchToList && (
          <button
            type="button"
            onClick={onSwitchToList}
            className="inline-flex items-center gap-2 min-h-[44px] px-5 rounded-full bg-primary text-primary-foreground font-semibold text-sm active:scale-[0.98] transition-transform"
          >
            <List className="h-4 w-4" /> Switch to List view
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {!isReady && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-muted/20">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">Loading map…</p>
          </div>
        </div>
      )}
      <div ref={mapEl} className="h-full w-full" />

      {geoListings.length === 0 && isReady && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 bg-card/95 border border-border rounded-full px-4 py-2 shadow-md">
          <p className="text-xs text-muted-foreground">No mapped houses in this area yet</p>
        </div>
      )}

      {/* Selected house card */}
      {selected && (
        <div className="absolute bottom-3 left-3 right-3 z-20">
          <div className="rounded-2xl border border-border bg-card shadow-xl overflow-hidden">
            <div className="flex gap-3 p-3">
              <div className="h-20 w-20 shrink-0 rounded-xl overflow-hidden bg-muted">
                {selected.image_urls?.[0] ? (
                  <img src={selected.image_urls[0]} alt={selected.title} className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center"><Home className="h-7 w-7 text-muted-foreground/30" /></div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-sm truncate">{selected.title}</p>
                <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                  <MapPin className="h-3 w-3 shrink-0" />
                  <span className="truncate">{selected.region}{selected.district ? `, ${selected.district}` : ''}</span>
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                  <DoorOpen className="h-3 w-3" />
                  <span>{selected.number_of_rooms} room{selected.number_of_rooms > 1 ? 's' : ''}</span>
                </div>
                <p className="text-base font-black text-success leading-none mt-1">{formatUGX(selected.daily_rate)}<span className="text-[10px] font-medium text-muted-foreground"> /day</span></p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label="Close"
                className="self-start text-muted-foreground/70 hover:text-foreground p-1"
              >
                ✕
              </button>
            </div>
            <div className="flex gap-2 px-3 pb-3">
              <button
                type="button"
                onClick={() => {
                  if (onSelectHouse) onSelectHouse(selected);
                  else navigate(`/house/${selected.id}`);
                }}
                className="flex-1 inline-flex items-center justify-center gap-1.5 min-h-[44px] rounded-full bg-primary text-primary-foreground font-bold text-sm active:scale-[0.98] transition-transform"
              >
                <Home className="h-4 w-4" /> View house
              </button>
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${selected.latitude},${selected.longitude}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Get directions to ${selected.title}`}
                className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-full border border-border bg-background font-semibold text-sm active:scale-[0.98] transition-transform"
              >
                <Navigation className="h-4 w-4" /> Directions
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default HousesMapView;