import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { parsePublicPolicy, type PublicReturnPolicy } from '@/lib/partnerReturnPolicy';

/**
 * The PUBLIC partner Returns policy (get_partner_return_policy, readable before login).
 *
 *   newContractRate  the public new-partner rate (15 while the switch is off, 10 when on), or null
 *   enabled          whether the switch is on, or null when unknown
 *
 * For logged-out pages, share text, agent screens and Nexa public replies only. A signed-in
 * partner's own next-portfolio figures come from useOwnNewPortfolioRate() (their own rate, which
 * may differ); a named partner's rate on a staff form from usePartnerQuoteRate('partner', id).
 *
 * Never a default: every field is null until the database has answered, and stays null on error.
 * localStorage may seed the first render with the last real answer (display only). `fromNetwork`
 * is true only once THIS mount has fetched the policy, so a staff form can tell a fresh answer
 * from a remembered one (design v2 §6.1, staff form contract).
 */
export const PARTNER_RETURN_POLICY_QUERY_KEY = ['partner-return-policy'] as const;
const STORAGE_KEY = 'welile.partnerReturnPolicy.v2';

function readCached(): PublicReturnPolicy | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Stored in the RPC's own shape, so the one parser validates it.
    return raw ? parsePublicPolicy(JSON.parse(raw)) ?? undefined : undefined;
  } catch {
    return undefined;
  }
}

function writeCached(p: PublicReturnPolicy) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      enabled: p.enabled,
      new_contract_rate: p.newContractRate,
      cutoff_at: p.cutoffAt,
      enabled_at: p.enabledAt,
      updated_at: p.updatedAt,
    }));
  } catch {
    /* private mode / storage blocked: the live value still applies */
  }
}

/** One RPC. Throws on an error or a malformed answer, so the hook keeps every field null. */
export async function fetchPartnerReturnPolicy(): Promise<PublicReturnPolicy> {
  // Not in the generated types until Phase 1 is applied and the types are regenerated.
  const { data, error } = await (supabase.rpc as unknown as (fn: string) => Promise<{ data: unknown; error: Error | null }>)(
    'get_partner_return_policy',
  );
  if (error) throw error;
  const policy = parsePublicPolicy(data);
  if (!policy) throw new Error('The Partner Returns policy answer was malformed.');
  writeCached(policy);
  return policy;
}

export interface UsePartnerReturnPolicyOptions {
  /** Staff forms: refetch on every mount, ignore remembered answers, and expose the policy only
   *  once this mount has fetched it (until then every field is null = unknown). */
  fresh?: boolean;
}

export interface PartnerReturnPolicyState {
  policy: PublicReturnPolicy | null;
  /** The public new-partner rate, or null when unknown. */
  newContractRate: number | null;
  /** Whether the switch is on, or null when unknown. */
  enabled: boolean | null;
  cutoffAt: string | null;
  isLoading: boolean;
  /** True only when this mount fetched the policy from the network (never from localStorage). */
  fromNetwork: boolean;
}

export function usePartnerReturnPolicy(opts: UsePartnerReturnPolicyOptions = {}): PartnerReturnPolicyState {
  const fresh = opts.fresh === true;
  const cached = fresh ? undefined : readCached();
  const query = useQuery({
    queryKey: PARTNER_RETURN_POLICY_QUERY_KEY,
    queryFn: fetchPartnerReturnPolicy,
    // The switch changes once at go-live; five minutes keeps display screens in step without polling.
    staleTime: fresh ? 0 : 5 * 60_000,
    refetchOnMount: fresh ? 'always' : true,
    retry: 1,
    // initialDataUpdatedAt 0: a remembered answer is always stale, so it is refetched at once.
    ...(cached ? { initialData: cached, initialDataUpdatedAt: 0 } : {}),
  });

  // A fetch finished after this mount and the query holds a network answer (the localStorage seed
  // has dataUpdatedAt 0; a failed refetch turns the status to 'error').
  const fromNetwork = query.isFetchedAfterMount && query.status === 'success' && query.dataUpdatedAt > 0;
  const policy: PublicReturnPolicy | null = fresh && !fromNetwork ? null : query.data ?? null;
  // A fresh mount is still loading while its own fetch runs, even when another screen already
  // holds an answer (query.isLoading is false then): a staff form must not treat "not fetched yet"
  // as "unknown" and let staff submit in that window.
  const isLoading = fresh ? query.isLoading || (!fromNetwork && query.isFetching) : query.isLoading;
  return {
    policy,
    newContractRate: policy?.newContractRate ?? null,
    enabled: policy ? policy.enabled : null,
    cutoffAt: policy?.cutoffAt ?? null,
    isLoading,
    fromNetwork,
  };
}
