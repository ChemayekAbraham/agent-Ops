import { ExternalLink } from 'lucide-react';

interface Props {
  lat: number;
  lng: number;
  accuracy?: number;
  height?: number;
  zoom?: number;
}

/**
 * Lightweight, key-free map preview using the OpenStreetMap embed.
 * Renders a marker at lat/lng and exposes a "view larger" link.
 */
export default function LocationMapPreview({ lat, lng, accuracy, height = 180, zoom = 16 }: Props) {
  // Bounding box approx ±0.003° around the point (~330m) for a tight view
  const d = 0.003;
  const bbox = `${lng - d}%2C${lat - d}%2C${lng + d}%2C${lat + d}`;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lng}`;
  const fullUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=${zoom}/${lat}/${lng}`;

  return (
    <div className="rounded-lg overflow-hidden border border-border bg-muted/30">
      <iframe
        title="Applicant location preview"
        src={src}
        style={{ width: '100%', height, border: 0 }}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
      />
      <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] bg-background/60">
        <span className="font-mono text-muted-foreground">
          {lat.toFixed(5)}, {lng.toFixed(5)}
          {typeof accuracy === 'number' ? ` · ±${Math.round(accuracy)}m` : ''}
        </span>
        <a
          href={fullUrl}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline inline-flex items-center gap-1"
        >
          Open map <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}