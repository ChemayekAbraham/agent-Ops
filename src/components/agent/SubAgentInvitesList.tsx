import { useState, useEffect } from 'react';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { Copy, Check, Share2, Users, Clock, CheckCircle2, RefreshCw, Send, Loader2, Link2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface SubAgentInvite {
  id: string;
  email: string;
  full_name: string;
  phone: string;
  status: string;
  activation_token: string;
  temp_password: string;
  created_at: string;
  activated_at: string | null;
}

export function SubAgentInvitesList() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [invites, setInvites] = useState<SubAgentInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [bulkResending, setBulkResending] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 });

  const fetchInvites = async () => {
    if (!user) return;
    
    setLoading(true);
    const { data, error } = await supabase
      .from('supporter_invites')
      .select('*')
      .eq('created_by', user.id)
      .eq('role', 'agent')
      .order('created_at', { ascending: false });

    if (!error && data) {
      setInvites(data);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchInvites();
  }, [user]);

  const pendingInvites = invites.filter(i => i.status === 'pending');

  const getShareLink = (token: string) => {
    return `${getPublicOrigin()}/join?t=${token}`;
  };

  const generateNewPassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let password = '';
    for (let i = 0; i < 8; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  };

  const handleCopyLink = async (invite: SubAgentInvite) => {
    await navigator.clipboard.writeText(getShareLink(invite.activation_token));
    setCopiedId(invite.id);
    setTimeout(() => setCopiedId(null), 2000);
    toast({ title: 'Link & password copied!' });
  };

  const handleShareWhatsApp = (invite: SubAgentInvite, password?: string) => {
    const pwd = password || invite.temp_password;
    const message = `🤝 Welcome to Welile, ${invite.full_name}!

You've been invited to join as a Sub-Agent!

🔐 Your password: ${pwd}

👉 Activate your account here:
${getShareLink(invite.activation_token)}

Just click the link and enter your password to get started!`;
    
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  };

  const handleResendInvite = async (invite: SubAgentInvite) => {
    setResendingId(invite.id);
    
    try {
      const newPassword = generateNewPassword();
      
      const { error } = await supabase
        .from('supporter_invites')
        .update({ temp_password: newPassword })
        .eq('id', invite.id);

      if (error) throw error;

      // Update local state
      setInvites(prev => prev.map(inv => 
        inv.id === invite.id ? { ...inv, temp_password: newPassword } : inv
      ));

      // Open WhatsApp with new password
      handleShareWhatsApp(invite, newPassword);
      
      toast({ 
        title: '✅ Invite Resent', 
        description: `New password generated and WhatsApp opened for ${invite.full_name}.` 
      });
    } catch (error: any) {
      toast({ 
        title: 'Resend Failed', 
        description: error.message || 'Failed to resend invite', 
        variant: 'destructive' 
      });
    } finally {
      setResendingId(null);
    }
  };

  const handleBulkResend = async () => {
    if (pendingInvites.length === 0) return;
    
    setBulkResending(true);
    setBulkProgress({ current: 0, total: pendingInvites.length });
    let successCount = 0;
    
    try {
      for (let i = 0; i < pendingInvites.length; i++) {
        const invite = pendingInvites[i];
        setBulkProgress({ current: i + 1, total: pendingInvites.length });
        
        const newPassword = generateNewPassword();
        
        const { error } = await supabase
          .from('supporter_invites')
          .update({ temp_password: newPassword })
          .eq('id', invite.id);

        if (!error) {
          const message = `🤝 Welcome to Welile, ${invite.full_name}!

You've been invited to join as a Sub-Agent!

🔐 Your password: ${newPassword}

👉 Activate your account here:
${getShareLink(invite.activation_token)}

Just click the link and enter your password to get started!`;
          
          window.open(`https://wa.me/${invite.phone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`, '_blank');
          successCount++;
          
          // Small delay between opening tabs
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      await fetchInvites();
      
      toast({ 
        title: '✅ Bulk Resend Complete', 
        description: `Opened WhatsApp for ${successCount} of ${pendingInvites.length} sub-agents.` 
      });
    } catch (error: any) {
      toast({ 
        title: 'Bulk Resend Failed', 
        description: error.message || 'Some invites could not be resent', 
        variant: 'destructive' 
      });
    } finally {
      setBulkResending(false);
      setBulkProgress({ current: 0, total: 0 });
    }
  };

  const pendingCount = pendingInvites.length;
  const activatedCount = invites.filter(i => i.status === 'activated').length;

  // Sub-agents are now auto-activated, so no "pending invite" UI is needed.
  // Only render this section if legacy pending invites still exist.
  if (loading || pendingCount === 0) return null;

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            My Sub-Agents
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={fetchInvites} className="h-8 w-8">
              <RefreshCw className="h-4 w-4" />
            </Button>
            {pendingCount > 0 && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className="h-8 gap-1 text-xs"
                    disabled={bulkResending}
                  >
                    {bulkResending ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {bulkProgress.current}/{bulkProgress.total}
                      </>
                    ) : (
                      <>
                        <Send className="h-3 w-3" />
                        Resend All
                      </>
                    )}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Resend All Sub-Agent Invites?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will generate new passwords and open WhatsApp for all {pendingCount} pending sub-agent invite{pendingCount !== 1 ? 's' : ''}. 
                      Each invite will open in a new tab.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleBulkResend}>
                      Yes, Resend All
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>
        
        {/* Stats */}
        <div className="flex gap-3 mt-2">
          <Badge variant="outline" className="gap-1 bg-warning/10 text-warning border-warning/20">
            <Clock className="h-3 w-3" />
            {pendingCount} Pending
          </Badge>
          <Badge variant="outline" className="gap-1 bg-success/10 text-success border-success/20">
            <CheckCircle2 className="h-3 w-3" />
            {activatedCount} Active
          </Badge>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-3">
        {invites.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Users className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p>No sub-agents invited yet</p>
            <p className="text-sm">Use "Register User" → "Sub-Agent" to invite</p>
          </div>
        ) : (
          invites.map((invite) => {
            const isPending = invite.status === 'pending';
            
            return (
              <div 
                key={invite.id} 
                className="p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className="p-2 rounded-lg bg-primary/10 text-primary">
                      <Users className="h-4 w-4" />
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
                          {isPending ? 'Pending' : 'Active'}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground truncate">{invite.phone}</p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <p className="text-xs text-muted-foreground">
                          Invited {formatDistanceToNow(new Date(invite.created_at), { addSuffix: true })}
                        </p>
                        {isPending && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-green-500/10 text-green-600 border-green-500/30">
                            ∞ Never expires
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  {isPending && (
                    <div className="flex flex-col gap-1 shrink-0">
                      <Button 
                        variant="default" 
                        size="sm" 
                        className="h-8 gap-1 text-xs"
                        onClick={() => handleResendInvite(invite)}
                        disabled={resendingId === invite.id}
                      >
                        {resendingId === invite.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Send className="h-3 w-3" />
                        )}
                        Resend
                      </Button>
                      <div className="flex gap-1">
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
                    </div>
                  )}
                </div>
                
                {/* Show activation link for pending invites */}
                {isPending && (
                  <div className="mt-3 p-2 rounded-lg bg-primary/5 border border-primary/20">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                      <Link2 className="h-3 w-3" />
                      Activation Link
                    </div>
                    <p className="text-xs font-mono truncate text-primary">
                      {getShareLink(invite.activation_token)}
                    </p>
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

export default SubAgentInvitesList;
