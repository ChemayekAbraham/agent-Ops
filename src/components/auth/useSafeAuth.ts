import { useAuth } from '@/hooks/useAuth';

/**
 * Safe wrapper around useAuth that returns null user if rendered outside an AuthProvider (e.g. in component unit tests).
 */
export function useSafeAuth() {
  try {
    return useAuth();
  } catch {
    return {
      user: null,
      session: null,
      loading: false,
      signOut: async () => {},
    };
  }
}

export default useSafeAuth;
