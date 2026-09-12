import { User, Session } from '@supabase/supabase-js';

export type AppRole = 'tenant' | 'agent' | 'landlord' | 'supporter' | 'manager' | 'ceo' | 'coo' | 'cfo' | 'cto' | 'cmo' | 'crm' | 'employee' | 'operations' | 'super_admin' | 'hr' | 'access_admin';

export interface AuthContextType {
  user: User | null;
  session: Session | null;
  role: AppRole | null;
  roles: AppRole[];
  loading: boolean;
  /** True once the role list reflects a definitive database answer. */
  rolesResolved: boolean;
  signUp: (email: string, password: string, fullName: string, phone: string, role: AppRole) => Promise<{ data?: { user: User | null; session: Session | null } | null; error: Error | null }>;
  signUpWithoutRole: (email: string, password: string, fullName: string, phone: string, referrerId?: string, intendedRole?: string, signupSource?: string) => Promise<{ data?: { user: User | null; session: Session | null } | null; error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signInWithGoogle: () => Promise<{ error: Error | null }>;
  signInWithApple: () => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  switchRole: (role: AppRole) => void;
  addRole: (role: AppRole) => Promise<{ error: Error | null }>;
  grantAndSwitchRole: (role: AppRole) => Promise<{ error: Error | null }>;
  resetPassword: (email: string) => Promise<{ error: Error | null }>;
}
