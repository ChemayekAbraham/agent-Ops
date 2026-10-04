import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/** Position title that owns the proxy agent growth tooling. */
export const PARTNER_GROWTH_LEAD_TITLE = 'Lead Partner Growth';

/**
 * True only for the employee currently holding the "Lead Partner Growth"
 * position. Used to keep the proxy agent invite link + notes feed off every
 * other employee's "My work" page.
 */
export function useIsPartnerGrowthLead() {
  return useQuery({
    queryKey: ['is-partner-growth-lead'],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<boolean> => {
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth?.user?.id;
      if (!userId) return false;

      const { data: staff } = await supabase
        .from('hr_staff')
        .select('id')
        .eq('user_id', userId)
        .maybeSingle();
      if (!staff?.id) return false;

      const { data } = await supabase
        .from('hr_assignments')
        .select('id, hr_positions!inner(title)')
        .eq('staff_id', staff.id)
        .is('ended_on', null);

      return (data ?? []).some(
        (r: any) => (r.hr_positions?.title ?? '').trim().toLowerCase() === PARTNER_GROWTH_LEAD_TITLE.toLowerCase(),
      );
    },
  });
}
