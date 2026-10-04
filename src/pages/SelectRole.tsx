import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth, AppRole } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Home, Users, Wallet, Building2, Shield, Check, ArrowLeft, Sparkles, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import WelileLogo from '@/components/WelileLogo';
import { supabase } from '@/integrations/supabase/client';
import { roleToSlug } from '@/lib/roleRoutes';
import { attachCampaignIfPresent, getStoredAttributionToken } from '@/lib/campaignAttribution';

const MANAGER_ACCESS_CODE = 'Manager@welile';

interface RoleOption {
  value: AppRole;
  label: string;
  description: string;
  icon: React.ReactNode;
  requiresCode: boolean;
}

const roleOptions: RoleOption[] = [
  { 
    value: 'tenant', 
    label: 'Tenant', 
    description: 'Request rent facilitation and pay back over time',
    icon: <Home className="h-6 w-6" />,
    requiresCode: false
  },
  { 
    value: 'agent', 
    label: 'Agent', 
    description: 'Connect tenants to the platform and earn commissions',
    icon: <Users className="h-6 w-6" />,
    requiresCode: false
  },
  { 
    value: 'landlord', 
    label: 'Landlord', 
    description: 'Receive rent payments from tenants',
    icon: <Building2 className="h-6 w-6" />,
    requiresCode: false
  },
  { 
    value: 'supporter', 
    label: 'Supporter', 
    description: 'Fund rent requests and earn 15% returns',
    icon: <Wallet className="h-6 w-6" />,
    requiresCode: false
  },
  { 
    value: 'manager', 
    label: 'Manager', 
    description: 'Manage platform operations and approvals',
    icon: <Shield className="h-6 w-6" />,
    requiresCode: true
  },
];

export default function SelectRole() {
  const [selectedRoles, setSelectedRoles] = useState<AppRole[]>([]);
  const [accessCode, setAccessCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [isSubAgentSignup, setIsSubAgentSignup] = useState(false);
  const [parentAgentId, setParentAgentId] = useState<string | null>(null);
  
  const { addRole, user, roles, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();

  // Banner shown when DashboardRedirect bounces a user here because their
  // requested dashboard URL was invalid or they no longer hold that role.
  const redirectState = (location.state ?? null) as
    | { reason?: 'unknown-slug' | 'role-not-held' | 'no-roles'; requestedSlug?: string }
    | null;
  const redirectReason = redirectState?.reason ?? null;
  const redirectMessage = (() => {
    if (!redirectReason) return null;
    if (redirectReason === 'no-roles') {
      return "Your account doesn't have a dashboard role yet — pick one below to get started.";
    }
    if (redirectReason === 'unknown-slug') {
      return `The link you opened (${redirectState?.requestedSlug ?? 'that URL'}) isn't a valid dashboard. Choose a role below to continue.`;
    }
    // role-not-held
    return `You no longer have access to ${redirectState?.requestedSlug ?? 'that dashboard'}. Pick one of your active roles below.`;
  })();

  const [autoSubmitting, setAutoSubmitting] = useState(false);

  // Check for become_role and referrer on mount
  useEffect(() => {
    const becomeRole = localStorage.getItem('become_role') as AppRole | null;
    const referrerId = localStorage.getItem('referral_agent_id');
    
    if (becomeRole === 'agent' && referrerId) {
      setIsSubAgentSignup(true);
      setParentAgentId(referrerId);
      setSelectedRoles(['agent']);
    } else if (becomeRole && ['tenant', 'supporter', 'landlord', 'agent'].includes(becomeRole)) {
      // Auto-select the role from URL/localStorage
      setSelectedRoles([becomeRole]);
    }
  }, []);

  // Auto-submit when role is pre-selected from embed/calculator (not sub-agent flow which needs UI)
  useEffect(() => {
    const becomeRole = localStorage.getItem('become_role') as AppRole | null;
    const referrerId = localStorage.getItem('referral_agent_id');
    
    // Only auto-submit for simple role assignment (not sub-agent which needs confirmation)
    const isSimpleRoleAssignment = becomeRole && 
      ['tenant', 'supporter', 'landlord'].includes(becomeRole) && 
      !referrerId;
    
    if (isSimpleRoleAssignment && selectedRoles.length > 0 && !autoSubmitting && user) {
      setAutoSubmitting(true);
      // Immediate submit - no delay for faster signup
      handleAutoSubmit();
    }
  }, [selectedRoles, user]);

  const handleAutoSubmit = async () => {
    const becomeRole = localStorage.getItem('become_role') as AppRole | null;
    if (!becomeRole || !user) return;

    const { error } = await addRole(becomeRole);
    if (!error) {
      if (becomeRole === 'agent' && getStoredAttributionToken()) {
        await attachCampaignIfPresent();
      }
      localStorage.removeItem('become_role');
      toast({
        title: 'Welcome!',
        description: `You're now set up as a ${becomeRole}. Redirecting to dashboard...`
      });
      navigate(roleToSlug(becomeRole));
    } else {
      setAutoSubmitting(false);
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive'
      });
    }
  };

  // Handle redirects in useEffect to avoid render-time navigation
  useEffect(() => {
    if (loading) return;
    
    if (!user) {
      navigate('/auth');
    } else if (roles.length > 0) {
      navigate(roleToSlug(roles[0]));
    }
  }, [user, roles, loading, navigate]);

  // Show loading while auth is checking or auto-submitting
  if (loading || !user || autoSubmitting) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
          {autoSubmitting && (
            <p className="text-sm text-muted-foreground">Setting up your account...</p>
          )}
        </div>
      </div>
    );
  }

  const toggleRole = (role: AppRole) => {
    if (role === 'manager') {
      if (selectedRoles.includes('manager')) {
        setSelectedRoles(selectedRoles.filter(r => r !== 'manager'));
        setShowCodeInput(false);
        setAccessCode('');
      } else {
        setShowCodeInput(true);
      }
    } else {
      if (selectedRoles.includes(role)) {
        setSelectedRoles(selectedRoles.filter(r => r !== role));
      } else {
        setSelectedRoles([...selectedRoles, role]);
      }
    }
  };

  const confirmManagerAccess = () => {
    if (accessCode === MANAGER_ACCESS_CODE) {
      setSelectedRoles([...selectedRoles, 'manager']);
      setShowCodeInput(false);
      toast({
        title: 'Manager Access Granted',
        description: 'You can now access the manager dashboard'
      });
    } else {
      toast({
        title: 'Invalid Code',
        description: 'The access code is incorrect',
        variant: 'destructive'
      });
    }
  };

  const handleContinue = async () => {
    if (selectedRoles.length === 0) {
      toast({
        title: 'Select a Role',
        description: 'Please select at least one role to continue',
        variant: 'destructive'
      });
      return;
    }

    setIsLoading(true);

    for (const role of selectedRoles) {
      const { error } = await addRole(role);
      if (error) {
        toast({
          title: 'Error',
          description: error.message,
          variant: 'destructive'
        });
        setIsLoading(false);
        return;
      }
    }

    if (selectedRoles.includes('agent') && getStoredAttributionToken()) {
      await attachCampaignIfPresent();
    }

    // If this is a sub-agent signup, create the sub-agent relationship
    if (isSubAgentSignup && parentAgentId && selectedRoles.includes('agent') && user) {
      try {
        // Create the sub-agent relationship
        const { error: subAgentError } = await supabase.from('agent_subagents').insert({
          parent_agent_id: parentAgentId,
          sub_agent_id: user.id,
          source: 'link' // Track that this came from shareable link
        });
        
        if (subAgentError) {
          console.error('Sub-agent relationship error:', subAgentError);
          // Check if it's a duplicate - that's okay, continue
          if (!subAgentError.message.includes('duplicate')) {
            throw subAgentError;
          }
        }

        // Sub-agent registration bonus (UGX 3,000) is awarded automatically
        // by the trg_award_subagent_commission trigger on agent_subagents insert.

        // Notification removed - table dropped
        
        // Clear the stored values
        localStorage.removeItem('become_role');
        localStorage.removeItem('referral_agent_id');
        
        toast({
          title: '🎉 Welcome, Sub-Agent!',
          description: 'You are now connected to your parent agent and can start earning!'
        });
      } catch (err: any) {
        console.error('Failed to create sub-agent relationship:', err);
        // Still navigate to dashboard even if there was an issue
        toast({
          title: 'Account Created',
          description: 'Your agent account is ready. Contact support if you need help.',
        });
      }
    } else {
      // Clear any leftover values
      localStorage.removeItem('become_role');
      localStorage.removeItem('referral_agent_id');
      
      toast({
        title: 'Roles Added!',
        description: `You now have access to ${selectedRoles.length} dashboard${selectedRoles.length > 1 ? 's' : ''}`
      });
    }
    
    navigate(roleToSlug(selectedRoles[0]));
    setIsLoading(false);
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <Link 
          to="/" 
          className="inline-flex items-center gap-2 text-muted-foreground hover:text-primary mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Home
        </Link>

        <div className="text-center mb-8">
          <div className="flex items-center justify-center mb-4">
            <WelileLogo linkToHome={false} />
          </div>
          <p className="text-muted-foreground">Choose your role(s) on the platform</p>
        </div>

        {redirectMessage && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4 text-left"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <div className="space-y-0.5">
              <p className="text-sm font-semibold text-warning">
                Dashboard not available
              </p>
              <p className="text-xs text-muted-foreground">{redirectMessage}</p>
            </div>
          </div>
        )}

        {isSubAgentSignup && (
          <div className="mb-4 p-4 rounded-xl bg-orange-500/10 border border-orange-500/20">
            <div className="flex items-center justify-center gap-2 text-orange-600">
              <Sparkles className="h-4 w-4" />
              <span className="text-sm font-medium">Becoming a Sub-Agent</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1 text-center">
              You'll be connected to your parent agent and can start earning commissions!
            </p>
          </div>
        )}

        <Card className="glass-card">
          <CardHeader>
            <CardTitle>{isSubAgentSignup ? 'Confirm Your Role' : 'Select Your Role(s)'}</CardTitle>
            <CardDescription>
              {isSubAgentSignup 
                ? 'Click continue to activate your agent account'
                : 'You can select multiple roles. You can always add more later.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {roleOptions.map((option) => {
                const isSelected = selectedRoles.includes(option.value);
                return (
                  <button
                    key={option.value}
                    onClick={() => toggleRole(option.value)}
                    className={`relative p-4 rounded-lg border-2 text-left transition-all ${
                      isSelected 
                        ? 'border-primary bg-primary/10' 
                        : 'border-border hover:border-primary/50 hover:bg-secondary/50'
                    }`}
                  >
                    {isSelected && (
                      <div className="absolute top-2 right-2">
                        <Check className="h-5 w-5 text-primary" />
                      </div>
                    )}
                    <div className={`mb-2 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`}>
                      {option.icon}
                    </div>
                    <h3 className="font-semibold">{option.label}</h3>
                    <p className="text-sm text-muted-foreground">{option.description}</p>
                    {option.requiresCode && (
                      <span className="inline-block mt-2 text-xs px-2 py-1 rounded bg-destructive/10 text-destructive">
                        Requires Access Code
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {showCodeInput && (
              <Card className="border-warning/50 bg-warning/5">
                <CardContent className="pt-4">
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-warning">
                      <Shield className="h-5 w-5" />
                      <span className="font-medium">Manager Access Required</span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Enter the manager access code to unlock this role.
                    </p>
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        placeholder="Enter access code"
                        value={accessCode}
                        onChange={(e) => setAccessCode(e.target.value)}
                      />
                      <Button onClick={confirmManagerAccess} variant="outline">
                        Verify
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {selectedRoles.length > 0 && (
              <div className="p-3 rounded-lg bg-primary/10 text-sm">
                <span className="font-medium">Selected: </span>
                {selectedRoles.map(r => roleOptions.find(o => o.value === r)?.label).join(', ')}
              </div>
            )}

            <Button 
              onClick={handleContinue} 
              className="w-full" 
              disabled={selectedRoles.length === 0 || isLoading}
            >
              {isLoading ? 'Setting up...' : 'Continue to Dashboard'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
