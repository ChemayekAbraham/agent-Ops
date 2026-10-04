import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { useShortLink } from '@/hooks/useShortLink';
import { Copy, Check, Share2, Users, Link2, Sparkles, UserPlus, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

export function ShareSubAgentLink() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [stats, setStats] = useState({ linkSignups: 0, directInvites: 0 });
  const [loading, setLoading] = useState(true);

  const { shortUrl, isLoading: linkLoading } = useShortLink({
    targetPath: '/auth',
    targetParams: { ref: user?.id || '', become: 'agent' },
    enabled: !!user,
  });

  useEffect(() => {
    if (user) fetchStats();
  }, [user]);

  const fetchStats = async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('agent_subagents')
      .select('source')
      .eq('parent_agent_id', user.id);
    if (!error && data) {
      setStats({
        linkSignups: data.filter(d => d.source === 'link').length,
        directInvites: data.filter(d => d.source === 'invite').length,
      });
    }
    setLoading(false);
  };

  const getWhatsAppMessage = () => {
    return `🚀 Join me as a Sub-Agent on Welile!

💰 Earn money by:
• Registering tenants & landlords
• Earning 8% commission on repayments
• Building your own team of sub-agents

✨ It's FREE to join and start earning!

👉 TAP THIS LINK TO SIGN UP:
${shortUrl}

📱 You'll create a NEW account with your email and password.

Let's grow together! 🤝`;
  };

  const handleCopyLink = async () => {
    await navigator.clipboard.writeText(shortUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: 'Link copied!' });
  };

  const handleShareWhatsApp = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(getWhatsAppMessage())}`, '_blank');
  };

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join Welile as a Sub-Agent',
          text: 'Earn money by registering tenants & landlords. Sign up for free!',
          url: shortUrl,
        });
      } catch { handleCopyLink(); }
    } else {
      handleCopyLink();
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
      <Card className="border-2 border-orange-500/30 bg-gradient-to-br from-orange-500/5 via-amber-500/5 to-yellow-500/5 overflow-hidden">
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-lg shadow-orange-500/25">
                <Users className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-bold text-base flex items-center gap-2">
                  Recruit Sub-Agents
                  <Sparkles className="h-4 w-4 text-orange-500" />
                </h3>
                <p className="text-xs text-muted-foreground">
                  Earn <span className="font-bold text-orange-600">UGX 10,000</span> for each signup!
                </p>
              </div>
            </div>
          </div>

          {!loading && (stats.linkSignups > 0 || stats.directInvites > 0) && (
            <div className="flex gap-2">
              <Badge variant="outline" className="gap-1.5 px-2.5 py-1 bg-orange-500/10 text-orange-600 border-orange-500/20">
                <Link2 className="h-3 w-3" />{stats.linkSignups} via link
              </Badge>
              <Badge variant="outline" className="gap-1.5 px-2.5 py-1 bg-primary/10 text-primary border-primary/20">
                <UserPlus className="h-3 w-3" />{stats.directInvites} direct
              </Badge>
              <Badge variant="outline" className="gap-1.5 px-2.5 py-1 bg-success/10 text-success border-success/20">
                <Users className="h-3 w-3" />{stats.linkSignups + stats.directInvites} total
              </Badge>
            </div>
          )}

          <div className="relative p-3 rounded-xl bg-background/80 border border-orange-500/20">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground mb-2">
              <div className="flex items-center gap-2">
                <Link2 className="h-3 w-3" />
                <span>Your signup link (for NEW users)</span>
              </div>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0.5 bg-orange-500/10 text-orange-600 border-orange-500/20">
                Sign Up Only
              </Badge>
            </div>
            <div className="flex gap-2">
              <Input value={linkLoading ? 'Generating...' : shortUrl} readOnly className="h-10 text-xs font-mono bg-muted/50 border-orange-500/20" />
              <Button
                variant={copied ? "default" : "outline"}
                size="icon"
                onClick={handleCopyLink}
                disabled={linkLoading}
                className={`h-10 w-10 shrink-0 transition-all ${copied ? 'bg-green-600 hover:bg-green-700' : 'border-orange-500/30 hover:bg-orange-500/10'}`}
              >
                {linkLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : copied ? <Check className="h-4 w-4 text-white" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button onClick={handleShareWhatsApp} disabled={linkLoading} className="h-11 gap-2 bg-green-600 hover:bg-green-700 text-white font-semibold">
              <Share2 className="h-4 w-4" />WhatsApp
            </Button>
            <Button variant="outline" onClick={handleNativeShare} disabled={linkLoading} className="h-11 gap-2 border-orange-500/30 hover:bg-orange-500/10">
              <Share2 className="h-4 w-4" />Share Link
            </Button>
          </div>

          <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <p className="text-[11px] text-center text-amber-700 dark:text-amber-400">
              ⚠️ This link is for <strong>NEW users only</strong>. For registered invites, use "Register Sub-Agent" button above.
            </p>
          </div>
          <p className="text-[11px] text-center text-muted-foreground">
            When someone signs up using your link, they become your sub-agent and you earn 2% of their earnings!
          </p>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export default ShareSubAgentLink;
