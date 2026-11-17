import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

/**
 * E131: a request the COO pushed to the funders' board with items still
 * missing ("Push anyway") carries one small amber line on the desk review and
 * on the funders' board item (staff only):
 *   "COO pushed with items missing: ID back — <reason>"
 * read from rpc('coo_item_override_for', { p_request_id }) → { missing, reason, by, at } or null.
 * The server answers null for anyone who is not active staff, and the line
 * renders nothing when there is no override or the read fails.
 */

export type CooItemOverride = { missing: string[]; reason: string | null; by: string | null; at: string | null };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The server's row, or null when there is none (or it is not the shape we expect). */
export function readCooOverride(v: unknown): CooItemOverride | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const missing = Array.isArray(o.missing)
    ? o.missing.map(str).filter((x): x is string => !!x)
    : str(o.missing)
      ? [str(o.missing) as string]
      : [];
  return { missing, reason: str(o.reason), by: str(o.by), at: str(o.at) };
}

/** "COO pushed with items missing: ID back — <reason>". */
export function cooOverrideText(o: CooItemOverride): string {
  const items = o.missing.length ? o.missing.join(', ') : 'items';
  return `COO pushed with items missing: ${items}${o.reason ? ` — ${o.reason}` : ''}`;
}

export const cooOverrideKey = (requestId: string) => ['coo-item-override', requestId] as const;

export function useCooItemOverride(requestId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: cooOverrideKey(requestId ?? ''),
    enabled: enabled && !!requestId,
    queryFn: async (): Promise<CooItemOverride | null> => {
      const { data, error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>)(
        'coo_item_override_for',
        { p_request_id: requestId },
      );
      if (error) throw error;
      return readCooOverride(data);
    },
    staleTime: 60_000,
    retry: false,
  });
}

const when = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kampala' });
};

export function CooOverrideLine({ requestId, enabled = true, className }: { requestId: string | null | undefined; enabled?: boolean; className?: string }) {
  const q = useCooItemOverride(requestId, enabled);
  const o = q.data;
  if (!o) return null;
  const by = [o.by, when(o.at)].filter(Boolean).join(' · ');
  return (
    <p
      data-coo-override
      title={by ? `Pushed by ${by}` : undefined}
      className={cn(
        'w-fit max-w-full rounded-lg bg-amber-500/10 px-2.5 py-1 text-xs font-semibold leading-snug text-amber-800 ring-1 ring-amber-600/40 dark:text-amber-300',
        className,
      )}
      style={{ margin: 0, overflowWrap: 'anywhere' }}
    >
      {cooOverrideText(o)}
    </p>
  );
}

export default CooOverrideLine;
