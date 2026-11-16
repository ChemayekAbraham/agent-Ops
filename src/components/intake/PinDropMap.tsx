import 'leaflet/dist/leaflet.css';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleMarker, MapContainer, TileLayer, useMapEvents } from 'react-leaflet';
import { DEFAULT_MAP_CENTRE, networkCentre } from '@/lib/gpsCapture';

/**
 * "Drop a pin on the house": a full-screen map; the agent taps the house and the pin becomes
 * the GPS. Rendered into document.body, outside the chat's role="dialog", because on Android
 * index.css strips transforms inside dialogs and Leaflet moves its tiles with transforms.
 */
export default function PinDropMap({ near, onPick, onCancel }: {
  /** The last known reading, if any; else the phone's rough network location; else Kampala. */
  near?: { lat: number; lng: number } | null;
  onPick: (lat: number, lng: number) => void;
  onCancel: () => void;
}) {
  const [centre, setCentre] = useState<{ lat: number; lng: number } | null>(near ?? null);
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    if (near) return;
    let live = true;
    void networkCentre(null).then((c) => { if (live) setCentre(c); });
    return () => { live = false; };
  }, [near]);
  const at = centre ?? DEFAULT_MAP_CENTRE;

  return createPortal(
    <div className="fixed inset-0 z-[140] flex flex-col bg-background" role="region" aria-label="Drop a pin on the house" data-testid="pin-drop-map">
      <div className="border-b border-border bg-card px-4 py-3 pt-safe">
        <p className="font-display text-base font-bold">Drop a pin on the house</p>
        <p className="text-sm text-muted-foreground">Tap the house on the map. You can move the pin by tapping again.</p>
      </div>
      <div className="relative flex-1">
        <MapContainer key={`${at.lat},${at.lng}`} center={[at.lat, at.lng]} zoom={centre ? 17 : 12} className="h-full w-full" zoomControl>
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
          <TapToPin onTap={(lat, lng) => setPin({ lat, lng })} />
          {pin && <CircleMarker center={[pin.lat, pin.lng]} radius={10} pathOptions={{ color: '#7c3aed', fillOpacity: 0.6 }} />}
        </MapContainer>
      </div>
      <div className="flex gap-2 border-t border-border bg-card px-4 py-3 pb-safe">
        <button type="button" onClick={onCancel} className="h-12 flex-1 rounded-xl border border-border font-semibold">Cancel</button>
        <button type="button" disabled={!pin} onClick={() => pin && onPick(pin.lat, pin.lng)}
          className="h-12 flex-[2] rounded-xl bg-primary font-semibold text-primary-foreground disabled:opacity-50">
          Use this pin
        </button>
      </div>
    </div>,
    document.body,
  );
}

function TapToPin({ onTap }: { onTap: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onTap(e.latlng.lat, e.latlng.lng) });
  return null;
}
