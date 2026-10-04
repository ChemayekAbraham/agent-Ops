import { useEffect, useRef, useState } from 'react';
import { Search, X, MapPin, User, Building2, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { useLocationSearch, hitToPath, type LocationSearchHit } from '@/hooks/useLocationSearch';
import type { BreadcrumbPath } from '@/hooks/useLocationBreakdown';

const ICON: Record<LocationSearchHit['kind'], any> = {
  country: MapPin, region: MapPin, district: MapPin, ward: MapPin,
  agent: User, landlord: Building2,
};

interface Props {
  onPick: (path: BreadcrumbPath) => void;
}

export function LocationSearchBar({ onPick }: Props) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data, isFetching } = useLocationSearch(q);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === 'Escape') {
        setQ(''); setOpen(false); inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search any country, region, district, agent, landlord…  ( press / )"
        className="pl-9 pr-9 h-11"
      />
      {q && (
        <button onClick={() => { setQ(''); inputRef.current?.focus(); }} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground" aria-label="Clear">
          <X className="h-4 w-4" />
        </button>
      )}
      {open && q.trim().length >= 2 && (
        <Card className="absolute top-full left-0 right-0 mt-1 max-h-[60vh] overflow-y-auto z-30 shadow-lg">
          {isFetching && (
            <div className="p-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Searching…
            </div>
          )}
          {data && data.length === 0 && !isFetching && (
            <div className="p-4 text-center text-xs text-muted-foreground">No matches.</div>
          )}
          {data && data.map((h, i) => {
            const Icon = ICON[h.kind];
            return (
              <button
                key={`${h.kind}-${i}-${h.label}`}
                onMouseDown={(e) => { e.preventDefault(); onPick(hitToPath(h)); setOpen(false); setQ(''); }}
                className="w-full text-left px-3 py-2 hover:bg-muted/60 flex items-center gap-2 border-b last:border-0"
              >
                <Icon className="h-4 w-4 text-primary shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{h.label}</p>
                  <p className="text-[10px] text-muted-foreground capitalize">{h.kind}</p>
                </div>
                <span className="text-[10px] text-muted-foreground">{h.total.toLocaleString()} houses</span>
              </button>
            );
          })}
        </Card>
      )}
    </div>
  );
}