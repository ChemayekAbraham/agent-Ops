import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from '@/lib/motion-lite';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { Label } from '@/components/ui/label';

import sendMoneyIllustration from '@/assets/undraw_wallet_diag.svg.asset.json';
import { useWallet } from '@/hooks/useWallet';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useFirstTransactionCelebration } from '@/hooks/useFirstTransactionCelebration';
import { useConfetti } from '@/components/Confetti';
import { toast } from 'sonner';
import { AutoPayoutSection } from '@/components/wallet/AutoPayoutSection';

import { useProfile } from '@/hooks/useProfile';
import { UserAvatar } from '@/components/UserAvatar';
import { WELILE_ITEM_IMAGES } from '@/lib/welileItemImages';

import { 
  Loader2, Send, Phone, Coins, FileText, CheckCircle, Sparkles, UserCheck, UserX,
  Mail, UtensilsCrossed, Fuel, AlertTriangle, ArrowRight, Home, Egg, Gift, Landmark, Sandwich,
  Star, X, Pencil, Check, Search, Bike
} from 'lucide-react';

/**
 * Every Welile transfer is a payment for one of these items. The sender picks
 * from this fixed list — no free-text reasons — and the chosen label becomes
 * the statement description on BOTH wallet legs (handled server side).
 */
const WELILE_ITEMS = [
  { label: 'Welile Rent', hint: 'Rent payment', icon: Home },
  { label: 'Welile Bread', hint: 'Bread', icon: Sandwich },
  { label: 'Welile Chapati', hint: 'Chapati', icon: UtensilsCrossed },
  { label: 'Welile Eggs', hint: 'Eggs', icon: Egg },
  { label: 'Welile Fuel', hint: 'Fuel', icon: Fuel },
  { label: 'Welile Reward', hint: 'A reward', icon: Gift },
  { label: 'Welile Boda fees', hint: 'Boda ride', icon: Bike },
  { label: 'Welile tax', hint: 'Tax', icon: Landmark },
] as const;

/**
 * Asks the server whether this receiver can actually be paid (live account,
 * not closed, not frozen, not yourself). Returns a plain-language problem to
 * show the sender, or null when the receiver is fine. A lookup error returns
 * null — the same gate runs again server-side before any money moves.
 */
async function recipientProblem(recipientId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('check_transfer_recipient_eligibility', {
    p_recipient_id: recipientId,
    p_item: null,
  });
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return row.eligible ? null : (row.reason || 'This person cannot receive money right now.');
}

import {
  loadRecipients,
  rememberRecipient,
  toggleFavorite,
  removeRecipient,
  updateNickname,
  sortRecipients,
  type SavedRecipient,
} from '@/lib/transferRecipients';

interface SendMoneyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const formVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08, delayChildren: 0.1 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 15, scale: 0.98 },
  visible: { 
    opacity: 1, 
    y: 0, 
    scale: 1,
    transition: { type: 'spring' as const, stiffness: 300, damping: 25 }
  },
};

export function SendMoneyDialog({ open, onOpenChange }: SendMoneyDialogProps) {
  const { sendMoney, wallet } = useWallet();
  const { user } = useAuth();
  const { profile } = useProfile();
  const { triggerCelebration, markCelebrated } = useFirstTransactionCelebration();
  const { fireSuccess } = useConfetti();
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState<'phone' | 'email'>('phone');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [isFirstTx, setIsFirstTx] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [lookupNonce, setLookupNonce] = useState(0);
  const [savedRecipients, setSavedRecipients] = useState<SavedRecipient[]>([]);
  const [editingNicknameId, setEditingNicknameId] = useState<string | null>(null);
  const [draftNickname, setDraftNickname] = useState('');
  const [recipientSearch, setRecipientSearch] = useState('');
  const [approvedDepositCount, setApprovedDepositCount] = useState<number | null>(null);
  const MIN_APPROVED_DEPOSITS = 7;
  // Agent daily-collection performance gate (mirrors WithdrawFlow). When an
  // agent has active tenants and today's collection ratio < 20%, sending
  // money to another user is blocked — same rule as withdrawals.
  const [perfLocked, setPerfLocked] = useState(false);
  const [perfPct, setPerfPct] = useState<number | null>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  type RecipientMatch = {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    isSelf: boolean;
  };
  const [recipient, setRecipient] = useState<
    | { status: 'idle' }
    | { status: 'invalid'; reason: string }
    | { status: 'searching' }
    | { status: 'found'; id: string; name: string; phone: string; email: string | null; isSelf: boolean }
    | { status: 'multiple'; matches: RecipientMatch[] }
    | { status: 'not_found' }
  >({ status: 'idle' });

  // Load this user's saved recipients (favourites + recents) when the dialog opens.
  useEffect(() => {
    if (open) {
      setSavedRecipients(sortRecipients(loadRecipients(user?.id)));
    }
  }, [open, user?.id]);

  // Anti-fraud gate: user-to-user transfers require at least 7 approved deposits.
  // We fetch the current count each time the dialog opens so the message and the
  // disabled state reflect the freshest server truth.
  useEffect(() => {
    if (!open || !user?.id) return;
    let cancelled = false;
    (async () => {
      const { count, error } = await supabase
        .from('deposit_requests')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('status', 'approved');
      if (cancelled) return;
      if (error) {
        // On error we still allow the server-side gate to be the final word.
        setApprovedDepositCount(null);
        return;
      }
      setApprovedDepositCount(count ?? 0);
    })();
    return () => { cancelled = true; };
  }, [open, user?.id]);

  // Agent performance gate — locks transfers when today's collection ratio
  // is under 20% (matches server-side wallet-transfer + withdrawal trigger).
  useEffect(() => {
    if (!open || !user?.id) return;
    let cancelled = false;
    (async () => {
      const [{ data: rolesRows }, { data: cashoutRow }, { data: proxyRow }, { data: gateOff }] = await Promise.all([
        supabase.from('user_roles').select('role').eq('user_id', user.id),
        supabase.from('cashout_agents').select('agent_id').eq('agent_id', user.id).eq('is_active', true).maybeSingle(),
        (supabase as any).from('proxy_agent_assignments').select('agent_id').eq('agent_id', user.id).eq('is_active', true).maybeSingle(),
        supabase.rpc('is_agent_perf_gate_disabled' as never),
      ]);
      if (cancelled) return;
      const roles = (rolesRows ?? []).map((r: any) => r.role as string);
      const isAgent = roles.includes('agent') || roles.includes('senior_agent');
      const isMerchant = !!cashoutRow;
      const isProxy = !!proxyRow;
      if (!isAgent || isMerchant || isProxy || gateOff) {
        setPerfLocked(false);
        setPerfPct(null);
        return;
      }
      const { data: perf } = await (supabase as any)
        .from('v_agent_daily_eligibility')
        .select('active_count, expected_daily, today_pct')
        .eq('agent_id', user.id)
        .maybeSingle();
      if (cancelled) return;
      if (!perf || Number(perf.active_count) <= 0 || Number(perf.expected_daily) <= 0) {
        setPerfLocked(false);
        setPerfPct(null);
        return;
      }
      const pct = Number(perf.today_pct ?? 0) * 100;
      setPerfPct(pct);
      setPerfLocked(pct < 20);
    })();
    return () => { cancelled = true; };
  }, [open, user?.id]);

  const depositsCompleted = approvedDepositCount ?? 0;
  const transferLocked =
    approvedDepositCount !== null && depositsCompleted < MIN_APPROVED_DEPOSITS;
  const depositsRemaining = Math.max(0, MIN_APPROVED_DEPOSITS - depositsCompleted);

  // Fill the input from a saved recipient chip — the debounced lookup re-resolves them.
  const selectSavedRecipient = (r: SavedRecipient) => {
    if (r.mode === 'email' && r.email) {
      setMode('email');
      setEmail(r.email);
      setPhone('');
    } else if (r.phone) {
      setMode('phone');
      setPhone(r.phone);
      setEmail('');
    }
    setRecipient({ status: 'searching' });
    setLookupNonce((n) => n + 1);
  };

  const handleToggleFavorite = (r: SavedRecipient) => {
    setSavedRecipients(sortRecipients(toggleFavorite(user?.id, r)));
  };

  const handleRemoveSaved = (r: SavedRecipient) => {
    setSavedRecipients(sortRecipients(removeRecipient(user?.id, r)));
  };

  // Debounced recipient lookup (phone OR email depending on mode)
  useEffect(() => {
    if (mode === 'phone') {
      const digits = phone.replace(/\D/g, '');
      if (digits.length === 0) {
        setRecipient({ status: 'idle' });
        return;
      }
      // Reject obviously wrong shapes early
      if (digits.length < 9) {
        setRecipient({
          status: 'invalid',
          reason: `Phone number too short (${digits.length}/9 digits).`,
        });
        return;
      }
      if (digits.length > 13) {
        setRecipient({
          status: 'invalid',
          reason: 'Phone number is too long. Use a Ugandan format like 0783673998 or +256783673998.',
        });
        return;
      }
      const last9 = digits.slice(-9);
      // Ugandan mobile numbers always start with 7 (after the leading 0 / 256)
      if (!/^7\d{8}$/.test(last9)) {
        setRecipient({
          status: 'invalid',
          reason: 'Enter a valid Ugandan mobile number (e.g. 0783673998).',
        });
        return;
      }
      setRecipient({ status: 'searching' });
      let cancelled = false;
      const timer = setTimeout(async () => {
        const { data, error } = await supabase.rpc('resolve_transfer_recipient', {
          p_phone: last9,
          p_email: null,
        });
        if (cancelled) return;
        if (error || !data || data.length === 0) {
          setRecipient({ status: 'not_found' });
          return;
        }
        const matches: RecipientMatch[] = data.map((d) => ({
          id: d.id,
          name: d.display_name || 'Welile user',
          phone: d.masked_phone || '',
          email: d.masked_email || null,
          isSelf: !!d.is_self,
        }));
        if (matches.length === 1) {
          const m = matches[0];
          if (!m.isSelf) {
            const bad = await recipientProblem(m.id);
            if (cancelled) return;
            if (bad) {
              setRecipient({ status: 'invalid', reason: bad });
              return;
            }
          }
          setRecipient({
            status: 'found',
            id: m.id,
            name: m.name,
            phone: m.phone,
            email: m.email,
            isSelf: m.isSelf,
          });
        } else {
          setRecipient({ status: 'multiple', matches });
        }
      }, 400);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }

    // Email mode
    const trimmed = email.trim().toLowerCase();
    if (trimmed.length === 0) {
      setRecipient({ status: 'idle' });
      return;
    }
    if (trimmed.length > 254) {
      setRecipient({ status: 'invalid', reason: 'Email is too long.' });
      return;
    }
    const validEmail = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(trimmed);
    if (!validEmail) {
      setRecipient({
        status: 'invalid',
        reason: 'Enter a valid email like name@example.com.',
      });
      return;
    }
    setRecipient({ status: 'searching' });
    let cancelled = false;
    const timer = setTimeout(async () => {
      const { data, error } = await supabase.rpc('resolve_transfer_recipient', {
        p_phone: null,
        p_email: trimmed,
      });
      if (cancelled) return;
      if (error || !data || data.length === 0) {
        setRecipient({ status: 'not_found' });
        return;
      }
      const matches: RecipientMatch[] = data.map((d) => ({
        id: d.id,
        name: d.display_name || 'Welile user',
        phone: d.masked_phone || '',
        email: d.masked_email || null,
        isSelf: !!d.is_self,
      }));
      if (matches.length === 1) {
        const m = matches[0];
        if (!m.isSelf) {
          const bad = await recipientProblem(m.id);
          if (cancelled) return;
          if (bad) {
            setRecipient({ status: 'invalid', reason: bad });
            return;
          }
        }
        setRecipient({
          status: 'found',
          id: m.id,
          name: m.name,
          phone: m.phone,
          email: m.email,
          isSelf: m.isSelf,
        });
      } else {
        setRecipient({ status: 'multiple', matches });
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, phone, email, user?.id, lookupNonce]);

  const selectedItem = WELILE_ITEMS.find((i) => i.label === description) ?? null;

  // Sender + receiver identity card, shown on the confirmation and success
  // screens so both sides of the transfer are always a face and a name.
  const PeopleCard = ({ recipientName }: { recipientName: string | null }) => (
    <div className="rounded-lg border border-border/60 bg-background/50 p-4">
      <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">People</p>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <UserAvatar avatarUrl={profile?.avatar_url} fullName={profile?.full_name} size="sm" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{profile?.full_name || 'You'}</p>
            <p className="text-[11px] text-muted-foreground">Sender</p>
          </div>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 text-right">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{recipientName || '—'}</p>
            <p className="text-[11px] text-muted-foreground">Receiver</p>
          </div>
          <UserAvatar fullName={recipientName || 'user'} size="sm" />
        </div>
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        They will see your name and this item on their wallet statement.
      </p>
    </div>
  );

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-UG', {
      style: 'currency',
      currency: 'UGX',
      minimumFractionDigits: 0,
    }).format(value);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      toast.error('Enter an amount greater than 0 UGX');
      return;
    }
    if (wallet && amountNum > (wallet.withdrawable || 0)) {
      toast.error(`Insufficient transferable balance. Available: ${formatCurrency(wallet.withdrawable || 0)}`);
      return;
    }
    if (mode === 'phone' && !phone) {
      toast.error('Enter the recipient phone number to continue');
      return;
    }
    if (mode === 'email' && !email) {
      toast.error('Enter the recipient email to continue');
      return;
    }

    if (recipient.status === 'invalid') {
      toast.error(recipient.reason);
      return;
    }
    if (recipient.status === 'not_found') {
      toast.error(
        mode === 'email'
          ? 'No Welile user found for this email address'
          : 'No Welile user found for this phone number'
      );
      return;
    }
    if (recipient.status === 'found' && recipient.isSelf) {
      toast.error("You can't send money to your own account");
      return;
    }
    if (recipient.status === 'searching') {
      toast.error('Still verifying recipient — please wait a moment');
      return;
    }
    if (recipient.status === 'multiple') {
      toast.error('Multiple accounts match — pick the correct recipient to continue');
      return;
    }
    if (recipient.status === 'idle') {
      toast.error(
        mode === 'email'
          ? 'Enter a valid recipient email like name@example.com'
          : 'Enter a valid Ugandan phone number (e.g. 0783673998)'
      );
      return;
    }

    // Open confirmation step — user must explicitly confirm before money is sent.
    setConfirming(true);
  };

  // Single source of truth for why the Send button is disabled.
  // Returned string is shown inline; null means the button is enabled.
  const getDisabledReason = (): string | null => {
    if (loading) return 'Sending… please wait.';
    if (perfLocked) {
      return `Transfers disabled: today's collection is ${(perfPct ?? 0).toFixed(1)}% (min 20%). Collect from your tenants first.`;
    }
    if (transferLocked) {
      return `Sending to another user unlocks after ${MIN_APPROVED_DEPOSITS} approved deposits (${depositsCompleted}/${MIN_APPROVED_DEPOSITS}).`;
    }
    const amountNum = parseFloat(amount);
    if (mode === 'phone' && !phone.trim()) return 'Enter the recipient phone number to continue.';
    if (mode === 'email' && !email.trim()) return 'Enter the recipient email to continue.';
    if (recipient.status === 'idle') {
      return mode === 'email'
        ? 'Enter a valid recipient email like name@example.com.'
        : 'Enter a valid Ugandan phone number (e.g. 0783673998).';
    }
    if (recipient.status === 'invalid') return recipient.reason;
    if (recipient.status === 'searching') return 'Verifying recipient on Welile…';
    if (recipient.status === 'not_found') {
      return mode === 'email'
        ? 'No Welile user found for this email address.'
        : 'No Welile user found for this phone number.';
    }
    if (recipient.status === 'multiple') return 'Multiple accounts match — pick the correct recipient above.';
    if (recipient.status === 'found' && recipient.isSelf) {
      return "You can't send money to your own account.";
    }
    if (!amount.trim() || isNaN(amountNum) || amountNum <= 0) return 'Enter an amount greater than 0 UGX.';
    if (wallet && amountNum > (wallet.withdrawable || 0)) {
      return `Insufficient transferable balance. Available: ${formatCurrency(wallet.withdrawable || 0)}.`;
    }
    if (!selectedItem) return 'Pick what you are sending (Welile Rent, Welile Bread, …).';
    return null;
  };
  const disabledReason = getDisabledReason();
  const sendDisabled = disabledReason !== null;

  const executeSend = async () => {
    const amountNum = parseFloat(amount);
    setLoading(true);
    // Send by the resolved recipient id (returned by resolve_transfer_recipient).
    // We no longer pass a raw phone — the masked phone shown in the UI is
    // display-only and is never used to route the transfer.
    const recipientId =
      recipient.status === 'found' ? recipient.id : undefined;
    if (!recipientId) {
      setLoading(false);
      toast.error('Pick a valid recipient before sending');
      return;
    }
    const { error } = await sendMoney(recipientId, amountNum, description);
    setLoading(false);

    if (error) {
      toast.error(error.message);
      return;
    }

    // Remember this recipient so the user doesn't have to retype next time.
    if (recipient.status === 'found') {
      setSavedRecipients(
        sortRecipients(
          rememberRecipient(user?.id, {
            id: recipient.id,
            name: recipient.name,
            phone: mode === 'phone' ? phone : recipient.phone,
            email: mode === 'email' ? email : recipient.email || undefined,
            mode,
          }),
        ),
      );
    }

    setConfirming(false);
    setSuccess(true);
    
    // Check if this was the first transaction and trigger celebration
    setTimeout(async () => {
      const celebrated = localStorage.getItem(`welile_first_tx_celebrated_${wallet?.user_id}`);
      if (!celebrated) {
        // This might be their first transaction - fire confetti!
        fireSuccess();
        setIsFirstTx(true);
        localStorage.setItem(`welile_first_tx_celebrated_${wallet?.user_id}`, 'true');
        toast.success('🎉 Congratulations on your first transaction!', {
          duration: 4000,
        });
      }
    }, 300);
    
    toast.success(`Successfully sent ${formatCurrency(amountNum)}`);
    
    setTimeout(() => {
      setPhone('');
      setEmail('');
      setMode('phone');
      setAmount('');
      setDescription('');
      setSuccess(false);
      setIsFirstTx(false);
      setRecipient({ status: 'idle' });
      onOpenChange(false);
    }, isFirstTx ? 3000 : 1500);
  };

  const handleClose = (value: boolean) => {
    if (!value) {
      setPhone('');
      setEmail('');
      setMode('phone');
      setAmount('');
      setDescription('');
      setSuccess(false);
      setIsFirstTx(false);
      setConfirming(false);
      setRecipient({ status: 'idle' });
      setRecipientSearch('');
    }
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className={`w-screen max-w-none h-[100dvh] max-h-[100dvh] rounded-none border-border/50 glass-card sm:w-full sm:max-w-md sm:h-auto sm:max-h-[85vh] sm:rounded-xl ${
          confirming ? 'grid-rows-[minmax(0,1fr)] overflow-hidden' : 'overflow-y-auto'
        }`}
      >
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 pointer-events-none" />
        
        <AnimatePresence mode="wait">
          {success ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className="py-12 flex flex-col items-center justify-center relative"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring' as const, stiffness: 300, damping: 20, delay: 0.1 }}
                className={`w-20 h-20 rounded-full flex items-center justify-center mb-4 ${isFirstTx ? 'bg-gradient-to-br from-success/30 to-primary/30' : 'bg-success/20'}`}
              >
                <CheckCircle className={`h-10 w-10 ${isFirstTx ? 'text-primary' : 'text-success'}`} />
              </motion.div>
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="text-lg font-semibold"
              >
                {isFirstTx ? '🎉 First Transaction!' : 'Money Sent!'}
              </motion.p>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="text-muted-foreground text-sm text-center"
              >
                {selectedItem
                  ? `${selectedItem.label} of ${formatCurrency(parseFloat(amount))} sent successfully`
                  : `${formatCurrency(parseFloat(amount))} transferred successfully`}
              </motion.p>
              <div className="mt-4 w-full px-1">
                <PeopleCard recipientName={recipient.status === 'found' ? recipient.name : null} />
              </div>
            </motion.div>
          ) : confirming ? (
            <motion.div
              key="confirm"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="relative flex h-full min-h-0 flex-col"
            >
              <img
                src={sendMoneyIllustration.url}
                alt="Illustration of a wallet and money transfer"
                loading="lazy"
                className="mx-auto mb-2 h-14 w-auto shrink-0 min-[390px]:h-16 sm:mb-3 sm:h-28"
              />
              <DialogHeader className="shrink-0 pr-12">
                <DialogTitle className="flex items-center gap-2">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <CheckCircle className="h-5 w-5 text-primary" />
                  </div>
                  Confirm transfer
                </DialogTitle>
                <DialogDescription>
                  Review the recipient before sending. This cannot be undone.
                </DialogDescription>
              </DialogHeader>

              <div className="mt-3 min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain pb-3 pr-0.5 sm:mt-4 sm:space-y-3">
                <div className="rounded-lg border border-border/60 bg-background/50 p-3 space-y-1.5 sm:p-4 sm:space-y-2">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Sending to</p>
                  <p className="text-base font-semibold">
                    {recipient.status === 'found' ? recipient.name : '—'}
                  </p>
                  <div className="space-y-1 text-sm text-muted-foreground">
                    {recipient.status === 'found' && recipient.phone && (
                      <div className="flex items-center gap-2">
                        <Phone className="h-3.5 w-3.5" />
                        <span className="text-foreground">{recipient.phone}</span>
                      </div>
                    )}
                    {recipient.status === 'found' && recipient.email && (
                      <div className="flex items-center gap-2">
                        <Mail className="h-3.5 w-3.5" />
                        <span className="text-foreground truncate">{recipient.email}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-border/60 bg-background/50 p-3 space-y-2 sm:p-4 sm:space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">Amount</span>
                    <span className="text-sm font-semibold text-foreground">{formatCurrency(parseFloat(amount) || 0)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">Transfer fee</span>
                    <span className="text-sm font-semibold text-success">Free</span>
                  </div>
                  <div className="flex items-center justify-between border-t border-border/60 pt-2.5">
                    <span className="text-xs font-semibold uppercase tracking-wide text-foreground">Total to send</span>
                    <span className="text-lg font-bold">{formatCurrency(parseFloat(amount) || 0)}</span>
                  </div>
                  {selectedItem && (
                    <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-2.5">
                      <span className="text-xs uppercase tracking-wide text-muted-foreground">Item</span>
                      <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        {WELILE_ITEM_IMAGES[selectedItem.label] ? (
                          <img
                            src={WELILE_ITEM_IMAGES[selectedItem.label]}
                            alt={selectedItem.label}
                            loading="lazy"
                            width={512}
                            height={512}
                            className="h-8 w-8 rounded-md object-cover"
                          />
                        ) : (
                          <selectedItem.icon className="h-4 w-4 text-primary" />
                        )}
                        {selectedItem.label}
                      </span>
                    </div>
                  )}
                </div>

                <div className="hidden sm:block">
                  <PeopleCard recipientName={recipient.status === 'found' ? recipient.name : null} />
                </div>
              </div>

              <DialogFooter className="-mx-5 -mb-5 shrink-0 gap-2 border-t border-border/50 bg-background px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:mt-2 sm:gap-0 sm:py-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setConfirming(false)}
                  disabled={loading}
                  size="lg"
                  className="w-full sm:w-auto"
                >
                  Back
                </Button>
                <Button
                  type="button"
                  onClick={executeSend}
                  disabled={loading}
                  size="lg"
                  className="w-full sm:w-auto gap-2"
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  Confirm & Send
                </Button>
              </DialogFooter>
            </motion.div>
          ) : (
            <motion.div
              key="form"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="relative"
            >
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <motion.div
                    className="p-2 rounded-lg bg-primary/10"
                    whileHover={{ scale: 1.1, rotate: 5 }}
                    transition={{ type: 'spring' as const, stiffness: 400, damping: 17 }}
                  >
                    <Send className="h-5 w-5 text-primary" />
                  </motion.div>
                  Send Money
                </DialogTitle>
                <DialogDescription>
                  Send money to anyone on Welile using their phone number
                </DialogDescription>
              </DialogHeader>

              <motion.form 
                onSubmit={handleSubmit} 
                className="space-y-4 mt-4"
                variants={formVariants}
                initial="hidden"
                animate="visible"
              >
                {/* Balance summary — one calm card, big number, subtle locked notice */}
                <motion.div
                  variants={itemVariants}
                  className="rounded-2xl border border-border/60 bg-muted/40 p-4"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Available to send
                    </span>
                    <span className="text-base font-bold text-success">
                      {formatCurrency(wallet?.withdrawable || 0)}
                    </span>
                  </div>
                  {(wallet?.float_balance || 0) > 0 && (
                    <div className="mt-3 flex items-start gap-2 border-t border-border/50 pt-3">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        {formatCurrency(wallet?.float_balance || 0)} operational float is locked and
                        cannot be transferred.
                      </p>
                    </div>
                  )}
                </motion.div>
                {transferLocked && (
                  <motion.div
                    variants={itemVariants}
                    className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4"
                  >
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-foreground">
                          Sending to other users is locked
                        </p>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          To protect the community from fraud, user-to-user transfers unlock
                          after <span className="font-semibold text-foreground">{MIN_APPROVED_DEPOSITS} approved deposits</span>.
                          You have <span className="font-semibold text-foreground">{depositsCompleted}/{MIN_APPROVED_DEPOSITS}</span>
                          {depositsRemaining > 0 && (
                            <> — {depositsRemaining} more to go</>
                          )}. You can still deposit, withdraw, pay rent and pay merchants normally.
                        </p>
                      </div>
                    </div>
                  </motion.div>
                )}
                {!transferLocked && perfLocked && (
                  <motion.div
                    variants={itemVariants}
                    className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4"
                  >
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-foreground">
                          Sending to other users is locked today
                        </p>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          Today's collection is <span className="font-semibold text-foreground">{(perfPct ?? 0).toFixed(1)}%</span> — you must be at least
                          <span className="font-semibold text-foreground"> 20%</span> to move money out of your wallet.
                          Collect from your tenants and this will unlock automatically.
                        </p>
                      </div>
                    </div>
                  </motion.div>
                )}
                {savedRecipients.length > 0 && (
                  <motion.div variants={itemVariants} className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="flex items-center gap-2">
                        <Star className="h-3.5 w-3.5 text-muted-foreground" />
                        Saved recipients
                      </Label>
                    </div>
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={recipientSearch}
                        onChange={(e) => setRecipientSearch(e.target.value)}
                        placeholder="Search by name, nickname or number…"
                        className="h-8 pl-8 pr-7 text-xs bg-background/50 border-border/50 focus:border-primary/50"
                      />
                      {recipientSearch && (
                        <button
                          type="button"
                          onClick={() => setRecipientSearch('')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5 pr-0.5">
                      {savedRecipients
                        .filter((r) => {
                          const q = recipientSearch.trim().toLowerCase();
                          if (!q) return true;
                          return (
                            (r.nickname || '').toLowerCase().includes(q) ||
                            (r.name || '').toLowerCase().includes(q) ||
                            (r.phone || '').toLowerCase().includes(q) ||
                            (r.email || '').toLowerCase().includes(q)
                          );
                        })
                        .map((r) => {
                        const chipKey = `${r.mode}-${r.id || r.phone || r.email}`;
                        const isEditing = editingNicknameId === chipKey;
                        return (
                          <div
                            key={chipKey}
                            className="group flex items-center gap-2 rounded-lg border border-border/50 bg-background/50 px-2.5 py-2 transition-all hover:border-primary/50"
                          >
                            <button
                              type="button"
                              onClick={() => handleToggleFavorite(r)}
                              className="shrink-0"
                              title={r.favorite ? 'Remove from favourites' : 'Mark as favourite'}
                            >
                              <Star
                                className={`h-4 w-4 transition-colors ${
                                  r.favorite
                                    ? 'fill-amber-400 text-amber-400'
                                    : 'text-muted-foreground hover:text-amber-400'
                                }`}
                              />
                            </button>
                            <button
                              type="button"
                              onClick={() => selectSavedRecipient(r)}
                              className="flex flex-1 items-center gap-2 min-w-0 text-left"
                            >
                              <div className="min-w-0 flex-1">
                                {r.nickname ? (
                                  <p className="text-sm font-semibold text-foreground truncate">{r.nickname}</p>
                                ) : (
                                  <p className="text-sm font-medium text-foreground truncate">{r.name}</p>
                                )}
                                <p className="text-[11px] text-muted-foreground flex items-center gap-1 truncate">
                                  {r.mode === 'email' ? (
                                    <Mail className="h-3 w-3 shrink-0" />
                                  ) : (
                                    <Phone className="h-3 w-3 shrink-0" />
                                  )}
                                  {r.mode === 'email' ? r.email : r.phone}
                                  {r.nickname && (
                                    <span className="truncate">· {r.name}</span>
                                  )}
                                </p>
                              </div>
                            </button>
                            {isEditing ? (
                              <div className="flex items-center gap-1 shrink-0">
                                <Input
                                  autoFocus
                                  value={draftNickname}
                                  onChange={(e) => setDraftNickname(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      setSavedRecipients(sortRecipients(updateNickname(user?.id, r, draftNickname)));
                                      setEditingNicknameId(null);
                                    }
                                    if (e.key === 'Escape') {
                                      setEditingNicknameId(null);
                                    }
                                  }}
                                  onBlur={() => {
                                    setSavedRecipients(sortRecipients(updateNickname(user?.id, r, draftNickname)));
                                    setEditingNicknameId(null);
                                  }}
                                  className="h-7 w-28 px-1.5 py-0 text-xs"
                                  placeholder="Nickname"
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSavedRecipients(sortRecipients(updateNickname(user?.id, r, draftNickname)));
                                    setEditingNicknameId(null);
                                  }}
                                  className="text-muted-foreground hover:text-foreground"
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDraftNickname(r.nickname || '');
                                  setEditingNicknameId(chipKey);
                                }}
                                className="shrink-0 text-muted-foreground/60 opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
                                title="Edit nickname"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleRemoveSaved(r)}
                              className="shrink-0 text-muted-foreground/60 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                              title="Remove from list"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        );
                      })}
                      {savedRecipients.filter((r) => {
                        const q = recipientSearch.trim().toLowerCase();
                        if (!q) return true;
                        return (
                          (r.nickname || '').toLowerCase().includes(q) ||
                          (r.name || '').toLowerCase().includes(q) ||
                          (r.phone || '').toLowerCase().includes(q) ||
                          (r.email || '').toLowerCase().includes(q)
                        );
                      }).length === 0 && (
                        <p className="text-xs text-muted-foreground text-center py-3">
                          No saved recipients match "{recipientSearch.trim()}"
                        </p>
                      )}
                    </div>
                  </motion.div>
                )}
                <motion.div variants={itemVariants} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor={mode === 'phone' ? 'phone' : 'email'} className="flex items-center gap-2">
                      {mode === 'phone' ? (
                        <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      Recipient {mode === 'phone' ? 'Phone Number' : 'Email'}
                    </Label>
                    <button
                      type="button"
                      onClick={() => {
                        setMode(mode === 'phone' ? 'email' : 'phone');
                        setRecipient({ status: 'idle' });
                      }}
                      className="text-xs text-primary hover:underline"
                    >
                      Use {mode === 'phone' ? 'email' : 'phone'} instead
                    </button>
                  </div>
                  {mode === 'phone' ? (
                    <PhoneInput
                      id="phone"
                      ref={phoneInputRef}
                      placeholder="e.g. 0783673998"
                      value={phone}
                      onChange={(v) => {
                        setPhone(v);
                        // Auto-clear any stale lookup status (invalid / not_found /
                        // multiple / found-self) the instant the user edits the
                        // phone — the debounced effect will reapply the correct
                        // status shortly. This prevents old errors from lingering
                        // while typing a corrected number.
                        setRecipient((prev) =>
                          prev.status === 'idle' || prev.status === 'searching'
                            ? prev
                            : { status: 'searching' }
                        );
                      }}
                      className="h-12 text-base bg-background/50 border-border/50 focus:border-primary/50 transition-all"
                      required
                    />
                  ) : (
                    <Input
                      id="email"
                      ref={emailInputRef}
                      type="email"
                      placeholder="recipient@example.com"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setRecipient((prev) =>
                          prev.status === 'idle' || prev.status === 'searching'
                            ? prev
                            : { status: 'searching' }
                        );
                      }}
                      className="h-12 text-base bg-background/50 border-border/50 focus:border-primary/50 transition-all"
                      required
                    />
                  )}
                  <div role="status" aria-live="polite" aria-atomic="true">
                  <AnimatePresence mode="wait">
                    {recipient.status === 'searching' && (
                      <motion.p
                        key="searching"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        className="text-xs text-muted-foreground flex items-center gap-1.5"
                      >
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Looking up recipient… sending is paused until we confirm them.
                      </motion.p>
                    )}
                    {recipient.status === 'found' && !recipient.isSelf && (
                      <motion.div
                        key="found"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        className="flex items-start gap-2 rounded-md border border-success/30 bg-success/10 px-2.5 py-1.5"
                      >
                        <UserCheck className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
                        <div className="text-xs text-foreground space-y-0.5 min-w-0">
                          <p>
                            Sending to <span className="font-semibold">{recipient.name}</span>
                          </p>
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
                            {recipient.phone && (
                              <span className="flex items-center gap-1">
                                <Phone className="h-3 w-3" />
                                {recipient.phone}
                              </span>
                            )}
                            {recipient.email && (
                              <span className="flex items-center gap-1 truncate">
                                <Mail className="h-3 w-3" />
                                {recipient.email}
                              </span>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    )}
                    {recipient.status === 'found' && recipient.isSelf && (
                      <motion.p
                        key="self"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        className="text-xs text-destructive flex items-center gap-1.5"
                      >
                        <UserX className="h-3 w-3" />
                        Sending blocked: this {mode === 'email' ? 'email' : 'number'} is your own account.
                      </motion.p>
                    )}
                    {recipient.status === 'not_found' && (
                      <motion.p
                        key="notfound"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5"
                      >
                        <UserX className="h-3 w-3" />
                        Sending blocked: no Welile user found for this {mode === 'email' ? 'email' : 'number'}.
                      </motion.p>
                    )}
                    {recipient.status === 'multiple' && (
                      <motion.div
                        key="multiple"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 space-y-2"
                      >
                        <p className="text-xs text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                          <UserX className="h-3 w-3" />
                          {recipient.matches.length} accounts match this {mode === 'email' ? 'email' : 'number'}. Pick the correct recipient:
                        </p>
                        <div className="space-y-1.5">
                          {recipient.matches.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              disabled={m.isSelf}
                              onClick={() =>
                                setRecipient({
                                  status: 'found',
                                  id: m.id,
                                  name: m.name,
                                  phone: m.phone,
                                  email: m.email,
                                  isSelf: m.isSelf,
                                })
                              }
                              className="w-full text-left rounded-md border border-border/60 bg-background/70 hover:bg-background hover:border-primary/50 disabled:opacity-50 disabled:cursor-not-allowed px-2.5 py-2 transition-all"
                            >
                              <p className="text-sm font-medium text-foreground truncate">
                                {m.name}
                                {m.isSelf && (
                                  <span className="ml-1.5 text-[10px] uppercase tracking-wide text-destructive">
                                    you
                                  </span>
                                )}
                              </p>
                              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground mt-0.5">
                                {m.phone && (
                                  <span className="flex items-center gap-1">
                                    <Phone className="h-3 w-3" />
                                    {m.phone}
                                  </span>
                                )}
                                {m.email && (
                                  <span className="flex items-center gap-1 truncate">
                                    <Mail className="h-3 w-3" />
                                    {m.email}
                                  </span>
                                )}
                              </div>
                            </button>
                          ))}
                        </div>
                      </motion.div>
                    )}
                    {recipient.status === 'invalid' && (
                      <motion.p
                        key="invalid"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        className="text-xs text-destructive flex items-center gap-1.5"
                      >
                        <UserX className="h-3 w-3" />
                        {recipient.reason}
                      </motion.p>
                    )}
                  </AnimatePresence>
                  </div>
                </motion.div>

                <motion.div variants={itemVariants} className="space-y-2">
                  <Label htmlFor="amount" className="flex items-center gap-2">
                    <Coins className="h-3.5 w-3.5 text-muted-foreground" />
                    Amount (UGX)
                  </Label>
                  <div className="relative flex items-center">
                    <span className="pointer-events-none absolute left-4 text-lg font-bold text-muted-foreground">
                      UGX
                    </span>
                    <Input
                      id="amount"
                      type="number"
                      placeholder="0"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      enterKeyHint="next"
                      autoComplete="off"
                      className="h-16 pl-16 bg-background/50 border-2 border-border/50 focus:border-primary transition-all text-3xl font-bold"
                      min="1"
                      required
                    />
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {[5000, 10000, 20000, 50000].map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setAmount(String(v))}
                        className="min-h-11 rounded-full border border-border/60 bg-muted/40 px-4 text-sm font-semibold active:scale-95"
                      >
                        {v.toLocaleString()}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setAmount(String(Math.floor(wallet?.withdrawable || 0)))}
                      className="min-h-11 rounded-full border border-primary/40 bg-primary/10 px-4 text-sm font-semibold text-primary active:scale-95"
                    >
                      Max
                    </button>
                  </div>
                  <div className="flex items-center justify-between px-1 pt-0.5">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Sparkles className="h-3.5 w-3.5 text-success" />
                      Transferable balance
                    </span>
                    <span className="text-xs font-bold text-success">
                      {formatCurrency(wallet?.withdrawable || 0)}
                    </span>
                  </div>
                </motion.div>

                <motion.div variants={itemVariants} className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    What are you sending?
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Pick one — every Welile transfer is a payment for an item.
                  </p>
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    {WELILE_ITEMS.map((item) => {
                      const selected = description === item.label;
                      return (
                        <button
                          key={item.label}
                          type="button"
                          onClick={() => setDescription(item.label)}
                          aria-pressed={selected}
                          className={`flex min-h-14 items-center gap-2.5 rounded-xl border-2 px-3 py-2.5 text-left transition-all active:scale-[0.98] ${
                            selected
                              ? 'border-primary bg-primary/10'
                              : 'border-border/50 bg-muted/40 hover:bg-muted'
                          }`}
                        >
                          {WELILE_ITEM_IMAGES[item.label] ? (
                            <img
                              src={WELILE_ITEM_IMAGES[item.label]}
                              alt={item.label}
                              loading="lazy"
                              width={512}
                              height={512}
                              className={`h-11 w-11 shrink-0 rounded-lg object-cover ${
                                selected ? 'ring-2 ring-primary' : ''
                              }`}
                            />
                          ) : (
                            <span
                              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                                selected ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'
                              }`}
                            >
                              <item.icon className="h-4.5 w-4.5" />
                            </span>
                          )}
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">{item.label}</span>
                            <span className="block truncate text-[11px] text-muted-foreground">{item.hint}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </motion.div>

                <motion.div variants={itemVariants}>
                  <AutoPayoutSection
                    recipientId={recipient.status === 'found' && !recipient.isSelf ? recipient.id : undefined}
                    recipientName={recipient.status === 'found' ? recipient.name : undefined}
                    amount={amount}
                    description={description}
                  />
                </motion.div>


                <motion.div
                  variants={itemVariants}
                  className="sticky bottom-0 z-10 -mx-5 -mb-5 mt-2 border-t border-border/50 bg-background px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
                >
                  <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:gap-0">
                    <motion.div className="w-full sm:w-auto" whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                      <Button type="button" variant="outline" size="lg" className="w-full sm:w-auto" onClick={() => handleClose(false)}>
                        Cancel
                      </Button>
                    </motion.div>
                    <motion.div
                      className="w-full sm:w-auto"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      // Native tooltip on the wrapper so it still shows even when
                      // the underlying <button> is disabled (disabled buttons
                      // don't reliably emit hover events in all browsers).
                      title={disabledReason ?? undefined}
                    >
                      <Button
                        type="submit"
                        disabled={sendDisabled}
                        size="lg"
                        className="w-full sm:w-auto gap-2 font-bold"
                        // Mirror the inline validation text exactly so the
                        // hover tooltip matches searching / not-found / self
                        // / invalid / insufficient-balance cases verbatim.
                        // The disabled reason is also announced via the
                        // role="alert" aria-live region below, so we keep the
                        // button's accessible name stable at "Send Money" and
                        // expose the reason via aria-describedby instead of
                        // mutating aria-label (which would break label-based
                        // queries that match on "phone number" etc.).
                        title={disabledReason ?? undefined}
                        aria-disabled={sendDisabled}
                        aria-describedby={
                          disabledReason ? 'send-money-disabled-reason' : undefined
                        }
                      >
                        {loading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Send className="h-4 w-4" />
                        )}
                        Send Money
                        {!loading && <ArrowRight className="h-4 w-4" />}
                      </Button>
                    </motion.div>
                  </DialogFooter>
                  <AnimatePresence mode="wait">
                    {disabledReason && !loading && (
                      <motion.p
                        key={disabledReason}
                        id="send-money-disabled-reason"
                        initial={{ opacity: 0, y: -2 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        role="alert"
                        aria-live="assertive"
                        aria-atomic="true"
                        className="mt-2 text-xs text-muted-foreground text-right"
                      >
                        {disabledReason}
                      </motion.p>
                    )}
                  </AnimatePresence>
                  {disabledReason && !loading && (
                    <div className="mt-1 flex justify-end gap-3 text-xs">
                      {(recipient.status === 'not_found' ||
                        recipient.status === 'invalid' ||
                        (recipient.status === 'found' && recipient.isSelf)) && (
                        <button
                          type="button"
                          onClick={() => {
                            // Re-trigger the debounced lookup effect.
                            setRecipient({ status: 'searching' });
                            setLookupNonce((n) => n + 1);
                          }}
                          className="text-primary hover:underline"
                        >
                          Retry lookup
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          const el = mode === 'phone' ? phoneInputRef.current : emailInputRef.current;
                          if (!el) return;
                          el.focus();
                          try { el.select(); } catch { /* number inputs ignore select */ }
                        }}
                        className="text-primary hover:underline"
                      >
                        Edit recipient
                      </button>
                    </div>
                  )}
                </motion.div>
              </motion.form>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
