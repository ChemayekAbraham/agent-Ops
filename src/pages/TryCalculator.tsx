import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { 
  Calculator, TrendingUp, ArrowRight, Sparkles, Shield, Clock, 
  Share2, WifiOff, RefreshCw, Download, ChevronDown, Settings, Globe, FileDown, Check, Home
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap, hapticSuccess } from '@/lib/haptics';
import { motion, AnimatePresence } from 'framer-motion';
// jsPDF loaded dynamically when needed
import { useCurrency } from '@/hooks/useCurrency';
import { useLanguage } from '@/hooks/useLanguage';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { CurrencySwitcher } from '@/components/CurrencySwitcher';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';

interface MonthlyProjection {
  month: number;
  principal: number;
  earnings: number;
  totalEarnings: number;
  balance: number;
}

const ROI_RATE = 0.15; // 15% monthly

export default function TryCalculator() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const referrerId = searchParams.get('ref') || searchParams.get('s');
  const projectionRef = useRef<HTMLDivElement>(null);
  
  const { currency, formatAmount, usdRate, isLoadingRates } = useCurrency();
  const { t, language } = useLanguage();
  
  const [amount, setAmount] = useState(500000);
  const [months, setMonths] = useState(12);
  const [isCompounding, setIsCompounding] = useState(false);
  const [hasTriedCalculator, setHasTriedCalculator] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [showSettings, setShowSettings] = useState(false);

  // Monitor online status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Calculate projections
  const projections = useMemo((): MonthlyProjection[] => {
    const results: MonthlyProjection[] = [];
    let currentBalance = amount;
    let totalEarnings = 0;

    for (let month = 1; month <= months; month++) {
      const earnings = currentBalance * ROI_RATE;
      totalEarnings += earnings;
      if (isCompounding) currentBalance += earnings;

      results.push({
        month,
        principal: isCompounding ? currentBalance - earnings : amount,
        earnings,
        totalEarnings,
        balance: isCompounding ? currentBalance : amount + totalEarnings,
      });
    }
    return results;
  }, [amount, months, isCompounding]);

  const finalProjection = projections[projections.length - 1];
  const monthlyEarnings = amount * ROI_RATE;

  const handleCalculate = () => {
    hapticTap();
    setHasTriedCalculator(true);
  };

  const handleSignUp = () => {
    hapticSuccess();
    const params = new URLSearchParams({ role: 'supporter' });
    if (referrerId) params.set('ref', referrerId);
    navigate(`/auth?${params.toString()}`);
  };

  const handleShare = async () => {
    hapticTap();
    const shareLink = `${window.location.origin}/try-calculator${referrerId ? `?ref=${referrerId}` : ''}`;
    const shareMessage = `💰 Want to earn 15% monthly returns?

📊 Try this FREE Investment Calculator - no signup needed!
📈 See exactly how much you can earn
🔄 With compounding up to 60 months!
🎁 Sign up & we BOTH earn UGX 500!

👉 Try it: ${shareLink}`;

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Welile Investment Calculator',
          text: shareMessage,
          url: shareLink,
        });
        return;
      } catch {
        // Fall through to WhatsApp
      }
    }
    
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareMessage)}`;
    window.open(whatsappUrl, '_blank');
  };

  const handleDownloadPDF = async () => {
    hapticTap();
    setIsExporting(true);
    setExportSuccess(false);
    
    try {
      // Small delay for visual feedback
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const { default: jsPDF } = await import('jspdf');
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      
      // Header
      doc.setFillColor(124, 58, 237); // primary violet
      doc.rect(0, 0, pageWidth, 35, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(22);
      doc.setFont('helvetica', 'bold');
      doc.text('Welile Investment Projection', pageWidth / 2, 18, { align: 'center' });
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.text(`Generated: ${new Date().toLocaleDateString()}`, pageWidth / 2, 28, { align: 'center' });
      
      // Summary Box
      doc.setTextColor(0, 0, 0);
      doc.setFillColor(245, 245, 245);
      doc.roundedRect(15, 45, pageWidth - 30, 35, 3, 3, 'F');
      
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text('Investment Summary', 20, 55);
      
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      const summaryY = 63;
      doc.text(`Principal: ${formatUGX(amount)}`, 20, summaryY);
      doc.text(`Duration: ${months} months`, 80, summaryY);
      doc.text(`Compounding: ${isCompounding ? 'Yes' : 'No'}`, 140, summaryY);
      doc.text(`Monthly ROI: 15%`, 20, summaryY + 8);
      doc.text(`Total Earnings: ${formatUGX(finalProjection?.totalEarnings || 0)}`, 80, summaryY + 8);
      doc.setTextColor(34, 197, 94);
      doc.text(`Final Balance: ${formatUGX(finalProjection?.balance || 0)}`, 140, summaryY + 8);
      
      // Table Header
      doc.setTextColor(0, 0, 0);
      doc.setFillColor(124, 58, 237);
      doc.rect(15, 90, pageWidth - 30, 10, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text('Month', 20, 97);
      doc.text('Principal', 50, 97);
      doc.text('Earnings', 95, 97);
      doc.text('Total Earnings', 130, 97);
      doc.text('Balance', 170, 97);
      
      // Table Rows
      doc.setTextColor(0, 0, 0);
      doc.setFont('helvetica', 'normal');
      let yPos = 107;
      const rowHeight = 7;
      const maxRowsPerPage = 25;
      
      projections.forEach((row, index) => {
        if (index > 0 && index % maxRowsPerPage === 0) {
          doc.addPage();
          yPos = 20;
          
          // Repeat header on new page
          doc.setFillColor(124, 58, 237);
          doc.rect(15, yPos - 10, pageWidth - 30, 10, 'F');
          doc.setTextColor(255, 255, 255);
          doc.setFont('helvetica', 'bold');
          doc.text('Month', 20, yPos - 3);
          doc.text('Principal', 50, yPos - 3);
          doc.text('Earnings', 95, yPos - 3);
          doc.text('Total Earnings', 130, yPos - 3);
          doc.text('Balance', 170, yPos - 3);
          doc.setTextColor(0, 0, 0);
          doc.setFont('helvetica', 'normal');
          yPos += 7;
        }
        
        // Alternate row colors
        if (index % 2 === 0) {
          doc.setFillColor(250, 250, 250);
          doc.rect(15, yPos - 5, pageWidth - 30, rowHeight, 'F');
        }
        
        doc.setFontSize(8);
        doc.text(`${row.month}`, 20, yPos);
        doc.text(formatUGX(row.principal), 50, yPos);
        doc.setTextColor(34, 197, 94);
        doc.text(`+${formatUGX(row.earnings)}`, 95, yPos);
        doc.text(formatUGX(row.totalEarnings), 130, yPos);
        doc.setTextColor(0, 0, 0);
        doc.setFont('helvetica', 'bold');
        doc.text(formatUGX(row.balance), 170, yPos);
        doc.setFont('helvetica', 'normal');
        
        yPos += rowHeight;
      });
      
      // Footer
      const lastPage = doc.getNumberOfPages();
      doc.setPage(lastPage);
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text('This projection is for illustration purposes. Past performance does not guarantee future results.', pageWidth / 2, doc.internal.pageSize.getHeight() - 15, { align: 'center' });
      doc.text('Start investing at welile.com', pageWidth / 2, doc.internal.pageSize.getHeight() - 8, { align: 'center' });
      
      doc.save(`Welile_${months}mo_${isCompounding ? 'compound' : 'simple'}.pdf`);
      hapticSuccess();
      setExportSuccess(true);
      
      toast({
        title: "PDF Downloaded! ✅",
        description: `Your ${months}-month projection is ready`,
      });
      
      // Reset success state after 3 seconds
      setTimeout(() => setExportSuccess(false), 3000);
    } catch (error) {
      console.error('PDF export failed:', error);
      toast({
        title: "Download failed",
        description: "Please try again",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const quickMonths = [6, 12, 24, 60];

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 via-purple-50 to-fuchsia-50 dark:from-violet-950/30 dark:via-purple-950/20 dark:to-background">
      {/* Offline indicator */}
      {!isOnline && (
        <div className="bg-warning/20 border-b border-warning/30 px-3 py-2.5 flex items-center justify-center gap-2 text-sm">
          <WifiOff className="h-4 w-4 text-warning" />
          <span className="text-warning-foreground font-medium">Offline - Calculator still works!</span>
        </div>
      )}

      {/* Header - Mobile optimized */}
      <header className="sticky top-0 z-50 bg-white/90 dark:bg-background/90 backdrop-blur-xl border-b safe-area-top">
        <div className="px-3 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate('/')}
              className="h-10 w-10"
            >
              <Home className="h-5 w-5" />
            </Button>
            <span 
              className="text-xl font-bold text-primary cursor-pointer"
              style={{ fontFamily: "'Chewy', cursive" }}
              onClick={() => navigate('/')}
            >
              Welile
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Settings Toggle - Larger touch target */}
            <Button 
              variant={showSettings ? "default" : "ghost"} 
              size="icon" 
              onClick={() => setShowSettings(!showSettings)} 
              className="h-11 w-11 min-h-[44px] min-w-[44px]"
              aria-label="Settings"
            >
              <Settings className="h-5 w-5" />
            </Button>
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={handleShare} 
              className="h-11 w-11 min-h-[44px] min-w-[44px]"
            >
              <Share2 className="h-5 w-5" />
            </Button>
            <Button onClick={handleSignUp} size="sm" className="gap-1.5 h-11 px-4 text-sm min-h-[44px]">
              <Sparkles className="h-4 w-4" />
              <span className="hidden xs:inline">Start</span> Earning
            </Button>
          </div>
        </div>
      </header>

      <div className="px-3 py-4 pb-8 max-w-lg mx-auto">
        {/* Settings Panel - Mobile optimized */}
        <AnimatePresence>
          {showSettings && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden mb-4"
            >
              <Card className="border-primary/30 bg-gradient-to-r from-primary/5 to-violet-500/5">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Globe className="h-5 w-5 text-primary" />
                    <h3 className="font-semibold">Language & Currency</h3>
                  </div>
                  <p className="text-sm text-muted-foreground mb-4">
                    View in your preferred language and any world currency!
                  </p>
                  <div className="space-y-4">
                    <div>
                      <Label className="text-sm text-muted-foreground mb-2 block">Language</Label>
                      <LanguageSwitcher />
                    </div>
                    <div>
                      <Label className="text-sm text-muted-foreground mb-2 block">Currency</Label>
                      <CurrencySwitcher />
                    </div>
                  </div>
                  {/* Live Rate Display */}
                  <div className="mt-4 pt-3 border-t border-border/50">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Rate:</span>
                      <span className="font-mono font-medium">
                        1 USD = {usdRate.toLocaleString(undefined, { maximumFractionDigits: 0 })} UGX
                        {isLoadingRates && <RefreshCw className="inline h-3 w-3 ml-1 animate-spin" />}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Quick Settings Bar - Larger touch target */}
        <button 
          onClick={() => setShowSettings(true)}
          className="w-full flex items-center justify-between mb-4 p-3 rounded-xl bg-muted/50 border active:bg-muted/80 transition-colors min-h-[48px]"
        >
          <div className="flex items-center gap-2.5">
            <span className="text-xl">{currency.flag}</span>
            <span className="font-medium">{currency.code}</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Settings className="h-4 w-4" />
            <span className="text-sm">Change</span>
          </div>
        </button>

        {/* Hero - Compact for mobile */}
        <div className="text-center mb-5">
          <div className="inline-flex items-center gap-2 bg-success/10 text-success px-4 py-2.5 rounded-full text-sm font-semibold mb-3">
            <TrendingUp className="h-4 w-4" />
            15% Monthly Returns
          </div>
          <h1 className="text-xl font-bold mb-1">
            Investment Calculator
          </h1>
          <p className="text-muted-foreground text-sm">
            With compounding up to 60 months
          </p>
        </div>

        {/* Calculator Card - Mobile optimized spacing */}
        <Card className="mb-4 shadow-xl border-2">
          <CardHeader className="pb-2 px-4 pt-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <Calculator className="h-5 w-5 text-primary" />
              Calculate Your Earnings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 px-4 pb-5">
            {/* Investment Amount */}
            <div className="space-y-3">
              <Label className="text-sm font-semibold block">Investment Amount</Label>
              <Input
                type="text"
                inputMode="numeric"
                value={amount.toLocaleString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value.replace(/,/g, '')) || 0;
                  setAmount(Math.max(0, Math.min(value, 100000000)));
                }}
                className="text-xl h-14 font-bold text-center min-h-[56px]"
              />
              <div className="pt-2 pb-1">
                <Slider
                  value={[amount]}
                  onValueChange={([v]) => setAmount(v)}
                  min={50000}
                  max={50000000}
                  step={50000}
                  className="py-2"
                />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground px-1">
                <span>50K</span>
                <span>50M</span>
              </div>
            </div>

            {/* Duration - Larger buttons */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-semibold">Duration</Label>
                <span className="text-sm text-primary font-bold bg-primary/10 px-2.5 py-1 rounded-lg">{months} months</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {quickMonths.map((m) => (
                  <Button
                    key={m}
                    variant={months === m ? 'default' : 'outline'}
                    onClick={() => setMonths(m)}
                    className="h-12 text-base font-semibold min-h-[48px]"
                  >
                    {m}mo
                  </Button>
                ))}
              </div>
              <div className="pt-2 pb-1">
                <Slider
                  value={[months]}
                  onValueChange={([v]) => setMonths(v)}
                  min={1}
                  max={60}
                  step={1}
                  className="py-2"
                />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground px-1">
                <span>1 month</span>
                <span>60 months</span>
              </div>
            </div>

            {/* Compounding Mode - Prominent selection */}
            <div className="space-y-3">
              <Label className="text-sm font-semibold block">Earning Mode</Label>
              <div className="grid grid-cols-2 gap-3">
                {/* Simple Mode */}
                <button
                  onClick={() => setIsCompounding(false)}
                  className={`relative p-4 rounded-xl border-2 transition-all min-h-[100px] text-left ${
                    !isCompounding 
                      ? 'border-primary bg-primary/10 shadow-md' 
                      : 'border-border bg-muted/30 hover:bg-muted/50'
                  }`}
                >
                  {!isCompounding && (
                    <div className="absolute top-2 right-2">
                      <div className="h-5 w-5 rounded-full bg-primary flex items-center justify-center">
                        <Check className="h-3 w-3 text-primary-foreground" />
                      </div>
                    </div>
                  )}
                  <div className="flex flex-col gap-2">
                    <div className={`p-2 rounded-lg w-fit ${!isCompounding ? 'bg-primary/20' : 'bg-muted'}`}>
                      <TrendingUp className={`h-5 w-5 ${!isCompounding ? 'text-primary' : 'text-muted-foreground'}`} />
                    </div>
                    <div>
                      <p className="font-bold text-sm">Simple</p>
                      <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                        Fixed monthly earnings
                      </p>
                    </div>
                  </div>
                </button>

                {/* Compound Mode */}
                <button
                  onClick={() => setIsCompounding(true)}
                  className={`relative p-4 rounded-xl border-2 transition-all min-h-[100px] text-left ${
                    isCompounding 
                      ? 'border-success bg-success/10 shadow-md' 
                      : 'border-border bg-muted/30 hover:bg-muted/50'
                  }`}
                >
                  {isCompounding && (
                    <div className="absolute top-2 right-2">
                      <div className="h-5 w-5 rounded-full bg-success flex items-center justify-center">
                        <Check className="h-3 w-3 text-success-foreground" />
                      </div>
                    </div>
                  )}
                  <div className="absolute -top-2 left-3">
                    <span className="text-[10px] font-bold bg-success text-success-foreground px-2 py-0.5 rounded-full">
                      RECOMMENDED
                    </span>
                  </div>
                  <div className="flex flex-col gap-2 mt-1">
                    <div className={`p-2 rounded-lg w-fit ${isCompounding ? 'bg-success/20' : 'bg-muted'}`}>
                      <RefreshCw className={`h-5 w-5 ${isCompounding ? 'text-success' : 'text-muted-foreground'}`} />
                    </div>
                    <div>
                      <p className="font-bold text-sm">Compound</p>
                      <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                        Earnings grow monthly
                      </p>
                    </div>
                  </div>
                </button>
              </div>
            </div>

            <Button 
              onClick={handleCalculate} 
              className="w-full h-14 text-lg gap-2 font-bold min-h-[56px]"
            >
              <Calculator className="h-5 w-5" />
              Calculate
            </Button>
          </CardContent>
        </Card>

        {/* Results - Mobile optimized */}
        <AnimatePresence>
          {hasTriedCalculator && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
            >
              <Card className="mb-4 bg-gradient-to-br from-success/10 to-emerald-500/5 border-success/30 shadow-lg">
                <CardContent className="p-4 pt-5">
                  <div className="text-center mb-4">
                    <p className="text-sm text-muted-foreground mb-1">
                      After {months} months {isCompounding ? '(compounded)' : ''}
                    </p>
                    <p className="text-3xl font-bold text-success">{formatAmount(finalProjection?.balance || 0)}</p>
                    {currency.code !== 'UGX' && (
                      <p className="text-xs text-muted-foreground mt-1">
                        ≈ {formatUGX(finalProjection?.balance || 0)}
                      </p>
                    )}
                  </div>
                  
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div className="text-center p-3 bg-background rounded-xl">
                      <p className="text-xs text-muted-foreground mb-1">Your Investment</p>
                      <p className="font-bold">{formatAmount(amount)}</p>
                      {currency.code !== 'UGX' && (
                        <p className="text-[10px] text-muted-foreground mt-0.5">{formatUGX(amount)}</p>
                      )}
                    </div>
                    <div className="text-center p-3 bg-background rounded-xl">
                      <p className="text-xs text-muted-foreground mb-1">Total Earnings</p>
                      <p className="font-bold text-success">+{formatAmount(finalProjection?.totalEarnings || 0)}</p>
                      {currency.code !== 'UGX' && (
                        <p className="text-[10px] text-muted-foreground mt-0.5">+{formatUGX(finalProjection?.totalEarnings || 0)}</p>
                      )}
                    </div>
                  </div>

                  {!isCompounding && (
                    <div className="p-3 bg-primary/5 rounded-xl mb-4">
                      <p className="text-center text-sm">
                        <span className="font-bold">{formatAmount(monthlyEarnings)}</span>
                        <span className="text-muted-foreground"> earned every month</span>
                      </p>
                    </div>
                  )}

                  {/* Download PDF - Prominent card */}
                  <div className="mb-4 p-4 rounded-xl bg-gradient-to-r from-primary/10 to-violet-500/10 border border-primary/20">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className={`p-2.5 rounded-xl ${exportSuccess ? 'bg-success/20' : 'bg-primary/20'}`}>
                          {exportSuccess ? (
                            <Check className="h-5 w-5 text-success" />
                          ) : (
                            <FileDown className="h-5 w-5 text-primary" />
                          )}
                        </div>
                        <div>
                          <p className="font-semibold text-sm">Download Report</p>
                          <p className="text-xs text-muted-foreground">{months}-month breakdown PDF</p>
                        </div>
                      </div>
                      <Button 
                        onClick={handleDownloadPDF} 
                        size="lg"
                        className={`gap-2 h-12 px-5 min-h-[48px] font-semibold ${
                          exportSuccess 
                            ? 'bg-success hover:bg-success/90' 
                            : 'bg-primary hover:bg-primary/90'
                        }`}
                        disabled={isExporting}
                      >
                        {isExporting ? (
                          <>
                            <RefreshCw className="h-4 w-4 animate-spin" />
                            <span className="sr-only">Downloading...</span>
                          </>
                        ) : exportSuccess ? (
                          <>
                            <Check className="h-4 w-4" />
                            Done
                          </>
                        ) : (
                          <>
                            <Download className="h-4 w-4" />
                            Get PDF
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* View Breakdown Toggle */}
                  <Button 
                    onClick={() => setShowBreakdown(!showBreakdown)} 
                    variant="outline" 
                    className="w-full gap-2 h-12 min-h-[48px] mb-4"
                  >
                    <ChevronDown className={`h-4 w-4 transition-transform ${showBreakdown ? 'rotate-180' : ''}`} />
                    {showBreakdown ? 'Hide' : 'View'} Monthly Breakdown
                  </Button>

                  {/* Monthly Breakdown - Mobile scrollable */}
                  <AnimatePresence>
                    {showBreakdown && (
                      <motion.div
                        ref={projectionRef}
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden"
                      >
                        <div 
                          className="max-h-72 overflow-y-auto rounded-xl border bg-background overscroll-contain"
                          style={{ WebkitOverflowScrolling: 'touch' }}
                        >
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-muted border-b z-10">
                              <tr>
                                <th className="text-left py-3 px-3 font-semibold">Mo</th>
                                <th className="text-right py-3 px-2 font-semibold">Earn</th>
                                <th className="text-right py-3 px-2 font-semibold">Total</th>
                                <th className="text-right py-3 px-3 font-semibold">Balance</th>
                              </tr>
                            </thead>
                            <tbody>
                              {projections.map((row, i) => (
                                <tr key={row.month} className={i % 2 === 0 ? 'bg-muted/30' : ''}>
                                  <td className="py-2.5 px-3 font-medium">{row.month}</td>
                                  <td className="py-2.5 px-2 text-right text-success text-xs">+{formatAmount(row.earnings)}</td>
                                  <td className="py-2.5 px-2 text-right text-xs">{formatAmount(row.totalEarnings)}</td>
                                  <td className="py-2.5 px-3 text-right font-semibold text-xs">{formatAmount(row.balance)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <Button 
                    onClick={handleSignUp} 
                    className="w-full h-14 text-lg gap-2 mt-4 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 font-bold min-h-[56px]"
                  >
                    Start Earning Now
                    <ArrowRight className="h-5 w-5" />
                  </Button>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Trust Badges - Mobile grid */}
        <div className="grid grid-cols-3 gap-2 mb-6">
          <div className="flex flex-col items-center gap-1.5 p-3 bg-white/60 dark:bg-card/60 rounded-xl text-center min-h-[72px] justify-center">
            <Shield className="h-5 w-5 text-primary" />
            <p className="text-xs font-medium">Secure</p>
          </div>
          <div className="flex flex-col items-center gap-1.5 p-3 bg-white/60 dark:bg-card/60 rounded-xl text-center min-h-[72px] justify-center">
            <Clock className="h-5 w-5 text-primary" />
            <p className="text-xs font-medium">Flexible</p>
          </div>
          <div className="flex flex-col items-center gap-1.5 p-3 bg-white/60 dark:bg-card/60 rounded-xl text-center min-h-[72px] justify-center">
            <WifiOff className="h-5 w-5 text-primary" />
            <p className="text-xs font-medium">Offline</p>
          </div>
        </div>

        {/* CTA Footer */}
        {!hasTriedCalculator && (
          <p className="text-center text-sm text-muted-foreground pb-4">
            Try the calculator above to see your potential earnings!
          </p>
        )}
      </div>
    </div>
  );
}
