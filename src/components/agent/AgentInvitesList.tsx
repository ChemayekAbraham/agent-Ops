import { useState, useEffect, useRef } from 'react';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { Copy, Check, Share2, Users, Building2, Clock, CheckCircle2, RefreshCw, ChevronRight, HandCoins, Banknote } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { hapticSuccess } from '@/lib/haptics';
import { playSuccessSound } from '@/lib/notificationSound';
import { ProxyPartnerDepositDialog } from './ProxyPartnerDepositDialog';

interface UserInvite {
  id: string;
  email: string;
  full_name: string;
  phone: string;
  role: string;
  status: string;
  activation_token: string;
  temp_password: string;
  created_at: string;
  activated_at: string | null;
  activated_user_id: string | null;
}

const roleConfig: Record<string, { label: string; icon: React.ElementType; color: string; emoji: string }> = {
  tenant: {
    label: 'Tenant',
    icon: Users,
    color: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
    emoji: '🏠',
  },
  landlord: {
    label: 'Landlord',
    icon: Building2,
    color: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    emoji: '🏢',
  },
  supporter: {
    label: 'Partner',
    icon: HandCoins,
    color: 'bg-orange-500/10 text-orange-600 border-orange-500/20',
    emoji: '💰',
  },
};

export function AgentInvitesList() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [invites, setInvites] = useState<UserInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [depositPartner, setDepositPartner] = useState<{ id: string; full_name: string; phone: string } | null>(null);
  const activatedIdsRef = useRef<Set<string>>(new Set());

  const fetchInvites = async () => {
    if (!user) return;
    
    setLoading(true);
    const { data, error } = await supabase
      .from('supporter_invites')
      .select('*')
      .eq('created_by', user.id)
      .in('role', ['tenant', 'landlord', 'supporter'])
      .order('created_at', { ascending: false });

    if (!error && data) {
      // Initialize the set of already-activated invite IDs
      data.forEach(invite => {
        if (invite.status === 'activated') {
          activatedIdsRef.current.add(invite.id);
        }
      });
      setInvites(data);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchInvites();
  }, [user]);

  // Realtime removed — supporter_invites not in realtime whitelist. Refresh on revisit.

  const getShareLink = (token: string) => {
    return `${getPublicOrigin()}/join?t=${token}`;
  };

  const handleCopyLink = async (invite: UserInvite) => {
    await navigator.clipboard.writeText(getShareLink(invite.activation_token));
    setCopiedId(invite.id);
    setTimeout(() => setCopiedId(null), 2000);
    toast({ title: 'Link & password copied!' });
  };

  const handleShareWhatsApp = (invite: UserInvite) => {
    const config = roleConfig[invite.role] || roleConfig.tenant;
    const message = `${config.emoji} Welcome to Welile, ${invite.full_name}!

You've been invited to join as a ${config.label}!

🔐 Your password: ${invite.temp_password}

👉 Activate your account here:
${getShareLink(invite.activation_token)}

Just click the link and enter your password to get started!`;
    
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  };

  const pendingCount = invites.filter(i => i.status === 'pending').length;
  const activatedCount = invites.filter(i => i.status === 'activated').length;

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
        </CardHeader>
        <CardContent className="space-y-3">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  // Only show first 3 invites
  const displayedInvites = invites.slice(0, 3);
  const hasMore = invites.length > 3;

  return (
    <>
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            My Registered Users
          </CardTitle>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" onClick={fetchInvites}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate('/agent-registrations')}>
              View All
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
        
        {/* Stats */}
        <div className="flex gap-3 mt-2">
          <Badge variant="outline" className="gap-1">
            <Clock className="h-3 w-3" />
            {pendingCount} Pending
          </Badge>
          <Badge variant="outline" className="gap-1 bg-success/10 text-success border-success/20">
            <CheckCircle2 className="h-3 w-3" />
            {activatedCount} Activated
          </Badge>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-3">
        {invites.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Users className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p>No users registered yet</p>
            <p className="text-sm">Use "Add User" to register tenants or landlords</p>
          </div>
        ) : (
          <>
            {displayedInvites.map((invite) => {
            const config = roleConfig[invite.role] || roleConfig.tenant;
            const RoleIcon = config.icon;
            const isPending = invite.status === 'pending';
            
            return (
              <div 
                key={invite.id} 
                className="p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className={`p-2 rounded-lg ${config.color}`}>
                      <RoleIcon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium truncate">{invite.full_name}</p>
                        <Badge 
                          variant="outline" 
                          className={isPending 
                            ? 'bg-warning/10 text-warning border-warning/20' 
                            : 'bg-success/10 text-success border-success/20'
                          }
                        >
                          {isPending ? 'Pending' : 'Activated'}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground truncate">{invite.phone}</p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <p className="text-xs text-muted-foreground">
                          {config.label} • {formatDistanceToNow(new Date(invite.created_at), { addSuffix: true })}
                        </p>
                        {isPending && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-green-500/10 text-green-600 border-green-500/30">
                            ∞ Never expires
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  {isPending ? (
                    <div className="flex gap-1 shrink-0">
                      <Button 
                        variant="outline" 
                        size="icon" 
                        className="h-8 w-8"
                        onClick={() => handleCopyLink(invite)}
                      >
                        {copiedId === invite.id ? (
                          <Check className="h-3.5 w-3.5 text-success" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button 
                        size="icon" 
                        className="h-8 w-8 bg-green-600 hover:bg-green-700"
                        onClick={() => handleShareWhatsApp(invite)}
                      >
                        <Share2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : (
                    invite.role === 'supporter' && invite.activated_user_id && (
                      <Button
                        size="sm"
                        className="h-8 gap-1 shrink-0"
                        onClick={() => setDepositPartner({
                          id: invite.activated_user_id!,
                          full_name: invite.full_name,
                          phone: invite.phone,
                        })}
                      >
                        <Banknote className="h-3.5 w-3.5" />
                        Deposit
                      </Button>
                    )
                  )}
                </div>
              </div>
            );
          })}
          
          {hasMore && (
            <Button 
              variant="ghost" 
              className="w-full text-muted-foreground"
              onClick={() => navigate('/agent-registrations')}
            >
              View all {invites.length} registrations
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          )}
        </>
      )}
    </CardContent>
    </Card>

    <ProxyPartnerDepositDialog
      open={!!depositPartner}
      onOpenChange={(open) => { if (!open) setDepositPartner(null); }}
      partner={depositPartner}
      onSuccess={fetchInvites}
    />
    </>
  );
}

export default AgentInvitesList;
