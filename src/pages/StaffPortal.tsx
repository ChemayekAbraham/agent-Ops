import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Lock, Loader2, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { roleDashboardRoutes } from '@/components/layout/executiveSidebarConfig';
import type { AppRole } from '@/hooks/auth/types';
import ScreenLoader from '@/components/common/ScreenLoader';
const STAFF_ROLES: AppRole[] = ['super_admin', 'manager', 'employee', 'ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'hr', 'operations'];

export default function StaffPortal() {
  const navigate = useNavigate();
  const { user, roles, loading: authLoading, signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  // If already logged in with a staff role, redirect
  useEffect(() => {
    if (authLoading || !user) return;
    if (roles.length > 0) {
      const staffRole = roles.find(r => STAFF_ROLES.includes(r));
      if (staffRole) {
        const route = roleDashboardRoutes[staffRole];
        navigate(route || '/admin/dashboard', { replace: true });
      }
    }
  }, [user, roles, authLoading, navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;

    setSigningIn(true);
    const { error } = await signIn(email, password);
    
    if (error) {
      toast.error('Login failed', { description: error.message });
      setSigningIn(false);
      return;
    }

    const { data: { user: authUser } } = await supabase.auth.getUser();
    if (!authUser) {
      toast.error('Authentication failed');
      setSigningIn(false);
      return;
    }

    const { data: userRoles } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', authUser.id)
      .in('role', STAFF_ROLES as any);

    if (!userRoles || userRoles.length === 0) {
      toast.error('Access denied', { description: 'This portal is for authorized staff only.' });
      await supabase.auth.signOut();
      setSigningIn(false);
      return;
    }

    // Audit: staff_login
    await supabase.from('audit_logs').insert({
      user_id: authUser.id,
      action_type: 'staff_login',
      metadata: { roles: userRoles.map(r => r.role), login_at: new Date().toISOString() },
    });

    const primaryRole = userRoles[0].role as AppRole;
    const route = roleDashboardRoutes[primaryRole];
    toast.success('Welcome back');
    navigate(route || '/admin/dashboard', { replace: true });
  };

  if (authLoading) {
    return (
      <ScreenLoader />
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-3">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-primary/10 border-2 border-primary/20 flex items-center justify-center shadow-lg">
            <Shield className="h-8 w-8 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-foreground">Staff Portal</h1>
            <p className="text-sm text-muted-foreground mt-1">Welile internal access only</p>
          </div>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div className="rounded-2xl border border-border/50 bg-card p-5 shadow-xl space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="staff-email" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Staff Email
              </Label>
              <Input
                id="staff-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@welile.com"
                className="h-12 rounded-xl"
                autoComplete="email"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="staff-password" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Password
              </Label>
              <div className="relative">
                <Input
                  id="staff-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="h-12 rounded-xl pr-10"
                  autoComplete="current-password"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <Button
              type="submit"
              disabled={signingIn || !email.trim() || !password.trim()}
              className="w-full h-12 rounded-xl font-bold gap-2"
            >
              {signingIn ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Lock className="h-4 w-4" />
              )}
              Sign In to Staff Portal
            </Button>
          </div>
        </form>

        <p className="text-center text-[11px] text-muted-foreground/50">
          Authorized personnel only • All actions are logged
        </p>
      </div>
    </div>
  );
}
