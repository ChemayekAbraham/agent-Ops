import { getSessionCheckedUser } from '@/lib/authenticatedRequests';
import { useState, useMemo, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, Send, ArrowUpRight, ArrowDownLeft, TrendingUp, TrendingDown, Minus, Info, ChevronDown, Banknote, Phone, Building2, AlertTriangle, ShieldCheck, Wallet, Check, Sparkles } from 'lucide-react';
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
import { UserSearchPicker } from './UserSearchPicker';
import { Checkbox } from '@/components/ui/checkbox';
import { TreasuryImpactBanner } from './TreasuryImpactBanner';
import { RentDisbursementQueue } from './RentDisbursementQueue';
import { type LocationRecipient } from './PayByLocationRecipientPicker';
import { BusinessAdvanceDisbursementQueue } from './BusinessAdvanceDisbursementQueue';
import { CreditDrawApprovalQueue } from './CreditDrawApprovalQueue';
import { ROIPayoutQueue } from './ROIPayoutQueue';
import { CFOAgentRequisitions } from './CFOAgentRequisitions';
import { PayoutAutomationToggle, describeSchedule, type PayoutScheduleConfig } from './PayoutAutomationToggle';
import { getNextRunDate } from '@/lib/standingOrderSchedule';
import { UGANDA_BANKS } from '@/lib/ugandaBanks';
import { CFO_PAYOUT_LABELS, CFO_PAYOUT_VERB, CFO_PAYOUT_TOAST } from '@/lib/cfoPayoutLabels';
import { logStandingOrderAction } from '@/lib/standingOrderAudit';
import { useCfoApprovalNotifications } from '@/hooks/useCfoApprovalNotifications';
import { CfoApprovalGate } from '@/components/cfo/CfoApprovalGate';

type Operation = 'credit' | 'debit' | 'withdraw';
type FinancialImpact = 'expense' | 'revenue' | 'neutral';
type RecipientType = 'user' | 'operational_wallet';
type PayoutMethod = 'cash' | 'mobile_money' | 'bank_transfer';

interface SubCategory {
  id: string;
  label: string;
}

export interface PayoutCategory {
  id: string;
  label: string;
  description: string;
  impact: FinancialImpact;
  walletCategory: string;
  platformCategory: string;
  allowedOps: Operation[];
  subCategories?: SubCategory[];
  /**
   * Wallet Routing v2: which recipient bucket this category is allowed to land in.
   * - 'user'                → money belongs to the recipient (Withdrawable)
   * - 'operational_wallet'  → company-controlled funds (Float)
   * - 'either'              → CFO must choose (rare)
   */
  recipientLock: RecipientType | 'either';
}

export const PAYOUT_CATEGORIES: PayoutCategory[] = [
  // ── CREDIT (Platform → Wallet) ──
  {
    id: 'roi_payout',
    label: '📈 ROI Payout',
    description: 'Return on investment to a partner/supporter',
    impact: 'expense',
    walletCategory: 'roi_wallet_credit',
    platformCategory: 'roi_expense',
    allowedOps: ['credit'],
    recipientLock: 'user',
  },
  {
    id: 'rent_disbursement',
    label: '🏠 Rent Disbursement',
    description: 'Approved rent payouts to landlord wallets or agent float — earns access fees & request fees',
    impact: 'revenue',
    walletCategory: 'rent_disbursement',
    platformCategory: 'rent_disbursement',
    allowedOps: ['credit'],
    recipientLock: 'operational_wallet',
  },
  {
    id: 'business_advance',
    label: '💼 Business Advance',
    description: 'COO-approved business advances paid into tenant wallets — earns 1% daily compounding interest (4% commission to originating agent)',
    impact: 'revenue',
    walletCategory: 'rent_disbursement',
    platformCategory: 'rent_disbursement',
    allowedOps: ['credit'],
    recipientLock: 'operational_wallet',
  },
  {
    id: 'agent_float_allocation',
    label: '🏦 Agent Float Allocation',
    description: 'Manually credit an agent\'s Float balance when their normal deposit approval did not land — routes to Operational Wallet (Float). Uses the same `agent_float_deposit` ledger category as approve-deposit so the bucket and reporting stay consistent.',
    impact: 'neutral',
    walletCategory: 'agent_float_deposit',
    platformCategory: 'agent_float_deposit',
    allowedOps: ['credit'],
    recipientLock: 'operational_wallet',
  },
  {
    id: 'marketing_expenses',
    label: '📢 Marketing Expenses',
    description: 'Payments for marketing, advertising, and promotional activities',
    impact: 'expense',
    walletCategory: 'marketing_expense',
    platformCategory: 'marketing_expense',
    allowedOps: ['credit'],
    recipientLock: 'either',
    subCategories: [
      { id: 'marketing_materials', label: 'Marketing Materials' },
      { id: 'events_exhibition', label: 'Events & Exhibition' },
    ],
  },
  {
    id: 'agent_commission',
    label: '🤝 Agent Commissions',
    description: 'Commission earned by an agent for rent collection',
    impact: 'expense',
    walletCategory: 'agent_commission_earned',
    platformCategory: 'agent_commission_earned',
    allowedOps: ['credit'],
    recipientLock: 'user',
  },
  {
    id: 'research_development',
    label: '🔬 Research & Development',
    description: 'R&D expenditures, innovation costs, and technology investments',
    impact: 'expense',
    walletCategory: 'research_development_expense',
    platformCategory: 'research_development_expense',
    allowedOps: ['credit'],
    recipientLock: 'either',
    subCategories: [
      { id: 'software', label: 'Software' },
      { id: 'welile_dowry', label: 'Welile Dowry' },
    ],
  },
  {
    id: 'school_of_ai',
    label: '🎓 School of AI',
    description: 'Welile School of AI expenditures — training programs, curriculum, facilitators, learner stipends, and AI education initiatives. Routes to the R&D expense ledger for reporting consistency.',
    impact: 'expense',
    walletCategory: 'research_development_expense',
    platformCategory: 'research_development_expense',
    allowedOps: ['credit'],
    recipientLock: 'either',
    subCategories: [
      { id: 'training_programs', label: 'Training Programs' },
      { id: 'curriculum_content', label: 'Curriculum & Content' },
      { id: 'facilitators', label: 'Facilitators & Trainers' },
      { id: 'learner_stipends', label: 'Learner Stipends' },
      { id: 'equipment_tools', label: 'Equipment & Tools' },
    ],
  },
  {
    id: 'operational_expense',
    label: '🏢 Operational Expenses',
    description: 'Day-to-day operational costs including staff, office, and utilities',
    impact: 'expense',
    walletCategory: 'general_admin_expense',
    platformCategory: 'general_admin_expense',
    allowedOps: ['credit'],
    recipientLock: 'user',
    subCategories: [
      { id: 'salaries', label: 'Salaries' },
      { id: 'transport', label: 'Transport' },
      { id: 'food', label: 'Food' },
      { id: 'office_rent', label: 'Office Rent' },
      { id: 'internet', label: 'Internet' },
      { id: 'airtime', label: 'Airtime' },
      { id: 'stationery', label: 'Stationery' },
      { id: 'property_equipment', label: 'Property & Equipment' },
      { id: 'eviction_enforcement', label: 'Eviction & Enforcement' },
      { id: 'financial_agent_requisitions', label: 'Financial Agent Requisitions' },
    ],
  },
  {
    id: 'payroll',
    label: '💰 Payroll',
    description: 'Staff salaries, wages, and payroll-related expenses',
    impact: 'expense',
    walletCategory: 'payroll_expense',
    platformCategory: 'payroll_expense',
    allowedOps: ['credit'],
    recipientLock: 'user',
  },
  {
    id: 'lunch_allowance',
    label: '🍽️ Lunch Allowance',
    description: 'Staff lunch allowance paid into staff wallets — recorded as a staff cost under payroll expenses',
    impact: 'expense',
    walletCategory: 'payroll_expense',
    platformCategory: 'payroll_expense',
    allowedOps: ['credit'],
    recipientLock: 'user',
  },
  {
    id: 'tax_payment',
    label: '🏛️ Tax Payment',
    description: 'Income tax, VAT, withholding tax, and other government levies',
    impact: 'expense',
    walletCategory: 'tax_expense',
    platformCategory: 'tax_expense',
    allowedOps: ['credit'],
    recipientLock: 'either',
  },
  {
    id: 'interest_payment',
    label: '🏦 Interest Payment',
    description: 'Interest on loans, advances, or credit facilities',
    impact: 'expense',
    walletCategory: 'interest_expense',
    platformCategory: 'interest_expense',
    allowedOps: ['credit'],
    recipientLock: 'either',
  },
  {
    id: 'equipment_purchase',
    label: '🖥️ Equipment & Assets',
    description: 'Capital expenditure on property, equipment, and fixed assets',
    impact: 'expense',
    walletCategory: 'equipment_expense',
    platformCategory: 'equipment_expense',
    allowedOps: ['credit'],
    recipientLock: 'either',
    subCategories: [
      { id: 'maintenance', label: 'Maintenance' },
      { id: 'renovation', label: 'Renovation' },
    ],
  },
  {
    id: 'correction_credit',
    label: '🔧 Balance Correction (Credit)',
    description: 'Fix an error — add missing funds to a user wallet',
    impact: 'neutral',
    walletCategory: 'system_balance_correction',
    platformCategory: 'system_balance_correction',
    allowedOps: ['credit'],
    recipientLock: 'user',
  },
  {
    id: 'wallet_transfer_out',
    label: '🔄 Internal Transfer',
    description: 'Move funds from platform to a user wallet (inter-account)',
    impact: 'neutral',
    walletCategory: 'wallet_transfer',
    platformCategory: 'wallet_transfer',
    allowedOps: ['credit'],
    recipientLock: 'either',
  },

  // ── DEBIT (Wallet → Platform) ──
  {
    id: 'fee_collection',
    label: '💰 Fee Collection',
    description: 'Collect access fee, registration fee, or service charge',
    impact: 'revenue',
    walletCategory: 'system_balance_correction',
    platformCategory: 'access_fee_collected',
    allowedOps: ['debit'],
    recipientLock: 'either',
  },
  {
    id: 'penalty',
    label: '⚠️ Penalty / Fine',
    description: 'Penalty for rule violation, late payment, or fraud',
    impact: 'revenue',
    walletCategory: 'system_balance_correction',
    platformCategory: 'access_fee_collected',
    allowedOps: ['debit'],
    recipientLock: 'either',
  },
  {
    id: 'correction_debit',
    label: '🔧 Balance Correction (Debit)',
    description: 'Fix an error — remove excess funds from a user wallet',
    impact: 'neutral',
    walletCategory: 'system_balance_correction',
    platformCategory: 'system_balance_correction',
    allowedOps: ['debit'],
    recipientLock: 'user',
  },
  {
    id: 'overpayment_recovery',
    label: '🔁 Overpayment Recovery',
    description: 'Recover funds that were credited in error or overpaid',
    impact: 'revenue',
    walletCategory: 'system_balance_correction',
    platformCategory: 'system_balance_correction',
    allowedOps: ['debit'],
    recipientLock: 'either',
  },
  {
    id: 'wallet_retraction',
    label: '🚫 Wallet Retraction',
    description: 'Retract funds paid out externally that still show in balance',
    impact: 'neutral',
    walletCategory: 'system_balance_correction',
    platformCategory: 'system_balance_correction',
    allowedOps: ['debit'],
    recipientLock: 'either',
  },
];

const IMPACT_CONFIG: Record<FinancialImpact, { label: string; color: string; icon: typeof TrendingUp }> = {
  revenue: { label: 'Revenue', color: 'text-emerald-600 bg-emerald-50 border-emerald-200', icon: TrendingUp },
  expense: { label: 'Expense', color: 'text-orange-600 bg-orange-50 border-orange-200', icon: TrendingDown },
  neutral: { label: 'Neutral', color: 'text-muted-foreground bg-muted/50 border-border', icon: Minus },
};

// Map a wallet category to the wallet bucket it lands in, so the CFO knows
// whether the user can actually withdraw the credited amount.
type WalletBucket = 'withdrawable' | 'float' | 'advance';

// Wallet Routing v2: bucket is determined by recipient_type, NOT category.
const RECIPIENT_BUCKET: Record<RecipientType, WalletBucket> = {
  user: 'withdrawable',
  operational_wallet: 'float',
};
const BUCKET_LABEL: Record<WalletBucket, { name: string; note: string; tone: string }> = {
  withdrawable: {
    name: 'Withdrawable by user',
    note: 'Lands directly in the user\u2019s withdrawable bucket — they can cash out immediately.',
    tone: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  },
  advance: {
    name: 'Withdrawable by user (after advance recovery)',
    note: 'Sweeps any outstanding advance debt first, then the remainder lands in withdrawable. Advance balance also counts as withdrawable.',
    tone: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  },
  float: {
    name: 'Operational Float — not withdrawable',
    note: 'Company/operational money reserved for agent/partner operations. The user CANNOT withdraw this.',
    tone: 'text-amber-700 bg-amber-50 border-amber-200',
  },
};

export function DirectCreditTool() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedUser, setSelectedUser] = useState<any>(null);
  // Pay by Location/Category — extra recipients selected by location/category.
  // They are paid through the *existing* payout flow below, unchanged.
  const [locationRecipients, setLocationRecipients] = useState<LocationRecipient[]>([]);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [operation, setOperation] = useState<Operation>('credit');
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [selectedSubCategoryId, setSelectedSubCategoryId] = useState('');
  const [recipientType, setRecipientType] = useState<RecipientType | ''>('');
  const [automateEnabled, setAutomateEnabled] = useState(false);
  const [automateConfig, setAutomateConfig] = useState<PayoutScheduleConfig>({
    frequency: 'monthly',
    dayOfMonth: 1,
    dayOfWeek: 1,
    intervalDays: 7,
  });
  // Float (Operational Wallet) sends require an explicit confirmation step —
  // no transaction ID is collected, the CFO simply confirms the float movement.
  const [floatConfirmOpen, setFloatConfirmOpen] = useState(false);
  const [floatApproved, setFloatApproved] = useState(false);

  // Forced-Reversal confirmation state — opened when the edge function
  // rejects a debit for insufficient strict-ledger balance. The CFO must
  // explicitly consent to creating a recoverable debt before we retry with
  // allow_overdraw=true.
  const [overdrawInfo, setOverdrawInfo] = useState<{
    available: number;
    requested: number;
    shortfall: number;
    /** Which wallet bucket was validated — drives bucket-aware messaging. */
    bucket?: 'withdrawable' | 'float';
  } | null>(null);
  const [overdrawApproved, setOverdrawApproved] = useState(false);
  const [splitFreezing, setSplitFreezing] = useState(false);

  // ── Expense-Only Withdrawal state ──────────────────────────────────
  // Used when operation === 'withdraw'. Captures HOW the company is
  // paying the expense out (Cash / MoMo / Bank) and WHO/WHERE it goes.
  // These details are folded into the mandatory `reason` so they land
  // in general_ledger.description and audit_logs for full traceability,
  // without requiring an edge-function schema change.
  const [payoutMethod, setPayoutMethod] = useState<PayoutMethod>('mobile_money');
  const [pickupLocation, setPickupLocation] = useState('');
  const [momoNumber, setMomoNumber] = useState('');
  const [momoProvider, setMomoProvider] = useState<'MTN' | 'Airtel'>('MTN');
  const [momoName, setMomoName] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankAccountName, setBankAccountName] = useState('');

  /**
   * Pending-approval counts per payout category.
   *
   * Reuses the existing CFO approval-notification layer (same filters the
   * queues themselves use, kept live via realtime) instead of duplicating
   * per-category count queries here. Counts only — no approval logic.
   */
  const { counts: approvalCounts } = useCfoApprovalNotifications();

  const pendingByCategory = useMemo<Record<string, number>>(
    () => ({
      roi_payout: approvalCounts.roi,
      rent_disbursement: approvalCounts.rent,
      operational_expense: approvalCounts.agentRequisitions,
      // This category renders both the Credit Draw approval queue and the
      // Business Advance disbursement queue, so the badge covers both.
      business_advance: approvalCounts.businessAdvances + approvalCounts.creditDraws,
    }),
    [approvalCounts],
  );

  const availableCategories = useMemo(
    () => {
      if (operation === 'withdraw') {
        // Expense-Only Withdrawal Rule — only categories whose financial
        // impact is `expense` may fund a real outbound payment. Revenue
        // and neutral categories are intentionally excluded.
        return PAYOUT_CATEGORIES.filter(
          c => c.impact === 'expense' && c.allowedOps.includes('credit'),
        );
      }
      return PAYOUT_CATEGORIES.filter(c => c.allowedOps.includes(operation));
    },
    [operation]
  );

  const selectedCategory = useMemo(
    () => PAYOUT_CATEGORIES.find(c => c.id === selectedCategoryId),
    [selectedCategoryId]
  );

  const hasSubCategories = selectedCategory?.subCategories && selectedCategory.subCategories.length > 0;
  const needsSubCategory = hasSubCategories && !selectedSubCategoryId;

  const selectedSubCategory = useMemo(
    () => selectedCategory?.subCategories?.find(s => s.id === selectedSubCategoryId),
    [selectedCategory, selectedSubCategoryId]
  );

  const isRentDisbursement = selectedCategoryId === 'rent_disbursement';
  // Rent requests behind the tenants picked via Pay by Location/Category.
  // Used only to narrow the existing rent disbursement queue.
  const rentRequestIdsFromLocation = useMemo(
    () => locationRecipients.map(r => r.rent_request_id).filter(Boolean) as string[],
    [locationRecipients],
  );
  const isBusinessAdvance = selectedCategoryId === 'business_advance';
  const isROIPayout = selectedCategoryId === 'roi_payout';
  const isFinancialAgentRequisitionQueue =
    selectedCategoryId === 'operational_expense' && selectedSubCategoryId === 'financial_agent_requisitions';
  const isQueueCategory = isRentDisbursement || isBusinessAdvance || isROIPayout || isFinancialAgentRequisitionQueue;

  const handleOperationChange = (op: Operation) => {
    setOperation(op);
    setSelectedCategoryId('');
    setSelectedSubCategoryId('');
    setRecipientType('');
    setAutomateEnabled(false);
    if (op !== 'withdraw') {
      setPayoutMethod('mobile_money');
      setPickupLocation('');
      setMomoNumber('');
      setMomoName('');
      setBankName('');
      setBankAccountNumber('');
      setBankAccountName('');
    }
  };

  const handleCategoryChange = (catId: string) => {
    setSelectedCategoryId(catId);
    setSelectedSubCategoryId('');
  };

  // Wallet Routing v2: auto-pick & lock the recipient bucket based on the
  // selected category. This prevents the CFO from accidentally routing
  // user-owned money (e.g. system_balance_correction, ROI, payroll, agent
  // commission) to the Operational (Float) bucket, which the routing
  // enforcement trigger rejects with INVALID_ROUTING.
  useEffect(() => {
    if (!selectedCategory) return;
    if (selectedCategory.recipientLock === 'either') {
      // 'either' categories let the CFO choose — clear any stale lock from a
      // previous category so the radio doesn't carry over a wrong selection.
      setRecipientType('');
      return;
    }
    setRecipientType(selectedCategory.recipientLock);
  }, [selectedCategory, operation]);

  const mutation = useMutation({
    mutationFn: async (opts?: { allowOverdraw?: boolean }) => {
      const amt = parseFloat(amount);
      if (!amt || amt <= 0) throw new Error('Invalid amount');
      if (!reason || reason.trim().length < 20) throw new Error('Reason must be at least 20 characters');
      if (!selectedUser) throw new Error('Select a user');
      // Recipients: either the single user picked as before, or the people
      // selected via Pay by Location/Category. Everything below is identical.
      const targets: any[] = locationRecipients.length > 0 ? locationRecipients : [selectedUser];
      if (!selectedCategory) throw new Error('Select a payout category');
      if (hasSubCategories && !selectedSubCategoryId) throw new Error('Select a subcategory');

      // Expense-Only Withdrawal validation — block any non-expense category
      // and require complete recipient details for the chosen method.
      let payoutTag = '';
      if (operation === 'withdraw') {
        if (selectedCategory.impact !== 'expense') {
          throw new Error(
            `Withdrawal blocked: only Expense categories may be withdrawn. "${selectedCategory.label}" is marked as ${selectedCategory.impact}.`,
          );
        }
        if (payoutMethod === 'cash') {
          if (pickupLocation.trim().length < 3) {
            throw new Error('Cash payout requires pickup details (min 3 characters).');
          }
          payoutTag = `[PAYOUT: CASH @ ${pickupLocation.trim()}]`;
        } else if (payoutMethod === 'mobile_money') {
          if (momoNumber.trim().length < 9) throw new Error('Mobile Money number is required (min 9 digits).');
          if (momoName.trim().length < 2) throw new Error('Mobile Money account name is required.');
          payoutTag = `[PAYOUT: MOMO ${momoProvider} ${momoNumber.trim()} (${momoName.trim()})]`;
        } else if (payoutMethod === 'bank_transfer') {
          if (!bankName) throw new Error('Bank name is required.');
          if (bankAccountNumber.trim().length < 5) throw new Error('Bank account number is required.');
          if (bankAccountName.trim().length < 2) throw new Error('Bank account name is required.');
          payoutTag = `[PAYOUT: BANK ${bankName} A/C ${bankAccountNumber.trim()} (${bankAccountName.trim()})]`;
        }
      }

      // Wallet Routing v2: when the category has a hard recipient lock, that
      // lock is the single source of truth at submit time. This protects
      // against any stale `recipientType` state (e.g. radio carried over from
      // a previously-selected operational category) that would otherwise be
      // rejected by the edge function with INVALID_ROUTING.
      const effectiveRecipient: RecipientType | '' =
        selectedCategory.recipientLock !== 'either'
          ? selectedCategory.recipientLock
          : recipientType;
      if (!effectiveRecipient) {
        throw new Error('Select a Recipient type (User or Operational Wallet)');
      }

      const categoryLabel = selectedSubCategory
        ? `${selectedCategory.label} → ${selectedSubCategory.label}`
        : selectedCategory.label;

      // Withdraw rides the existing `credit` rail — the CFO is paying
      // the expense out to the recipient via Cash / MoMo / Bank. The
      // ledger leg, recipient bucket, and audit trail are identical to
      // a direct credit; the payout details are embedded in `reason`
      // so they appear in general_ledger.description and audit_logs.
      const submitOperation: 'credit' | 'debit' =
        operation === 'withdraw' ? 'credit' : operation;
      const submitReason = operation === 'withdraw'
        ? `${payoutTag} ${reason}`.trim()
        : reason;

      const postOne = async (target: any) => {
      const { data, error } = await supabase.functions.invoke('cfo-direct-credit', {
        body: {
          target_user_id: target.id,
          amount: amt,
          reason: submitReason,
          operation: submitOperation,
          wallet_category: selectedCategory.walletCategory,
          platform_category: selectedCategory.platformCategory,
          financial_impact: selectedCategory.impact,
          category_label: categoryLabel,
          sub_category: selectedSubCategoryId || null,
          recipient_type: effectiveRecipient,
          // Manual CFO payout — never subject to email-origin idempotency.
          // Allows paying any user, any category/sub-category, countless times.
          manual_credit: true,
          // Forced Reversal — set only after CFO explicitly confirms creating
          // a recoverable debt in the shortfall dialog. Never sent for Float
          // (operational) corrections: those can never create personal debt.
          allow_overdraw: opts?.allowOverdraw === true && effectiveRecipient !== 'operational_wallet',
          solvency_bypass_reason:
            opts?.allowOverdraw === true && effectiveRecipient !== 'operational_wallet'
              ? 'duplicate_reversal'
              : undefined,
        },
      });
      if (error) {
        const msg = await extractFromErrorObject(error, 'Something went wrong');
        if (
          msg.includes('INSUFFICIENT_AVAILABLE_BALANCE') ||
          msg.includes('WITHDRAWABLE_INSUFFICIENT_BALANCE') ||
          msg.includes('FLOAT_INSUFFICIENT_BALANCE')
        ) {
          const availMatch = msg.match(/balance is (\d+)/);
          const reqMatch = msg.match(/requested (\d+)/);
          const shortMatch = msg.match(/shortfall (\d+)/);
          setOverdrawInfo({
            available: availMatch ? Number(availMatch[1]) : 0,
            requested: reqMatch ? Number(reqMatch[1]) : amt,
            shortfall: shortMatch ? Number(shortMatch[1]) : Math.max(0, amt - (availMatch ? Number(availMatch[1]) : 0)),
            bucket: msg.includes('FLOAT_INSUFFICIENT_BALANCE') ? 'float' : 'withdrawable',
          });
          setOverdrawApproved(false);
          const silent: any = new Error('BUCKET_INSUFFICIENT_BALANCE');
          silent.__silent = true;
          throw silent;
        }
        if (msg.includes('INVALID_BUCKET_RECOVERY')) {
          throw new Error(msg.replace(/^.*INVALID_BUCKET_RECOVERY:\s*/, 'Bucket recovery rejected: '));
        }
        if (msg.includes('NEGATIVE_FLOAT_BLOCKED')) {
          throw new Error('NEGATIVE_FLOAT_BLOCKED: the operational float bucket cannot be pushed negative. Allocate more float first.');
        }
        if (msg.includes('WITHDRAWABLE_HOLD_ACTIVE')) {
          throw new Error('WITHDRAWABLE_HOLD_ACTIVE: a pending withdrawal hold is blocking this debit. Clear or settle the hold first.');
        }
        if (msg.includes('Unauthorized')) throw new Error('You do not have permission. Please log in again.');
        if (msg.includes('Insufficient permissions')) throw new Error('Your role does not have CFO privileges.');
        if (msg.includes('Target user not found')) throw new Error('The selected user could not be found.');
        if (msg.includes('Invalid amount')) throw new Error('Please enter a valid amount between 1 and 50,000,000 UGX.');
        if (msg.includes('Reason must be')) throw new Error('Please provide a detailed reason (at least 20 characters).');
        if (msg.includes('Insufficient ledger balance')) throw new Error(msg);
        if (msg.includes('INVALID_ROUTING')) throw new Error(msg.replace(/^.*INVALID_ROUTING:\s*/, 'Routing rejected: '));
        if (msg.includes('RECIPIENT_TYPE_REQUIRED')) throw new Error('Choose a Recipient type — User (Withdrawable) or Operational Wallet (Float).');
        if (msg.includes('NEGATIVE_WALLET_BLOCKED')) {
          const m = msg.match(/strict available balance is (\d+)/);
          const avail = m ? Number(m[1]).toLocaleString() : '0';
          throw new Error(
            `Debit refused: this user's strict withdrawable balance is UGX ${avail}. ` +
            `Wallets cannot be pushed negative. Credit the user first, lower the amount, ` +
            `or use the agent/business advance flow if this is meant as debt.`,
          );
        }
        if (msg.includes('Ledger error')) throw new Error(msg);
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      return data;
      };

      let resultData: any = null;
      if (targets.length <= 1) {
        resultData = await postOne(targets[0]);
      } else {
        const failures: string[] = [];
        let ok = 0;
        for (const t of targets) {
          try {
            resultData = await postOne(t);
            ok++;
          } catch (e: any) {
            failures.push(`${t.full_name ?? t.id}: ${e?.__silent ? 'insufficient balance' : e.message}`);
          }
        }
        setOverdrawInfo(null);
        setOverdrawApproved(false);
        if (ok === 0) throw new Error(failures[0] ?? 'Payout failed');
        resultData = {
          message: `${ok}/${targets.length} recipients paid UGX ${amt.toLocaleString()} each` +
            (failures.length ? ` · failed: ${failures.slice(0, 3).join(' • ')}` : ''),
        };
      }

      if (automateEnabled && selectedUser && targets.length <= 1) {
        const { data: schedRow, error: schedErr } = await supabase.from('scheduled_payouts').insert({
          created_by: (await getSessionCheckedUser()).data.user?.id,
          target_user_id: selectedUser.id,
          amount: amt,
          category_id: selectedCategoryId,
          sub_category: selectedSubCategoryId || null,
          reason,
          frequency: automateConfig.frequency,
          day_of_month: automateConfig.frequency === 'monthly' ? automateConfig.dayOfMonth : null,
          day_of_week: automateConfig.frequency === 'weekly' ? automateConfig.dayOfWeek : null,
          interval_days: automateConfig.frequency === 'interval' ? automateConfig.intervalDays : null,
          enabled: true,
          next_run_at: getNextRunDate(automateConfig),
        }).select('id').maybeSingle();
        if (schedErr) {
          console.error('[DirectCreditTool] Failed to save schedule:', schedErr);
          toast({ title: '⚠️ Payout succeeded but schedule failed', description: schedErr.message, variant: 'destructive' });
        } else {
          await logStandingOrderAction({
            scheduledPayoutId: (schedRow as any)?.id ?? null,
            action: 'create',
            targetUserId: selectedUser.id,
            recipientName: selectedUser.full_name ?? selectedUser.name ?? null,
            amount: amt,
            reason,
            scheduleDescription: describeSchedule(automateConfig),
          });
          toast({ title: '🔁 Standing order saved', description: `Will auto-pay: ${describeSchedule(automateConfig)}` });

          // Notify the recipient that a recurring payout has been set up (SMS + email).
          try {
            await supabase.functions.invoke('notify-standing-order-setup', {
              body: {
                target_user_id: selectedUser.id,
                scheduled_payout_id: (schedRow as any)?.id ?? null,
                amount: amt,
                schedule: describeSchedule(automateConfig),
                reason,
                next_run_at: getNextRunDate(automateConfig),
              },
            });
          } catch (notifyErr) {
            console.error('[DirectCreditTool] standing order notify failed:', notifyErr);
          }
        }
      }

      return resultData;
    },
    onSuccess: (data) => {
      toast({
        title:
          operation === 'credit'
            ? CFO_PAYOUT_TOAST.credit
            : operation === 'debit'
              ? CFO_PAYOUT_TOAST.debit
              : '✅ Expense withdrawal recorded',
        description: data?.message,
      });
      qc.invalidateQueries({ queryKey: ['expense-transfers'] });
      qc.invalidateQueries({ queryKey: ['channel-balances'] });
      qc.invalidateQueries({ queryKey: ['treasury-cash-snapshot'] });
      qc.invalidateQueries({ queryKey: ['cfo-overview'] });
      setSelectedUser(null);
      setLocationRecipients([]);
      setAmount('');
      setReason('');
      setSelectedCategoryId('');
      setSelectedSubCategoryId('');
      setRecipientType('');
      setAutomateEnabled(false);
      setPickupLocation('');
      setMomoNumber('');
      setMomoName('');
      setBankName('');
      setBankAccountNumber('');
      setBankAccountName('');
    },
    onError: (e: any) => {
      if (e?.__silent) return; // confirmation dialog will handle it
      toast({ title: 'Failed', description: e.message, variant: 'destructive' });
    },
  });

  const isCredit = operation === 'credit';
  const amt = parseFloat(amount || '0');

  // ── One-click Freeze + Split Debit ────────────────────────────────
  // From the "Insufficient Available Balance" dialog. Posts the available
  // portion as a clean debit, then the shortfall as a Forced Reversal
  // (creating a `cfo_debit_obligations` receivable), then freezes the
  // account via `admin_freeze_kyc_account` so no future outflow can
  // dodge the debt.
  const handleFreezeAndSplitDebit = async () => {
    if (!overdrawInfo || !selectedUser || !selectedCategory) return;
    const effectiveRecipient: RecipientType | '' =
      selectedCategory.recipientLock !== 'either'
        ? selectedCategory.recipientLock
        : recipientType;
    if (!effectiveRecipient) {
      toast({ title: 'Recipient type required', description: 'Choose User or Operational Wallet before splitting.', variant: 'destructive' });
      return;
    }
    // Bucket-aware guard: Freeze + Split Debit is a WITHDRAWABLE-only remedy.
    // Operational float corrections must never create personal debt.
    if (effectiveRecipient === 'operational_wallet' || overdrawInfo.bucket === 'float') {
      toast({
        title: 'Not available for float corrections',
        description:
          'This correction affects operational float only. No personal debt may be created — lower the amount or allocate more float first.',
        variant: 'destructive',
      });
      return;
    }
    const categoryLabel = selectedSubCategory
      ? `${selectedCategory.label} → ${selectedSubCategory.label}`
      : selectedCategory.label;
    const baseBody = {
      target_user_id: selectedUser.id,
      reason,
      operation: 'debit' as const,
      wallet_category: selectedCategory.walletCategory,
      platform_category: selectedCategory.platformCategory,
      financial_impact: selectedCategory.impact,
      category_label: categoryLabel,
      sub_category: selectedSubCategoryId || null,
      recipient_type: effectiveRecipient,
      manual_credit: true,
    };
    const clean = Math.floor(overdrawInfo.available);
    const debt = Math.max(0, Math.floor(overdrawInfo.shortfall));
    setSplitFreezing(true);
    try {
      // 1) Clean debit up to the strict available balance (skip if 0).
      if (clean > 0) {
        const { data, error } = await supabase.functions.invoke('cfo-direct-credit', {
          body: {
            ...baseBody,
            amount: clean,
            reason: `[SPLIT 1/2 — collectable] ${reason}`,
            allow_overdraw: false,
          },
        });
        if (error) {
          const msg = await extractFromErrorObject(error, 'Clean debit failed');
          throw new Error(`Clean debit (UGX ${clean.toLocaleString()}) failed: ${msg}`);
        }
        if ((data as any)?.error) throw new Error(`Clean debit failed: ${(data as any).error}`);
      }

      // 2) Forced Reversal for the shortfall — creates a recoverable debt.
      if (debt > 0) {
        const { data, error } = await supabase.functions.invoke('cfo-direct-credit', {
          body: {
            ...baseBody,
            amount: debt,
            reason: `[SPLIT 2/2 — receivable, freeze+recover] ${reason}`,
            allow_overdraw: true,
            solvency_bypass_reason: 'duplicate_reversal',
          },
        });
        if (error) {
          const msg = await extractFromErrorObject(error, 'Force reversal failed');
          throw new Error(`Force reversal (UGX ${debt.toLocaleString()}) failed: ${msg}`);
        }
        if ((data as any)?.error) throw new Error(`Force reversal failed: ${(data as any).error}`);
      }

      // 3) Freeze the account so future inflows can be swept by recovery
      //    and no withdrawal can drain the debt.
      const { error: freezeErr } = await supabase.rpc('admin_freeze_kyc_account', {
        p_user_id: selectedUser.id,
        p_reason: `Auto-freeze after CFO Split Debit: UGX ${clean.toLocaleString()} collected + UGX ${debt.toLocaleString()} debt. Reason: ${reason}`,
      });
      if (freezeErr) throw new Error(`Debits posted but freeze failed: ${freezeErr.message}`);

      toast({
        title: '✅ Freeze + Split Debit complete',
        description: `Collected UGX ${clean.toLocaleString()} · Debt UGX ${debt.toLocaleString()} · Account frozen.`,
      });
      qc.invalidateQueries({ queryKey: ['expense-transfers'] });
      qc.invalidateQueries({ queryKey: ['channel-balances'] });
      qc.invalidateQueries({ queryKey: ['treasury-cash-snapshot'] });
      qc.invalidateQueries({ queryKey: ['cfo-overview'] });
      qc.invalidateQueries({ queryKey: ['cfo-debit-obligations'] });
      qc.invalidateQueries({ queryKey: ['kyc-console'] });
      setOverdrawInfo(null);
      setOverdrawApproved(false);
      setSelectedUser(null);
      setAmount('');
      setReason('');
      setSelectedCategoryId('');
      setSelectedSubCategoryId('');
      setRecipientType('');
    } catch (e: any) {
      toast({ title: 'Split Debit failed', description: e?.message ?? String(e), variant: 'destructive' });
    } finally {
      setSplitFreezing(false);
    }
  };

  const impactInfo = selectedCategory ? IMPACT_CONFIG[selectedCategory.impact] : null;
  const ImpactIcon = impactInfo?.icon;

  return (
    <Card className="rounded-3xl border border-border/70 bg-card shadow-sm overflow-hidden transition-all">
      <CardHeader className="p-5 sm:p-6 pb-5 border-b border-border/60 bg-gradient-to-r from-card via-card to-muted/20">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3.5">
            <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ring-1 shadow-xs transition-colors ${
              isCredit
                ? 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/20'
                : operation === 'debit'
                  ? 'bg-rose-500/10 text-rose-600 ring-rose-500/20'
                  : 'bg-amber-500/10 text-amber-600 ring-amber-500/20'
            }`}>
              {isCredit ? (
                <ArrowUpRight className="h-5 w-5" />
              ) : operation === 'debit' ? (
                <ArrowDownLeft className="h-5 w-5" />
              ) : (
                <Banknote className="h-5 w-5" />
              )}
            </div>
            <div>
              <CardTitle className="text-base sm:text-lg font-bold tracking-tight text-foreground flex items-center gap-2">
                CFO Wallet Payout & Standing Orders
              </CardTitle>
              <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
                Execute direct wallet credits, operational debits, outbound withdrawals, and automated standing orders.
              </p>
            </div>
          </div>
          <Badge variant="outline" className="hidden sm:inline-flex text-[11px] font-medium py-1 px-2.5 rounded-full border-border/70 bg-background/50 self-start sm:self-auto gap-1.5 text-muted-foreground shrink-0">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
            Ledger Protected
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-5 sm:p-6 space-y-5">
        <div className="p-1 rounded-2xl bg-muted/40 border border-border/60 grid grid-cols-1 sm:grid-cols-3 gap-1.5">
          <button
            type="button"
            onClick={() => handleOperationChange('credit')}
            className={`relative flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 ${
              isCredit
                ? 'bg-emerald-600 text-white shadow-sm ring-1 ring-emerald-600/30'
                : 'text-muted-foreground hover:text-foreground hover:bg-background/60'
            }`}
          >
            <ArrowUpRight className="h-4 w-4 shrink-0" />
            <span className="truncate">{CFO_PAYOUT_LABELS.credit}</span>
          </button>
          <button
            type="button"
            onClick={() => handleOperationChange('debit')}
            className={`relative flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 ${
              operation === 'debit'
                ? 'bg-rose-600 text-white shadow-sm ring-1 ring-rose-600/30'
                : 'text-muted-foreground hover:text-foreground hover:bg-background/60'
            }`}
          >
            <ArrowDownLeft className="h-4 w-4 shrink-0" />
            <span className="truncate">{CFO_PAYOUT_LABELS.debit}</span>
          </button>
          <button
            type="button"
            onClick={() => handleOperationChange('withdraw')}
            className={`relative flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 ${
              operation === 'withdraw'
                ? 'bg-amber-600 text-white shadow-sm ring-1 ring-amber-600/30'
                : 'text-muted-foreground hover:text-foreground hover:bg-background/60'
            }`}
          >
            <Banknote className="h-4 w-4 shrink-0" />
            <span className="truncate">Outbound Withdraw</span>
          </button>
        </div>

        {operation === 'withdraw' && (
          <div className="rounded-2xl border border-amber-200/80 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20 p-4 text-xs text-amber-900 dark:text-amber-200 flex gap-3 shadow-xs">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 ring-1 ring-amber-500/20">
              <AlertTriangle className="h-4 w-4 shrink-0" />
            </div>
            <div>
              <div className="font-semibold text-sm text-amber-900 dark:text-amber-100">Expense-Only Outbound Withdrawal</div>
              <div className="opacity-90 mt-0.5 leading-relaxed">
                Only categories marked as <strong>Expense</strong> can fund real outbound payments
                (Cash, Mobile Money, Bank). Revenue and Neutral categories are blocked to prevent accounting imbalances.
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="payout-category" className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            Payout Category
            <span className="text-destructive">*</span>
          </Label>
          <Select value={selectedCategoryId} onValueChange={handleCategoryChange}>
            <SelectTrigger id="payout-category" className="h-11 w-full text-sm rounded-xl border-border/70 bg-background hover:bg-muted/20">
              <SelectValue placeholder="Select a category..." />
            </SelectTrigger>
            <SelectContent className="rounded-xl shadow-lg border-border/70">
              {availableCategories.map((cat) => {
                const impactLabel = IMPACT_CONFIG[cat.impact].label;
                const pending = pendingByCategory[cat.id] ?? 0;
                return (
                  <SelectItem key={cat.id} value={cat.id} className="rounded-lg py-2">
                    <span className="flex items-center gap-1.5">
                      <span className="font-medium">{cat.label}</span>
                      <span className="text-muted-foreground text-xs">— {impactLabel}</span>
                      {pending > 0 && (
                        <span className="text-primary font-bold text-xs ml-1">
                          • {pending} ready
                        </span>
                      )}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {availableCategories.some((cat) => (pendingByCategory[cat.id] ?? 0) > 0) && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs text-muted-foreground font-medium flex items-center gap-1">
                <Sparkles className="h-3 w-3 text-primary" />
                Waiting for approval:
              </span>
              {availableCategories
                .filter((cat) => (pendingByCategory[cat.id] ?? 0) > 0)
                .map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => handleCategoryChange(cat.id)}
                    className="focus:outline-none"
                  >
                    <Badge variant="outline" className="text-xs px-2.5 py-1 gap-1.5 cursor-pointer rounded-xl border-primary/30 bg-primary/5 hover:bg-primary/10 text-primary font-semibold transition-colors">
                      {cat.label}
                      <span className="bg-primary text-primary-foreground text-[10px] font-bold px-1.5 py-0.2 rounded-full">
                        {pendingByCategory[cat.id]}
                      </span>
                    </Badge>
                  </button>
                ))}
            </div>
          )}
        </div>

        {hasSubCategories && (
          <div className="space-y-2">
            <Label htmlFor="payout-subcategory" className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              Subcategory
              <span className="text-destructive">*</span>
            </Label>
            <div className="relative">
              <select
                id="payout-subcategory"
                value={selectedSubCategoryId}
                onChange={(e) => setSelectedSubCategoryId(e.target.value)}
                className="flex h-11 w-full appearance-none rounded-xl border border-border/70 bg-background px-3.5 py-2 pr-10 text-sm text-foreground transition-colors ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring/20 focus:border-primary/50"
              >
                <option value="">Select a subcategory...</option>
                {selectedCategory?.subCategories?.map((sub) => (
                  <option key={sub.id} value={sub.id}>
                    {sub.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>
        )}

        {/* Category Impact Explanation */}

        {selectedCategory && impactInfo && ImpactIcon && !isQueueCategory && !needsSubCategory && (
          <div className={`rounded-2xl border p-4 text-xs space-y-2.5 shadow-2xs ${impactInfo.color}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-sm">
                <ImpactIcon className="h-4 w-4" />
                Financial Impact: {impactInfo.label}
              </div>
              {selectedSubCategory && (
                <Badge variant="outline" className="text-[10px] font-medium border-current/20 bg-background/50">
                  📂 {selectedSubCategory.label}
                </Badge>
              )}
            </div>
            <p className="opacity-90 leading-relaxed">{selectedCategory.description}</p>
            <div className="pt-2 border-t border-current/15 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
              <div><span className="font-semibold opacity-70">Wallet entry:</span> <span className="font-medium">{selectedCategory.walletCategory.replace(/_/g, ' ')}</span></div>
              <div><span className="font-semibold opacity-70">Platform entry:</span> <span className="font-medium">{selectedCategory.platformCategory.replace(/_/g, ' ')}</span></div>
            </div>
            {selectedCategory.impact === 'expense' && (
              <div className="text-[11px] font-medium text-orange-800 dark:text-orange-300 pt-0.5">
                📉 Recorded as platform expense — reduces net platform earnings.
              </div>
            )}
            {selectedCategory.impact === 'revenue' && (
              <div className="text-[11px] font-medium text-emerald-800 dark:text-emerald-300 pt-0.5">
                ✅ Recorded as platform income — recognized as platform revenue.
              </div>
            )}
            {selectedCategory.impact === 'neutral' && (
              <div className="text-[11px] font-medium opacity-80 pt-0.5">
                ➖ Balance sheet adjustment — zero impact on profit or loss.
              </div>
            )}
          </div>
        )}

        {/* ── RENT DISBURSEMENT QUEUE ── */}
        {isRentDisbursement && (
          <>
            {locationRecipients.length > 0 && (
              <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 text-xs space-y-1 shadow-2xs">
                <p className="font-semibold text-sm">
                  Showing {locationRecipients.length} tenant{locationRecipients.length === 1 ? '' : 's'} selected by location/category
                </p>
                <p className="text-muted-foreground">
                  Amounts, checks, approval and records below are the normal rent payout — unchanged.
                </p>
                <button
                  type="button"
                  className="text-primary hover:underline font-semibold pt-1 inline-block"
                  onClick={() => setLocationRecipients([])}
                >
                  Show the full queue again
                </button>
              </div>
            )}
            <RentDisbursementQueue
              restrictToIds={rentRequestIdsFromLocation}
              autoSelectIds={rentRequestIdsFromLocation}
            />
          </>
        )}

        {/* ── BUSINESS ADVANCE DISBURSEMENT QUEUE ── */}
        {isBusinessAdvance && locationRecipients.length === 0 && (
          <div className="space-y-4">
            <CreditDrawApprovalQueue />
            <BusinessAdvanceDisbursementQueue />
          </div>
        )}

        {/* ── ROI PAYOUT QUEUE ── */}
        {isROIPayout && locationRecipients.length === 0 && (
          <ROIPayoutQueue />
        )}

        {/* ── FINANCIAL AGENT REQUISITIONS ── */}
        {selectedCategoryId === 'operational_expense' && selectedSubCategoryId === 'financial_agent_requisitions' && (
          <CFOAgentRequisitions />
        )}

        {/* ── MANUAL PAYOUT FORM (non-queue categories) ── */}
        {(!isQueueCategory || (locationRecipients.length > 0 && !isRentDisbursement)) && selectedCategoryId && !needsSubCategory && (
          <>
            {locationRecipients.length > 0 && (
              <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 text-xs space-y-1 shadow-2xs">
                <p className="font-semibold text-sm">
                  {locationRecipients.length} recipients selected by location/category
                </p>
                <p className="text-muted-foreground">
                  The payout below runs once per recipient using the same amount, checks and records.
                </p>
                <button
                  type="button"
                  className="text-primary hover:underline font-semibold pt-1 inline-block"
                  onClick={() => setLocationRecipients([])}
                >
                  Clear list and pay a single user
                </button>
              </div>
            )}

            <UserSearchPicker
              label="Search User"
              placeholder="Name or phone..."
              selectedUser={selectedUser}
              onSelect={(u: any) => { setLocationRecipients([]); setSelectedUser(u); }}
            />

            {/* ── Wallet Routing v2: Recipient Type (REQUIRED) ── */}
            {selectedUser && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    Recipient Type
                    <span className="text-destructive">*</span>
                  </Label>
                  {selectedCategory && selectedCategory.recipientLock !== 'either' && (
                    <Badge variant="outline" className="text-[10px] px-2 py-0.5 rounded-full border-border/70 text-muted-foreground bg-muted/40">
                      Auto-set by category
                    </Badge>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedCategory?.recipientLock === 'operational_wallet') return;
                      setRecipientType('user');
                    }}
                    disabled={selectedCategory?.recipientLock === 'operational_wallet'}
                    className={`group relative text-left rounded-2xl border p-4 transition-all duration-200 ${
                      recipientType === 'user'
                        ? 'border-emerald-500 bg-emerald-50/70 dark:bg-emerald-950/25 ring-2 ring-emerald-500/20 shadow-xs'
                        : 'border-border/70 bg-card hover:border-emerald-300/80 hover:bg-emerald-50/20'
                    } ${selectedCategory?.recipientLock === 'operational_wallet' ? 'opacity-40 cursor-not-allowed hover:bg-transparent hover:border-border/70' : ''}`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <div className={`h-7 w-7 rounded-lg flex items-center justify-center font-bold ${
                          recipientType === 'user' ? 'bg-emerald-600 text-white' : 'bg-emerald-500/10 text-emerald-600'
                        }`}>
                          <Wallet className="h-4 w-4" />
                        </div>
                        <span className="text-sm font-bold text-foreground">User Wallet</span>
                      </div>
                      <Badge variant="outline" className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-300 border-emerald-300/40 bg-emerald-100/50 dark:bg-emerald-900/40">
                        Withdrawable
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Money belongs to recipient. Lands in <strong>Withdrawable Available Balance</strong> for immediate payout.
                    </p>
                    <div className="text-[10px] text-muted-foreground/90 mt-2 flex items-center gap-1.5 font-medium">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                      Payroll, agent commissions, returns, refunds, personal payouts.
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      if (selectedCategory?.recipientLock === 'user') return;
                      setRecipientType('operational_wallet');
                    }}
                    disabled={selectedCategory?.recipientLock === 'user'}
                    className={`group relative text-left rounded-2xl border p-4 transition-all duration-200 ${
                      recipientType === 'operational_wallet'
                        ? 'border-amber-500 bg-amber-50/70 dark:bg-amber-950/25 ring-2 ring-amber-500/20 shadow-xs'
                        : 'border-border/70 bg-card hover:border-amber-300/80 hover:bg-amber-50/20'
                    } ${selectedCategory?.recipientLock === 'user' ? 'opacity-40 cursor-not-allowed hover:bg-transparent hover:border-border/70' : ''}`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <div className={`h-7 w-7 rounded-lg flex items-center justify-center font-bold ${
                          recipientType === 'operational_wallet' ? 'bg-amber-600 text-white' : 'bg-amber-500/10 text-amber-600'
                        }`}>
                          <Building2 className="h-4 w-4" />
                        </div>
                        <span className="text-sm font-bold text-foreground">Operational Wallet</span>
                      </div>
                      <Badge variant="outline" className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 border-amber-300/40 bg-amber-100/50 dark:bg-amber-900/40">
                        Float Only
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Company-controlled funds. Lands in <strong>Float balance</strong> — <em>cannot</em> be cashed out by recipient.
                    </p>
                    <div className="text-[10px] text-muted-foreground/90 mt-2 flex items-center gap-1.5 font-medium">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
                      Rent disbursement, agent float top-up, operational movements.
                    </div>
                  </button>
                </div>
                {selectedCategory && selectedCategory.recipientLock !== 'either' ? (
                  <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1">
                    <span>🔒</span> Locked by category — “{selectedCategory.label}” is{' '}
                    {selectedCategory.recipientLock === 'user'
                      ? 'money owed to the recipient (Withdrawable).'
                      : 'company-controlled float (Operational).'}
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Withdrawability is determined by who receives the money — not by the category.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="payout-amount" className="text-xs font-semibold text-foreground">
                  Amount (UGX) <span className="text-destructive">*</span>
                </Label>
                {amt > 0 && (
                  <span className="text-xs font-bold font-mono text-primary bg-primary/10 px-2 py-0.5 rounded-md border border-primary/20">
                    UGX {amt.toLocaleString()}
                  </span>
                )}
              </div>
              <div className="relative flex items-center">
                <div className="pointer-events-none absolute left-3 z-10 flex items-center justify-center h-8 px-2.5 rounded-lg bg-muted text-foreground font-bold text-xs border border-border/70 shadow-2xs">
                  UGX
                </div>
                <Input
                  id="payout-amount"
                  type="number"
                  placeholder="0"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  className="pl-20 h-14 rounded-2xl text-xl sm:text-2xl font-bold tracking-tight text-foreground bg-background border-border/80 focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:border-primary shadow-xs"
                />
              </div>
            </div>

            {/* ── Payout Method + Recipient Details (Withdraw only) ── */}
            {operation === 'withdraw' && (
              <div className="space-y-4 rounded-2xl border border-amber-200/80 bg-amber-50/40 dark:border-amber-900/40 dark:bg-amber-950/20 p-4">
                <div>
                  <Label className="flex items-center gap-1.5 text-xs font-semibold text-foreground mb-2">
                    Payout Method <span className="text-destructive">*</span>
                  </Label>
                  <div className="grid grid-cols-3 gap-2.5">
                    <button
                      type="button"
                      onClick={() => setPayoutMethod('cash')}
                      className={`rounded-xl border p-3 text-xs font-semibold transition-all duration-200 flex flex-col items-center gap-1.5 ${
                        payoutMethod === 'cash'
                          ? 'border-amber-500 bg-background text-amber-700 dark:text-amber-300 ring-2 ring-amber-500/20 shadow-xs'
                          : 'border-border/70 bg-background/60 text-muted-foreground hover:border-amber-300 hover:text-foreground'
                      }`}
                    >
                      <Banknote className="h-4 w-4" />
                      Cash
                    </button>
                    <button
                      type="button"
                      onClick={() => setPayoutMethod('mobile_money')}
                      className={`rounded-xl border p-3 text-xs font-semibold transition-all duration-200 flex flex-col items-center gap-1.5 ${
                        payoutMethod === 'mobile_money'
                          ? 'border-amber-500 bg-background text-amber-700 dark:text-amber-300 ring-2 ring-amber-500/20 shadow-xs'
                          : 'border-border/70 bg-background/60 text-muted-foreground hover:border-amber-300 hover:text-foreground'
                      }`}
                    >
                      <Phone className="h-4 w-4" />
                      MoMo
                    </button>
                    <button
                      type="button"
                      onClick={() => setPayoutMethod('bank_transfer')}
                      className={`rounded-xl border p-3 text-xs font-semibold transition-all duration-200 flex flex-col items-center gap-1.5 ${
                        payoutMethod === 'bank_transfer'
                          ? 'border-amber-500 bg-background text-amber-700 dark:text-amber-300 ring-2 ring-amber-500/20 shadow-xs'
                          : 'border-border/70 bg-background/60 text-muted-foreground hover:border-amber-300 hover:text-foreground'
                      }`}
                    >
                      <Building2 className="h-4 w-4" />
                      Bank
                    </button>
                  </div>
                </div>

                {payoutMethod === 'cash' && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-foreground">Pickup Details <span className="text-destructive">*</span></Label>
                    <Input
                      placeholder="e.g. Welile HQ Reception, Nakasero — collected by Jane Doe"
                      value={pickupLocation}
                      onChange={(e) => setPickupLocation(e.target.value)}
                      className="h-10 rounded-xl border-border/70"
                    />
                  </div>
                )}

                {payoutMethod === 'mobile_money' && (
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="col-span-2 space-y-1.5">
                      <Label className="text-xs font-semibold text-foreground">MoMo Number <span className="text-destructive">*</span></Label>
                      <Input
                        type="tel"
                        placeholder="07XX XXX XXX"
                        value={momoNumber}
                        onChange={(e) => setMomoNumber(e.target.value)}
                        className="h-10 rounded-xl border-border/70"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-foreground">Provider <span className="text-destructive">*</span></Label>
                      <div className="relative">
                        <select
                          value={momoProvider}
                          onChange={(e) => setMomoProvider(e.target.value as 'MTN' | 'Airtel')}
                          className="flex h-10 w-full appearance-none rounded-xl border border-border/70 bg-background px-3 py-2 pr-10 text-sm"
                        >
                          <option value="MTN">MTN</option>
                          <option value="Airtel">Airtel</option>
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-foreground">Account Name <span className="text-destructive">*</span></Label>
                      <Input
                        placeholder="Registered MoMo name"
                        value={momoName}
                        onChange={(e) => setMomoName(e.target.value)}
                        className="h-10 rounded-xl border-border/70"
                      />
                    </div>
                  </div>
                )}

                {payoutMethod === 'bank_transfer' && (
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="col-span-2 space-y-1.5">
                      <Label className="text-xs font-semibold text-foreground">Bank Name <span className="text-destructive">*</span></Label>
                      <div className="relative">
                        <select
                          value={bankName}
                          onChange={(e) => setBankName(e.target.value)}
                          className="flex h-10 w-full appearance-none rounded-xl border border-border/70 bg-background px-3 py-2 pr-10 text-sm"
                        >
                          <option value="">Select bank...</option>
                          {UGANDA_BANKS.map((b) => (
                            <option key={b} value={b}>{b}</option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-foreground">Account Number <span className="text-destructive">*</span></Label>
                      <Input
                        placeholder="0123456789"
                        value={bankAccountNumber}
                        onChange={(e) => setBankAccountNumber(e.target.value)}
                        className="h-10 rounded-xl border-border/70"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-foreground">Account Name <span className="text-destructive">*</span></Label>
                      <Input
                        placeholder="Account holder full name"
                        value={bankAccountName}
                        onChange={(e) => setBankAccountName(e.target.value)}
                        className="h-10 rounded-xl border-border/70"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-semibold text-foreground">Audit Reason</Label>
                <span className={`text-[11px] font-medium transition-colors ${
                  reason.trim().length >= 20 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
                }`}>
                  {reason.trim().length}/20 characters minimum
                </span>
              </div>
              <Textarea
                placeholder={
                  operation === 'withdraw'
                    ? 'e.g. April marketing campaign payout to vendor...'
                    : isCredit
                      ? 'e.g. ROI payout for March cycle, salary advance for agent...'
                      : 'e.g. Access fee collection, penalty for policy violation...'
                }
                value={reason}
                onChange={e => setReason(e.target.value)}
                rows={2}
                className="rounded-xl border-border/70 focus-visible:ring-primary/20 text-sm"
              />
            </div>

            {/* Automation Toggle (credit only) */}
            {isCredit && selectedUser && (
              <PayoutAutomationToggle
                enabled={automateEnabled}
                onToggle={setAutomateEnabled}
                config={automateConfig}
                onConfigChange={setAutomateConfig}
              />
            )}

            {/* Treasury Impact */}
            {amt > 0 && isCredit && (
              <TreasuryImpactBanner payoutAmount={amt} />
            )}

            {/* Summary before submit */}
            {selectedCategory && amt > 0 && selectedUser && recipientType && (
              <div className="rounded-2xl bg-muted/30 border border-border/70 p-4 text-xs space-y-2.5 shadow-2xs">
                <div className="flex items-center justify-between pb-1 border-b border-border/50">
                  <p className="font-bold text-sm flex items-center gap-2 text-foreground">
                    <Info className="h-4 w-4 text-primary" />
                    Double-Entry Summary
                  </p>
                  <Badge variant="outline" className="text-[10px] font-mono">
                    Balanced
                  </Badge>
                </div>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 overflow-x-auto text-xs">
                  <span className="text-muted-foreground font-medium">Entry 1:</span>
                  <span className="font-medium text-foreground flex items-center flex-wrap gap-1">
                    <span className={isCredit ? 'text-emerald-600 font-bold' : 'text-rose-600 font-bold'}>
                      {isCredit ? '↗ Credit' : '↘ Debit'}
                    </span>{' '}
                    UGX {amt.toLocaleString()} {isCredit ? 'to' : 'from'}{' '}
                    <span className="font-bold underline decoration-primary/30 underline-offset-2">{selectedUser.full_name}</span>'s wallet
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 rounded-md">
                      {selectedCategory.walletCategory.replace(/_/g, ' ')}
                    </Badge>
                  </span>
                  <span className="text-muted-foreground font-medium">Entry 2:</span>
                  <span className="font-medium text-foreground flex items-center flex-wrap gap-1">
                    <span className={isCredit ? 'text-rose-600 font-bold' : 'text-emerald-600 font-bold'}>
                      {isCredit ? '↘ Debit' : '↗ Credit'}
                    </span>{' '}
                    UGX {amt.toLocaleString()} {isCredit ? 'from' : 'to'} platform
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 rounded-md">
                      {selectedCategory.platformCategory.replace(/_/g, ' ')}
                    </Badge>
                  </span>
                  {selectedSubCategory && (
                    <>
                      <span className="text-muted-foreground font-medium">Tag:</span>
                      <span className="font-medium text-foreground">📂 {selectedSubCategory.label}</span>
                    </>
                  )}
                  {automateEnabled && (
                    <>
                      <span className="text-muted-foreground font-medium">Recurrence:</span>
                      <span className="font-medium text-foreground">🔁 {describeSchedule(automateConfig)}</span>
                    </>
                  )}
                </div>
                {isCredit && (() => {
                  const bucket = RECIPIENT_BUCKET[recipientType as RecipientType];
                  const meta = BUCKET_LABEL[bucket];
                  return (
                    <div className={`mt-2 rounded-xl border p-3 text-[11px] ${meta.tone}`}>
                      <div className="font-bold flex items-center gap-1.5">
                        💼 Lands in: {meta.name} bucket
                      </div>
                      <div className="opacity-85 mt-0.5">{meta.note}</div>
                      <div className="opacity-75 mt-1 italic">
                        Only Available Balance can be withdrawn.
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            <CfoApprovalGate>
            <Button
              className={`w-full h-12 rounded-xl text-base font-semibold shadow-md active:scale-[0.99] transition-all ${
                operation === 'withdraw'
                  ? 'bg-amber-600 hover:bg-amber-700 text-white shadow-amber-600/20'
                  : isCredit
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-600/20'
                    : 'bg-rose-600 hover:bg-rose-700 text-white shadow-rose-600/20'
              }`}
              onClick={() => {
                // Float (Operational Wallet) credits — e.g. Agent Float / Rent
                // Disbursement — need no transaction ID, just an explicit confirm.
                if (isCredit && recipientType === 'operational_wallet') {
                  setFloatApproved(false);
                  setFloatConfirmOpen(true);
                  return;
                }
                mutation.mutate(undefined);
              }}
              disabled={mutation.isPending || !selectedUser || !amount || reason.trim().length < 20 || !selectedCategoryId || !recipientType}
            >
              {mutation.isPending ? <Loader2 className="h-5 w-5 animate-spin mr-2" /> : <Send className="h-5 w-5 mr-2" />}
              {operation === 'withdraw'
                ? `Withdraw UGX ${amt.toLocaleString()} → ${selectedUser?.full_name || '...'}`
                : locationRecipients.length > 1
                  ? `${isCredit ? CFO_PAYOUT_VERB.credit : CFO_PAYOUT_VERB.debit} ${locationRecipients.length} recipients' wallets · UGX ${amt.toLocaleString()} each`
                  : `${isCredit ? CFO_PAYOUT_VERB.credit : CFO_PAYOUT_VERB.debit} ${selectedUser?.full_name || '...'}'s wallet · UGX ${amt.toLocaleString()}`}
            </Button>
            </CfoApprovalGate>

            <AlertDialog open={floatConfirmOpen} onOpenChange={setFloatConfirmOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Confirm float transfer</AlertDialogTitle>
                  <AlertDialogDescription asChild>
                    <div className="space-y-2 text-sm">
                      <p>
                        You're sending <strong>UGX {amt.toLocaleString()}</strong> to{' '}
                        <strong>
                          {locationRecipients.length > 1
                            ? `${locationRecipients.length} recipients`
                            : selectedUser?.full_name || '...'}
                        </strong>
                        {locationRecipients.length > 1 ? "' Float (Operational Wallet) each" : "'s Float (Operational Wallet)"}
                        {selectedCategory ? <> via <strong>{selectedCategory.label}</strong></> : null}.
                      </p>
                      <p className="text-muted-foreground">
                        No transaction ID is required for float transfers — just confirm to post the movement.
                      </p>
                      <label className="flex items-start gap-2 rounded-md border border-border p-3 mt-2 cursor-pointer">
                        <Checkbox
                          checked={floatApproved}
                          onCheckedChange={(v) => setFloatApproved(v === true)}
                          disabled={mutation.isPending}
                          className="mt-0.5"
                        />
                        <span className="text-foreground">
                          I explicitly approve posting this float credit without a transaction ID.
                        </span>
                      </label>
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-emerald-600 hover:bg-emerald-700"
                    onClick={(e) => {
                      e.preventDefault();
                      mutation.mutate(undefined, { onSettled: () => setFloatConfirmOpen(false) });
                    }}
                    disabled={mutation.isPending || !floatApproved}
                  >
                    {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Confirm transfer
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={!!overdrawInfo} onOpenChange={(o) => { if (!o) { setOverdrawInfo(null); setOverdrawApproved(false); } }}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-amber-600" />
                    {overdrawInfo?.bucket === 'float'
                      ? 'Insufficient Operational Float'
                      : 'Insufficient Available Balance'}
                  </AlertDialogTitle>
                  <AlertDialogDescription asChild>
                    <div className="space-y-3 text-sm">
                      <p>
                        {overdrawInfo?.bucket === 'float'
                          ? "This wallet's current operational float is not enough to cover this correction."
                          : "The user's live ledger balance is not enough to cover this correction."}
                      </p>
                      <div className="rounded-md border border-border bg-muted/50 p-3 space-y-1">
                        <div className="flex justify-between"><span className="text-muted-foreground">{overdrawInfo?.bucket === 'float' ? 'Float balance (strict)' : 'Available (strict)'}</span><strong>UGX {overdrawInfo?.available.toLocaleString()}</strong></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Requested</span><strong>UGX {overdrawInfo?.requested.toLocaleString()}</strong></div>
                        <div className="flex justify-between text-amber-700"><span>Shortfall</span><strong>UGX {overdrawInfo?.shortfall.toLocaleString()}</strong></div>
                      </div>
                      {overdrawInfo?.bucket === 'float' ? (
                        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 space-y-2 text-foreground">
                          <div className="font-semibold text-emerald-800">Operational float only</div>
                          <p className="text-[13px] leading-relaxed">
                            This correction affects operational float only. <strong>No personal debt will be
                            created.</strong> Any remaining operational shortfall will remain against the
                            company's operational float ledger until additional float is allocated.
                          </p>
                          <p className="text-[13px] leading-relaxed">
                            Lower the amount to at most{' '}
                            <strong>UGX {overdrawInfo?.available.toLocaleString()}</strong>, or allocate more
                            float to this wallet first.
                          </p>
                        </div>
                      ) : (
                      <>
                      <p>
                        Proceeding with <strong>Forced Reversal</strong> will still post the full
                        correction and record the shortfall as a <strong>recoverable debt</strong>
                        (<code>cfo_debit_obligations</code>, <code>auto_recover=true</code>) that the
                        recovery cron will settle from the user's next eligible credits.
                      </p>
                      <label className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 cursor-pointer">
                        <Checkbox
                          checked={overdrawApproved}
                          onCheckedChange={(v) => setOverdrawApproved(v === true)}
                          disabled={mutation.isPending || splitFreezing}
                          className="mt-0.5"
                        />
                        <span className="text-foreground">
                          I understand this creates a recoverable debt of{' '}
                          <strong>UGX {overdrawInfo?.shortfall.toLocaleString()}</strong> and I want to proceed.
                        </span>
                      </label>
                      <div className="rounded-md border border-red-200 bg-red-50 p-3 space-y-2 text-foreground">
                        <div className="font-semibold text-red-800 flex items-center gap-1.5">
                          <AlertTriangle className="h-4 w-4" /> Recommended: Freeze + Split Debit
                        </div>
                        <p className="text-[13px] leading-relaxed">
                          Post <strong>UGX {overdrawInfo?.available.toLocaleString()}</strong> as a clean
                          debit (collectable now), <strong>UGX {overdrawInfo?.shortfall.toLocaleString()}</strong> as
                          a Force Reversal (recorded as a receivable), and immediately{' '}
                          <strong>freeze the account</strong> so future inflows are swept by auto-recovery.
                        </p>
                      </div>
                      </>
                      )}
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={mutation.isPending || splitFreezing}>
                    {overdrawInfo?.bucket === 'float' ? 'Close' : 'Cancel'}
                  </AlertDialogCancel>
                  {overdrawInfo?.bucket !== 'float' && (
                  <>
                  <Button
                    type="button"
                    className="bg-red-600 hover:bg-red-700 text-white"
                    onClick={handleFreezeAndSplitDebit}
                    disabled={mutation.isPending || splitFreezing || !overdrawApproved}
                  >
                    {splitFreezing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Freeze + Split Debit
                  </Button>
                  <AlertDialogAction
                    className="bg-amber-600 hover:bg-amber-700"
                    onClick={(e) => {
                      e.preventDefault();
                      mutation.mutate({ allowOverdraw: true }, {
                        onSettled: () => { setOverdrawInfo(null); setOverdrawApproved(false); },
                      });
                    }}
                    disabled={mutation.isPending || splitFreezing || !overdrawApproved}
                  >
                    {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Force reversal & create debt
                  </AlertDialogAction>
                  </>
                  )}
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </CardContent>
    </Card>
  );
}

