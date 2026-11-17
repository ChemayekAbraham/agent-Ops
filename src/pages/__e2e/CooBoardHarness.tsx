/**
 * Dev-only Playwright harness for the COO desk's rows (bug, 17 Nov: names
 * rendered one letter per line once "Push anyway" widened the actions). The
 * board renders as on /desk/coo; every server call goes out as usual and the
 * spec answers it (page.route on /rest/v1/), pipeline_coo_board included.
 *
 * Mounted at `/__e2e/coo-board` only when `import.meta.env.DEV` is true.
 */
import { useMemo } from 'react';
import type { User } from '@supabase/supabase-js';
import { AuthContext } from '@/hooks/useAuth';
import type { AuthContextType } from '@/hooks/auth/types';
import { CooBoard } from '@/pages/desk/CooBoard';
import { DeskPrefsProvider } from '@/pages/desk/deskPrefs';

const noop = async () => ({ error: null });

export default function CooBoardHarness() {
  const auth = useMemo<AuthContextType>(
    () => ({
      user: { id: 'e2e-coo' } as User,
      session: null,
      role: 'coo',
      roles: ['coo'],
      enabledRoles: ['coo'],
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
      <DeskPrefsProvider>
        <div className="desk-root min-h-dvh" data-desk-theme="light" data-testid="coo-board-harness">
          <main className="mx-auto w-full min-w-0 max-w-[1440px] px-4 py-6 sm:px-8">
            <CooBoard board={false} onOpen={() => {}} />
          </main>
        </div>
      </DeskPrefsProvider>
    </AuthContext.Provider>
  );
}
