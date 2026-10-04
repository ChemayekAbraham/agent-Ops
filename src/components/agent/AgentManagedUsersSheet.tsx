import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Loader2, Search, UserCog, Wallet, ShieldCheck, ExternalLink, Phone, Plus } from 'lucide-react';
import ResidenceAddressForm from '@/components/profile/ResidenceAddressForm';
import EmailEditor from '@/components/profile/EmailEditor';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
}

interface ManagedUser {
  id: string;
  full_name: string;
  phone: string;
  email: string;
  verified: boolean;
  managed_by_agent: boolean;
  managing_agent_id: string | null;
}

export function AgentManagedUsersSheet({ open, onOpenChange, agentId }: Props) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ManagedUser | null>(null);
  const [showAddPicker, setShowAddPicker] = useState(false);

  const { data: users = [], isLoading, refetch } = useQuery({
    queryKey: ['agent-managed-users', agentId],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone, email, verified, managed_by_agent, managing_agent_id')
        .eq('managing_agent_id', agentId)
        .eq('managed_by_agent', true)
        .order('full_name');
      if (error) throw error;
      return (data || []) as ManagedUser[];
    },
  });

  // Referred users not yet flagged as managed (candidates to add)
  const { data: candidates = [], refetch: refetchCandidates } = useQuery({
    queryKey: ['agent-manageable-candidates', agentId],
    enabled: open && showAddPicker,
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, phone, email, verified, managed_by_agent, managing_agent_id')
        .eq('referrer_id', agentId)
        .eq('managed_by_agent', false)
        .order('full_name');
      return (data || []) as ManagedUser[];
    },
  });

  const flagAsManaged = async (userId: string) => {
    const { error } = await supabase
      .from('profiles')
      .update({ managed_by_agent: true, managing_agent_id: agentId })
      .eq('id', userId);
    if (error) { toast.error('Failed: ' + error.message); return; }
    await supabase.from('agent_managed_user_actions').insert({
      agent_id: agentId, user_id: userId, action_type: 'management_started', details: {},
    });
    toast.success('User added — you can now manage their profile.');
    setShowAddPicker(false);
    refetch();
    refetchCandidates();
  };

  const filtered = users.filter(u => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return u.full_name?.toLowerCase().includes(q) || u.phone?.includes(q) || u.email?.toLowerCase().includes(q);
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <UserCog className="h-5 w-5 text-primary" /> Managed Users
          </SheetTitle>
          <SheetDescription>
            Users you onboarded who haven't activated their own dashboard yet. You can update their profile, address, email, and view their wallet on their behalf.
          </SheetDescription>
        </SheetHeader>

        {!selected ? (
          <div className="mt-4 space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone, email…" className="pl-10 h-11 rounded-xl" />
              </div>
              <Button onClick={() => setShowAddPicker(v => !v)} variant={showAddPicker ? 'secondary' : 'default'} className="h-11 rounded-xl gap-1.5 shrink-0">
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>

            {showAddPicker && (
              <Card className="border-primary/30 bg-primary/5 rounded-2xl">
                <CardContent className="pt-4 space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Pick a user you onboarded to manage</p>
                  {candidates.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-3">No users available — onboard a user first or all your users are already managed.</p>
                  ) : (
                    <div className="space-y-1.5 max-h-64 overflow-y-auto">
                      {candidates.map(c => (
                        <button
                          key={c.id}
                          onClick={() => flagAsManaged(c.id)}
                          className="w-full flex items-center justify-between p-2.5 rounded-lg bg-card border border-border/40 hover:border-primary/40 text-left"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-semibold truncate">{c.full_name}</p>
                            <p className="text-[11px] text-muted-foreground truncate">{c.phone}</p>
                          </div>
                          <Plus className="h-4 w-4 text-primary shrink-0" />
                        </button>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {isLoading ? (
              <div className="py-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : filtered.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-10 text-center space-y-2">
                  <UserCog className="h-10 w-10 mx-auto text-muted-foreground/40" />
                  <p className="text-sm font-semibold">No managed users yet</p>
                  <p className="text-xs text-muted-foreground">Tap "Add" above to start managing a user you onboarded.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                {filtered.map(u => (
                  <button
                    key={u.id}
                    onClick={() => setSelected(u)}
                    className="w-full flex items-center gap-3 p-3 rounded-xl bg-card border border-border/60 hover:border-primary/40 active:scale-[0.99] transition-all text-left"
                  >
                    <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm shrink-0">
                      {u.full_name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm truncate">{u.full_name}</p>
                      <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                        <Phone className="h-3 w-3" /> {u.phone}
                      </p>
                    </div>
                    {u.verified && <Badge variant="outline" className="text-[10px] gap-1"><ShieldCheck className="h-3 w-3" /> Verified</Badge>}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <ManagedUserDetail
            user={selected}
            agentId={agentId}
            onBack={() => { setSelected(null); refetch(); }}
            onReleased={() => { setSelected(null); refetch(); }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function ManagedUserDetail({ user, agentId, onBack, onReleased }: { user: ManagedUser; agentId: string; onBack: () => void; onReleased: () => void; }) {
  const [releasing, setReleasing] = useState(false);

  const { data: wallet } = useQuery({
    queryKey: ['managed-user-wallet', user.id],
    queryFn: async () => {
      // Strict ledger-derived view — never read the wallets cache from a
      // user-facing surface. Cache is operator-only (CFO/FinOps).
      const { data } = await supabase.rpc('get_user_wallet_view', {
        p_user_id: user.id,
      });
      const r = (data ?? {}) as Record<string, number | string>;
      return {
        balance: Number(r.total_visible ?? 0),
        withdrawable_balance: Number(r.withdrawable ?? 0),
        float_balance: Number(r.float_balance ?? 0),
        advance_balance: Number(r.advance_balance ?? 0),
      };
    },
  });

  const releaseManagement = async () => {
    if (!confirm(`Release ${user.full_name} from your management? They will manage their own account from now on.`)) return;
    setReleasing(true);
    const { error } = await supabase
      .from('profiles')
      .update({ managed_by_agent: false, managing_agent_id: null })
      .eq('id', user.id);
    if (error) { toast.error('Failed: ' + error.message); setReleasing(false); return; }
    await supabase.from('agent_managed_user_actions').insert({
      agent_id: agentId, user_id: user.id, action_type: 'management_released', details: {},
    });
    toast.success('User released — they manage their own account now.');
    setReleasing(false);
    onReleased();
  };

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5 -ml-2">← Back to list</Button>
        <Badge variant="outline" className="gap-1"><UserCog className="h-3 w-3" /> Managed</Badge>
      </div>

      <Card className="bg-gradient-to-br from-primary/5 to-background border-primary/20 rounded-2xl">
        <CardContent className="pt-5">
          <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Managing</p>
          <p className="text-lg font-bold">{user.full_name}</p>
          <p className="text-xs text-muted-foreground">{user.phone} · {user.email}</p>
        </CardContent>
      </Card>

      {/* Wallet snapshot */}
      <Card className="border-border/40 rounded-2xl">
        <CardContent className="pt-5 space-y-2">
          <div className="flex items-center gap-2 mb-2"><Wallet className="h-4 w-4 text-primary" /><p className="text-sm font-semibold">Wallet (read-only)</p></div>
          {wallet ? (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Stat label="Total" value={formatUGX(Number(wallet.balance ?? 0))} />
              <Stat label="Withdrawable" value={formatUGX(Number(wallet.withdrawable_balance ?? 0))} />
              <Stat label="Float" value={formatUGX(Number(wallet.float_balance ?? 0))} />
              <Stat label="Advance" value={formatUGX(Number(wallet.advance_balance ?? 0))} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No wallet yet for this user.</p>
          )}
          <p className="text-[11px] text-muted-foreground pt-1">Wallet movements (deposit/withdraw) are still done via the user's own action flows; this view is for oversight.</p>
        </CardContent>
      </Card>

      <EmailEditor mode="agent" userId={user.id} currentEmail={user.email} />
      <ResidenceAddressForm userId={user.id} actingAsAgent />

      <Button
        variant="outline"
        onClick={releaseManagement}
        disabled={releasing}
        className="w-full gap-2 h-11 rounded-xl text-sm font-semibold border-warning/40 text-warning hover:bg-warning/10"
      >
        {releasing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
        Release management (user takes over)
      </Button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-2.5 rounded-xl bg-muted/40 border border-border/40">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</p>
      <p className="text-sm font-bold mt-0.5">{value}</p>
    </div>
  );
}
