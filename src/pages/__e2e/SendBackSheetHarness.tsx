/**
 * Dev-only Playwright harness for the desks' send-back dialogs on a phone:
 * the one-request sheet, the COO's bulk sheet and the Service Centre's bulk
 * dialog, each opened as the desks open them. Every server call goes out as
 * usual and the spec answers it (page.route on /rest/v1/).
 *
 * Mounted at `/__e2e/send-back` only when `import.meta.env.DEV` is true.
 *   which=single|coo|sc    (default single)
 *   stage=service_centre|agent_ops|tenant_ops|landlord_ops|coo   (single only; default service_centre)
 */
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { User } from '@supabase/supabase-js';
import { AuthContext } from '@/hooks/useAuth';
import type { AuthContextType } from '@/hooks/auth/types';
import { SendBackSheet } from '@/pages/desk/sendBack';
import { CooSendBackSheet } from '@/pages/desk/cooSendBack';
import { BulkDialog } from '@/pages/desk/scBulk';
import type { Stage } from '@/pages/desk/reviewTypes';

const STAGES: Stage[] = ['service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'coo'];
const noop = async () => ({ error: null });

export default function SendBackSheetHarness() {
  const [params] = useSearchParams();
  const which = params.get('which') ?? 'single';
  const stage = (STAGES as string[]).includes(params.get('stage') ?? '') ? (params.get('stage') as Stage) : 'service_centre';

  const auth = useMemo<AuthContextType>(
    () => ({
      user: { id: 'e2e-officer' } as User,
      session: null,
      role: 'operations',
      roles: ['operations', 'coo'],
      enabledRoles: ['operations', 'coo'],
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
      <div className="desk-root min-h-dvh" data-desk-theme="light" data-testid="send-back-harness">
        {which === 'coo' ? (
          <CooSendBackSheet
            targets={[
              { id: 'c0000000-0000-0000-0000-000000000001', tenant: 'Fred Okello' },
              { id: 'c0000000-0000-0000-0000-000000000002', tenant: 'Faye Nakato' },
            ]}
            onClose={() => {}}
          />
        ) : which === 'sc' ? (
          <BulkDialog decision="send_back" ids={['s0000000-0000-0000-0000-000000000001', 's0000000-0000-0000-0000-000000000002']} tenantOf={() => null} onDone={() => {}} onClose={() => {}} />
        ) : (
          <SendBackSheet requestId="r0000000-0000-0000-0000-000000000001" stage={stage} tenant="Odenyo Elly" onClose={() => {}} />
        )}
      </div>
    </AuthContext.Provider>
  );
}
