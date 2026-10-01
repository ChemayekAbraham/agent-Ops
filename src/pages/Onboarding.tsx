import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { motion, AnimatePresence, useInView } from 'framer-motion';
import { toast, Toaster } from 'sonner';
import {
  ArrowLeft, Check, X, Shield, Home, TrendingUp, Banknote,
  ChevronRight, BadgeCheck, Eye, EyeOff, Mail, Phone, Lock, MapPin,
  Building2, CreditCard, User, Hash, Users, Landmark, Wallet, ChevronDown, Smartphone,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth as useRealAuth } from '@/hooks/useAuth';
import { buildPartnerReference } from '@/lib/partnerReference';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import { numberToWords } from '@/lib/numberToWords';
import { buildAgreementHtml } from '@/components/partner/agreementTemplate';
import { renderAgreementPdfBase64 } from '@/components/partner/renderAgreementPdf';
import { SignaturePad } from '@/components/shared/SignaturePad';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import { preflightSignup, attachSignupUser } from '@/lib/signupGuard';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import type { UgLocationSelection } from '@/hooks/useUgLocations';

// ─── Mocks ───────────────────────────────────────────────────────────────────
const useRouteRole = () => 'FUNDER';
// Real Supabase signup wrapper — preserves the existing call signature used below.
const registerUser = async (payload: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  otherNames?: string;
  phone: string;
  role: string;
  referrerId?: string;
}): Promise<{ status: string; data: { user: any; userId: string; hasSession: boolean } }> => {
  const fullName = joinPersonName({
    firstName: payload.firstName,
    otherNames: payload.otherNames ?? '',
    lastName: payload.lastName,
  });
  const guard = await preflightSignup({ email: payload.email, phone: payload.phone, path: '/funder-onboarding' });
  if (!guard.allowed) {
    throw new Error(guard.reason || 'Sign-up is temporarily unavailable from this device or network. Please try again tomorrow.');
  }
  // Funder onboarding is vetted through /partner-onboarding, so it must not use
  // the public auth sign-up call (that sends the misleading confirmation email).
  // Create a pre-confirmed account server-side, then sign in once so the contract
  // pipeline below can write the agreement and send the single intended email.
  const { data, error } = await supabase.functions.invoke('create-funder-onboarding-account', {
    body: {
      email: payload.email,
      password: payload.password,
      fullName,
      phone: payload.phone,
      referrerId: payload.referrerId || null,
    },
  });
  // On a non-2xx (e.g. 409 "already registered") the SDK returns a generic
  // FunctionsHttpError whose .message is "non-2xx status code"; the real
  // backend message sits in error.context. Surface the parsed message so the
  // user never sees a raw edge-function status.
  if (error) {
    const parsed = await extractFromErrorObject(error, 'We couldn’t create your account. Please try again.');
    throw new Error(parsed);
  }
  if (!data?.userId) throw new Error(data?.error || 'Failed to create funder account');
  await attachSignupUser(guard.attempt_id, data.userId);

  const signInResult = await supabase.auth.signInWithPassword({
    email: payload.email,
    password: payload.password,
  });
  if (signInResult.error) throw signInResult.error;

  return {
    status: 'success',
    data: {
      user: signInResult.data.user ?? data.user ?? { email: payload.email },
      userId: data.userId,
      hasSession: !!signInResult.data.session,
    },
  };
};
const useCurrency = () => ({ symbol: 'UGX', code: 'UGX' });
const formatCurrencyCompact = (val: number, currency: { symbol: string }) => {
  if (val >= 1_000_000) return `${currency.symbol} ${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${currency.symbol} ${(val / 1_000).toFixed(1)}K`;
  return `${currency.symbol} ${Math.round(val).toLocaleString()}`;
};

// ─── Types ───────────────────────────────────────────────────────────────────
type InvestPath = 'tenant' | 'pool' | null;

interface FormState {
  understoodRole: boolean;
  investPath: InvestPath;
  supportAmount: string;
  firstName: string;
  lastName: string;
  otherNames: string;
  email: string;
  password: string;
  confirmPassword: string;
  phone: string;
  address: string;
  nationalId: string;
  payoutMode: 'bank' | 'momo';
  momoProvider: string;
  momoNumber: string;
  momoName: string;
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  kinName: string;
  kinContact: string;
  agreedToTerms: boolean;
  signatureDataUrl: string;
  /** Official Uganda dataset pick (optional) — approved location source. */
  ugLoc?: UgLocationSelection | null;
}

// ─── Password Strength ───────────────────────────────────────────────────────
function getStrength(pw: string): { score: number; label: string; color: string } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const map = [
    { label: 'Too short', color: '#EF4444' },
    { label: 'Weak', color: '#F97316' },
    { label: 'Fair', color: '#EAB308' },
    { label: 'Good', color: '#22C55E' },
    { label: 'Strong', color: '#6c11d4' },
  ];
  return { score, ...map[score] };
}

// ─── Animation Variants ──────────────────────────────────────────────────────
const slideVariants = {
  enter: { x: 40, opacity: 0 },
  center: { x: 0, opacity: 1, transition: { duration: 0.35, ease: 'easeOut' as const } },
  exit: { x: -40, opacity: 0, transition: { duration: 0.22, ease: 'easeIn' as const } },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
};

const fadeUp = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' as const } },
};

// ─── StepDots ────────────────────────────────────────────────────────────────
function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }).map((_, i) => (
        <motion.div
          key={i}
          animate={{
            width: i + 1 === current ? 24 : 6,
            backgroundColor: i + 1 <= current ? '#6c11d4' : '#DDD6FE',
          }}
          transition={{ duration: 0.3 }}
          className="h-1.5 rounded-full"
        />
      ))}
    </div>
  );
}

// ─── ChoiceCard ──────────────────────────────────────────────────────────────
function ChoiceCard({
  selected, onClick, icon: Icon, title, body, badge,
}: {
  selected: boolean; onClick: () => void; icon: React.ElementType;
  title: string; body: string; badge: string;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.985 }}
      className={`w-full text-left p-4 rounded-2xl border-2 transition-all duration-200 relative overflow-hidden ${
        selected ? 'border-[#6c11d4] bg-[#F3F0FF]' : 'border-border bg-card hover:border-purple-200'
      }`}
    >
      {selected && (
        <motion.div
          layoutId="card-glow"
          className="absolute inset-0 bg-gradient-to-br from-purple-100/40 to-transparent pointer-events-none"
        />
      )}
      <div className="flex items-start gap-3 relative z-10">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
          selected ? 'bg-[#6c11d4] text-white' : 'bg-purple-50 text-[#6c11d4]'
        }`}>
          <Icon size={18} strokeWidth={1.75} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <h4 className="font-bold text-foreground text-[13px]">{title}</h4>
            <span className={`text-[9px] font-black px-2 py-0.5 rounded-full shrink-0 ${
              selected ? 'bg-[#6c11d4] text-white' : 'bg-purple-100 text-[#6c11d4]'
            }`}>{badge}</span>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">{body}</p>
        </div>
      </div>
      {selected && (
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          className="absolute top-0 right-0 w-5 h-5 rounded-full bg-[#6c11d4] flex items-center justify-center"
        >
          <Check size={11} className="text-white" strokeWidth={3} />
        </motion.div>
      )}
    </motion.button>
  );
}

// ─── CountUp ─────────────────────────────────────────────────────────────────
function CountUp({ to, suffix = '', duration = 1400 }: { to: number; suffix?: string; duration?: number }) {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLParagraphElement>(null);
  const inView = useInView(ref, { once: true, margin: '-40px' });

  useEffect(() => {
    if (!inView) return;
    const start = performance.now();
    let raf: number;
    const step = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.round(eased * to));
      if (progress < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [inView, to, duration]);

  return (
    <p ref={ref} className="text-base font-black text-foreground leading-none">
      {count.toLocaleString()}{suffix}
    </p>
  );
}

// ─── Support Graph ───────────────────────────────────────────────────────────
const MONTHS = 12;
/** Minimum supported contribution, in UGX. Required before a funder can proceed. */
export const MIN_SUPPORT = 50_000;

function buildPoints(mode: 'tenant' | 'pool', principal: number): number[] {
  const pts: number[] = [];
  let bal = principal;
  for (let m = 0; m <= MONTHS; m++) {
    pts.push(bal);
    if (mode === 'tenant') bal += principal * 0.15;
    else bal = bal * 1.15;
  }
  return pts;
}

function SupportGraph({
  mode,
  amount,
  onAmountChange,
  showError,
}: {
  mode: 'tenant' | 'pool';
  amount: string;
  onAmountChange: (value: string) => void;
  showError: boolean;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const currency = useCurrency();
  const enteredAmount = Number(amount.replace(/,/g, '')) || 0;
  const hasAmount = enteredAmount >= MIN_SUPPORT;
  const isInvalid = showError && !hasAmount;
  // The chart shape uses a preview principal so it's never empty, but every
  // breakdown figure reflects ONLY the real amount the funder entered.
  const principal = enteredAmount > 0 ? enteredAmount : MIN_SUPPORT;

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const digits = e.target.value.replace(/[^0-9]/g, '');
    const formatted = digits ? Number(digits).toLocaleString() : '';
    onAmountChange(formatted);
  };

  const W = 320, H = 140, PAD = { top: 12, right: 12, bottom: 28, left: 8 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const points = buildPoints(mode, principal);
  const maxVal = points[MONTHS];
  const minVal = principal;
  const range = maxVal - minVal || 1;

  const xOf = (i: number) => PAD.left + (i / MONTHS) * innerW;
  const yOf = (v: number) => PAD.top + innerH - ((v - minVal) / range) * innerH;

  const pathD = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`)
    .join(' ');

  const areaD = pathD +
    ` L${xOf(MONTHS).toFixed(1)},${(PAD.top + innerH).toFixed(1)}` +
    ` L${PAD.left.toFixed(1)},${(PAD.top + innerH).toFixed(1)} Z`;

  const color = mode === 'pool' ? '#6c11d4' : '#7B2AC5';
  const labelStep = mode === 'pool' ? 3 : 2;
  const pathId = `graph-${mode}`;

  // ── Breakdown figures (computed strictly from the entered amount) ──
  const monthlyReward = enteredAmount * 0.15;
  const totalValue = points[MONTHS];
  const totalEarned = totalValue - enteredAmount;
  const dash = '—';
  const breakdown = mode === 'tenant'
    ? [
        { label: 'Your support', value: hasAmount ? formatCurrencyCompact(enteredAmount, currency) : dash },
        { label: 'Monthly reward', value: hasAmount ? `+${formatCurrencyCompact(monthlyReward, currency)}` : dash },
        { label: 'Rewards · 12 mo', value: hasAmount ? `+${formatCurrencyCompact(monthlyReward * MONTHS, currency)}` : dash },
        { label: 'Total after 12 mo', value: hasAmount ? formatCurrencyCompact(enteredAmount + monthlyReward * MONTHS, currency) : dash, accent: true },
      ]
    : [
        { label: 'Your support', value: hasAmount ? formatCurrencyCompact(enteredAmount, currency) : dash },
        { label: 'Month 1 reward', value: hasAmount ? `+${formatCurrencyCompact(monthlyReward, currency)}` : dash },
        { label: 'Total growth', value: hasAmount ? `+${formatCurrencyCompact(totalEarned, currency)}` : dash },
        { label: 'Total after 12 mo', value: hasAmount ? formatCurrencyCompact(totalValue, currency) : dash, accent: true },
      ];

  return (
    <motion.div
      key={mode}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      className="bg-card border border-border rounded-2xl p-4 shadow-sm"
    >
      <div className="flex items-start justify-between mb-3 gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
            {mode === 'tenant' ? 'Monthly rewards · 12 months' : 'Compounding growth · 12 months'}
          </p>
          <div
            className={`flex items-center gap-1.5 mt-1.5 border rounded-xl px-3 py-1.5 transition-colors ${
              isInvalid ? 'bg-red-50 border-red-400' : 'bg-purple-50 border-purple-100'
            }`}
          >
            <span className="text-[11px] font-bold text-[#6c11d4] shrink-0">{currency.symbol}</span>
            {/* Blinking caret on the LEFT — indicates where to type when empty */}
            {!amount && (
              <span
                aria-hidden="true"
                className="inline-block w-[2px] h-4 bg-[#6c11d4] animate-blink shrink-0"
              />
            )}
            <input
              type="text"
              inputMode="numeric"
              value={amount}
              onChange={handleAmountChange}
              placeholder="Enter amount"
              aria-invalid={isInvalid}
              className="flex-1 min-w-0 bg-transparent text-sm font-black text-[#1C1C2E] outline-none placeholder:text-gray-300 w-full caret-[#6c11d4]"
            />
          </div>
          {isInvalid ? (
            <p className="text-[10px] font-semibold text-red-500 mt-1">
              Please enter the amount you'd like to support (min {currency.symbol} {MIN_SUPPORT.toLocaleString()}) to continue.
            </p>
          ) : (
            <p className="text-[10px] text-muted-foreground mt-1">
              Enter the amount you're willing to support — required to continue (min {currency.symbol} {MIN_SUPPORT.toLocaleString()}).
            </p>
          )}
        </div>
        <motion.span
          key={mode + '-badge'}
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="text-[11px] font-black px-2.5 py-1 rounded-full bg-purple-100 text-[#6c11d4] shrink-0 mt-4"
        >
          {mode === 'tenant' ? '+15% / mo' : 'Compounds'}
        </motion.span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className={`w-full transition-opacity ${hasAmount ? 'opacity-100' : 'opacity-40'}`} style={{ touchAction: 'none' }} onMouseLeave={() => setHovered(null)}>
        <defs>
          <linearGradient id={`area-${mode}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
          <clipPath id={pathId}>
            <motion.rect x={PAD.left} y={0} height={H} initial={{ width: 0 }} animate={{ width: innerW }} transition={{ duration: 1.1, ease: 'easeOut', delay: 0.1 }} />
          </clipPath>
        </defs>
        <path d={areaD} fill={`url(#area-${mode})`} clipPath={`url(#${pathId})`} />
        <path d={pathD} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" clipPath={`url(#${pathId})`} />
        {points.map((_, i) => {
          if (i % labelStep !== 0 || i === 0) return null;
          return <text key={i} x={xOf(i)} y={H - 6} textAnchor="middle" fontSize="8" fill="#9CA3AF">M{i}</text>;
        })}
        {points.map((v, i) => (
          <g key={i}>
            <rect x={xOf(i) - 12} y={0} width={24} height={H - PAD.bottom} fill="transparent" onMouseEnter={() => setHovered(i)} style={{ cursor: 'crosshair' }} />
            {hovered === i && (
              <g>
                <line x1={xOf(i)} y1={PAD.top} x2={xOf(i)} y2={PAD.top + innerH} stroke={color} strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
                <circle cx={xOf(i)} cy={yOf(v)} r={4} fill={color} />
                <circle cx={xOf(i)} cy={yOf(v)} r={7} fill={color} opacity="0.15" />
                <g transform={`translate(${Math.min(xOf(i) + 6, W - 82)},${Math.max(yOf(v) - 28, PAD.top)})`}>
                  <rect width="78" height="22" rx="6" fill={color} />
                  <text x="39" y="14" textAnchor="middle" fontSize="9" fill="white" fontWeight="700">{formatCurrencyCompact(v, currency)}</text>
                </g>
              </g>
            )}
          </g>
        ))}
      </svg>

      {/* ── Live breakdown — computed from the entered amount ── */}
      <div className="grid grid-cols-2 gap-2 pt-3 border-t border-gray-50 mt-1">
        {breakdown.map(({ label, value, accent }) => (
          <div
            key={label}
            className={`rounded-xl px-3 py-2 ${accent ? 'bg-[#F3F0FF] border border-[#E0D2FA]' : 'bg-muted'}`}
          >
            <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider">{label}</p>
            <p className={`text-[13px] font-black mt-0.5 ${accent ? 'text-[#6c11d4]' : 'text-foreground'}`}>{value}</p>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

// ─── Step 1 — Welcome ────────────────────────────────────────────────────────
function Step1({ form, setForm }: { form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>> }) {
  const cards = [
    {
      icon: Home,
      title: 'You Fund the Rent',
      body: 'Your capital enters the Rent Management Pool. Welile deploys it to pay landlords on behalf of verified tenants.',
      highlight: false,
    },
    {
      icon: Banknote,
      title: '15% Monthly Pay Outs',
      body: 'You earn 15% of your active contribution each month, credited to your wallet automatically on a strict 30-day cycle.',
      highlight: true,
    },
    {
      icon: Shield,
      title: 'Fully Managed by Welile',
      body: 'We verify tenants, manage collections, and handle all repayments. You see anonymised Virtual Houses, never personal details.',
      highlight: false,
    },
  ];

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-7">
      <motion.div variants={fadeUp} className="pt-2">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-xl bg-[#6c11d4]/10 flex items-center justify-center">
            <Shield size={16} className="text-[#6c11d4]" strokeWidth={1.75} />
          </div>
          <span className="text-xs font-bold text-[#6c11d4] tracking-wide uppercase">Welile Housing Partner</span>
        </div>
        <h2 className="text-2xl font-black text-foreground tracking-tight leading-[1.15]">
          Put Your Money<br />
          <span className="text-[#6c11d4]">to Work for Families.</span>
        </h2>
        <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
          You contribute capital. Welile pays rent for verified tenants, manages collections, and credits your wallet every 30 days. You don't manage anything.
        </p>
      </motion.div>

      <motion.div variants={fadeUp} className="space-y-3">
        {cards.map(({ icon: Icon, title, body, highlight }) => (
          <div
            key={title}
            className={`relative flex items-start gap-3 rounded-xl p-3 border transition-all ${
              highlight
                ? 'bg-[#F3F0FF] border-[#6c11d4]/25 shadow-sm shadow-purple-100'
                : 'bg-card border-border shadow-sm'
            }`}
          >
            {highlight && (
              <BadgeCheck
                size={18}
                className="absolute -top-1 -right-1 drop-shadow-md"
                style={{ color: '#6c11d4' }}
                strokeWidth={1.75}
                fill="white"
              />
            )}
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
              highlight ? 'bg-[#6c11d4] text-white' : 'bg-purple-50 text-[#6c11d4]'
            }`}>
              <Icon size={14} strokeWidth={1.75} />
            </div>
            <div className="flex-1 min-w-0">
              <p className={`text-[13px] font-bold ${highlight ? 'text-[#6c11d4]' : 'text-foreground'}`}>{title}</p>
              <p className="text-[11px] text-muted-foreground leading-relaxed">{body}</p>
            </div>
          </div>
        ))}
      </motion.div>

      <motion.div variants={fadeUp} className="grid grid-cols-3 gap-3">
        {[
          { icon: Home,     to: 3000, suffix: '+', label: 'Homes Supported' },
          { icon: Banknote, to: 15,   suffix: '%', label: 'Average ROI'     },
          { icon: Shield,   to: 30,   suffix: 'd', label: 'Payout Cycle'    },
        ].map(({ icon: Icon, to, suffix, label }) => (
          <div key={label} className="flex flex-col items-center gap-1.5 bg-card border border-border rounded-2xl py-3 px-2 shadow-sm">
            <div className="w-7 h-7 rounded-xl bg-purple-50 flex items-center justify-center text-[#6c11d4]">
              <Icon size={14} strokeWidth={1.75} />
            </div>
            <CountUp to={to} suffix={suffix} />
            <p className="text-[10px] text-muted-foreground font-medium text-center leading-tight">{label}</p>
          </div>
        ))}
      </motion.div>

      <motion.label
        variants={fadeUp}
        className="flex items-start gap-3 bg-muted border border-border rounded-xl p-4 cursor-pointer"
      >
        <div
          className={`w-5 h-5 rounded border-2 shrink-0 mt-0.5 flex items-center justify-center transition-colors ${
            form.understoodRole ? 'bg-[#6c11d4] border-[#6c11d4]' : 'border-border'
          }`}
          onClick={() => setForm(p => ({ ...p, understoodRole: !p.understoodRole }))}
        >
          {form.understoodRole && <Check size={11} className="text-white" strokeWidth={3} />}
        </div>
        <p className="text-[12.5px] text-muted-foreground leading-snug">
          I understand I am a capital facilitator, not a lender.{' '}
          Welile manages tenant relationships, collections, and monthly payouts.
        </p>
      </motion.label>
    </motion.div>
  );
}

// ─── Step 2 — Support ────────────────────────────────────────────────────────
function Step2({ form, setForm, showError }: { form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>>; showError: boolean }) {
  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-6">
      <motion.div variants={fadeUp}>
        <h2 className="text-[22px] font-black text-foreground tracking-tight leading-tight">
          How Would You Like<br />to Contribute?
        </h2>
        <p className="text-xs text-muted-foreground mt-1.5">Choose your contribution style — you can always adjust later.</p>
      </motion.div>

      <motion.div variants={fadeUp} className="space-y-3">
        <ChoiceCard
          selected={form.investPath === 'tenant'}
          onClick={() => setForm(p => ({ ...p, investPath: 'tenant' }))}
          icon={Home}
          title="Support a Tenant"
          body="Your contribution is matched to a specific rent need. A real family gets housed, and you earn a monthly participation reward on what you put in."
          badge="15% Monthly"
        />
        <ChoiceCard
          selected={form.investPath === 'pool'}
          onClick={() => setForm(p => ({ ...p, investPath: 'pool' }))}
          icon={TrendingUp}
          title="Grow Your Contribution"
          body="Add to the housing pool. Your monthly rewards build on themselves — each cycle your base grows and so does the next reward."
          badge="Compounding"
        />
      </motion.div>

      <AnimatePresence mode="wait">
        {form.investPath && (
          <SupportGraph
            key={form.investPath}
            mode={form.investPath}
            amount={form.supportAmount}
            onAmountChange={(value) => setForm(p => ({ ...p, supportAmount: value }))}
            showError={showError}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Step 3 — Register ───────────────────────────────────────────────────────
function Step3({ form, setForm }: { form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>> }) {
  const [showPw, setShowPw] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  return _Step3Impl({ form, setForm, showPw, setShowPw, showConfirm, setShowConfirm });
}

// ─── Step (Banking & Next of Kin) ─────────────────────────────────────────────
function StepBankKin({ form, setForm }: { form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>> }) {
  const fieldClass =
    'w-full bg-muted border border-border rounded-xl pl-9 pr-4 py-3 text-sm text-foreground placeholder:text-gray-300 outline-none focus:bg-card focus:border-[#6c11d4] focus:ring-2 focus:ring-[#6c11d4]/10 transition-all';
  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(p => ({ ...p, [key]: e.target.value }));

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-5">
      <motion.div variants={fadeUp}>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-xl bg-[#6c11d4]/10 flex items-center justify-center">
            <Landmark size={16} className="text-[#6c11d4]" strokeWidth={1.75} />
          </div>
          <span className="text-xs font-bold text-[#6c11d4] tracking-wide uppercase">Agreement Details</span>
        </div>
        <h2 className="text-[22px] font-black text-foreground tracking-tight leading-tight">
          Banking &amp; Next of Kin
        </h2>
        <p className="text-xs text-muted-foreground mt-1.5">
          These details complete your Welile Partnership Agreement and route your payouts.
        </p>
      </motion.div>

      {/* Bank details */}
      <motion.div variants={fadeUp} className="bg-card border border-border rounded-2xl p-4 space-y-3">
        <p className="text-[10px] font-black text-[#6c11d4] uppercase tracking-widest">Payout Details</p>

        {/* Payout method selector */}
        <div className="space-y-1">
          <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest pl-1">Payout Method</label>
          <div className="relative">
            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"><Wallet size={15} strokeWidth={1.75} /></div>
            <select
              value={form.payoutMode}
              onChange={(e) => setForm(p => ({ ...p, payoutMode: e.target.value as 'bank' | 'momo' }))}
              className={fieldClass + ' appearance-none cursor-pointer'}
            >
              <option value="bank">Bank Account</option>
              <option value="momo">Mobile Money</option>
            </select>
            <div className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"><ChevronDown size={15} strokeWidth={1.75} /></div>
          </div>
        </div>

        {form.payoutMode === 'bank' ? (
          <>
            <div className="space-y-1">
              <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest pl-1">Bank Name</label>
              <div className="relative">
                <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"><Building2 size={15} strokeWidth={1.75} /></div>
                <input type="text" placeholder="e.g. Stanbic Bank" value={form.bankName} onChange={set('bankName')} className={fieldClass} />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest pl-1">Account Name</label>
              <div className="relative">
                <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"><User size={15} strokeWidth={1.75} /></div>
                <input type="text" placeholder="Name on the account" value={form.bankAccountName} onChange={set('bankAccountName')} className={fieldClass} />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest pl-1">Account Number</label>
              <div className="relative">
                <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"><CreditCard size={15} strokeWidth={1.75} /></div>
                <input type="text" inputMode="numeric" placeholder="Account number" value={form.bankAccountNumber} onChange={set('bankAccountNumber')} className={fieldClass} />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1">
              <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest pl-1">Mobile Money Provider</label>
              <div className="relative">
                <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"><Smartphone size={15} strokeWidth={1.75} /></div>
                <select
                  value={form.momoProvider}
                  onChange={(e) => setForm(p => ({ ...p, momoProvider: e.target.value }))}
                  className={fieldClass + ' appearance-none cursor-pointer'}
                >
                  <option value="">Select provider</option>
                  <option value="MTN">MTN MoMo</option>
                  <option value="Airtel">Airtel Money</option>
                </select>
                <div className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"><ChevronDown size={15} strokeWidth={1.75} /></div>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest pl-1">Mobile Money Number</label>
              <div className="relative">
                <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"><Phone size={15} strokeWidth={1.75} /></div>
                <input type="tel" inputMode="tel" placeholder="+256 700 000 000" value={form.momoNumber} onChange={set('momoNumber')} className={fieldClass} />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest pl-1">Registered Name</label>
              <div className="relative">
                <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"><User size={15} strokeWidth={1.75} /></div>
                <input type="text" placeholder="Name on the MoMo account" value={form.momoName} onChange={set('momoName')} className={fieldClass} />
              </div>
            </div>
          </>
        )}
      </motion.div>

      {/* Next of kin */}
      <motion.div variants={fadeUp} className="bg-card border border-border rounded-2xl p-4 space-y-3">
        <p className="text-[10px] font-black text-[#6c11d4] uppercase tracking-widest">Next of Kin</p>

        <div className="space-y-1">
          <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest pl-1">Next of Kin Name</label>
          <div className="relative">
            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"><Users size={15} strokeWidth={1.75} /></div>
            <input type="text" placeholder="Full name" value={form.kinName} onChange={set('kinName')} className={fieldClass} />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest pl-1">Next of Kin Contact</label>
          <div className="relative">
            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"><Phone size={15} strokeWidth={1.75} /></div>
            <input type="tel" placeholder="+256 700 000 000" value={form.kinContact} onChange={set('kinContact')} className={fieldClass} />
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Step 4 — Register ───────────────────────────────────────────────────────
function _Step3Impl({
  form, setForm, showPw, setShowPw, showConfirm, setShowConfirm,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  showPw: boolean;
  setShowPw: React.Dispatch<React.SetStateAction<boolean>>;
  showConfirm: boolean;
  setShowConfirm: React.Dispatch<React.SetStateAction<boolean>>;
}) {

  const strength = form.password.length > 0 ? getStrength(form.password) : null;
  const passwordsMatch = form.password === form.confirmPassword;

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-5">
      <motion.div
        variants={fadeUp}
        className="relative overflow-hidden rounded-2xl px-4 py-3"
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              'linear-gradient(rgba(108,17,212,0.18) 1px,transparent 1px),linear-gradient(90deg,rgba(108,17,212,0.18) 1px,transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        />
        <div className="relative z-10 flex items-center justify-between">
          <div>
            <p className="text-[9px] font-black text-[#6c11d4] uppercase tracking-[0.1em] mb-0.5">Secure Registration</p>
            <h2 className="text-lg font-black text-[#1C1C2E] tracking-tight leading-snug">
              Create Your<br />Funder Account
            </h2>
          </div>
          <div className="flex flex-col items-center gap-1">
            <div className="w-10 h-10 rounded-xl bg-[#6c11d4]/10 border border-[#6c11d4]/20 flex items-center justify-center">
              <Shield size={20} className="text-[#6c11d4]" strokeWidth={1.75} />
            </div>
            <span className="text-[9px] text-[#6c11d4] font-bold">256-BIT</span>
          </div>
        </div>
        <div className="relative z-10 flex items-center gap-2 mt-3">
          {[
            { icon: Lock, label: 'Encrypted' },
            { icon: Shield, label: 'KYC Ready' },
            { icon: BadgeCheck, label: 'Regulated' },
          ].map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-1 bg-[#6c11d4]/5 border border-[#6c11d4]/15 rounded-lg px-2 py-1">
              <Icon size={10} className="text-[#6c11d4]" strokeWidth={2} />
              <span className="text-[9px] font-bold text-[#6c11d4]">{label}</span>
            </div>
          ))}
        </div>
      </motion.div>

      <motion.div
        variants={fadeUp}
        className="bg-card border border-border rounded-2xl p-4 space-y-3"
      >
        <PersonNameFields
          idPrefix="funder-onboarding"
          value={{ firstName: form.firstName, otherNames: form.otherNames, lastName: form.lastName }}
          onChange={(next: PersonNameParts) =>
            setForm(p => ({ ...p, firstName: next.firstName, otherNames: next.otherNames, lastName: next.lastName }))
          }
        />

        <div className="space-y-1">
          <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest pl-1">Email</label>
          <div className="relative">
            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
              <Mail size={15} strokeWidth={1.75} />
            </div>
            <input
              type="email"
              placeholder="you@example.com"
              value={form.email}
              onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
              className="w-full bg-muted border border-border rounded-xl pl-9 pr-4 py-3 text-sm text-foreground placeholder:text-gray-300 outline-none focus:bg-card focus:border-[#6c11d4] focus:ring-2 focus:ring-[#6c11d4]/10 transition-all"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest pl-1">Phone</label>
          <div className="relative">
            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
              <Phone size={15} strokeWidth={1.75} />
            </div>
            <input
              type="tel"
              inputMode="tel"
              maxLength={20}
              placeholder="e.g. 0700 000 000 or +44 7700 900000"
              value={form.phone}
              onChange={e => setForm(p => ({ ...p, phone: e.target.value.replace(/[^\d+\s\-()]/g, '').slice(0, 20) }))}
              className="w-full bg-muted border border-border rounded-xl pl-9 pr-4 py-3 text-sm text-foreground placeholder:text-gray-300 outline-none focus:bg-card focus:border-[#6c11d4] focus:ring-2 focus:ring-[#6c11d4]/10 transition-all"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest pl-1">Address</label>
          <div className="relative">
            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
              <MapPin size={15} strokeWidth={1.75} />
            </div>
            <input
              type="text"
              placeholder="District, town or village"
              value={form.address}
              onChange={e => setForm(p => ({ ...p, address: e.target.value }))}
              className="w-full bg-muted border border-border rounded-xl pl-9 pr-4 py-3 text-sm text-foreground placeholder:text-gray-300 outline-none focus:bg-card focus:border-[#6c11d4] focus:ring-2 focus:ring-[#6c11d4]/10 transition-all"
            />
          </div>
        </div>

        {/* Official Uganda location (optional) — approved dataset, never typed. */}
        <UgLocationPicker
          value={form.ugLoc ?? null}
          onChange={(sel) => setForm(p => ({ ...p, ugLoc: sel }))}
          label="Official location (optional)"
        />

        <div className="space-y-1">
          <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest pl-1">National ID / Passport No.</label>
          <div className="relative">
            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
              <CreditCard size={15} strokeWidth={1.75} />
            </div>
            <input
              type="text"
              placeholder="e.g. CM900123456XYZ"
              value={form.nationalId}
              onChange={e => setForm(p => ({ ...p, nationalId: e.target.value.toUpperCase() }))}
              className="w-full bg-muted border border-border rounded-xl pl-9 pr-4 py-3 text-sm text-foreground placeholder:text-gray-300 outline-none focus:bg-card focus:border-[#6c11d4] focus:ring-2 focus:ring-[#6c11d4]/10 transition-all"
            />
          </div>
          <p className="text-[10px] text-muted-foreground pl-1">Required for your Welile Partnership Agreement.</p>
        </div>

        <div className="h-px bg-muted" />

        <div className="space-y-1">
          <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest pl-1">Password</label>
          <div className="relative">
            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
              <Lock size={15} strokeWidth={1.75} />
            </div>
            <input
              type={showPw ? 'text' : 'password'}
              placeholder="Min. 8 characters"
              value={form.password}
              onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
              className="w-full bg-muted border border-border rounded-xl pl-9 pr-11 py-3 text-sm text-foreground placeholder:text-gray-300 outline-none focus:bg-card focus:border-[#6c11d4] focus:ring-2 focus:ring-[#6c11d4]/10 transition-all"
            />
            <button type="button" onClick={() => setShowPw(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-muted-foreground transition-colors p-0.5"
            >
              {showPw ? <EyeOff size={15} strokeWidth={1.75} /> : <Eye size={15} strokeWidth={1.75} />}
            </button>
          </div>
          <AnimatePresence>
            {strength && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden px-1">
                <div className="flex gap-1 mt-1.5 mb-1">
                  {[0, 1, 2, 3].map(i => (
                    <motion.div key={i} className="flex-1 h-[3px] rounded-full"
                      animate={{ backgroundColor: i < strength.score ? strength.color : '#E5E7EB' }}
                      transition={{ duration: 0.3 }}
                    />
                  ))}
                </div>
                <p className="text-[10px] font-bold" style={{ color: strength.color }}>
                  {strength.label}
                  {strength.score < 4 && <span className="text-muted-foreground font-normal"> — use uppercase, numbers &amp; symbols</span>}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest pl-1">Confirm Password</label>
          <div className="relative">
            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
              <Lock size={15} strokeWidth={1.75} />
            </div>
            <input
              type={showConfirm ? 'text' : 'password'}
              placeholder="Re-enter password"
              value={form.confirmPassword}
              onChange={e => setForm(p => ({ ...p, confirmPassword: e.target.value }))}
              className={`w-full bg-muted border rounded-xl pl-9 pr-11 py-3 text-sm text-foreground placeholder:text-gray-300 outline-none focus:bg-card transition-all focus:ring-2 ${
                form.confirmPassword.length > 0
                  ? passwordsMatch
                    ? 'border-emerald-400 focus:border-emerald-400 focus:ring-emerald-100'
                    : 'border-red-400 focus:border-red-400 focus:ring-red-100'
                  : 'border-border focus:border-[#6c11d4] focus:ring-[#6c11d4]/10'
              }`}
            />
            <button type="button" onClick={() => setShowConfirm(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-muted-foreground transition-colors p-0.5"
            >
              {showConfirm ? <EyeOff size={15} strokeWidth={1.75} /> : <Eye size={15} strokeWidth={1.75} />}
            </button>
            {form.confirmPassword.length > 0 && (
              <div className={`absolute right-9 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full flex items-center justify-center ${
                passwordsMatch ? 'bg-emerald-500' : 'bg-red-400'
              }`}>
                {passwordsMatch
                  ? <Check size={9} className="text-white" strokeWidth={3} />
                  : <X size={9} className="text-white" strokeWidth={3} />
                }
              </div>
            )}
          </div>
          <AnimatePresence>
            {form.confirmPassword.length > 0 && !passwordsMatch && (
              <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-[10px] text-red-500 font-semibold mt-0.5 pl-1"
              >
                Passwords don't match
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      <motion.div variants={fadeUp}>
        <div className="rounded-xl border border-border bg-card p-3">
          <SignaturePad
            label="Sign your Partnership Agreement"
            onChange={(dataUrl) => setForm(p => ({ ...p, signatureDataUrl: dataUrl }))}
          />
          <p className="text-[10px] text-muted-foreground mt-1.5 pl-1">
            Your handwritten signature is attached to your Welile Partnership Agreement.
          </p>
        </div>
      </motion.div>

      <motion.div variants={fadeUp}>
        <button
          type="button"
          onClick={() => setForm(p => ({ ...p, agreedToTerms: !p.agreedToTerms }))}
          className="w-full flex items-start gap-3 cursor-pointer bg-muted border border-border rounded-xl p-3 text-left touch-manipulation active:bg-muted transition-colors"
          style={{ WebkitTapHighlightColor: 'transparent' }}
          aria-pressed={form.agreedToTerms}
        >
          <div
            className={`w-5 h-5 rounded-md border-2 shrink-0 mt-0.5 flex items-center justify-center transition-all ${
              form.agreedToTerms ? 'bg-[#6c11d4] border-[#6c11d4] scale-100' : 'border-border'
            }`}
          >
            {form.agreedToTerms && <Check size={11} className="text-white" strokeWidth={3} />}
          </div>
          <p className="text-[12px] text-muted-foreground leading-snug">
            I agree to Welile's{' '}
            <span className="text-[#6c11d4] font-semibold">Terms of Service</span>
            {' '}and{' '}
            <span className="text-[#6c11d4] font-semibold">Privacy Policy</span>.
            {' '}<span className="text-muted-foreground">Your data is encrypted and never Exchanged.</span>
          </p>
        </button>
      </motion.div>
    </motion.div>
  );
}

// ─── Step Validity ───────────────────────────────────────────────────────────
function isValid(step: number, form: FormState): boolean {
  if (step === 1) return form.understoodRole;
  if (step === 2) {
    if (form.investPath === null) return false;
    const amount = Number(form.supportAmount.replace(/,/g, '')) || 0;
    return amount >= MIN_SUPPORT;
  }
  if (step === 3) {
    let payoutOk = false;
    if (form.payoutMode === 'bank') {
      payoutOk =
        form.bankName.trim().length >= 2 &&
        form.bankAccountName.trim().length >= 2 &&
        form.bankAccountNumber.trim().length >= 4;
    } else {
      payoutOk =
        form.momoProvider.trim().length >= 2 &&
        form.momoNumber.trim().length >= 7 &&
        form.momoName.trim().length >= 2;
    }
    const kinNameOk = form.kinName.trim().length >= 2;
    const kinContactOk = form.kinContact.trim().length >= 7;
    return payoutOk && kinNameOk && kinContactOk;
  }
  if (step === 4) {
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email);
    const nameOk = validatePersonNameParts({
      firstName: form.firstName,
      otherNames: form.otherNames,
      lastName: form.lastName,
    }).valid;
    const pwOk = form.password.length >= 8;
    const matchOk = form.password === form.confirmPassword;
    const phoneOk = form.phone.trim().length >= 7;
    const addressOk = form.address.trim().length >= 2;
    const nationalIdOk = form.nationalId.trim().length >= 5;
    const signatureOk = form.signatureDataUrl.trim().length > 0;
    return emailOk && nameOk && pwOk && matchOk && phoneOk && addressOk && nationalIdOk && form.agreedToTerms && signatureOk;
  }
  return false;
}

function getValidationMessage(step: number, form: FormState): string {
  if (step === 1) {
    return 'Please tick the confirmation box to confirm you understand Welile manages tenants, collections, and payouts.';
  }

  if (step === 2) {
    if (form.investPath === null) return 'Please choose either “Support a Tenant” or “Grow Your Contribution”.';
    const amount = Number(form.supportAmount.replace(/,/g, '')) || 0;
    if (!form.supportAmount.trim()) return `Please enter the amount you are willing to support. Minimum amount is UGX ${MIN_SUPPORT.toLocaleString()}.`;
    if (amount < MIN_SUPPORT) return `The support amount must be at least UGX ${MIN_SUPPORT.toLocaleString()}.`;
  }

  if (step === 3) {
    const missing: string[] = [];
    if (form.payoutMode === 'bank') {
      if (form.bankName.trim().length < 2) missing.push('bank name');
      if (form.bankAccountName.trim().length < 2) missing.push('bank account name');
      if (form.bankAccountNumber.trim().length < 4) missing.push('bank account number');
    } else {
      if (form.momoProvider.trim().length < 2) missing.push('mobile money provider');
      if (form.momoNumber.trim().length < 7) missing.push('mobile money number');
      if (form.momoName.trim().length < 2) missing.push('mobile money account name');
    }
    if (form.kinName.trim().length < 2) missing.push('next of kin name');
    if (form.kinContact.trim().length < 7) missing.push('next of kin contact');
    return missing.length ? `Please complete: ${missing.join(', ')}.` : '';
  }

  if (step === 4) {
    const missing: string[] = [];
    const nameCheck = validatePersonNameParts({
      firstName: form.firstName,
      otherNames: form.otherNames,
      lastName: form.lastName,
    });
    if (!nameCheck.valid) missing.push(nameCheck.error ? nameCheck.error.toLowerCase() : 'your full name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) missing.push('a valid email address');
    if (form.phone.trim().length < 7) missing.push('phone number');
    if (form.address.trim().length < 2) missing.push('address');
    if (form.nationalId.trim().length < 5) missing.push('national ID/passport number');
    if (form.password.length < 8) missing.push('password of at least 8 characters');
    if (form.password !== form.confirmPassword) missing.push('matching password confirmation');
    if (!form.agreedToTerms) missing.push('agreement to the terms and privacy policy');
    if (form.signatureDataUrl.trim().length === 0) missing.push('your handwritten signature');
    return missing.length ? `Please complete: ${missing.join(', ')}.` : '';
  }

  return 'Please complete the required fields before continuing.';
}

function friendlySubmissionError(err: any): string {
  const raw = err?.response?.data?.detail || err?.response?.data?.message || err?.message || '';
  const msg = String(raw || '').trim();
  const lower = msg.toLowerCase();
  if (lower.includes('phone') && (lower.includes('already') || lower.includes('registered') || lower.includes('taken') || lower.includes('exists'))) {
    return 'This phone number is already registered. Please sign in instead, or use a different number.';
  }
  if (lower.includes('email') && (lower.includes('already') || lower.includes('registered') || lower.includes('taken') || lower.includes('exists'))) {
    return 'This email is already registered. Please sign in instead, or use a different email address.';
  }
  if (lower.includes('already registered') || lower.includes('already exists') || lower.includes('duplicate')) {
    return 'An account already exists with these details. Please sign in, or use a different email/phone number.';
  }
  if (lower.includes('invalid email') || (lower.includes('email') && lower.includes('invalid'))) return 'Please enter a valid email address.';
  if (lower.includes('invalid phone') || (lower.includes('phone') && lower.includes('invalid'))) return 'Please check your phone number — it should have at least 7 digits.';
  if (lower.includes('rate limit') || lower.includes('too many') || lower.includes('429')) {
    return 'Too many attempts. Please wait a minute and try again.';
  }
  if (lower.includes('weak password') || (lower.includes('password') && lower.includes('short')) || lower.includes('at least')) {
    return 'Your password is too weak. Use at least 8 characters with a mix of letters and numbers.';
  }
  if (lower.includes('password')) return 'The password could not be accepted. Use at least 8 characters and try again.';
  if (lower.includes('network') || lower.includes('failed to fetch') || lower.includes('timeout') || lower.includes('timed out')) {
    return 'Network error. Please check your internet connection and try again.';
  }
  if (lower.includes('sign-up is temporarily unavailable') || lower.includes('device or network')) return msg;
  if (lower.includes('database error') || lower.includes('unexpected_failure') || lower.includes('internal error')) {
    return 'Your account could not be saved because of a problem on our side. Your details are fine — please try again in a few minutes, or contact Welile support on WhatsApp if it keeps happening.';
  }
  return msg || 'We couldn’t create your account. Please review your details and try again.';
}

const STEP_LABELS = ['Welcome', 'Support', 'Bank & Next of Kin', 'Create Account'];

// ─── Main Component ──────────────────────────────────────────────────────────
export default function FunderOnboarding() {
  const navigate = useNavigate();
  const definedRole = useRouteRole();
  const { user, loading: authLoading } = useRealAuth();
  const [step, setStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [loadingTextIdx, setLoadingTextIdx] = useState(0);
  const loadingTexts = ["Creating Account...", "Securing Wallet...", "Getting you started...", "Just a moment..."];

  useEffect(() => {
    if (!isSubmitting) return;
    const interval = setInterval(() => {
      setLoadingTextIdx(p => (p + 1) % loadingTexts.length);
    }, 2000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSubmitting]);

  const [apiError, setApiError] = useState('');
  const TOTAL = 4;

  // Capture ?ref=<uuid> from the URL once on mount and persist it across the
  // email-confirmation round-trip via sessionStorage. The handle_new_user
  // trigger reads `referrer_id` from raw_user_meta_data at signup time.
  const [referrerId, setReferrerId] = useState<string>('');
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = (params.get('ref') || '').trim();
      const stored = sessionStorage.getItem('welile.funder.referrer_id') || '';
      const candidate = fromUrl || stored;
      // Strict RFC-4122 UUID v1–v8
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (candidate && UUID_RE.test(candidate)) {
        const normalized = candidate.toLowerCase();
        setReferrerId(normalized);
        sessionStorage.setItem('welile.funder.referrer_id', normalized);
      } else if (candidate) {
        // Tampered or stale ref — wipe so it doesn't poison later submissions.
        sessionStorage.removeItem('welile.funder.referrer_id');
      }
    } catch { /* non-fatal */ }
  }, []);


  const [form, setForm] = useState<FormState>({
    understoodRole: false,
    investPath: null,
    supportAmount: '',
    firstName: '',
    lastName: '',
    otherNames: '',
    email: '',
    password: '',
    confirmPassword: '',
    phone: '',
    address: '',
    ugLoc: null,
    nationalId: '',
    payoutMode: 'bank',
    momoProvider: '',
    momoNumber: '',
    momoName: '',
    bankName: '',
    bankAccountName: '',
    bankAccountNumber: '',
    kinName: '',
    kinContact: '',
    agreedToTerms: false,
    signatureDataUrl: '',
  });

  useEffect(() => {
    // Don't auto-redirect while showing the success modal — its own timer handles it.
    if (user && !showSuccess && !isSubmitting) navigate('/dashboard/funder');
  }, [user, navigate, showSuccess, isSubmitting]);

  const valid = isValid(step, form);

  // Surfaces inline validation feedback (e.g. red amount border) when the user
  // presses the action button before the current step is complete.
  const [showStepError, setShowStepError] = useState(false);
  useEffect(() => { setShowStepError(false); }, [step]);
  const stepErrorMessage = showStepError && !valid ? getValidationMessage(step, form) : '';

  // Guard: while auth is initialising, OR an authenticated user is being
  // redirected away, render a lightweight loader instead of the fixed
  // inset-0 wizard chrome. Without this, mobile browsers can show a brief
  // blank screen between auth resolution and the navigate() call, which
  // some users perceive as the page being "broken".
  if (authLoading || (user && !showSuccess && !isSubmitting)) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-[#FAFAFA] gap-3">
        <div className="w-6 h-6 border-2 border-[#6c11d4] border-t-transparent rounded-full animate-spin" />
        <p className="text-[12px] font-bold text-muted-foreground tracking-wide uppercase">
          {user ? 'Redirecting…' : 'Loading…'}
        </p>
      </div>
    );
  }

  const handleNext = async () => {
    if (!valid) {
      setShowStepError(true);
      toast.error(getValidationMessage(step, form));
      return;
    }
    if (step < TOTAL) {
      setStep(s => s + 1);
    } else {
      setIsSubmitting(true);
      setApiError('');
      try {
        const sanitizeInput = (val: string) => val.replace(/[<>]/g, '');
        const cleanEmail = sanitizeInput(form.email).trim().toLowerCase();
        const cleanFirst = sanitizeInput(form.firstName).trim();
        const cleanLast = sanitizeInput(form.lastName).trim();
        const cleanOther = sanitizeInput(form.otherNames).trim();
        const cleanFullName = joinPersonName({
          firstName: cleanFirst,
          otherNames: cleanOther,
          lastName: cleanLast,
        });
        const cleanPhone = sanitizeInput(form.phone).trim();
        const cleanAddress = sanitizeInput(form.address).trim();
        const cleanBankName = sanitizeInput(form.bankName).trim();
        const cleanBankAccountName = sanitizeInput(form.bankAccountName).trim();
        const cleanBankAccountNumber = sanitizeInput(form.bankAccountNumber).trim();
        const cleanMomoProvider = sanitizeInput(form.momoProvider).trim();
        const cleanMomoNumber = sanitizeInput(form.momoNumber).trim();
        const cleanMomoName = sanitizeInput(form.momoName).trim();
        const cleanKinName = sanitizeInput(form.kinName).trim();
        const cleanKinContact = sanitizeInput(form.kinContact).trim();
        const cleanNationalId = sanitizeInput(form.nationalId).trim().toUpperCase();

        const signupResult = await registerUser({
          email: cleanEmail,
          password: form.password,
          firstName: cleanFirst,
          lastName: cleanLast,
          otherNames: cleanOther,
          phone: cleanPhone,
          role: definedRole || 'FUNDER',
          referrerId: referrerId || undefined,
        });

        const newUserId = signupResult?.data?.userId ?? '';

        // Persist the funder's address + national ID on their profile (non-blocking).
        if (newUserId && (cleanAddress || cleanNationalId)) {
          const profilePatch: Record<string, string | number> = {};
          if (cleanAddress) profilePatch.landmark = cleanAddress;
          if (cleanNationalId) profilePatch.national_id = cleanNationalId;
          // Approved dataset wins for the administrative chain when picked.
          const ugLoc = form.ugLoc;
          if (ugLoc) {
            profilePatch.country = 'Uganda';
            profilePatch.region = ugLoc.region ?? '';
            profilePatch.district = ugLoc.district;
            profilePatch.sub_county = ugLoc.subcounty;
            profilePatch.parish = ugLoc.parish;
            profilePatch.village = ugLoc.village;
            profilePatch.ug_village_id = ugLoc.villageId;
          }
          supabase
            .from('profiles')
            .update(profilePatch)
            .eq('id', newUserId)
            .then(({ error }) => {
              if (error) console.warn('profile save failed (non-blocking):', error);
            });
        }
        // Persist the funder's payout method (bank or mobile money) — non-blocking.
        if (newUserId) {
          const payoutRow =
            form.payoutMode === 'bank'
              ? (cleanBankName && cleanBankAccountNumber
                  ? {
                      user_id: newUserId,
                      payout_mode: 'bank',
                      nickname: cleanBankName,
                      bank_name: cleanBankName,
                      bank_account_name: cleanBankAccountName,
                      bank_account_number: cleanBankAccountNumber,
                      is_default: true,
                    }
                  : null)
              : (cleanMomoProvider && cleanMomoNumber
                  ? {
                      user_id: newUserId,
                      payout_mode: 'momo',
                      nickname: `${cleanMomoProvider} ${cleanMomoNumber}`.trim(),
                      momo_provider: cleanMomoProvider,
                      momo_number: cleanMomoNumber,
                      momo_name: cleanMomoName,
                      is_default: true,
                    }
                  : null);
          if (payoutRow) {
            supabase
              .from('saved_payout_methods')
              .insert(payoutRow)
              .then(({ error }) => {
                if (error) console.warn('payout method save failed (non-blocking):', error);
              });
          }
        }
        const partnerReference = buildPartnerReference(newUserId, new Date());
        // Persist every contract field the partner typed into the single
        // source-of-truth `partner_agreements` row, then ask the server-side
        // renderer to generate the draft PDF + email a download link. The row
        // upsert AND the edge-function invocation are AWAITED — earlier this
        // ran as a fire-and-forget IIFE, and any failure (client PDF render,
        // slow session hydrate, tab navigation) silently dropped the contract
        // email. See josephrp06@gmail.com incident 2026-07-23.
        const supportAmountNum = Number(form.supportAmount.replace(/,/g, '')) || 0;
        if (newUserId) {
          try {
            const { error: agErr } = await supabase
                .from('partner_agreements')
                .upsert({
                  partner_id: newUserId,
                  full_name: cleanFullName,
                  phone: cleanPhone,
                  email: cleanEmail,
                  national_id: cleanNationalId,
                  address: cleanAddress,
                  partnership_amount: supportAmountNum,
                  partnership_amount_words: numberToWords(supportAmountNum),
                  payout_mode: form.payoutMode === 'momo' ? 'momo' : 'bank',
                  bank_name: cleanBankName || null,
                  bank_account_name: cleanBankAccountName || null,
                  bank_account_number: cleanBankAccountNumber || null,
                  momo_provider: cleanMomoProvider || null,
                  momo_number: cleanMomoNumber || null,
                  momo_name: cleanMomoName || null,
                  kin_name: cleanKinName || null,
                  kin_contact: cleanKinContact || null,
                  reference: partnerReference,
                  status: 'pending',
                  // Persist the partner's handwritten signature so the executed /
                  // countersigned agreement (rebuilt from this row by the admin)
                  // renders the real signature instead of the italic typed name.
                  partner_signature_data_url: form.signatureDataUrl || null,
                }, { onConflict: 'partner_id' });
            if (agErr) {
              console.warn('partner agreement save failed:', agErr);
            }
            // Try to render the PDF client-side; if it fails, we STILL invoke
            // the edge function so the confirmation email always fires. The
            // partner can download the stored PDF from their dashboard later.
            let pdfBase64: string | null = null;
            try {
              // Hard 20s ceiling: a hung/slow client render must never stop the
              // contract email from going out.
              pdfBase64 = await Promise.race<string | null>([
                renderAgreementPdfBase64(
                buildAgreementHtml({
                  partnerName: cleanFullName,
                  partnerId: cleanNationalId,
                  partnerAddress: cleanAddress,
                  partnerPhone: cleanPhone,
                  partnerEmail: cleanEmail,
                  partnershipAmount: supportAmountNum,
                  payoutMode: form.payoutMode === 'momo' ? 'momo' : 'bank',
                  bankName: cleanBankName || undefined,
                  bankAccountName: cleanBankAccountName || undefined,
                  bankAccountNumber: cleanBankAccountNumber || undefined,
                  momoProvider: cleanMomoProvider || undefined,
                  momoNumber: cleanMomoNumber || undefined,
                  momoName: cleanMomoName || undefined,
                  kinName: cleanKinName || undefined,
                  kinContact: cleanKinContact || undefined,
                  agreementDate: new Date(),
                  includeStamp: false,
                  partnerSignatureDataUrl: form.signatureDataUrl || undefined,
                }),
                ),
                new Promise<null>(resolve => setTimeout(() => resolve(null), 20000)),
              ]);
            } catch (e) {
              console.warn('partnership PDF render failed — email will still be sent:', e);
            }
            // sendEmail:false — signup confirmation is the
            // `partner-account-created` template fired server-side by
            // create-funder-onboarding-account. The
            // `tenant-partnership-agreement` email must NOT go out here.
            try {
              await supabase.functions.invoke('generate-partner-agreement', {
                body: { partnerId: newUserId, countersign: false, pdfBase64: pdfBase64 || null, sendEmail: false },
              });
            } catch (e) {
              console.warn('generate-partner-agreement invoke failed:', e);
              // One retry without the PDF — the confirmation email matters more
              // than the attachment link, which the partner can also download
              // from their dashboard.
              try {
                await supabase.functions.invoke('generate-partner-agreement', {
                  body: { partnerId: newUserId, countersign: false, pdfBase64: null, sendEmail: false },
                });
              } catch (e2) {
                console.warn('generate-partner-agreement retry failed:', e2);
              }
            }
          } catch (e) {
            console.warn('partnership agreement pipeline failed:', e);
          }
        }

        // Flip into the success modal and auto-redirect after 3 seconds.
        setIsSubmitting(false);
        setShowSuccess(true);
        setTimeout(() => {
          navigate('/dashboard/funder');
        }, 3000);
      } catch (err: any) {
        console.error('Signup failed:', err);
        const friendly = friendlySubmissionError(err);
        setApiError(friendly);
        toast.error(friendly);
        setIsSubmitting(false);
      }
    }
  };

  const handleBack = () => {
    if (step > 1) setStep(s => s - 1);
    else navigate('/');
  };

  const stepComponents: Record<number, React.ReactNode> = {
    1: <Step1 form={form} setForm={setForm} />,
    2: <Step2 form={form} setForm={setForm} showError={showStepError} />,
    3: <StepBankKin form={form} setForm={setForm} />,
    4: <Step3 form={form} setForm={setForm} />,
  };

  return (
    <div className="fixed inset-0 flex font-sans overflow-hidden bg-[#0E0820]">
      <Toaster position="top-center" />
      <Helmet>
        <title>Become a Welile Funder — Fund the Future of Housing</title>
        <meta name="description" content="Empower verified tenants and grow your active capital with steady, managed returns. Start funding from as little as UGX 50,000." />
        <link rel="canonical" href="https://welileapp.com/funder-onboarding" />
        <meta property="og:title" content="Become a Welile Funder — Fund the Future of Housing" />
        <meta property="og:description" content="Empower verified tenants and grow your active capital with steady, managed returns. Start funding from as little as UGX 50,000." />
        <meta property="og:url" content="https://welileapp.com/funder-onboarding" />
      </Helmet>

      {/* LEFT COLUMN (HERO IMAGE) */}
      <div className="hidden lg:flex lg:w-1/2 lg:shrink-0 h-full relative bg-slate-900 overflow-hidden items-center justify-center">
        <div className="absolute inset-0 bg-black/30 z-10 mix-blend-multiply" />
        <img
          src="/agent-hero.jpeg"
          alt="Funder Onboarding Background"
          className="absolute inset-0 w-full h-full object-cover z-0"
        />
        <div className="relative z-20 p-12 flex flex-col items-center justify-center h-full text-center text-white">
          <img src="/welile-colored.png" alt="Welile Logo" className="h-20 w-auto mb-8 drop-shadow-md" />
          <h2 className="text-4xl lg:text-5xl font-black mb-4 tracking-tight drop-shadow-xl leading-tight">Fund The Future<br />Of Housing</h2>
          <p className="text-lg text-white/90 font-medium max-w-md drop-shadow-md">Empower verified tenants and grow your active capital with steady, managed returns.</p>
        </div>
      </div>

      {/* RIGHT COLUMN (WIZARD) */}
      <div className="relative w-full lg:w-1/2 lg:shrink-0 flex flex-col h-full overflow-hidden shadow-2xl z-20 bg-card">
        {/* Ambient grid only (gradient & color blobs removed per request) */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div
            className="absolute inset-0 opacity-[0.03]"
            style={{
              backgroundImage:
                'linear-gradient(#6c11d4 1px,transparent 1px),linear-gradient(90deg,#6c11d4 1px,transparent 1px)',
              backgroundSize: '32px 32px',
            }}
          />
        </div>
        <div className="relative z-10 flex flex-col h-full overflow-hidden">
        <div className="bg-white/90 backdrop-blur-sm border-b border-border shrink-0 sticky top-0 z-20">
          <div className="flex items-center justify-center pt-5 pb-2">
            <StepDots total={TOTAL} current={step} />
          </div>
          <div className="px-6 lg:px-[18px] pb-3 flex items-center justify-between">
            <button
              onClick={handleBack}
              className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:bg-muted transition"
            >
              <ArrowLeft size={16} />
            </button>
            <p className="text-[11px] font-black text-foreground tracking-widest uppercase">
              {STEP_LABELS[step - 1]}
            </p>
            <div className="w-8" />
          </div>
          {referrerId && (
            <div className="px-6 lg:px-[18px] pb-2 flex justify-center">
              <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[#6c11d4] bg-[#F3F0FF] border border-[#E0D2FA] rounded-full px-2.5 py-1">
                <BadgeCheck size={11} strokeWidth={2.5} />
                Referred signup
              </span>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-8 lg:px-[18px]">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              className="max-w-md mx-auto w-full"
            >
              {stepComponents[step]}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="px-6 pb-5 pt-3 bg-card border-t border-border shrink-0 lg:px-[18px]">
          <div className="max-w-md mx-auto w-full">
            {stepErrorMessage && (
              <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2 animate-in fade-in slide-in-from-top-1">
                <X size={16} strokeWidth={3} className="text-amber-600 mt-0.5 shrink-0" />
                <p className="text-[13px] text-amber-800 font-semibold leading-relaxed">
                  {stepErrorMessage}
                </p>
              </div>
            )}
            {step === TOTAL && apiError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-100 rounded-xl flex items-start gap-2 animate-in fade-in slide-in-from-top-1">
                <X size={16} strokeWidth={3} className="text-red-500 mt-0.5 shrink-0" />
                <p className="text-[13px] text-red-600 font-semibold leading-relaxed">
                  {apiError}
                </p>
              </div>
            )}
            <motion.button
              onClick={isSubmitting ? undefined : handleNext}
              disabled={isSubmitting}
              whileTap={valid && !isSubmitting ? { scale: 0.98 } : {}}
              animate={{ opacity: valid ? 1 : 0.55 }}
              transition={{ duration: 0.2 }}
              className={`w-full py-3 rounded-xl font-bold text-[14px] flex items-center justify-center gap-2 transition-all duration-200 ${
                !valid
                  ? 'bg-gray-200 text-muted-foreground'
                  : step === TOTAL
                    ? isSubmitting
                      ? 'bg-emerald-400 text-white cursor-not-allowed'
                      : 'bg-[#6c11d4] text-white shadow-sm hover:opacity-90'
                    : 'bg-[#6c11d4] text-white shadow-sm hover:bg-[#7B2AC5]'
              }`}
            >
              {!valid ? (
                <>
                  <Lock size={16} strokeWidth={2} />
                  {step === 1 && 'Confirm above to continue'}
                  {step === 2 && 'Choose a contribution style'}
                  {step === 3 && 'Fill in bank & next of kin details'}
                  {step === 4 && 'Fill in all fields to continue'}
                </>
              ) : step === TOTAL ? (
                isSubmitting ? (
                  <div className="flex items-center gap-2 overflow-hidden h-6 w-full justify-center">
                    <svg className="animate-spin h-[18px] w-[18px] text-white shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                    <AnimatePresence mode="wait">
                      <motion.span
                        key={loadingTextIdx}
                        initial={{ y: 20, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: -20, opacity: 0 }}
                        transition={{ duration: 0.3 }}
                        className="whitespace-nowrap"
                      >
                        {loadingTexts[loadingTextIdx]}
                      </motion.span>
                    </AnimatePresence>
                  </div>
                ) : (
                  <>Create Account <Check size={18} strokeWidth={2.5} /></>
                )
              ) : (
                <>Continue <ChevronRight size={18} strokeWidth={2.5} /></>
              )}
            </motion.button>

            <p className="text-center text-[10px] font-bold text-muted-foreground tracking-wider uppercase mt-2">
              Step {step} / {TOTAL}
            </p>
          </div>
        </div>
        </div>
      </div>

      {/* Success Modal — shown for 3s after account creation, then auto-redirects. */}
      <AnimatePresence>
        {showSuccess && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm px-6"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ type: 'spring', damping: 22, stiffness: 240 }}
              className="relative w-full max-w-sm bg-card rounded-2xl shadow-2xl p-8 text-center"
              role="dialog"
              aria-live="polite"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.1, type: 'spring', damping: 14, stiffness: 220 }}
                className="mx-auto w-20 h-20 rounded-full bg-emerald-50 flex items-center justify-center mb-5"
              >
                <div className="w-16 h-16 rounded-full bg-emerald-500 flex items-center justify-center shadow-lg shadow-emerald-500/30">
                  <Check size={36} strokeWidth={3.5} className="text-white" />
                </div>
              </motion.div>

              <h2 className="text-xl font-black text-foreground mb-2 tracking-tight">
                Account created successfully
              </h2>
              <p className="text-[14px] text-muted-foreground leading-relaxed mb-5">
                Please check your email to activate your account.
              </p>

              <div className="flex items-center justify-center gap-2 text-[12px] font-bold text-muted-foreground tracking-wider uppercase">
                <svg className="animate-spin h-3.5 w-3.5 text-[#6c11d4]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Redirecting to your dashboard…
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
