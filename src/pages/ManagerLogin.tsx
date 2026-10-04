import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, ArrowRight, Lock, ChevronRight, Download, Share, Plus, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import { hapticTap } from '@/lib/haptics';
import { useManagerPWAInstall } from '@/hooks/useManagerPWAInstall';
import ForcePasswordChange from '@/components/auth/ForcePasswordChange';
import { getStaffSession, setStaffSession } from '@/lib/staffSessionCache';

const MANAGER_ACCESS_CODE = 'Manager@welile';
const CACHE_KEY = 'welile_mgr_profiles';
const CACHE_TTL = 5 * 60 * 1000;

interface ManagerProfile {
  user_id: string;
  full_name: string;
  email: string;
  phone: string;
  avatar_url: string | null;
}

function getCachedProfiles(): ManagerProfile[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function setCachedProfiles(profiles: ManagerProfile[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data: profiles, ts: Date.now() }));
  } catch {}
}

function IOSInstallGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end justify-center animate-in fade-in">
      <div className="bg-card rounded-t-3xl w-full max-w-sm p-6 space-y-5 animate-in slide-in-from-bottom">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-foreground">Install Manager App</h3>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-muted">
            <X className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
              <Share className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">1. Tap the Share button</p>
              <p className="text-xs text-muted-foreground">At the bottom of Safari's toolbar</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
              <Plus className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">2. Tap "Add to Home Screen"</p>
              <p className="text-xs text-muted-foreground">Scroll down in the share menu</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
              <Download className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">3. Tap "Add"</p>
              <p className="text-xs text-muted-foreground">The Manager app will appear on your home screen</p>
            </div>
          </div>
        </div>
        <Button onClick={onClose} className="w-full h-12 rounded-xl">Got it</Button>
      </div>
    </div>
  );
}

export default function ManagerLogin() {
  const cached = getCachedProfiles();
  const [code, setCode] = useState('');
  const [error, setError] = useState(false);
  const [isShaking, setIsShaking] = useState(false);
  const [verified, setVerified] = useState(() => {
    return localStorage.getItem('manager_access_verified') === 'true';
  });
  const [managers, setManagers] = useState<ManagerProfile[]>(cached || []);
  const [loadingProfiles, setLoadingProfiles] = useState(!cached);
  
  // Access password state
  const [selectedManager, setSelectedManager] = useState<ManagerProfile | null>(null);
  const [accessPassword, setAccessPassword] = useState('');
  const [verifyingPassword, setVerifyingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState(false);

  const navigate = useNavigate();
  const { toast } = useToast();
  const { switchRole, roles, role } = useAuth();
  const { canInstall, isInstalled, showIOSGuide, setShowIOSGuide, installApp } = useManagerPWAInstall();

  useEffect(() => {
    const fetchManagers = async () => {
      try {
        const { data } = await supabase.rpc('get_manager_profiles');
        if (data && data.length > 0) {
          const profiles = data.map((p: any) => ({
            user_id: p.user_id,
            full_name: p.full_name || 'Unknown',
            email: p.email || '',
            phone: p.phone || '',
            avatar_url: p.avatar_url
          }));
          setManagers(profiles);
          setCachedProfiles(profiles);
        }
      } catch {} finally {
        setLoadingProfiles(false);
      }
    };
    fetchManagers();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    hapticTap();

    if (code === MANAGER_ACCESS_CODE) {
      localStorage.setItem('manager_access_verified', 'true');
      setVerified(true);
      toast({ title: '✅ Access Granted', description: 'Select your profile to continue' });
    } else {
      setError(true);
      setIsShaking(true);
      setTimeout(() => setIsShaking(false), 500);
      toast({ title: 'Invalid Code', description: 'Please check your access code and try again.', variant: 'destructive' });
    }
  };

  const handleSelectProfile = (manager: ManagerProfile) => {
    hapticTap();
    // Check if this manager has a valid 24hr session cached
    const cachedSession = getStaffSession();
    if (cachedSession && cachedSession.userId === manager.user_id) {
      // Skip password — session still valid
      proceedToDashboard(manager);
      return;
    }
    setSelectedManager(manager);
    setAccessPassword('');
    setPasswordError(false);
  };

  const handleVerifyPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedManager || !accessPassword.trim()) return;

    setVerifyingPassword(true);
    setPasswordError(false);

    try {
      const { data, error: rpcError } = await supabase.rpc('verify_staff_access_password', {
        p_user_id: selectedManager.user_id,
        p_password: accessPassword,
      });

      const result = data as { valid: boolean; must_change: boolean };

      if (rpcError || !result.valid) {
        setPasswordError(true);
        setVerifyingPassword(false);
        return;
      }

      // Audit: staff_login via manager portal with device info
      const ua = navigator.userAgent;
      const deviceName = /\(([^)]+)\)/.exec(ua)?.[1] || 'Unknown device';
      const browserMatch = ua.match(/(Chrome|Firefox|Safari|Edge|Opera|SamsungBrowser|UCBrowser)\/[\d.]+/);
      const browserName = browserMatch ? browserMatch[0] : 'Unknown browser';
      await supabase.from('audit_logs').insert({
        user_id: selectedManager.user_id,
        action_type: 'staff_portal_login',
        table_name: 'staff_access_passwords',
        record_id: selectedManager.user_id,
        metadata: {
          method: 'manager_portal',
          username: selectedManager.full_name,
          device: deviceName,
          browser: browserName,
          user_agent: ua,
          login_at: new Date().toISOString(),
        },
      });

      if (result.must_change) {
        setMustChangePassword(true);
        setVerifyingPassword(false);
        return;
      }

      // Proceed to dashboard
      proceedToDashboard(selectedManager);
    } catch {
      setPasswordError(true);
    } finally {
      setVerifyingPassword(false);
    }
  };

  const proceedToDashboard = (manager: ManagerProfile) => {
    localStorage.setItem('manager_access_verified', 'true');
    sessionStorage.setItem('manager_selected_id', manager.user_id);
    sessionStorage.setItem('manager_selected_name', manager.full_name);

    // Cache staff session for 24 hours
    setStaffSession(manager.user_id, manager.full_name);

    if (roles.includes('manager')) {
      switchRole('manager');
    }

    navigate(roleToSlug(role));
  };

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const handleInstall = async () => {
    hapticTap();
    const success = await installApp();
    if (success) {
      toast({ title: '🎉 Manager App Installed!', description: 'Find "Welile Manager" on your home screen' });
    }
  };

  // Force password change overlay
  if (mustChangePassword && selectedManager) {
    return (
      <ForcePasswordChange
        userId={selectedManager.user_id}
        onPasswordChanged={() => {
          setMustChangePassword(false);
          proceedToDashboard(selectedManager);
        }}
      />
    );
  }

  // Access password overlay
  if (selectedManager && !mustChangePassword) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 relative">
        <div className="absolute top-4 right-4 sm:top-6 sm:right-6">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/')}
            className="h-9 w-9 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center space-y-3">
            <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center ring-2 ring-primary/10">
              {selectedManager.avatar_url ? (
                <img src={selectedManager.avatar_url} alt={selectedManager.full_name} className="w-14 h-14 rounded-full object-cover" />
              ) : (
                <span className="text-lg font-bold text-primary">{getInitials(selectedManager.full_name)}</span>
              )}
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">{selectedManager.full_name}</h1>
              <p className="text-sm text-muted-foreground mt-1">Enter your access password</p>
            </div>
          </div>

          <form onSubmit={handleVerifyPassword} className="space-y-4">
            <div className="rounded-2xl border border-border/50 bg-card p-5 shadow-xl space-y-4">
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  type="password"
                  placeholder="Access password"
                  value={accessPassword}
                  onChange={(e) => { setAccessPassword(e.target.value); setPasswordError(false); }}
                  className={`pl-10 h-12 rounded-xl ${passwordError ? 'border-destructive ring-destructive/20 ring-2' : ''}`}
                  autoFocus
                  autoComplete="off"
                />
              </div>
              {passwordError && (
                <p className="text-xs text-destructive">Incorrect password. Try again.</p>
              )}
              <Button type="submit" disabled={!accessPassword.trim() || verifyingPassword} className="w-full h-12 rounded-xl font-bold gap-2">
                {verifyingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                Continue
              </Button>
            </div>
          </form>

          <button
            onClick={() => setSelectedManager(null)}
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            ← Back to profiles
          </button>

          <p className="text-center text-[11px] text-muted-foreground/50">
            Default password: WelileManager (first-time users)
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 relative">
      <div className="absolute top-4 right-4 sm:top-6 sm:right-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate('/')}
          className="h-9 w-9 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-3">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
            <Shield className="h-8 w-8 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {verified ? 'Select Your Profile' : 'Manager Access'}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {verified ? 'Tap your name to continue' : 'Enter your access code to continue'}
            </p>
          </div>
        </div>

        {!verified ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className={`transition-transform ${isShaking ? 'animate-shake' : ''}`}>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="Enter access code"
                  value={code}
                  onChange={(e) => { setCode(e.target.value); setError(false); }}
                  className={`pl-10 h-14 text-base rounded-xl ${error ? 'border-destructive ring-destructive/20 ring-2' : ''}`}
                  autoFocus
                  autoComplete="off"
                />
              </div>
              {error && (
                <p className="text-xs text-destructive mt-1.5 pl-1">Incorrect code. Try again.</p>
              )}
            </div>

            <Button 
              type="submit" 
              className="w-full h-14 text-base font-semibold rounded-xl gap-2"
              disabled={!code.trim()}
            >
              Access Dashboard
              <ArrowRight className="h-4 w-4" />
            </Button>
          </form>
        ) : (
          <div className="space-y-2">
            {loadingProfiles ? (
              <div className="space-y-1.5">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-border/50 bg-card animate-pulse">
                    <div className="w-11 h-11 rounded-full bg-muted flex-shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-muted rounded w-3/4" />
                      <div className="h-3 bg-muted rounded w-1/2" />
                    </div>
                    <div className="w-4 h-4 bg-muted rounded flex-shrink-0" />
                  </div>
                ))}
              </div>
            ) : managers.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-8">
                No manager profiles found.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
                {managers.map((manager) => (
                  <button
                    key={manager.user_id}
                    onClick={() => handleSelectProfile(manager)}
                    className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-border/50 bg-card hover:bg-accent/50 active:scale-[0.98] transition-all text-left group"
                  >
                    {manager.avatar_url ? (
                      <img 
                        src={manager.avatar_url} 
                        alt={manager.full_name}
                        className="w-11 h-11 rounded-full object-cover flex-shrink-0 ring-2 ring-primary/10"
                      />
                    ) : (
                      <div className="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 ring-2 ring-primary/10">
                        <span className="text-sm font-bold text-primary">{getInitials(manager.full_name)}</span>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-foreground truncate">
                        {manager.full_name}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {manager.phone || manager.email}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors flex-shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {canInstall && (
          <Button 
            variant="outline" 
            onClick={handleInstall}
            className="w-full h-12 rounded-xl gap-2 border-dashed border-primary/30 text-primary hover:bg-primary/5"
          >
            <Download className="h-4 w-4" />
            Install Manager App
          </Button>
        )}

        {isInstalled && (
          <div className="text-center">
            <p className="text-xs text-primary font-medium flex items-center justify-center gap-1">
              ✅ Manager App installed on this device
            </p>
          </div>
        )}

        <p className="text-xs text-center text-muted-foreground/60">
          This page is restricted to authorized managers only.
        </p>
      </div>

      {showIOSGuide && <IOSInstallGuide onClose={() => setShowIOSGuide(false)} />}
    </div>
  );
}
