import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { Search, User, Loader2, PlusCircle, Sparkles, Wallet } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { UGANDA_BANKS } from '@/lib/ugandaBanks';
import { useFunderApprovalStatus } from '@/hooks/useFunderApprovalStatus';
import { Shield, Lock } from 'lucide-react';
import { extractEdgeFunctionError, extractEdgeFunctionErrorDetails, type EdgeFunctionErrorDetails } from '@/lib/extractEdgeFunctionError';

interface CreateInvestmentAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  /** Fired when create fails so callers (e.g. NewPartnersPanel) can surface
   *  their own inline error toast with partner context. */
  onError?: (message: string, details?: EdgeFunctionErrorDetails & { partnerId?: string }) => void;
  prefillInvestorId?: string | null;
  prefillInvestorName?: string;
  /**
   * 'invite' (default): sends the completion-link email; portfolio lands in
   *   Invited Portfolios awaiting partner details + Ops approval.
   * 'direct_confirmation': for partners with ZERO existing portfolios only.
   *   Skips the invite email, activates the portfolio immediately, and sends
   *   the standard Tenant Partnership Confirmation email.
   */
  mode?: 'invite' | 'direct_confirmation';
}

interface UserResult {
  id: string;
  full_name: string;
  phone: string;
}

export function CreateInvestmentAccountDialog({ open, onOpenChange, onSuccess, onError, prefillInvestorId, prefillInvestorName, mode = 'invite' }: CreateInvestmentAccountDialogProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [users, setUsers] = useState<UserResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserResult | null>(null);
  const { status: approvalStatus, isApproved, isLoading: approvalLoading } =
    useFunderApprovalStatus(selectedUser?.id);

  // When the dialog opens or the selected partner changes, force a fresh
  // approval-status fetch so the "Partner Not Approved" gate / button label
  // reflects the live DB state (e.g. right after Partner Ops verifies them).
  useEffect(() => {
    if (open && selectedUser?.id) {
      qc.invalidateQueries({ queryKey: ['funder-approval-status', selectedUser.id] });
    }
  }, [open, selectedUser?.id, qc]);

  const [partnerBalance, setPartnerBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [partnerFrozen, setPartnerFrozen] = useState<boolean>(false);
  // Existing-portfolio guard: in `direct_confirmation` mode we ONLY create
  // a portfolio when the partner has ZERO existing portfolios. If any exist,
  // we block the action and prompt the operator to use the invite flow.
  const [existingPortfolioCount, setExistingPortfolioCount] = useState<number | null>(null);
  const [portfolioCheckLoading, setPortfolioCheckLoading] = useState(false);
  // Guardrail: operator must explicitly confirm the wallet debit before we
  // create a portfolio. Same dialog for first-time and repeat partners so
  // there's no silent "invite fallthrough" that leaves the wallet credited
  // but never debited (see 2026-07-24 forensic backfill).
  const [confirmOpen, setConfirmOpen] = useState(false);
  // When the selected partner is managed by a proxy agent, the dialog shows
  // the proxy agent's wallet balance instead — funding is debited from that
  // wallet server-side (enforced in create-investor-portfolio edge fn).
  const [managedProxy, setManagedProxy] = useState<{ agentId: string; agentName: string } | null>(null);

  const [form, setForm] = useState({
    account_name: '',
    investment_amount: '',
    roi_percentage: '20',
    duration_months: '12',
    roi_mode: 'monthly_payout',
    portfolio_pin: '',
    payout_day: '15',
    contribution_date: new Date().toISOString().slice(0, 10),
    payment_method: '',
    mobile_network: '',
    mobile_money_number: '',
    bank_name: '',
    bank_account_name: '',
    account_number: '',
  });

  useEffect(() => {
    if (open && prefillInvestorId && prefillInvestorName) {
      setSelectedUser({ id: prefillInvestorId, full_name: prefillInvestorName, phone: '' });
    }
  }, [open, prefillInvestorId, prefillInvestorName]);

  useEffect(() => {
    if (!open) {
      setSelectedUser(prefillInvestorId ? { id: prefillInvestorId, full_name: prefillInvestorName || '', phone: '' } : null);
      setSearchTerm('');
      setUsers([]);
      setForm({
        account_name: '', investment_amount: '', roi_percentage: '20', duration_months: '12',
        roi_mode: 'monthly_payout', portfolio_pin: '', payout_day: '15',
        contribution_date: new Date().toISOString().slice(0, 10),
        payment_method: '', mobile_network: '', mobile_money_number: '',
        bank_name: '', bank_account_name: '', account_number: '',
      });
    }
  }, [open]);

  const generatePin = () => {
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    setForm(p => ({ ...p, portfolio_pin: pin }));
  };

  useEffect(() => {
    if (open && !form.portfolio_pin) generatePin();
  }, [open]);

  // Fetch the selected partner's withdrawable wallet balance — money for the
  // portfolio MUST come from this balance, not from manual input.
  useEffect(() => {
    let cancelled = false;
    if (!selectedUser) {
      setPartnerBalance(null);
      setPartnerFrozen(false);
      setExistingPortfolioCount(null);
      return;
    }
    setBalanceLoading(true);
    setPartnerBalance(null);
    setManagedProxy(null);
    setPartnerFrozen(false);
    setExistingPortfolioCount(null);
    (async () => {
      // Suspended (frozen) partners cannot receive new portfolios.
      const { data: prof } = await supabase
        .from('profiles')
        .select('frozen_at')
        .eq('id', selectedUser.id)
        .maybeSingle();
      if (!cancelled && (prof as any)?.frozen_at) {
        setPartnerFrozen(true);
      }
      // Existing-portfolio count — used to gate direct_confirmation mode.
      setPortfolioCheckLoading(true);
      const { count: pfCount } = await supabase
        .from('investor_portfolios')
        .select('id', { count: 'exact', head: true })
        .eq('investor_id', selectedUser.id);
      if (!cancelled) {
        setExistingPortfolioCount(pfCount ?? 0);
        setPortfolioCheckLoading(false);
      }
      // Portfolio funding ALWAYS comes from the partner's own wallet — the
      // server-side create-investor-portfolio edge fn forces this too.
      const { data, error } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', selectedUser.id)
        .maybeSingle();
      if (cancelled) return;
      const bal = !error && data ? Number(data.balance) || 0 : 0;
      setPartnerBalance(bal);
      // Default the amount to the full available balance (capped at sane max).
      setForm(p => ({
        ...p,
        investment_amount: bal > 0 ? String(Math.floor(bal)) : '',
      }));
      setBalanceLoading(false);
    })();
    return () => { cancelled = true; };
  }, [selectedUser?.id]);

  // Debounced lazy search: min 4 chars, waits 400ms after last keystroke,
  // returns only the 5 closest matches. Uses the fast RPC that bypasses
  // RLS overhead on the 47k+ profiles table.
  useEffect(() => {
    const q = searchTerm.trim();
    if (q.length < 4) { setUsers([]); setSearching(false); return; }
    setSearching(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const { data, error } = await supabase.rpc('search_users_fast', {
          p_query: q,
          p_limit: 5,
        }).abortSignal(ctrl.signal);
        if (ctrl.signal.aborted) return;
        if (error) {
          // Fallback if the RPC is unavailable in this environment.
          const { data: fb } = await supabase
            .from('profiles')
            .select('id, full_name, phone')
            .or(`full_name.ilike.${q}%,phone.ilike.%${q}%`)
            .limit(5);
          setUsers((fb || []) as UserResult[]);
        } else {
          setUsers(((data as any[]) || []).slice(0, 5).map((r) => ({
            id: r.id, full_name: r.full_name ?? '', phone: r.phone ?? '',
          })));
        }
      } finally {
        if (!ctrl.signal.aborted) setSearching(false);
      }
    }, 400);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [searchTerm]);

  const handleCreate = async () => {
    if (!selectedUser || !form.investment_amount) return;
    if (partnerFrozen) {
      toast({
        title: 'Partner suspended',
        description: 'This partner account is suspended. Unfreeze the account before creating a portfolio.',
        variant: 'destructive',
      });
      return;
    }
    if (!isApproved) {
      toast({
        title: 'Partner not approved',
        description: 'This funder must be approved in Partner Onboarding before a portfolio can be created.',
        variant: 'destructive',
      });
      return;
    }
    const amt = parseFloat(form.investment_amount);
    if (isNaN(amt) || amt < 20000) {
      toast({ title: 'Investment must be at least UGX 20,000', variant: 'destructive' });
      return;
    }

    setSaving(true);
    try {
      // Route ALL Create Portfolio actions through the invite flow so that
      // existing partners also receive a "complete + sign" email, land in
      // the Invited Portfolios tab, and go through the Partner Ops review
      // gate before the portfolio activates. No wallet is debited here.
      const response = await supabase.functions.invoke('create-portfolio-invite', {
        body: {
          partner_id: selectedUser.id,
          amount: amt,
          duration_months: parseInt(form.duration_months),
          roi_percentage: parseFloat(form.roi_percentage),
          roi_mode: form.roi_mode,
          nickname: form.account_name || null,
          direct_confirmation: mode === 'direct_confirmation',
        },
      });

      if (response.error || response.data?.error) {
        const details = await extractEdgeFunctionErrorDetails(response, 'Failed to send portfolio invite');
        const err: any = new Error(details.message);
        err.details = details;
        throw err;
      }
      const data = response.data;

      const code = data?.portfolio_code || '';
      if (mode === 'direct_confirmation') {
        toast({
          title: `Portfolio ${code} created`,
          description: `${selectedUser.full_name} has been emailed the Tenant Partnership Confirmation.`,
        });
      } else {
        toast({
          title: `Invite sent — portfolio ${code}`,
          description: `${selectedUser.full_name} will get an email to review and sign. It’s now in the Invited Portfolios tab.`,
        });
      }
      qc.invalidateQueries({ queryKey: ['invited-portfolios'] });
      qc.invalidateQueries({ queryKey: ['exec-partner-portfolios'] });
      onSuccess();
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: 'Invite failed', description: e.message, variant: 'destructive' });
      const details: EdgeFunctionErrorDetails | undefined = e?.details;
      onError?.(e?.message || 'Failed to create portfolio', {
        ...(details || { message: e?.message || 'Failed to create portfolio' }),
        partnerId: selectedUser?.id,
      });
    } finally {
      setSaving(false);
    }
  };

  const set = (key: string, val: string) => setForm(p => ({ ...p, [key]: val }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90dvh] p-0 gap-0 flex flex-col overflow-hidden">
        <DialogHeader className="px-4 sm:px-6 pt-4 sm:pt-6 pb-2 shrink-0 border-b">
          <DialogTitle className="flex items-center gap-2">
            <PlusCircle className="h-4 w-4 text-primary" />
            New Portfolio Account
          </DialogTitle>
        </DialogHeader>

        {/* Scrollable body — keeps the sticky footer/action button out of the
            way on mobile so it never overlaps inputs and stays fully tappable. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-3 space-y-4">
          {/* Partner selection */}
          {!selectedUser ? (
            <div className="space-y-2">
              <Label className="text-xs">Select Partner</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Type at least 4 characters (name or phone)..." className="pl-9 h-9" autoFocus />
              </div>
              {searchTerm.length > 0 && searchTerm.length < 4 && (
                <p className="text-[11px] text-muted-foreground pl-1">Keep typing — {4 - searchTerm.length} more character{4 - searchTerm.length === 1 ? '' : 's'} to search.</p>
              )}
              {searching && <div className="flex justify-center py-2"><Loader2 className="h-4 w-4 animate-spin" /></div>}
              {users.length > 0 && (
                <ScrollArea className="max-h-40 border rounded-lg">
                  {users.map(u => (
                    <button key={u.id} onClick={() => { setSelectedUser(u); setUsers([]); setSearchTerm(''); }}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 text-left text-sm">
                      <User className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-medium">{u.full_name}</span>
                      <span className="text-xs text-muted-foreground ml-auto">{u.phone}</span>
                    </button>
                  ))}
                </ScrollArea>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border p-2.5 bg-muted/30">
              <User className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium flex-1">{selectedUser.full_name}</span>
              {!prefillInvestorId && (
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelectedUser(null)}>Change</Button>
              )}
            </div>
          )}

          {selectedUser && partnerFrozen && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 flex items-start gap-2">
              <Shield className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="text-xs">
                <p className="font-semibold text-destructive">Partner account suspended</p>
                <p className="text-muted-foreground">Portfolios cannot be created for a suspended account. Unfreeze the account first.</p>
              </div>
            </div>
          )}

          {selectedUser && !partnerFrozen && !approvalLoading && !isApproved && (
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-2.5 flex items-start gap-2">
              <Shield className="h-4 w-4 text-warning shrink-0 mt-0.5" />
              <div className="text-xs">
                <p className="font-bold text-warning">
                  {approvalStatus === 'rejected' ? 'Partner rejected' : 'Partner not yet approved'}
                </p>
                <p className="text-muted-foreground mt-0.5 leading-relaxed">
                  {approvalStatus === 'rejected'
                    ? 'This funder was rejected in Partner Onboarding. Re-approve them before creating a portfolio.'
                    : 'This funder is awaiting Partner Ops verification. Approve them in Partner Onboarding before creating a portfolio.'}
                </p>
              </div>
            </div>
          )}

          {selectedUser && !partnerFrozen && isApproved && mode === 'direct_confirmation' && (existingPortfolioCount ?? 0) > 0 && (
            <div className="rounded-lg border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 p-2.5 flex items-start gap-2">
              <Sparkles className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-xs">
                <p className="font-semibold text-amber-800 dark:text-amber-200">
                  Partner already holds {existingPortfolioCount} portfolio{existingPortfolioCount === 1 ? '' : 's'}
                </p>
                <p className="text-muted-foreground mt-0.5 leading-relaxed">
                  A new portfolio will still debit their wallet immediately. Only cancel/reject the portfolio if they should be refunded.
                </p>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">Account Name <span className="text-muted-foreground">(optional)</span></Label>
            <Input value={form.account_name} onChange={e => set('account_name', e.target.value)} placeholder="e.g. Premium Fund" className="h-9" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs flex items-center gap-1">
                <Wallet className="h-3 w-3" /> From Wallet (UGX) *
              </Label>
              <Input
                type="number"
                min={1000}
                max={partnerBalance ?? undefined}
                value={form.investment_amount}
                onChange={e => set('investment_amount', e.target.value)}
                placeholder={partnerBalance ? String(Math.floor(partnerBalance)) : '—'}
                className="h-9"
                disabled={!selectedUser || balanceLoading}
              />
              {selectedUser && (
                <p className="text-[10px] text-muted-foreground">
                  {balanceLoading
                    ? 'Loading partner wallet…'
                    : `Partner wallet · Available: UGX ${(partnerBalance ?? 0).toLocaleString()}`}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">ROI %</Label>
              <Input type="number" min={0} max={100} value={form.roi_percentage} onChange={e => set('roi_percentage', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Duration</Label>
              <Select value={form.duration_months} onValueChange={v => set('duration_months', v)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="3">3 Months</SelectItem>
                  <SelectItem value="6">6 Months</SelectItem>
                  <SelectItem value="12">12 Months</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">ROI Mode</Label>
              <Select value={form.roi_mode} onValueChange={v => set('roi_mode', v)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly_payout">Monthly Payout</SelectItem>
                  <SelectItem value="monthly_compounding">Compounding</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Contribution Date</Label>
              <Input
                type="date"
                className="h-9"
                value={form.contribution_date}
                max={new Date().toISOString().slice(0, 10)}
                onChange={e => {
                  const v = e.target.value;
                  // Derive payout day-of-month from the chosen contribution date
                  const day = v ? Math.min(28, Number(v.slice(8, 10)) || 15) : 15;
                  setForm(p => ({ ...p, contribution_date: v, payout_day: String(day) }));
                }}
              />
              <p className="text-[10px] text-muted-foreground">Sets the recurring payout day to match this date.</p>
            </div>
          </div>

          {/* Portfolio PIN */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Portfolio PIN (4 digits) *</Label>
              <Button type="button" variant="ghost" size="sm" onClick={generatePin} className="h-6 text-[10px] gap-1">
                <Sparkles className="h-3 w-3" /> Generate
              </Button>
            </div>
            <Input type="text" inputMode="numeric" maxLength={4} placeholder="e.g. 1234" value={form.portfolio_pin}
              onChange={e => set('portfolio_pin', e.target.value.replace(/\D/g, '').slice(0, 4))}
              className="h-9 font-mono tracking-widest" />
          </div>

          {/* Payment Method */}
          <div className="space-y-1.5">
            <Label className="text-xs">Payment Method <span className="text-muted-foreground">(optional)</span></Label>
            <Select value={form.payment_method} onValueChange={v => set('payment_method', v)}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select payout method" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="mobile_money">📱 Mobile Money</SelectItem>
                <SelectItem value="bank">🏦 Bank Transfer</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {form.payment_method === 'mobile_money' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Network</Label>
                <Select value={form.mobile_network} onValueChange={v => set('mobile_network', v)}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mtn">MTN</SelectItem>
                    <SelectItem value="airtel">Airtel</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">MoMo Number</Label>
                <Input value={form.mobile_money_number} onChange={e => set('mobile_money_number', e.target.value)} placeholder="0770000000" className="h-9" inputMode="tel" />
              </div>
            </div>
          )}

          {form.payment_method === 'bank' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Bank</Label>
                <Select value={form.bank_name} onValueChange={v => set('bank_name', v)}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="Select bank" /></SelectTrigger>
                  <SelectContent>
                    {UGANDA_BANKS.map(b => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Account Name</Label>
                  <Input value={form.bank_account_name} onChange={e => set('bank_account_name', e.target.value)} placeholder="Account holder" className="h-9" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Account Number</Label>
                  <Input value={form.account_number} onChange={e => set('account_number', e.target.value)} placeholder="0123456789" className="h-9" />
                </div>
              </div>
            </div>
          )}
        </div>

        {selectedUser && !approvalLoading && !isApproved && (
          // Inline rationale rendered ABOVE the footer (the footer is a
          // flex row, so an explanatory block fits better here). Tells
          // the operator exactly why the Verify link replaced the
          // Create Portfolio action.
          <div className="shrink-0 mx-4 sm:mx-6 mb-2 rounded-md border border-amber-300/70 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700/50 p-2.5 text-[11px] leading-snug text-amber-800 dark:text-amber-200">
            <p className="font-semibold mb-0.5">Why approval is needed</p>
            <p>
              This partner self-registered and hasn't been verified by Partner Ops yet.
              Portfolios cannot move funds for an unverified partner — verify their
              identity & contact details first, then return here to create the portfolio.
            </p>
          </div>
        )}

        <DialogFooter className="shrink-0 flex-col-reverse gap-2 sm:flex-row sm:gap-2 px-4 sm:px-6 py-3 border-t bg-background pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          {selectedUser && !approvalLoading && !isApproved ? (
            // When the selected partner isn't yet approved, swap the
            // disabled gate for an actionable link that deep-jumps to
            // their row in Partner Onboarding so the operator can
            // verify them in one click. The dialog stays mounted; on
            // returning, the approval-status query auto-revalidates
            // (see useEffect above) and this button flips back to
            // "Create Portfolio".
            <Button
              asChild
              variant="outline"
              className="w-full sm:w-auto whitespace-normal text-center leading-tight min-h-[2.75rem] h-auto py-2 border-amber-400 text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/40"
            >
              <Link
                to={`/partner-onboarding?focus=${selectedUser.id}`}
                onClick={() => {
                  // Telemetry: record that an operator clicked the deep-link
                  // gate from the Create Portfolio dialog. Fire-and-forget;
                  // we never block the navigation on this insert.
                  if (user && selectedUser) {
                    supabase.from('audit_logs').insert({
                      user_id: user.id,
                      action_type: 'partner_verify_link_clicked',
                      table_name: 'profiles',
                      record_id: selectedUser.id,
                      metadata: {
                        source: 'create_investment_account_dialog',
                        partner_name: selectedUser.full_name || null,
                        partner_phone: selectedUser.phone || null,
                        reason: 'Operator clicked Verify in Partner Onboarding deep link from Create Portfolio gate',
                      },
                    }).then(({ error }) => {
                      if (error) console.warn('[verify-link telemetry] insert failed:', error.message);
                    });
                  }
                }}
              >
                <Lock className="h-3.5 w-3.5 mr-1.5 shrink-0" />
                <span className="sm:hidden">Verify partner</span>
                <span className="hidden sm:inline">Verify in Partner Onboarding</span>
              </Link>
            </Button>
          ) : (
            <Button
              onClick={() => {
                // Pre-validate cheap client-side checks BEFORE opening the
                // confirm dialog so we don't ask the operator to confirm a
                // debit that would immediately be rejected.
                if (!selectedUser || !form.investment_amount) return;
                if (partnerFrozen || !isApproved) { handleCreate(); return; }
                const amt = parseFloat(form.investment_amount);
                if (isNaN(amt) || amt < 20000) { handleCreate(); return; }
                setConfirmOpen(true);
              }}
              className="w-full sm:w-auto whitespace-normal text-center leading-tight min-h-[2.75rem] h-auto py-2"
              disabled={
                saving ||
                !selectedUser ||
                !form.investment_amount ||
                !isApproved ||
                partnerFrozen ||
                portfolioCheckLoading
              }
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5 shrink-0" />}
              {approvalLoading && selectedUser ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5 shrink-0" />
                  Checking approval…
                </>
              ) : portfolioCheckLoading && selectedUser ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5 shrink-0" />
                  Checking portfolios…
                </>
              ) : (
                mode === 'direct_confirmation' ? 'Create Portfolio' : 'Send invite'
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Debit partner wallet now?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  You are about to create a portfolio for{' '}
                  <span className="font-semibold">{selectedUser?.full_name}</span>{' '}
                  and immediately debit their wallet:
                </p>
                <div className="rounded-md bg-muted/50 border p-3 space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Amount</span>
                    <span className="font-bold">
                      UGX {Number(form.investment_amount || 0).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Duration</span>
                    <span>{form.duration_months} months</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">ROI</span>
                    <span>{form.roi_percentage}% ({form.roi_mode === 'monthly_payout' ? 'monthly payout' : 'compounding'})</span>
                  </div>
                  {existingPortfolioCount != null && existingPortfolioCount > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Existing portfolios</span>
                      <span>{existingPortfolioCount}</span>
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  The wallet debit posts <strong>immediately</strong>. If the portfolio is later
                  rejected or cancelled, the funds will be refunded to the partner wallet via a
                  reversing ledger entry — never leave a portfolio hanging without either activating
                  or rejecting it.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(e) => {
                e.preventDefault();
                setConfirmOpen(false);
                handleCreate();
              }}
            >
              {saving ? 'Creating…' : 'Confirm & debit wallet'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
