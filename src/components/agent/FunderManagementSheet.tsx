import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FunderDetailView } from './FunderDetailView';
import { formatUGX } from '@/lib/rentCalculations';
import { usePhoneDuplicateCheck } from '@/hooks/usePhoneDuplicateCheck';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import { useFunderAccountsRealtime } from '@/hooks/useFunderAccountsRealtime';
import { useAgentCapabilities } from '@/hooks/useAgentCapabilities';
import {
  Users, Loader2, Phone, Send, HandCoins, UserPlus, AlertCircle,
} from 'lucide-react';
import { collectAgentSignupTelemetry } from '@/lib/agentSignupTelemetry';

interface LinkedFunder {
  id: string;
  beneficiary_id: string;
  beneficiary_role: string;
  reason: string;
  created_at: string;
  approval_status: string;
  beneficiary: {
    id: string;
    full_name: string;
    phone: string;
  } | null;
}

interface FunderStats {
  totalInvested: number;
  totalROI: number;
  activeCount: number;
  walletBalance: number;
}

export function FunderManagementSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const { has, isLoading: capsLoading } = useAgentCapabilities();
  const [funders, setFunders] = useState<LinkedFunder[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFunder, setSelectedFunder] = useState<LinkedFunder | null>(null);
  const [funderStats, setFunderStats] = useState<Record<string, FunderStats>>({});
  const [sendingSMS, setSendingSMS] = useState<string | null>(null);

  // Register dialog state
  const [registerOpen, setRegisterOpen] = useState(false);
  // Captured in parts; `full_name` stays one concatenated string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const regName = joinPersonName(nameParts);
  const [regPhone, setRegPhone] = useState('');
  const [regNotes, setRegNotes] = useState('');
  const [registering, setRegistering] = useState(false);
  const { isDuplicate, isChecking, duplicateMessage } = usePhoneDuplicateCheck(regPhone);

  useEffect(() => {
    if (open && user) fetchFunders();
  }, [open, user]);

  const fetchFunders = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('proxy_agent_assignments')
        .select('id, beneficiary_id, beneficiary_role, reason, created_at, approval_status, beneficiary:beneficiary_id(id, full_name, phone)')
        .eq('agent_id', user.id)
        .eq('beneficiary_role', 'supporter')
        // Only show assignments that are still the live link to the funder.
        // When a funder is reassigned to another proxy agent, the prior row
        // is flipped is_active=false by `trg_deactivate_stale_proxy_assignments`,
        // and the previous agent must immediately stop seeing them.
        .eq('is_active', true)
        .in('approval_status', ['pending', 'approved'])
        .order('created_at', { ascending: false });

      if (error) throw error;
      setFunders((data as any) || []);

      if (data && data.length > 0) {
        const statsMap: Record<string, FunderStats> = {};
        for (const f of data) {
          const bid = (f as any).beneficiary?.id;
          if (!bid) continue;
          const [portfoliosRes, balanceRes] = await Promise.all([
            supabase
              .from('investor_portfolios')
              .select('investment_amount, total_roi_earned, status')
              .eq('investor_id', bid)
              .in('status', ['active', 'matured']),
            supabase.rpc('get_proxy_partner_balance', {
              p_agent_id: user.id,
              p_partner_id: bid,
            }),
          ]);
          const portfolios = portfoliosRes.data || [];
          statsMap[bid] = {
            totalInvested: portfolios.reduce((s: number, p: any) => s + (p.investment_amount || 0), 0),
            totalROI: portfolios.reduce((s: number, p: any) => s + (p.total_roi_earned || 0), 0),
            activeCount: portfolios.filter((p: any) => p.status === 'active').length,
            walletBalance: Number(balanceRes.data) || 0,
          };
        }
        setFunderStats(statsMap);
      }
    } catch (err: any) {
      console.error('Error fetching funders:', err);
    } finally {
      setLoading(false);
    }
  };

  useFunderAccountsRealtime({
    agentId: user?.id,
    onChange: fetchFunders,
    enabled: open && !!user,
  });

  const handleSendStatement = async (funder: LinkedFunder) => {
    if (!funder.beneficiary || !user) return;
    setSendingSMS(funder.beneficiary.id);
    try {
      const { data, error } = await supabase.functions.invoke('send-funder-statement', {
        body: { funder_id: funder.beneficiary.id, agent_id: user.id },
      });
      if (error) throw error;
      if (data?.success) {
        toast({ title: '📱 Statement sent!', description: `SMS sent to ${funder.beneficiary.full_name}` });
      } else {
        toast({ title: 'SMS may not have delivered', description: 'Check with the funder', variant: 'destructive' });
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSendingSMS(null);
    }
  };

  const handleRegister = async () => {
    if (!user || !validatePersonNameParts(nameParts).valid || !regPhone.trim()) return;
    if (isDuplicate) {
      toast({ title: 'Duplicate phone', description: duplicateMessage || 'This number is already registered', variant: 'destructive' });
      return;
    }
    setRegistering(true);
    try {
      const { data, error } = await supabase.functions.invoke('register-proxy-funder', {
        body: { full_name: regName.trim(), phone: regPhone.trim(), agent_id: user.id, notes: regNotes.trim() || undefined, telemetry: await collectAgentSignupTelemetry('/agent/funders', 'funder') },
      });
      if (error) {
        const msg = await extractFromErrorObject(error);
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      toast({ title: '✅ Funder registered!', description: `${data.full_name} has been added to your funders` });
      setRegisterOpen(false);
      setNameParts({ firstName: '', otherNames: '', lastName: '' });
      setRegPhone('');
      setRegNotes('');
      fetchFunders();
    } catch (err: any) {
      toast({ title: 'Registration failed', description: err.message, variant: 'destructive' });
    } finally {
      setRegistering(false);
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="h-[92vh] rounded-t-2xl p-0">
          <SheetHeader className="p-4 pb-3 border-b border-border">
            <div className="flex items-center justify-between">
              <SheetTitle className="flex items-center gap-2 text-lg">
                <HandCoins className="h-5 w-5 text-primary" />
                My Funders
              </SheetTitle>
              <Button size="sm" className="gap-1.5 text-xs" onClick={() => setRegisterOpen(true)}>
                <UserPlus className="h-3.5 w-3.5" /> Add Funder
              </Button>
            </div>
          </SheetHeader>

          <ScrollArea className="h-[calc(92vh-60px)]">
            {capsLoading ? (
              <div className="p-4 space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
              </div>
            ) : !has('capture_supporters') ? (
              <div className="p-8 text-center">
                <AlertCircle className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
                <p className="text-sm font-medium text-muted-foreground">Funder capture not enabled</p>
                <p className="text-xs text-muted-foreground mt-1">
                  This action requires the “capture_supporters” capability. Contact Operations if you believe this is in error.
                </p>
              </div>
            ) : loading ? (
              <div className="p-4 space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
              </div>
            ) : funders.length === 0 ? (
              <div className="p-8 text-center">
                <Users className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
                <p className="text-sm font-medium text-muted-foreground">No funders yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Register a funder who doesn't have a smartphone
                </p>
                <Button size="sm" className="mt-4 gap-1.5" onClick={() => setRegisterOpen(true)}>
                  <UserPlus className="h-3.5 w-3.5" /> Register First Funder
                </Button>
              </div>
            ) : !selectedFunder ? (
              <div className="p-4 space-y-2">
                <p className="text-xs text-muted-foreground mb-2">
                  {funders.length} funder{funders.length !== 1 ? 's' : ''} managed by you
                </p>
                {funders.map(f => {
                  const stats = f.beneficiary?.id ? funderStats[f.beneficiary.id] : null;
                  return (
                    <Card
                      key={f.id}
                      className="cursor-pointer hover:bg-muted/30 transition-colors active:scale-[0.98]"
                      onClick={() => setSelectedFunder(f)}
                    >
                      <CardContent className="p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="font-semibold text-sm truncate">{f.beneficiary?.full_name || 'Funder'}</p>
                              {f.approval_status === 'pending' ? (
                                <Badge className="text-[10px] shrink-0 bg-warning/15 text-warning border-0">⏳ Pending</Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px] shrink-0">💼 Funder</Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-1 mt-0.5">
                              <Phone className="h-3 w-3 text-muted-foreground" />
                              <span className="text-xs text-muted-foreground">{f.beneficiary?.phone}</span>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            {stats && (
                              <>
                                <p className="text-xs font-bold">{formatUGX(stats.totalInvested)}</p>
                                <p className="text-[10px] text-success">+{formatUGX(stats.totalROI)}</p>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-1.5 mt-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[10px] gap-1 flex-1"
                            onClick={(e) => { e.stopPropagation(); handleSendStatement(f); }}
                            disabled={sendingSMS === f.beneficiary?.id}
                          >
                            {sendingSMS === f.beneficiary?.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Send className="h-3 w-3" />
                            )}
                            SMS Statement
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[10px] gap-1 flex-1"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (f.beneficiary?.phone) window.location.href = `tel:${f.beneficiary.phone}`;
                            }}
                          >
                            <Phone className="h-3 w-3" /> Call
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <FunderDetailView
                funder={selectedFunder}
                stats={selectedFunder.beneficiary?.id ? funderStats[selectedFunder.beneficiary.id] || null : null}
                onBack={() => setSelectedFunder(null)}
                onSendStatement={() => handleSendStatement(selectedFunder)}
                sendingSMS={sendingSMS === selectedFunder.beneficiary?.id}
                onRefresh={fetchFunders}
              />
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {/* Register Funder Dialog */}
      <Dialog open={registerOpen} onOpenChange={setRegisterOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-primary" />
              Register No-Smartphone Funder
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Full Name *</Label>
              <PersonNameFields idPrefix="funder-reg" value={nameParts} onChange={setNameParts} />
            </div>
            <div>
              <Label>Phone Number *</Label>
              <Input
                placeholder="e.g. 0704825473 or +256704825473"
                value={regPhone}
                onChange={e => setRegPhone(e.target.value)}
                type="tel"
                maxLength={15}
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Accepted formats: 0704825473, 256704825473, or +256704825473
              </p>
              {isChecking && <p className="text-[10px] text-muted-foreground mt-1">Checking...</p>}
              {isDuplicate && (
                <p className="text-[10px] text-destructive mt-1 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" /> {duplicateMessage}
                </p>
              )}
            </div>
            <div>
              <Label>Notes (optional)</Label>
              <Input
                placeholder="e.g. My uncle, lives in Kampala"
                value={regNotes}
                onChange={e => setRegNotes(e.target.value)}
                maxLength={200}
              />
            </div>
            <div className="rounded-lg bg-muted/50 p-2.5 text-[10px] text-muted-foreground">
              <p>📱 This person will be able to check their balance via USSD and receive SMS statements.</p>
              <p className="mt-1">🔒 All actions you take on their behalf are audited.</p>
            </div>
            <Button
              className="w-full"
              onClick={handleRegister}
              disabled={registering || !validatePersonNameParts(nameParts).valid || !regPhone.trim() || isDuplicate || isChecking}
            >
              {registering ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Register Funder
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
