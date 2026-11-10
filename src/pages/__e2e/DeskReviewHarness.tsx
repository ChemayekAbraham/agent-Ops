/**
 * Dev-only Playwright harness for the desk review drawer's decision buttons.
 * The real ReviewDrawer, opened on one request, with a stand-in signed-in
 * reviewer. Every server call goes out as usual; the Playwright spec answers
 * them (page.route on /rest/v1/), so it sees exactly which RPCs a button makes.
 *
 * Mounted at `/__e2e/desk-review` only when `import.meta.env.DEV` is true.
 *   stage=landlord_ops|agent_ops|tenant_ops|service_centre|coo   (default landlord_ops)
 *   id=<request uuid>                                              (default 06df1e3b-…)
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { User } from '@supabase/supabase-js';
import { AuthContext } from '@/hooks/useAuth';
import type { AuthContextType } from '@/hooks/auth/types';
import { ReviewDrawer } from '@/pages/desk/ReviewDrawer';
import { ReviewStatusProvider } from '@/pages/desk/reviewStatus';
import type { Stage } from '@/pages/desk/reviewTypes';

const STAGES: Stage[] = ['service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'coo'];
const noop = async () => ({ error: null });

export default function DeskReviewHarness() {
  const [params] = useSearchParams();
  const stage = (STAGES as string[]).includes(params.get('stage') ?? '') ? (params.get('stage') as Stage) : 'landlord_ops';
  const id = params.get('id') ?? '06df1e3b-94f7-4efb-af5b-ea8fcccb6997';
  const [open, setOpen] = useState(true);

  const auth = useMemo<AuthContextType>(
    () => ({
      user: { id: 'e2e-reviewer' } as User,
      session: null,
      role: 'operations',
      roles: ['operations'],
      enabledRoles: ['operations'],
      loading: false,
      rolesResolved: true,
      signUp: async () => ({ error: null }),
      signUpWithoutRole: async () => ({ error: null }),
      signIn: noop,
      signInWithGoogle: noop,
      signInWithApple: noop,
      signOut: async () => {},
      switchRole: () => {},
      addRole: noop,
      grantAndSwitchRole: noop,
      resetPassword: noop,
    }),
    [],
  );

  return (
    <AuthContext.Provider value={auth}>
      <div className="desk-root min-h-dvh" data-desk-theme="light" data-testid="desk-review-harness">
        <ReviewStatusProvider>
          {open ? (
            <ReviewDrawer stage={stage} requestId={id} onClose={() => setOpen(false)} />
          ) : (
            <p data-drawer-closed style={{ padding: 16 }}>
              Drawer closed.
            </p>
          )}
        </ReviewStatusProvider>
      </div>
    </AuthContext.Provider>
  );
}
