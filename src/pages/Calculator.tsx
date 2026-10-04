import { useState, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { 
  TrendingUp, Target, ChevronLeft, Download, Share2, 
  RefreshCw, Calculator, Sparkles, ArrowUp
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { exportToPDF } from '@/lib/exportUtils';
import { toast } from '@/hooks/use-toast';
import { useCurrency } from '@/hooks/useCurrency';
import { CurrencySwitcher } from '@/components/CurrencySwitcher';

const ROI_RATE = 0.15; // 15% per month

interface MonthlyProjection {
  month: number;
  principal: number;
  earnings: number;
  totalEarnings: number;
  balance: number;
}

export default function CalculatorPage() {
  const navigate = useNavigate();
  const { formatAmount, currency } = useCurrency();
  const [desiredEarnings, setDesiredEarnings] = useState(150000);
  const [duration, setDuration] = useState(12);
  const [isCompounding, setIsCompounding] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const projectionRef = useRef<HTMLDivElement>(null);

  const calculations = useMemo(() => {
    const requiredInvestment = Math.ceil(desiredEarnings / ROI_RATE);
    const monthlyReturn = requiredInvestment * ROI_RATE;
    return { requiredInvestment, monthlyReturn };
  }, [desiredEarnings]);

  const projections = useMemo((): MonthlyProjection[] => {
    const results: MonthlyProjection[] = [];
    let currentBalance = calculations.requiredInvestment;
    let totalEarnings = 0;

    for (let month = 1; month <= duration; month++) {
      const earnings = currentBalance * ROI_RATE;
      totalEarnings += earnings;
      if (isCompounding) currentBalance += earnings;

      results.push({
        month,
        principal: isCompounding ? currentBalance - earnings : calculations.requiredInvestment,
        earnings,
        totalEarnings,
        balance: currentBalance,
      });
    }
    return results;
  }, [calculations.requiredInvestment, duration, isCompounding]);

  const finalProjection = projections[projections.length - 1];

  const handleShareWhatsApp = () => {
    const message = `💰 *Welile Investment Projection*\n\n` +
      `📊 Investment: ${formatAmount(calculations.requiredInvestment)}\n` +
      `📈 Monthly ROI: 15%\n` +
      `⏱️ Duration: ${duration} months\n` +
      `${isCompounding ? '🔄 Compounding: Yes\n' : ''}\n` +
      `✨ *Results:*\n` +
      `💵 Total Earnings: ${formatAmount(finalProjection?.totalEarnings || 0)}\n` +
      `🏦 Final Balance: ${formatAmount(finalProjection?.balance || 0)}\n\n` +
      `Start investing today at Welile! 🚀`;
    
    const encodedMessage = encodeURIComponent(message);
    window.open(`https://wa.me/?text=${encodedMessage}`, '_blank');
  };

  const handleExportPDF = async () => {
    if (!projectionRef.current) return;
    setIsExporting(true);
    try {
      await exportToPDF(projectionRef.current, `Welile_Projection_${duration}months`, 'Investment Projection');
      toast({ title: "PDF Downloaded", description: "Your projection has been saved." });
    } catch {
      toast({ title: "Export Failed", variant: "destructive" });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30 safe-area-inset">
      {/* Header */}
      <div className="sticky top-0 z-50 bg-background/95 backdrop-blur-lg border-b border-border">
        <div className="flex items-center gap-3 p-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="shrink-0">
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold truncate flex items-center gap-2">
              <Calculator className="h-5 w-5 text-primary" />
              ROI Calculator
            </h1>
          </div>
          <CurrencySwitcher />
        </div>
      </div>

      <div className="p-4 pb-24 space-y-4 max-w-lg mx-auto">
        {/* Hero Badge */}
        <motion.div 
          className="flex justify-center"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-success/10 border border-success/30">
            <Sparkles className="h-3.5 w-3.5 text-success" />
            <span className="text-xs font-bold text-success">15% Monthly Returns</span>
          </div>
        </motion.div>

        {/* Main Calculator Card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <Card className="border-primary/20 shadow-lg">
            <CardContent className="p-4 space-y-5">
              {/* Earnings Input */}
              <div className="space-y-2">
                <Label className="text-sm font-semibold text-center block">
                  I want to earn monthly
                </Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-semibold">
                    {currency.symbol}
                  </span>
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={desiredEarnings.toLocaleString()}
                    onChange={(e) => {
                      const value = parseInt(e.target.value.replace(/,/g, '')) || 0;
                      setDesiredEarnings(Math.max(0, Math.min(value, 30000000000)));
                    }}
                    className="pl-12 text-xl font-bold h-14 text-center border-2 border-primary/30 focus:border-primary rounded-xl"
                  />
                </div>
                <Slider
                  value={[desiredEarnings]}
                  onValueChange={([value]) => setDesiredEarnings(value)}
                  min={50000}
                  max={30000000000}
                  step={100000}
                  className="py-2"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>50K</span>
                  <span>30B</span>
                </div>
              </div>

              {/* Duration Slider */}
              <div className="space-y-2">
                <Label className="text-sm font-semibold text-center block">
                  Duration: <span className="text-primary">{duration} months</span>
                </Label>
                <Slider
                  value={[duration]}
                  onValueChange={([value]) => setDuration(value)}
                  min={1}
                  max={24}
                  step={1}
                  className="py-2"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>1 mo</span>
                  <span>24 mo</span>
                </div>
              </div>

              {/* Compounding Toggle */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-muted/50 border">
                <div className="flex items-center gap-2">
                  <RefreshCw className={`h-4 w-4 ${isCompounding ? 'text-success' : 'text-muted-foreground'}`} />
                  <span className="text-sm font-medium">Compound earnings</span>
                </div>
                <Switch checked={isCompounding} onCheckedChange={setIsCompounding} />
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Results Cards */}
        <motion.div 
          className="grid grid-cols-2 gap-3"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/30">
            <CardContent className="p-4 text-center">
              <div className="p-2 rounded-full bg-primary/20 w-fit mx-auto mb-2">
                <Target className="h-4 w-4 text-primary" />
              </div>
              <p className="text-[10px] font-bold text-primary uppercase tracking-wide mb-1">Invest</p>
              <AnimatePresence mode="wait">
                <motion.p 
                  key={calculations.requiredInvestment}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="text-base font-black leading-tight"
                >
                  {formatAmount(calculations.requiredInvestment)}
                </motion.p>
              </AnimatePresence>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-success/10 to-success/5 border-success/30">
            <CardContent className="p-4 text-center">
              <div className="p-2 rounded-full bg-success/20 w-fit mx-auto mb-2">
                <TrendingUp className="h-4 w-4 text-success" />
              </div>
              <p className="text-[10px] font-bold text-success uppercase tracking-wide mb-1">
                {isCompounding ? `After ${duration}mo` : 'Monthly'}
              </p>
              <AnimatePresence mode="wait">
                <motion.p 
                  key={`${isCompounding}-${finalProjection?.totalEarnings}`}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="text-base font-black text-success leading-tight"
                >
                  {formatAmount(isCompounding ? finalProjection?.totalEarnings || 0 : calculations.monthlyReturn)}
                </motion.p>
              </AnimatePresence>
            </CardContent>
          </Card>
        </motion.div>

        {/* Quick Share Actions */}
        <motion.div 
          className="flex gap-2"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <Button onClick={handleShareWhatsApp} className="flex-1 gap-2 bg-success hover:bg-success/90">
            <Share2 className="h-4 w-4" />
            Share
          </Button>
          <Button onClick={handleExportPDF} variant="outline" className="flex-1 gap-2" disabled={isExporting}>
            <Download className="h-4 w-4" />
            {isExporting ? 'Saving...' : 'PDF'}
          </Button>
        </motion.div>

        {/* View Breakdown Button */}
        <Button 
          variant="ghost" 
          className="w-full gap-2"
          onClick={() => setShowBreakdown(!showBreakdown)}
        >
          <ArrowUp className={`h-4 w-4 transition-transform ${showBreakdown ? '' : 'rotate-180'}`} />
          {showBreakdown ? 'Hide' : 'View'} Monthly Breakdown
        </Button>

        {/* Monthly Breakdown */}
        <AnimatePresence>
          {showBreakdown && (
            <motion.div
              ref={projectionRef}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <Card>
                <CardContent className="p-0">
                  {/* PDF Header */}
                  <div className="p-4 border-b bg-gradient-to-r from-primary/10 to-primary/5">
                    <div className="flex justify-between items-center">
                      <div>
                        <h2 className="text-xl font-bold text-primary" style={{ fontFamily: "'Chewy', cursive" }}>Welile</h2>
                        <p className="text-xs text-muted-foreground">Investment Projection</p>
                      </div>
                      <div className="text-right text-xs text-muted-foreground">
                        <p className="font-semibold text-foreground">{duration} Months</p>
                        <p>{new Date().toLocaleDateString()}</p>
                      </div>
                    </div>
                  </div>

                  {/* Summary Row */}
                  <div className="grid grid-cols-3 gap-2 p-3 border-b bg-muted/30">
                    <div className="text-center p-2 rounded-lg bg-primary/10">
                      <p className="text-[9px] text-muted-foreground">Investment</p>
                      <p className="text-xs font-bold text-primary">{formatAmount(calculations.requiredInvestment)}</p>
                    </div>
                    <div className="text-center p-2 rounded-lg bg-success/10">
                      <p className="text-[9px] text-muted-foreground">ROI</p>
                      <p className="text-xs font-bold text-success">15%/mo</p>
                    </div>
                    <div className="text-center p-2 rounded-lg bg-muted">
                      <p className="text-[9px] text-muted-foreground">Compound</p>
                      <p className="text-xs font-bold">{isCompounding ? '✓ Yes' : 'No'}</p>
                    </div>
                  </div>

                  {/* Monthly Table */}
                  <div className="max-h-80 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-background border-b">
                        <tr>
                          <th className="text-left py-2 px-3 font-semibold">Month</th>
                          <th className="text-right py-2 px-3 font-semibold">Earnings</th>
                          <th className="text-right py-2 px-3 font-semibold">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {projections.map((row, i) => (
                          <tr key={row.month} className={i % 2 === 0 ? 'bg-muted/20' : ''}>
                            <td className="py-2 px-3 font-medium">Month {row.month}</td>
                            <td className="py-2 px-3 text-right text-success">+{formatAmount(row.earnings)}</td>
                            <td className="py-2 px-3 text-right font-semibold">{formatAmount(row.totalEarnings)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Final Summary */}
                  <div className="p-4 bg-gradient-to-r from-success/10 to-success/5 border-t">
                    <div className="flex justify-between items-center">
                      <span className="font-semibold">Final Balance</span>
                      <span className="text-lg font-black text-success">{formatAmount(finalProjection?.balance || 0)}</span>
                    </div>
                    <div className="flex justify-between items-center mt-1">
                      <span className="text-sm text-muted-foreground">Total Earnings</span>
                      <span className="font-bold text-success">{formatAmount(finalProjection?.totalEarnings || 0)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {/* CTA Footer */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
        >
          <Card className="bg-gradient-to-br from-primary/5 to-success/5 border-primary/20">
            <CardContent className="p-4 text-center space-y-3">
              <h3 className="font-bold text-sm">Start Earning Today</h3>
              <p className="text-xs text-muted-foreground">
                Invest with Welile and earn 15% monthly returns by supporting tenants
              </p>
              <Button 
                onClick={() => navigate('/become-supporter')} 
                className="w-full gap-2 bg-gradient-to-r from-primary to-primary/80"
              >
                <Sparkles className="h-4 w-4" />
                Become a Supporter
              </Button>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
