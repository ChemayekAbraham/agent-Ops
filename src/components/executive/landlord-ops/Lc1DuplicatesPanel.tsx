import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, Phone, Loader2, MapPin, GitMerge, ShieldCheck, FileText } from 'lucide-react';

interface DupRow {
  id: string;
  name: string | null;
  phone: string | null;
  village: string | null;
  verified: boolean | null;
  created_at: string | null;
  normalized_phone: string | null;
  rent_request_count: number | null;
}

interface DupGroup {
  phone: string;
  rows: DupRow[];
}

interface Props {
  onResolved?: () => void;
}

/**
 * Landlord Ops tool to review LC1 chairpersons whose phone number appears more
 * than once and merge the duplicates into a single canonical record. The merge
 * repoints every linked rent request, carries verified status across, and
 * deletes the leftover duplicate rows via the `merge_lc1_duplicates` RPC.
 */
export function Lc1DuplicatesPanel({ onResolved }: Props) {
  const { toast } = useToast();
  const [groups, setGroups] = useState<DupGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [canonical, setCanonical] = useState<Record<string, string>>({});
  const [busyPhone, setBusyPhone] = useState<string | null>(null);

  // Default canonical = verified first, then most rent requests, then oldest.
  const pickDefault = (rows: DupRow[]): string =>
    [...rows].sort((a, b) => {
      if (!!b.verified !== !!a.verified) return b.verified ? 1 : -1;
      const rc = (b.rent_request_count ?? 0) - (a.rent_request_count ?? 0);
      if (rc !== 0) return rc;
      return (a.created_at ?? '').localeCompare(b.created_at ?? '');
    })[0]?.id;

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('v_lc1_phone_duplicates')
      .select('id, name, phone, village, verified, created_at, normalized_phone, rent_request_count');
    if (error) {
      setLoading(false);
      return;
    }
    const byPhone = new Map<string, DupRow[]>();
    (data ?? []).forEach((r) => {
      const key = r.normalized_phone ?? r.phone ?? r.id!;
      if (!byPhone.has(key)) byPhone.set(key, []);
      byPhone.get(key)!.push(r as DupRow);
    });
    const grouped: DupGroup[] = Array.from(byPhone.entries())
      .map(([phone, rows]) => ({
        phone,
        rows: rows.sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0)),
      }))
      .sort((a, b) => b.rows.length - a.rows.length);
    setGroups(grouped);
    setCanonical((prev) => {
      const next = { ...prev };
      grouped.forEach((g) => {
        if (!next[g.phone] || !g.rows.some((r) => r.id === next[g.phone])) {
          next[g.phone] = pickDefault(g.rows);
        }
      });
      return next;
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const totalDuplicates = useMemo(
    () => groups.reduce((sum, g) => sum + Math.max(0, g.rows.length - 1), 0),
    [groups],
  );

  const handleMerge = async (group: DupGroup) => {
    const canonicalId = canonical[group.phone];
    if (!canonicalId) return;
    const duplicateIds = group.rows.map((r) => r.id).filter((id) => id !== canonicalId);
    if (duplicateIds.length === 0) return;
    setBusyPhone(group.phone);
    try {
      const { data, error } = await supabase.rpc('merge_lc1_duplicates', {
        p_canonical_id: canonicalId,
        p_duplicate_ids: duplicateIds,
      });
      if (error) throw error;
      const moved = (data as any)?.moved_rent_requests ?? 0;
      const deleted = (data as any)?.deleted ?? duplicateIds.length;
      toast({
        title: '✅ Duplicates merged',
        description: `Removed ${deleted} duplicate record(s)${moved ? `, moved ${moved} rent request(s)` : ''}.`,
      });
      setGroups((prev) => prev.filter((g) => g.phone !== group.phone));
      onResolved?.();
    } catch (err: any) {
      toast({
        title: 'Merge failed',
        description: err?.message || 'Could not merge these LC1 records.',
        variant: 'destructive',
      });
    } finally {
      setBusyPhone(null);
    }
  };

  if (loading || groups.length === 0) return null;

  return (
    <div className="rounded-2xl border-2 border-violet-500/50 bg-violet-50/60 dark:bg-violet-500/5 p-4 space-y-3 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="p-2 rounded-xl bg-violet-500/15">
          <GitMerge className="h-[18px] w-[18px] text-violet-600 shrink-0" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-sm leading-tight flex items-center gap-2">
            Duplicate LC1 chairpersons
            <Badge className="bg-violet-600 text-white hover:bg-violet-600">{groups.length}</Badge>
          </p>
          <p className="text-[11px] text-muted-foreground leading-snug">
            {totalDuplicates} duplicate record(s) across {groups.length} phone number(s). Pick the record to keep, then merge.
          </p>
        </div>
      </div>

      <ul className="space-y-3">
        {groups.map((group) => {
          const selected = canonical[group.phone];
          return (
            <li key={group.phone} className="rounded-xl border border-violet-500/40 bg-background p-3 space-y-2.5">
              <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5 shrink-0" /> {group.phone}
                <span className="font-normal">· {group.rows.length} records</span>
              </p>

              <div className="space-y-1.5">
                {group.rows.map((r) => {
                  const isCanonical = r.id === selected;
                  return (
                    <label
                      key={r.id}
                      className={`flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer transition-colors ${
                        isCanonical ? 'border-violet-500 bg-violet-500/5' : 'border-border hover:bg-muted/50'
                      }`}
                    >
                      <input
                        type="radio"
                        name={`canonical-${group.phone}`}
                        checked={isCanonical}
                        onChange={() => setCanonical((prev) => ({ ...prev, [group.phone]: r.id }))}
                        className="mt-1 accent-violet-600"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate flex items-center gap-1.5">
                          {r.name || 'Unnamed'}
                          {r.verified && (
                            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                          )}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                          {r.village && (
                            <span className="flex items-center gap-1 truncate">
                              <MapPin className="h-3 w-3 shrink-0" /> {r.village}
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <FileText className="h-3 w-3 shrink-0" /> {r.rent_request_count ?? 0} rent request(s)
                          </span>
                        </div>
                      </div>
                      {isCanonical && (
                        <Badge variant="outline" className="shrink-0 border-violet-500/50 text-violet-700 text-[10px]">
                          Keep
                        </Badge>
                      )}
                    </label>
                  );
                })}
              </div>

              <Button
                size="sm"
                className="w-full bg-violet-600 hover:bg-violet-700 text-white"
                disabled={busyPhone === group.phone || !selected}
                onClick={() => handleMerge(group)}
              >
                {busyPhone === group.phone ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                )}
                Merge {group.rows.length - 1} duplicate(s) into the kept record
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}