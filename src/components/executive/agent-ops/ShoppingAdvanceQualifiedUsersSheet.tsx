import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ChevronRight, MapPin } from 'lucide-react';

type Row = {
  user_id: string;
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

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) setPath([]); onOpenChange(o); }}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Qualified users by location</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-1 text-sm">
            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setPath([])}>All</Button>
            {path.map((p, i) => (
              <span key={i} className="flex items-center gap-1">
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
                <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setPath(path.slice(0, i + 1))}>{p}</Button>
              </span>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            {isLoading ? 'Loading…' : isError ? 'Unavailable' :
              `${scoped.length.toLocaleString('en-US')} users · grouped by ${level.label.toLowerCase()}`}
          </p>
          <div className="divide-y divide-border rounded-md border border-border">
            {groups.map(([name, count]) => {
              const clickable = canDrill && name !== NONE;
              return (
                <button
                  key={name}
                  type="button"
                  disabled={!clickable}
                  onClick={() => clickable && setPath([...path, name])}
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
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default ShoppingAdvanceQualifiedUsersSheet;
