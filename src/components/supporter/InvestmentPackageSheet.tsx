import { useState, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import {
  Users, Home, TrendingUp, Calendar, Shield,
  Download, Share2, CheckCircle2, Loader2, CreditCard,
  Wallet, BarChart3, Clock, Lock, ArrowRight, Percent
} from 'lucide-react';
import { useCurrency } from '@/hooks/useCurrency';
import welileLogo from '@/assets/welile-logo-small.png';
import { motion, AnimatePresence } from 'framer-motion';
import { hapticTap } from '@/lib/haptics';
import { format, addMonths } from 'date-fns';
// jsPDF loaded dynamically when needed

interface InvestmentPackageSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category: {
    category: string;
    totalHouses: number;
    totalRent: number;
    avgRent: number;
    expectedReturn: number;
  } | null;
  onAcceptAndDeposit: () => void;
}

type SheetStep = 'summary' | 'accepted' | 'deposit';

const REWARD_RATE = 0.15; // 15% monthly supporter reward

export function InvestmentPackageSheet({ open, onOpenChange, category, onAcceptAndDeposit }: InvestmentPackageSheetProps) {
  const { formatAmount } = useCurrency();
  const [step, setStep] = useState<SheetStep>('summary');
  const [autoCompound, setAutoCompound] = useState(false);
  const [generating, setGenerating] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  if (!category) return null;

  const rentAmount = category.avgRent || category.totalRent;
  const monthlyReward = Math.round(rentAmount * REWARD_RATE);
  const estimatedLandlords = Math.max(1, Math.ceil(category.totalHouses * 0.7));

  // 12-month reward schedule with tenant growth
  const rewardSchedule = Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    const date = addMonths(new Date(), month);
    let payout: number;
    let tenantsSupported: number;
    if (autoCompound) {
      const compoundedCapital = rentAmount * Math.pow(1 + REWARD_RATE, month);
      payout = Math.round(rentAmount * (Math.pow(1 + REWARD_RATE, month) - Math.pow(1 + REWARD_RATE, month - 1)));
      tenantsSupported = Math.max(category.totalHouses, Math.round(category.totalHouses * (compoundedCapital / rentAmount)));
    } else {
      payout = monthlyReward;
      tenantsSupported = category.totalHouses;
    }
    return { month, date, payout, tenantsSupported };
  });

  const totalRewards12Months = rewardSchedule.reduce((s, r) => s + r.payout, 0);
  const totalWithCapital = rentAmount + totalRewards12Months;

  const handleAccept = () => {
    hapticTap();
    setStep('accepted');
    setTimeout(() => setStep('deposit'), 1800);
  };

  const handleReset = () => {
    setStep('summary');
    setAutoCompound(false);
  };

  const handleClose = (val: boolean) => {
    if (!val) handleReset();
    onOpenChange(val);
  };

  const loadLogoAsBase64 = (): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject('No canvas context');
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = welileLogo;
    });
  };

  const buildPDF = async () => {
    const { default: jsPDF } = await import('jspdf');
    const doc = new jsPDF();
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const m = 18;
    let y = 0;

    // Brand colors
    const purple = { r: 124, g: 58, b: 237 };
    const darkPurple = { r: 91, g: 33, b: 182 };
    const lightPurple = { r: 245, g: 243, b: 255 };
    const white = { r: 255, g: 255, b: 255 };
    const darkText = { r: 30, g: 30, b: 30 };
    const mutedText = { r: 100, g: 100, b: 100 };
    const green = { r: 22, g: 163, b: 74 };

    // ── HEADER BAR ──
    doc.setFillColor(purple.r, purple.g, purple.b);
    doc.rect(0, 0, pw, 50, 'F');

    // Add actual logo image
    try {
      const logoBase64 = await loadLogoAsBase64();
      doc.addImage(logoBase64, 'PNG', m, 8, 14, 14);
    } catch (e) {
      console.warn('Could not load logo for PDF', e);
    }

    const logoTextX = m + 18;
    doc.setTextColor(white.r, white.g, white.b);
    doc.setFontSize(22);
    doc.setFont('helvetica', 'bold');
    doc.text('Welile.com', logoTextX, 19);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'normal');
    doc.text('SUPPORTER PACKAGE', logoTextX, 32);
    doc.setFontSize(11);
    doc.text(category.category, logoTextX, 43);
    doc.setFontSize(9);
    doc.text(format(new Date(), 'MMMM d, yyyy'), pw - m - 40, 43);

    y = 60;

    // ── HERO STATS ──
    doc.setFillColor(lightPurple.r, lightPurple.g, lightPurple.b);
    doc.roundedRect(m, y, pw - m * 2, 50, 4, 4, 'F');
    doc.setDrawColor(purple.r, purple.g, purple.b);
    doc.setLineWidth(0.5);
    doc.roundedRect(m, y, pw - m * 2, 50, 4, 4, 'S');

    const col1 = m + 8;
    const col2 = pw / 2 + 5;

    doc.setTextColor(mutedText.r, mutedText.g, mutedText.b);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text('FACILITATION AMOUNT', col1, y + 12);
    doc.setTextColor(darkPurple.r, darkPurple.g, darkPurple.b);
    doc.setFontSize(22);
    doc.setFont('helvetica', 'bold');
    doc.text(formatAmount(rentAmount), col1, y + 25);

    doc.setTextColor(mutedText.r, mutedText.g, mutedText.b);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text('MONTHLY REWARD (15%)', col2, y + 12);
    doc.setTextColor(green.r, green.g, green.b);
    doc.setFontSize(22);
    doc.setFont('helvetica', 'bold');
    doc.text(formatAmount(monthlyReward), col2, y + 25);

    doc.setFontSize(11);
    doc.setTextColor(darkText.r, darkText.g, darkText.b);
    doc.setFont('helvetica', 'normal');
    doc.text(`Tenants: ${category.totalHouses}`, col1, y + 40);
    doc.text(`Landlords: ~${estimatedLandlords}`, col2, y + 40);
    doc.text(`Auto-Compound: ${autoCompound ? 'YES' : 'NO'}`, col1, y + 47);
    doc.text(`Capital Lock: 90 days`, col2, y + 47);

    y += 60;

    // ── 12-MONTH REWARD TABLE ──
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(purple.r, purple.g, purple.b);
    doc.text('12-MONTH REWARD SCHEDULE', m, y);
    y += 6;

    doc.setFillColor(purple.r, purple.g, purple.b);
    doc.rect(m, y, pw - m * 2, 9, 'F');
    doc.setTextColor(white.r, white.g, white.b);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text('MONTH', m + 4, y + 6.5);
    doc.text('DATE', m + 35, y + 6.5);
    if (autoCompound) doc.text('TENANTS', m + 75, y + 6.5);
    doc.text('REWARD', m + (autoCompound ? 105 : 90), y + 6.5);
    doc.text('TOTAL', m + 135, y + 6.5);
    y += 9;

    doc.setFont('helvetica', 'normal');
    let cumulative = 0;
    rewardSchedule.forEach((r, i) => {
      cumulative += r.payout;
      if (i % 2 === 0) {
        doc.setFillColor(lightPurple.r, lightPurple.g, lightPurple.b);
        doc.rect(m, y, pw - m * 2, 8, 'F');
      }
      doc.setFontSize(10);
      doc.setTextColor(darkText.r, darkText.g, darkText.b);
      doc.text(`Month ${r.month}`, m + 4, y + 6);
      doc.text(format(r.date, 'MMM d, yyyy'), m + 35, y + 6);
      if (autoCompound) {
        doc.setTextColor(purple.r, purple.g, purple.b);
        doc.setFont('helvetica', 'bold');
        doc.text(`${r.tenantsSupported}`, m + 75, y + 6);
      }
      doc.setTextColor(green.r, green.g, green.b);
      doc.setFont('helvetica', 'bold');
      doc.text(`+${formatAmount(r.payout)}`, m + (autoCompound ? 105 : 90), y + 6);
      doc.setTextColor(darkText.r, darkText.g, darkText.b);
      doc.setFont('helvetica', 'normal');
      doc.text(formatAmount(cumulative), m + 135, y + 6);
      y += 8;
    });

    y += 2;
    doc.setFillColor(purple.r, purple.g, purple.b);
    doc.roundedRect(m, y, pw - m * 2, 14, 3, 3, 'F');
    doc.setTextColor(white.r, white.g, white.b);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text(`Total Rewards: ${formatAmount(totalRewards12Months)}`, m + 6, y + 6);
    doc.text(`Capital + Rewards: ${formatAmount(totalWithCapital)}`, m + 6, y + 12);

    y += 22;

    // ── 90-DAY LOCK POLICY ──
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(purple.r, purple.g, purple.b);
    doc.text('90-DAY CAPITAL LOCK POLICY', m, y);
    y += 5;
    doc.setFillColor(lightPurple.r, lightPurple.g, lightPurple.b);
    doc.roundedRect(m, y, pw - m * 2, 28, 3, 3, 'F');
    doc.setDrawColor(purple.r, purple.g, purple.b);
    doc.roundedRect(m, y, pw - m * 2, 28, 3, 3, 'S');
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(darkText.r, darkText.g, darkText.b);
    doc.text('• Capital is locked for 90 days — Welile pays rent upfront for tenants.', m + 6, y + 8);
    doc.text('• Capital is NOT accessible during the 90-day lock period.', m + 6, y + 16);
    doc.text('• Reward payouts continue monthly throughout the lock-in period.', m + 6, y + 24);

    // ── FOOTER ──
    y = ph - 18;
    doc.setDrawColor(purple.r, purple.g, purple.b);
    doc.setLineWidth(0.3);
    doc.line(m, y, pw - m, y);
    doc.setFontSize(8);
    doc.setTextColor(mutedText.r, mutedText.g, mutedText.b);
    doc.text('Rewards guaranteed by Welile operational assurance. Welile Supporters Program.', m, y + 5);
    doc.setTextColor(purple.r, purple.g, purple.b);
    doc.text(`Ref: WS-${Date.now().toString(36).toUpperCase()}`, pw - m - 40, y + 5);

    return doc;
  };

  const generatePDF = async () => {
    setGenerating(true);
    try {
      const doc = await buildPDF();
      doc.save(`welile-package-${category.category.replace(/\s+/g, '-').toLowerCase()}-${format(new Date(), 'yyyy-MM-dd')}.pdf`);
      toast.success('Package PDF downloaded!');
    } catch (err) {
      console.error('PDF generation failed:', err);
      toast.error('Failed to generate PDF');
    } finally {
      setGenerating(false);
    }
  };

  const handleShareWhatsApp = async () => {
    setGenerating(true);
    try {
      const doc = await buildPDF();
      const pdfBlob = doc.output('blob');
      const fileName = `welile-package-${category.category.replace(/\s+/g, '-').toLowerCase()}-${format(new Date(), 'yyyy-MM-dd')}.pdf`;
      const file = new File([pdfBlob], fileName, { type: 'application/pdf' });

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: `Welile Supporter Package — ${category.category}`,
        });
      } else {
        // Fallback: download the PDF and open WhatsApp with a message
        doc.save(fileName);
        const text = `📊 Welile Supporter Package — ${category.category}\n\nPlease see the attached PDF for full details.\n\n✅ 15% Monthly Reward | 90-day lock-in\n\nJoin Welile Supporters today!`;
        window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
        toast.success('PDF downloaded — attach it in WhatsApp');
      }
    } catch (err) {
      console.error('Share failed:', err);
      toast.error('Failed to share PDF');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md max-h-[92vh] overflow-y-auto p-0">
        <AnimatePresence mode="wait">
          {step === 'accepted' && (
            <motion.div
              key="accepted"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center py-20 px-6 text-center"
            >
              <div className="w-20 h-20 rounded-full bg-success/10 flex items-center justify-center mb-4">
                <CheckCircle2 className="h-10 w-10 text-success" />
              </div>
              <h2 className="text-xl font-bold text-foreground mb-2">Package Accepted!</h2>
              <p className="text-sm text-muted-foreground">Preparing deposit instructions...</p>
            </motion.div>
          )}

          {step === 'deposit' && (
            <motion.div
              key="deposit"
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              className="p-5 space-y-5"
            >
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-lg">
                  <Wallet className="h-5 w-5 text-primary" />
                  Deposit Instructions
                </DialogTitle>
              </DialogHeader>

              <div className="p-4 rounded-2xl bg-primary/5 border border-primary/20 space-y-3">
                <p className="text-sm font-semibold text-foreground">To complete your investment:</p>
                <ol className="text-sm text-muted-foreground space-y-2.5 list-decimal list-inside">
                  <li>Deposit <span className="font-bold text-foreground">{formatAmount(rentAmount)}</span> via Mobile Money</li>
                  <li>Use your registered phone number</li>
                  <li>Submit the deposit below</li>
                  <li>A manager will verify &amp; approve your portfolio within 24hrs</li>
                </ol>
              </div>

              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-2.5">
                <Clock className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-xs text-amber-700">
                  After submitting, a Welile manager will verify your deposit and approve your portfolio. 
                  You'll receive a notification once approved.
                </p>
              </div>

              <Button
                onClick={() => {
                  hapticTap();
                  handleClose(false);
                  onAcceptAndDeposit();
                }}
                className="w-full h-12 rounded-2xl gap-2 text-sm font-bold"
              >
                <CreditCard className="h-5 w-5" />
                Submit Deposit Now
                <ArrowRight className="h-4 w-4" />
              </Button>

              <p className="text-[10px] text-center text-muted-foreground">
                Your investment is protected by Welile's supporter agreement
              </p>
            </motion.div>
          )}

          {step === 'summary' && (
            <motion.div
              key="summary"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              ref={contentRef}
            >
              {/* Hero Header */}
              <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white p-5 pb-6 rounded-t-lg">
                <DialogHeader>
                  <div className="flex items-center justify-between mb-1">
                    <img src={welileLogo} alt="Welile" className="h-7 w-auto" />
                    <Badge className="bg-white/10 text-white/80 border-white/20 text-[10px]">Supporter Package</Badge>
                  </div>
                  <DialogTitle className="text-white text-lg font-bold flex items-center gap-2">
                    <BarChart3 className="h-5 w-5" />
                    {category.category}
                  </DialogTitle>
                </DialogHeader>
                <p className="text-muted-foreground text-xs mt-0.5">Welile Supporters Program</p>
                <div className="mt-4 flex items-end justify-between">
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Facilitation Amount</p>
                    <p className="text-2xl font-black mt-0.5">{formatAmount(rentAmount)}</p>
                  </div>
                  <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30 text-xs">
                    15% Monthly Reward
                  </Badge>
                </div>
              </div>

              <div className="p-5 space-y-5">
                {/* Key Metrics */}
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="p-3 rounded-xl bg-muted/50 border border-border/40">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Users className="h-3.5 w-3.5 text-primary" />
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Tenants</span>
                    </div>
                    <p className="text-lg font-bold text-foreground">{category.totalHouses}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-muted/50 border border-border/40">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Home className="h-3.5 w-3.5 text-primary" />
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Landlords</span>
                    </div>
                    <p className="text-lg font-bold text-foreground">~{estimatedLandlords}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-success/5 border border-success/20">
                    <div className="flex items-center gap-1.5 mb-1">
                      <TrendingUp className="h-3.5 w-3.5 text-success" />
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Monthly Reward</span>
                    </div>
                    <p className="text-lg font-bold text-success">{formatAmount(monthlyReward)}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-primary/5 border border-primary/20">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Calendar className="h-3.5 w-3.5 text-primary" />
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">12-Mo Rewards</span>
                    </div>
                    <p className="text-lg font-bold text-primary">{formatAmount(totalRewards12Months)}</p>
                  </div>
                </div>

                {/* Auto-Compounding Toggle */}
                {/* How It Works — Operational Assurance */}
                <div className="p-3.5 rounded-xl bg-primary/5 border border-primary/20">
                  <div className="flex items-center gap-2 mb-2.5">
                    <Shield className="h-4 w-4 text-primary" />
                    <span className="text-xs font-bold text-foreground">How Welile Guarantees Your Rewards</span>
                  </div>
                  <ul className="text-[11px] text-muted-foreground space-y-2 pl-1">
                    <li className="flex gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" /><span>Welile pays rent <strong className="text-foreground">upfront</strong> for tenants — never in arrears. Your funds are deployed immediately.</span></li>
                    <li className="flex gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" /><span>Welile Agents hold <strong className="text-foreground">tenant placement rights</strong> — if a tenant defaults, the agent replaces them with a paying tenant.</span></li>
                    <li className="flex gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" /><span>Defaults <strong className="text-foreground">do not affect supporters</strong>. Welile's operational model absorbs and mitigates all default risk.</span></li>
                    <li className="flex gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" /><span>Your <strong className="text-foreground">15% monthly reward</strong> is a platform service reward — not an investment return.</span></li>
                  </ul>
                </div>

                {/* Auto-Compound Toggle */}
                <div className="flex items-center justify-between p-3.5 rounded-xl bg-card border border-border/60">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                      <Percent className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">Auto-Compound Rewards</p>
                      <p className="text-[10px] text-muted-foreground">Reinvest rewards — tenants supported grow each month</p>
                    </div>
                  </div>
                  <Switch checked={autoCompound} onCheckedChange={setAutoCompound} />
                </div>

                {autoCompound && (
                  <div className="p-3 rounded-xl bg-primary/5 border border-primary/20 flex items-start gap-2">
                    <TrendingUp className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                    <p className="text-[11px] text-muted-foreground">
                      With compounding, your rewards are reinvested — growing your facilitation capital and <strong className="text-foreground">increasing the number of tenants you support</strong> each month.
                    </p>
                  </div>
                )}

                {/* 12-Month Reward Schedule */}
                <div>
                  <h4 className="text-xs font-bold text-foreground mb-2.5 flex items-center gap-1.5">
                    <Calendar className="h-3.5 w-3.5 text-primary" />
                    12-Month Reward Schedule
                  </h4>
                  <div className="rounded-xl border border-border/60 overflow-hidden">
                    {/* Table header */}
                    <div className={`grid ${autoCompound ? 'grid-cols-4' : 'grid-cols-3'} gap-0 bg-muted/80 px-3 py-2`}>
                      <span className="text-[10px] font-bold text-muted-foreground uppercase">Month</span>
                      <span className="text-[10px] font-bold text-muted-foreground uppercase">Date</span>
                      {autoCompound && <span className="text-[10px] font-bold text-muted-foreground uppercase text-center">Tenants</span>}
                      <span className="text-[10px] font-bold text-muted-foreground uppercase text-right">Reward</span>
                    </div>
                    {/* Table rows */}
                    <div className="max-h-[200px] overflow-y-auto">
                      {rewardSchedule.map((r, i) => (
                        <div
                          key={r.month}
                          className={`grid ${autoCompound ? 'grid-cols-4' : 'grid-cols-3'} gap-0 px-3 py-2 ${i % 2 === 0 ? 'bg-background' : 'bg-muted/30'}`}
                        >
                          <span className="text-xs text-foreground font-medium">Month {r.month}</span>
                          <span className="text-xs text-muted-foreground">{format(r.date, 'MMM yyyy')}</span>
                          {autoCompound && <span className="text-xs font-bold text-primary text-center">{r.tenantsSupported}</span>}
                          <span className="text-xs font-bold text-success text-right">+{formatAmount(r.payout)}</span>
                        </div>
                      ))}
                    </div>
                    {/* Total */}
                    <div className="grid grid-cols-3 gap-0 px-3 py-2.5 bg-success/5 border-t border-success/20">
                      <span className="text-xs font-bold text-foreground col-span-2">Total Rewards</span>
                      <span className="text-sm font-black text-success text-right">{formatAmount(totalRewards12Months)}</span>
                    </div>
                  </div>
                </div>

                {/* 90-Day Capital Lock Policy */}
                <div className="p-3.5 rounded-xl bg-amber-500/5 border border-amber-500/20">
                  <div className="flex items-center gap-2 mb-2">
                    <Lock className="h-4 w-4 text-amber-600" />
                    <span className="text-xs font-bold text-amber-700">90-Day Capital Lock Policy</span>
                  </div>
                  <ul className="text-[11px] text-amber-700/80 space-y-2 pl-6 list-disc">
                    <li>Your capital is <strong>locked for 90 days</strong> — Welile pays rent upfront for tenants, and agents need this window to collect repayments</li>
                    <li>During the 90-day lock period, <strong>your capital is not accessible</strong> for withdrawal</li>
                    <li><strong>Reward payouts continue monthly</strong> throughout the lock-in period</li>
                    <li>Early withdrawal is <strong>not permitted</strong> during the 90-day period</li>
                  </ul>
                </div>

                {/* Supporter Options */}
                <div className="p-3.5 rounded-xl bg-primary/5 border border-primary/20">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="h-4 w-4 text-primary" />
                    <span className="text-xs font-bold text-foreground">Supporter Options</span>
                  </div>
                  <ul className="text-[11px] text-muted-foreground space-y-2 pl-6 list-disc">
                    <li><strong>Renew Contract</strong> — After 90 days, renew for another cycle to keep earning</li>
                    <li><strong>Top Up</strong> — Add more funds to an existing package anytime</li>
                    <li><strong>Multiple Accounts</strong> — Create up to <strong>12 different investment accounts</strong> across categories</li>
                  </ul>
                </div>

                {/* Manager Verification Notice */}
                <div className="flex items-start gap-2.5 p-3 rounded-xl bg-muted/30 border border-border/40">
                  <Shield className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <p className="text-[11px] text-muted-foreground">
                    All facilitations are verified by a <strong className="text-foreground">Welile Manager</strong> before your portfolio is activated. 
                    You'll be notified once approved.
                  </p>
                </div>

                <Separator />

                {/* Share / Download Actions */}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={generatePDF}
                    disabled={generating}
                    className="flex-1 gap-1.5 rounded-xl h-10"
                  >
                    {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    PDF
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleShareWhatsApp}
                    disabled={generating}
                    className="flex-1 gap-1.5 rounded-xl h-10 border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                  >
                    {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Share2 className="h-4 w-4" /><Download className="h-3.5 w-3.5" /></>}
                    Share PDF
                  </Button>
                </div>

                {/* Accept Button */}
                <Button
                  onClick={handleAccept}
                  className="w-full h-13 rounded-2xl gap-2 text-base font-bold shadow-lg shadow-primary/20"
                >
                  <CheckCircle2 className="h-5 w-5" />
                  Accept &amp; Proceed to Deposit
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
