/**
 * LC1 chairperson search for the Rent Request Assistant: type a name or a
 * phone, tap the chairperson. Same table and rules as Lc1ChairpersonPicker
 * (agents may read lc1_chairpersons), shaped as a chat reply.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, MapPin, Search, ShieldCheck, UserPlus } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

export interface Lc1Hit {
  id: string;
  name: string;
  phone: string;
  village: string | null;
  district: string | null;
  verified: boolean;
}

const DEBOUNCE_MS = 350;

/** Phone-like when it is only digits, spaces and a leading +. */
const isPhoneQuery = (q: string) => /^\+?[0-9\s]+$/.test(q);

/** Local digits to match anywhere in the stored phone, whatever its format (07…, 2567…, +2567…). */
const phoneDigits = (q: string) => {
  let d = q.replace(/\D/g, '');
  if (d.startsWith('256')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return d;
};

const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export function Lc1SearchStep({
  selectedId,
  nearDistrict,
  nearVillage,
  onPick,
  onNew,
}: {
  selectedId: string | null;
  /** The house's district and village; matching chairpersons are listed first. */
  nearDistrict?: string | null;
  nearVillage?: string | null;
  onPick: (hit: Lc1Hit) => void;
  /** Register a new LC1; the typed search is passed on to pre-fill the name or phone. */
  onNew: (query: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Lc1Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const phone = isPhoneQuery(q);
    const usable = phone ? phoneDigits(q).length >= 3 : q.replace(/[^a-zA-Z]/g, '').length >= 2;
    if (!usable) { setHits(null); setSearching(false); setFailed(false); return; }
    const mine = ++seq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        let builder = supabase
          .from('lc1_chairpersons')
          .select('id, name, phone, village, district, verified')
          .limit(12);
        builder = phone
          ? builder.ilike('phone', `%${phoneDigits(q)}%`)
          // Words in any spacing: "john  okello" finds "John Okello".
          : builder.ilike('name', `%${q.replace(/[%_,()]/g, '').trim().split(/\s+/).join('%')}%`);
        const { data, error } = await builder;
        if (mine !== seq.current) return;
        if (error) throw error;
        const near = (h: Lc1Hit) => (sameText(h.village, nearVillage) ? 2 : sameText(h.district, nearDistrict) ? 1 : 0);
        const rows = ((data ?? []) as Lc1Hit[]).sort((a, b) =>
          Number(b.verified) - Number(a.verified) || near(b) - near(a) || a.name.localeCompare(b.name));
        setHits(rows);
        setFailed(false);
      } catch (err) {
        if (mine !== seq.current) return;
        console.warn('[Lc1SearchStep] search failed', err);
        setHits(null);
        setFailed(true);
      } finally {
        if (mine === seq.current) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, nearDistrict, nearVillage]);

  return (
    <div className="flex max-w-[19rem] flex-col gap-2">
      <label className="flex h-11 items-center gap-2 rounded-full border border-border bg-background px-3.5 focus-within:border-primary">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          aria-label="Search LC1 chairperson by name or phone"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name or phone, e.g. Okello"
          className="min-w-0 flex-1 bg-transparent text-base outline-none"
        />
        {searching && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
      </label>

      {failed && <p className="px-1 text-xs text-muted-foreground">I couldn’t search just now. Check your connection and type again.</p>}

      {hits && hits.length > 0 && (
        <ul className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card">
          {hits.map((h) => {
            const isNear = sameText(h.village, nearVillage) || sameText(h.district, nearDistrict);
            const on = h.id === selectedId;
            return (
              <li key={h.id} className="border-b border-border last:border-b-0">
                <button type="button" onClick={() => onPick(h)} aria-pressed={on} className={cn('flex w-full items-center gap-2.5 px-3 py-2.5 text-left', on && 'bg-primary/5')}>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                      <span className="truncate">{h.name}</span>
                      {h.verified && <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" aria-label="Verified" />}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[h.village, h.district].filter(Boolean).join(' · ') || 'No village on file'}
                    </span>
                    {isNear && (
                      <span className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-semibold text-primary">
                        <MapPin className="h-3 w-3" /> Near the house
                      </span>
                    )}
                  </span>
                  {on && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {hits && hits.length === 0 && !searching && (
        <p className="px-1 text-sm text-muted-foreground">I couldn’t find “{query.trim()}” 🤔 Try another spelling or their phone, or add them below.</p>
      )}

      <button
        type="button"
        onClick={() => onNew(query.trim())}
        className="inline-flex min-h-9 items-center gap-1.5 self-start rounded-full border border-primary/30 bg-card px-3.5 text-sm font-semibold text-primary"
      >
        <UserPlus className="h-4 w-4" /> Register a new LC1
      </button>
    </div>
  );
}
