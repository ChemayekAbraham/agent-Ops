import { useEffect, useState } from 'react';
import HRPlaceholderPage from './HRPlaceholderPage';
import ExecutiveBrief from '../components/ExecutiveBrief';
import { supabase } from '../api/client';

/**
 * Executive Brief. Visible to executives (hr_is_executive) and to the
 * hr / super_admin roles. Everyone else sees a plain notice.
 */
export default function ExecutiveBriefPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let ok = false;
      try {
        const { data } = await supabase.rpc('hr_is_executive' as never);
        ok = data === true;
      } catch {
        ok = false;
      }
      if (!ok) {
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (uid) {
          const { data: roles } = await supabase
            .from('user_roles')
            .select('role')
            .eq('user_id', uid);
          ok = (roles ?? []).some(
            (r: { role: string }) => r.role === 'hr' || r.role === 'super_admin',
          );
        }
      }
      if (!cancelled) setAllowed(ok);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <HRPlaceholderPage
      heading="Executive Brief"
      subtitle="Live task status across every logged assignment"
    >
      {allowed === null && <p className="text-sm text-muted-foreground">Checking access…</p>}
      {allowed === false && (
        <p className="text-sm text-muted-foreground">
          This brief is available to executives only.
        </p>
      )}
      {allowed === true && <ExecutiveBrief />}
    </HRPlaceholderPage>
  );
}
