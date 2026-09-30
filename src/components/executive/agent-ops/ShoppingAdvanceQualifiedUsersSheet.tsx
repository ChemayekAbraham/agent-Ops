import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChevronRight, MapPin, ArrowLeft, Search } from 'lucide-react';

type Row = {
  user_id: string;
  full_name: string | null; phone: string | null; email: string | null; national_id: string | null;
  occupation: string | null; primary_persona: string | null; verified: boolean | null;
  phone_verified: boolean | null; is_frozen: boolean | null; created_at: string | null;
  last_active_at: string | null; continent: string | null; town: string | null; city: string | null;
  landmark: string | null; residence_lat: number | null; residence_lng: number | null;
  location_source: string | null; mobile_money_provider: string | null; mobile_money_number: string | null;
  transfer_count: number | null; transfer_total: number | null;
  first_transfer_at: string | null; last_transfer_at: string | null;
  country: string | null; region: string | null; district: string | null;
  sub_county: string | null; parish: string | null; village: string | null;
};

const LEVELS = [
  { key: 'country', label: 'Country' },
  { key: 'region', label: 'Region' },
  { key: 'district', label: 'District' },
  { key: 'sub_county', label: 'Sub county' },
  { key: 'parish', label: 'Parish' },
  { key: 'village', label: 'Village' },
] as const;
type LevelKey = (typeof LEVELS)[number]['key'];
const NONE = 'No location recorded';
const norm = (v: string | null) => (v ?? '').trim() || NONE;

export function ShoppingAdvanceQualifiedUsersSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [path, setPath] = useState<string[]>([]);
  const [selected, setSelected] = useState<Row | null>(null);
  const [q, setQ] = useState('');
  const [listMode, setListMode] = useState(false);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['agent-ops-shopping-advance-qualified-profiles'],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_ops_shopping_advance_qualified_profiles');
      if (error) throw error;
      return (data ?? []) as Row[];
    },
    staleTime: 60_000,
  });

  const depth = path.length;
  const level = LEVELS[Math.min(depth, LEVELS.length - 1)];

  const { groups, scoped } = useMemo(() => {
    const scoped = (data ?? []).filter((r) =>
      path.every((p, i) => norm(r[LEVELS[i].key as LevelKey]) === p));
    const m = new Map<string, number>();
    scoped.forEach((r) => { const k = norm(r[level.key]); m.set(k, (m.get(k) ?? 0) + 1); });
    const groups = [...m.entries()].sort((a, b) =>
      (a[0] === NONE ? 1 : b[0] === NONE ? -1 : b[1] - a[1]));
    return { groups, scoped };
  }, [data, path, level.key]);

  const canDrill = depth < LEVELS.length - 1;
  const showUsers = listMode || depth >= LEVELS.length - 1;
  const users = useMemo(() => {
    const t = q.trim().toLowerCase();
    return scoped.filter((r) => !t || `${r.full_name ?? ''} ${r.phone ?? ''}`.toLowerCase().includes(t));
  }, [scoped, q]);
  const fmtD = (v: string | null) => (v ? new Date(v).toLocaleString('en-GB') : '—');
  const fields = (r: Row): [string, string][] => [
    ['Phone', r.phone ?? '—'], ['Email', r.email ?? '—'], ['National ID', r.national_id ?? '—'],
    ['Occupation', r.occupation ?? '—'], ['Role', r.primary_persona ?? '—'],
    ['Verified', r.verified ? 'Yes' : 'No'], ['Phone verified', r.phone_verified ? 'Yes' : 'No'],
    ['Frozen', r.is_frozen ? 'Yes' : 'No'], ['Joined', fmtD(r.created_at)], ['Last active', fmtD(r.last_active_at)],
    ['Continent', r.continent ?? '—'], ['Country', r.country ?? '—'], ['Region', r.region ?? '—'],
    ['District', r.district ?? '—'], ['County', '—'], ['Sub county', r.sub_county ?? '—'],
    ['Parish', r.parish ?? '—'], ['Village', r.village ?? '—'], ['Town / City', r.town ?? r.city ?? '—'],
    ['Landmark', r.landmark ?? '—'], ['Location source', r.location_source ?? '—'],
    ['Mobile money', r.mobile_money_number ? `${r.mobile_money_provider ?? ''} ${r.mobile_money_number}` : '—'],
    ['Transfers sent', String(r.transfer_count ?? 0)],
    ['Total sent', `UGX ${Number(r.transfer_total ?? 0).toLocaleString('en-US')}`],
    ['First transfer', fmtD(r.first_transfer_at)], ['Last transfer', fmtD(r.last_transfer_at)],
  ];

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) { setPath([]); setSelected(null); setQ(''); setListMode(false); } onOpenChange(o); }}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{selected ? (selected.full_name ?? 'Unnamed user') : 'Qualified users by location'}</SheetTitle>
        </SheetHeader>
        {selected ? (
          <div className="mt-4 space-y-3">
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}><ArrowLeft className="mr-1 h-4 w-4" />Back to list</Button>
            {selected.residence_lat != null && selected.residence_lng != null && (
              <a className="inline-flex items-center gap-1 text-sm text-primary underline" target="_blank" rel="noreferrer"
                href={`https://www.google.com/maps?q=${selected.residence_lat},${selected.residence_lng}`}>
                <MapPin className="h-4 w-4" />GPS {selected.residence_lat}, {selected.residence_lng}
              </a>
            )}
            <dl className="divide-y divide-border rounded-md border border-border text-sm">
              {fields(selected).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 px-3 py-2"><dt className="text-muted-foreground">{k}</dt><dd className="text-right font-medium break-words">{v}</dd></div>
              ))}
            </dl>
          </div>
        ) : (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-1 text-sm">
            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => { setPath([]); setListMode(false); }}>All</Button>
            {path.map((p, i) => (
              <span key={i} className="flex items-center gap-1">
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
                <Button variant="link" size="sm" className="h-auto p-0" onClick={() => { setPath(path.slice(0, i + 1)); setListMode(false); }}>{p}</Button>
              </span>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            {isLoading ? 'Loading…' : isError ? 'Unavailable' :
              `${scoped.length.toLocaleString('en-US')} users · grouped by ${level.label.toLowerCase()}`}
          </p>
          {!showUsers && (
            <Button variant="outline" size="sm" onClick={() => setListMode(true)}>View all {scoped.length.toLocaleString('en-US')} users here</Button>
          )}
          {showUsers ? (
            <>
              <div className="relative"><Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input className="pl-8" placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
              <div className="divide-y divide-border rounded-md border border-border">
                {users.map((r) => (
                  <button key={r.user_id} type="button" onClick={() => setSelected(r)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/50">
                    <span><span className="block font-medium">{r.full_name ?? 'Unnamed user'}</span>
                      <span className="block text-xs text-muted-foreground">{r.phone ?? '—'}</span></span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </>
          ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {groups.map(([name, count]) => {
              const clickable = canDrill && name !== NONE;
              return (
                <button
                  key={name}
                  type="button"
                  disabled={!clickable}
                  onClick={() => { if (clickable) setPath([...path, name]); }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span className={`flex items-center gap-2 ${name === NONE ? 'text-muted-foreground italic' : 'font-medium'}`}>
                    <MapPin className="h-3.5 w-3.5 shrink-0 text-primary" />{name}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
                      {count.toLocaleString('en-US')}
                    </span>
                    {clickable && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                  </span>
                </button>
              );
            })}
          </div>
          )}
        </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default ShoppingAdvanceQualifiedUsersSheet;
