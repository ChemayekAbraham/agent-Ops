import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { Wallet, Users, Building2, Clock, DollarSign, MapPin } from 'lucide-react';

interface AgentDetailDrawerProps {
  agentId: string | null;
  open: boolean;
  onClose: () => void;
}

interface EarningEntry { amount: number; earning_type: string; created_at: string; description: string | null }
interface VisitEntry { checked_in_at: string; location_name: string | null; tenant: { full_name: string } | null }
interface TenantLink { tenant_id: string; tenant: { full_name: string; phone: string } | null }
interface LandlordLink { landlord_id: string; landlord: { landlord_name: string; phone_number: string } | null }

export function AgentDetailDrawer({ agentId, open, onClose }: AgentDetailDrawerProps) {
  const [profile, setProfile] = useState<any>(null);
  const [wallet, setWallet] = useState<{ balance: number } | null>(null);
  const [earnings, setEarnings] = useState<EarningEntry[]>([]);
  const [visits, setVisits] = useState<VisitEntry[]>([]);
  const [tenants, setTenants] = useState<TenantLink[]>([]);
  const [landlords, setLandlords] = useState<LandlordLink[]>([]);

  useEffect(() => {
    if (!agentId || !open) return;
    const load = async () => {
      const [pRes, wRes, eRes, vRes, tRes, lRes] = await Promise.all([
        (supabase as any).from('profiles').select('full_name, phone, email, created_at, territory, avatar_url, last_active_at').eq('id', agentId).single(),
        (supabase as any).from('wallets').select('balance').eq('user_id', agentId).single(),
        (supabase as any).from('agent_earnings').select('amount, earning_type, created_at, description').eq('agent_id', agentId).order('created_at', { ascending: false }).limit(10),
        (supabase as any).from('agent_visits').select('checked_in_at, location_name, tenant:tenant_id(full_name)').eq('agent_id', agentId).order('checked_in_at', { ascending: false }).limit(8),
        (supabase as any).from('rent_requests').select('tenant_id, tenant:tenant_id(full_name, phone)').eq('agent_id', agentId).limit(20),
        (supabase as any).from('agent_landlord_assignments').select('landlord_id, landlord:landlord_id(landlord_name, phone_number)').eq('agent_id', agentId).limit(20),
      ]);
      setProfile(pRes.data);
      setWallet(wRes.data);
      setEarnings((eRes.data || []) as unknown as EarningEntry[]);
      setVisits((vRes.data || []) as unknown as VisitEntry[]);
      // deduplicate tenants
      const seen = new Set<string>();
      const uniqueTenants = ((tRes.data || []) as unknown as TenantLink[]).filter(t => {
        if (seen.has(t.tenant_id)) return false;
        seen.add(t.tenant_id);
        return true;
      });
      setTenants(uniqueTenants);
      setLandlords((lRes.data || []) as unknown as LandlordLink[]);
    };
    load();
  }, [agentId, open]);

  const totalCommission = earnings.reduce((s, e) => s + e.amount, 0);

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-lg p-0">
        <SheetHeader className="p-5 pb-3 border-b bg-muted/30">
          <SheetTitle className="text-lg">{profile?.full_name || 'Agent'}</SheetTitle>
          {profile && (
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>{profile.phone}</span>
              {profile.territory && <span>• {profile.territory}</span>}
              <span>• Joined {format(new Date(profile.created_at), 'MMM yyyy')}</span>
            </div>
          )}
        </SheetHeader>

        <ScrollArea className="h-[calc(100vh-80px)]">
          <div className="p-5 space-y-6">
            {/* KPI row */}
            <div className="grid grid-cols-3 gap-3">
              <KpiMini icon={Wallet} label="Wallet" value={`UGX ${(wallet?.balance ?? 0).toLocaleString()}`} />
              <KpiMini icon={DollarSign} label="Commission" value={`UGX ${totalCommission.toLocaleString()}`} />
              <KpiMini icon={Users} label="Tenants" value={String(tenants.length)} />
            </div>

            <Separator />

            {/* Commission History */}
            <Section title="Commission History" icon={DollarSign}>
              {earnings.length === 0 && <p className="text-xs text-muted-foreground">No earnings yet.</p>}
              <div className="space-y-2">
                {earnings.map((e, i) => (
                  <div key={i} className="flex justify-between items-center text-sm">
                    <div>
                      <p className="font-medium capitalize">{e.earning_type.replace(/_/g, ' ')}</p>
                      <p className="text-[11px] text-muted-foreground">{format(new Date(e.created_at), 'dd MMM yyyy')}</p>
                    </div>
                    <span className="font-semibold text-emerald-600">+UGX {e.amount.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </Section>

            <Separator />

            {/* Linked Tenants */}
            <Section title={`Linked Tenants (${tenants.length})`} icon={Users}>
              {tenants.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
              <div className="space-y-1.5">
                {tenants.slice(0, 10).map((t, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span>{(t.tenant as any)?.full_name || '—'}</span>
                    <span className="text-muted-foreground text-xs">{(t.tenant as any)?.phone}</span>
                  </div>
                ))}
              </div>
            </Section>

            <Separator />

            {/* Linked Landlords */}
            <Section title={`Linked Landlords (${landlords.length})`} icon={Building2}>
              {landlords.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
              <div className="space-y-1.5">
                {landlords.slice(0, 10).map((l, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span>{(l.landlord as any)?.landlord_name || '—'}</span>
                    <span className="text-muted-foreground text-xs">{(l.landlord as any)?.phone_number}</span>
                  </div>
                ))}
              </div>
            </Section>

            <Separator />

            {/* Recent Activity */}
            <Section title="Recent Activity" icon={Clock}>
              {visits.length === 0 && <p className="text-xs text-muted-foreground">No recent visits.</p>}
              <div className="space-y-2">
                {visits.map((v, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <MapPin className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium">Visited {(v.tenant as any)?.full_name || 'tenant'}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {v.location_name && `${v.location_name} • `}
                        {format(new Date(v.checked_in_at), 'dd MMM yyyy, hh:mm a')}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function KpiMini({ icon: Icon, label, value }: { icon: typeof Wallet; label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-muted/30 p-3 text-center">
      <Icon className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-sm font-bold mt-0.5">{value}</p>
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Wallet; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-bold">{title}</h3>
      </div>
      {children}
    </div>
  );
}
