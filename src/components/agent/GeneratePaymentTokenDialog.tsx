import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useProfile } from '@/hooks/useProfile';
import { Key, Loader2, Clock, CheckCircle2, User } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

interface Tenant {
  id: string;
  full_name: string;
  phone: string;
}

interface GeneratePaymentTokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preselectedTenant?: Tenant | null;
  preselectedVisitId?: string | null;
  onSuccess?: () => void;
}

export function GeneratePaymentTokenDialog({ open, onOpenChange, preselectedTenant, preselectedVisitId, onSuccess }: GeneratePaymentTokenDialogProps) {
  const { profile } = useProfile();
  const { toast } = useToast();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState<{ code: string; expiresAt: Date } | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (open) {
      if (preselectedTenant) {
        setSelectedTenant(preselectedTenant);
      } else {
        loadTenants();
      }
    }
    if (!open) { setSelectedTenant(null); setAmount(''); setToken(null); setSearchQuery(''); }
  }, [open, preselectedTenant]);

  // Countdown timer
  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((token.expiresAt.getTime() - Date.now()) / 1000));
      setCountdown(remaining);
      if (remaining <= 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [token]);

  const loadTenants = async () => {
    if (!profile?.id) return;
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, phone')
      .eq('referrer_id', profile.id)
      .order('full_name');
    setTenants((data as Tenant[]) || []);
  };

  const filtered = tenants.filter(t =>
    t.full_name.toLowerCase().includes(searchQuery.toLowerCase()) || t.phone.includes(searchQuery)
  );

  const generateToken = async () => {
    if (!selectedTenant || !profile?.id || !amount) return;
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    // Check for a visit today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { count } = await supabase
      .from('agent_visits')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', profile.id)
      .eq('tenant_id', selectedTenant.id)
      .gte('checked_in_at', todayStart.toISOString());

    if (!count || count === 0) {
      toast({ title: 'Visit required', description: 'You must visit this tenant before generating a token.', variant: 'destructive' });
      return;
    }

    setLoading(true);
    const tokenCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    const { error } = await supabase.from('payment_tokens').insert({
      agent_id: profile.id,
      tenant_id: selectedTenant.id,
      token_code: tokenCode,
      amount: amountNum,
      expires_at: expiresAt.toISOString(),
      visit_id: preselectedVisitId || null,
    });

    setLoading(false);
    if (error) {
      toast({ title: 'Failed to generate token', description: error.message, variant: 'destructive' });
      return;
    }

    setToken({ code: tokenCode, expiresAt });
    toast({ title: 'Payment token generated!' });
    onSuccess?.();
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="h-5 w-5 text-amber-500" />
            Generate Payment Token
          </DialogTitle>
        </DialogHeader>

        {token ? (
          <div className="text-center space-y-4 py-4">
            <div className="w-16 h-16 mx-auto bg-amber-500/20 rounded-full flex items-center justify-center">
              <CheckCircle2 className="h-8 w-8 text-amber-500" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground mb-1">{selectedTenant?.full_name}</p>
              <p className="text-sm text-muted-foreground mb-3">Amount: {formatUGX(parseFloat(amount))}</p>
            </div>
            <div className="bg-secondary rounded-2xl p-6">
              <p className="text-4xl font-mono font-bold tracking-[0.3em]">{token.code}</p>
            </div>
            <div className="flex items-center justify-center gap-2 text-sm">
              <Clock className={`h-4 w-4 ${countdown <= 60 ? 'text-destructive' : 'text-muted-foreground'}`} />
              <span className={countdown <= 60 ? 'text-destructive font-semibold' : 'text-muted-foreground'}>
                {countdown > 0 ? `Expires in ${formatTime(countdown)}` : 'Token expired'}
              </span>
            </div>
            <Button onClick={() => onOpenChange(false)} className="w-full h-12">Done</Button>
          </div>
        ) : !selectedTenant ? (
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Search tenant..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-12 rounded-lg border border-input bg-background px-3 text-base focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="max-h-64 overflow-y-auto space-y-1">
              {filtered.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No tenants found</p>}
              {filtered.map(t => (
                <button
                  key={t.id}
                  onClick={() => setSelectedTenant(t)}
                  className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-muted/50 text-left transition-colors"
                >
                  <div className="p-2 rounded-lg bg-primary/10"><User className="h-4 w-4 text-primary" /></div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{t.full_name}</p>
                    <p className="text-xs text-muted-foreground">{t.phone}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-secondary/50 rounded-xl p-3">
              <p className="font-semibold text-sm">{selectedTenant.full_name}</p>
              <p className="text-xs text-muted-foreground">{selectedTenant.phone}</p>
            </div>
            <div className="space-y-2">
              <Label>Amount (UGX)</Label>
              <Input
                type="number"
                placeholder="e.g. 5000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="h-12"
                min="1"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setSelectedTenant(null)} className="flex-1 h-12">Back</Button>
              <Button onClick={generateToken} disabled={loading || !amount} className="flex-1 h-12">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Generate Token'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
