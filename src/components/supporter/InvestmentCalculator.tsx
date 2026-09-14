import { useState, useMemo, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Toggle, GooeyFilter } from '@/components/ui/liquid-toggle';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { TrendingUp, Target, Coins, Zap, Download, Share2, RefreshCw, BarChart3, GitCompare, ChevronDown, Shield, Clock, ArrowRight, Save, Layers, X, Wifi, DollarSign, Loader2, Mail, Heart } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { motion, AnimatePresence } from 'framer-motion';
import { exportToPDF } from '@/lib/exportUtils';
import { toast } from '@/hooks/use-toast';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine } from 'recharts';
import { useCurrency } from '@/hooks/useCurrency';
import { formatDistanceToNow } from 'date-fns';
import welileWordmark from '@/assets/welile-wordmark.png.asset.json';

const REWARD_RATE = 0.15; // 15% monthly platform rewards

interface MonthlyProjection {
  month: number;
  principal: number;
  earnings: number;
  totalEarnings: number;
  balance: number;
}

interface SavedScenario {
  id: string;
  name: string;
  desiredEarnings: number;
  duration: number;
  isCompounding: boolean;
  requiredContribution: number;
  totalEarnings: number;
  finalBalance: number;
  color: string;
  createdAt: Date;
}

const SCENARIO_COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--success))',
  'hsl(var(--warning))',
  'hsl(142, 76%, 36%)',
  'hsl(280, 65%, 60%)',
  'hsl(200, 80%, 50%)',
];

export function InvestmentCalculator() {
  const { currency, formatAmount, isLoadingRates, lastUpdated, refreshRates, usdRate } = useCurrency();
  const [mode, setMode] = useState<'invest' | 'earn'>('invest');
  const [investAmount, setInvestAmount] = useState(1_000_000);
  const [desiredEarnings, setDesiredEarnings] = useState(150000);
  const [duration, setDuration] = useState(12);
  const [isCompounding, setIsCompounding] = useState(false);
  const [showComparison, setShowComparison] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [savedScenarios, setSavedScenarios] = useState<SavedScenario[]>([]);
  const [showSavedScenarios, setShowSavedScenarios] = useState(false);
  const [scenarioName, setScenarioName] = useState('');
  const [isExportingComparison, setIsExportingComparison] = useState(false);
  const [isRefreshingRates, setIsRefreshingRates] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const projectionRef = useRef<HTMLDivElement>(null);
  const comparisonRef = useRef<HTMLDivElement>(null);

  const handleRefreshRates = async () => {
    setIsRefreshingRates(true);
    await refreshRates();
    setIsRefreshingRates(false);
    toast({
      title: "Exchange Rates Updated",
      description: `1 USD = ${usdRate.toLocaleString()} UGX`,
    });
  };

  // Load saved scenarios from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('welile-support-scenarios');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setSavedScenarios(parsed.map((s: SavedScenario) => ({
          ...s,
          createdAt: new Date(s.createdAt)
        })));
      } catch (e) {
        console.error('Failed to load saved scenarios', e);
      }
    }
  }, []);

  // Save scenarios to localStorage
  useEffect(() => {
    if (savedScenarios.length > 0) {
      localStorage.setItem('welile-support-scenarios', JSON.stringify(savedScenarios));
    }
  }, [savedScenarios]);

  const calculations = useMemo(() => {
    const requiredContribution =
      mode === 'invest' ? Math.max(0, investAmount) : Math.ceil(desiredEarnings / REWARD_RATE);
    const monthlyReward = requiredContribution * REWARD_RATE;
    const quarterlyReward = monthlyReward * 3;
    const yearlyReward = monthlyReward * 12;
    
    return {
      requiredContribution,
      monthlyReward,
      quarterlyReward,
      yearlyReward,
    };
  }, [mode, investAmount, desiredEarnings]);

  const projections = useMemo((): MonthlyProjection[] => {
    const results: MonthlyProjection[] = [];
    let currentBalance = calculations.requiredContribution;
    let totalEarnings = 0;

    for (let month = 1; month <= duration; month++) {
      const earnings = currentBalance * REWARD_RATE;
      totalEarnings += earnings;
      
      if (isCompounding) {
        currentBalance += earnings;
      }

      results.push({
        month,
        principal: isCompounding ? currentBalance - earnings : calculations.requiredContribution,
        earnings,
        totalEarnings,
        balance: currentBalance,
      });
    }

    return results;
  }, [calculations.requiredContribution, duration, isCompounding]);

  const comparisonData = useMemo(() => {
    const data = [{ 
      month: 0, 
      compoundingBalance: calculations.requiredContribution, 
      simpleBalance: calculations.requiredContribution,
      compoundingEarnings: 0,
      simpleEarnings: 0
    }];

    let compoundBalance = calculations.requiredContribution;
    let compoundTotalEarnings = 0;
    let simpleTotalEarnings = 0;

    for (let month = 1; month <= duration; month++) {
      const compoundEarnings = compoundBalance * REWARD_RATE;
      compoundTotalEarnings += compoundEarnings;
      compoundBalance += compoundEarnings;

      const simpleEarnings = calculations.requiredContribution * REWARD_RATE;
      simpleTotalEarnings += simpleEarnings;

      data.push({
        month,
        compoundingBalance: compoundBalance,
        simpleBalance: calculations.requiredContribution,
        compoundingEarnings: compoundTotalEarnings,
        simpleEarnings: simpleTotalEarnings,
      });
    }

    return data;
  }, [calculations.requiredContribution, duration]);

  const scenarioComparisonData = useMemo(() => {
    if (savedScenarios.length === 0) return [];
    
    const maxDuration = Math.max(...savedScenarios.map(s => s.duration), duration);
    const data = [];
    
    for (let month = 0; month <= maxDuration; month++) {
      const point: Record<string, number> = { month };
      
      if (month <= duration) {
        let currentBalance = calculations.requiredContribution;
        let totalEarnings = 0;
        for (let m = 1; m <= month; m++) {
          const earnings = currentBalance * REWARD_RATE;
          totalEarnings += earnings;
          if (isCompounding) currentBalance += earnings;
        }
        point['current'] = totalEarnings;
      }
      
      savedScenarios.forEach(scenario => {
        if (month <= scenario.duration) {
          let currentBalance = scenario.requiredContribution;
          let totalEarnings = 0;
          for (let m = 1; m <= month; m++) {
            const earnings = currentBalance * REWARD_RATE;
            totalEarnings += earnings;
            if (scenario.isCompounding) currentBalance += earnings;
          }
          point[scenario.id] = totalEarnings;
        }
      });
      
      data.push(point);
    }
    
    return data;
  }, [savedScenarios, calculations.requiredContribution, duration, isCompounding]);

  const handleSaveScenario = () => {
    if (savedScenarios.length >= 5) {
      toast({
        title: "Maximum Scenarios Reached",
        description: "You can save up to 5 scenarios. Delete one to add more.",
        variant: "destructive",
      });
      return;
    }
    
    const finalProjection = projections[projections.length - 1];
    const newScenario: SavedScenario = {
      id: `scenario-${Date.now()}`,
      name: scenarioName || `Scenario ${savedScenarios.length + 1}`,
      desiredEarnings,
      duration,
      isCompounding,
      requiredContribution: calculations.requiredContribution,
      totalEarnings: finalProjection?.totalEarnings || 0,
      finalBalance: finalProjection?.balance || 0,
      color: SCENARIO_COLORS[savedScenarios.length % SCENARIO_COLORS.length],
      createdAt: new Date(),
    };
    
    setSavedScenarios(prev => [...prev, newScenario]);
    setScenarioName('');
    toast({
      title: "Scenario Saved",
      description: `"${newScenario.name}" has been saved for comparison.`,
    });
  };

  const handleDeleteScenario = (id: string) => {
    setSavedScenarios(prev => {
      const updated = prev.filter(s => s.id !== id);
      if (updated.length === 0) {
        localStorage.removeItem('welile-support-scenarios');
      }
      return updated;
    });
    toast({
      title: "Scenario Deleted",
      description: "The scenario has been removed.",
    });
  };

  const handleLoadScenario = (scenario: SavedScenario) => {
    setDesiredEarnings(scenario.desiredEarnings);
    setDuration(scenario.duration);
    setIsCompounding(scenario.isCompounding);
    toast({
      title: "Scenario Loaded",
      description: `"${scenario.name}" settings have been applied.`,
    });
  };

  const handleExportComparisonPDF = async () => {
    if (!comparisonRef.current || savedScenarios.length === 0) {
      toast({
        title: "No Scenarios to Export",
        description: "Save at least one scenario to export a comparison.",
        variant: "destructive",
      });
      return;
    }
    
    setIsExportingComparison(true);
    try {
      await exportToPDF(
        comparisonRef.current,
        `Welile_Support_Scenario_Comparison_${savedScenarios.length + 1}scenarios`,
        'Support Scenarios Comparison'
      );
      toast({
        title: "Comparison PDF Downloaded",
        description: "Your scenario comparison has been saved as PDF.",
      });
    } catch (error) {
      toast({
        title: "Export Failed",
        description: "Could not generate PDF. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsExportingComparison(false);
    }
  };

  const handleShareComparisonWhatsApp = () => {
    if (savedScenarios.length === 0) {
      toast({
        title: "No Scenarios to Share",
        description: "Save at least one scenario to share a comparison.",
        variant: "destructive",
      });
      return;
    }
    
    const currentEarnings = projections[projections.length - 1]?.totalEarnings || 0;
    
    let message = `📊 *WELILE SCENARIO COMPARISON*\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `Compare ${savedScenarios.length + 1} support scenarios:\n\n`;
    
    message += `📍 *CURRENT SCENARIO*\n`;
    message += `💰 Contribution: ${formatUGX(calculations.requiredContribution)}\n`;
    message += `⏱️ Duration: ${duration} months\n`;
    message += `🔄 Reinvesting Rewards: ${isCompounding ? 'Yes' : 'No'}\n`;
    message += `✨ Total Earnings: ${formatUGX(currentEarnings)}\n\n`;
    
    savedScenarios.forEach((scenario, index) => {
      message += `${index + 1}️⃣ *${scenario.name.toUpperCase()}*\n`;
      message += `💰 Contribution: ${formatUGX(scenario.requiredContribution)}\n`;
      message += `⏱️ Duration: ${scenario.duration} months\n`;
      message += `🔄 Reinvesting: ${scenario.isCompounding ? 'Yes' : 'No'}\n`;
      message += `✨ Total Earnings: ${formatUGX(scenario.totalEarnings)}\n\n`;
    });
    
    const allScenarios = [
      { name: 'Current', earnings: currentEarnings },
      ...savedScenarios.map(s => ({ name: s.name, earnings: s.totalEarnings }))
    ];
    const bestScenario = allScenarios.reduce((best, current) => 
      current.earnings > best.earnings ? current : best
    );
    
    message += `━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🏆 *BEST OPTION: ${bestScenario.name}*\n`;
    message += `💵 Highest Earnings: ${formatUGX(bestScenario.earnings)}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n`;
    message += `✅ *WHY SUPPORT WITH WELILE?*\n`;
    message += `• 15% Monthly Platform Rewards\n`;
    message += `• Help tenants access rent facilitation\n`;
    message += `• Trusted agent collection network\n`;
    message += `• 90-day notice for capital withdrawal\n\n`;
    message += `🚀 Start earning with Welile today!`;
    
    const encodedMessage = encodeURIComponent(message);
    window.open(`https://wa.me/?text=${encodedMessage}`, '_blank');
  };

  const handleExportPDF = async () => {
    if (!projectionRef.current) return;
    
    setIsExporting(true);
    try {
      await exportToPDF(
        projectionRef.current,
        `Welile_Support_Projection_${duration}months`,
        'Tenant Support Projection Report'
      );
      toast({
        title: "PDF Downloaded",
        description: "Your support projection has been saved as PDF.",
      });
    } catch (error) {
      toast({
        title: "Export Failed",
        description: "Could not generate PDF. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleShareWhatsApp = () => {
    const finalBalance = projections[projections.length - 1]?.balance || 0;
    const totalEarnings = projections[projections.length - 1]?.totalEarnings || 0;
    
    const message = `💰 *Welile Earnings Projection*\n\n` +
      `📊 Contribution: ${formatUGX(calculations.requiredContribution)}\n` +
      `📈 Monthly Rewards: 15%\n` +
      `⏱️ Duration: ${duration} months\n` +
      `${isCompounding ? '🔄 Reinvesting Rewards: Yes\n' : ''}\n` +
      `✨ *Results:*\n` +
      `💵 Total Earnings: ${formatUGX(totalEarnings)}\n` +
      `🏦 Final Balance: ${formatUGX(finalBalance)}\n\n` +
      `Support tenants through Welile today! 🚀`;
    
    const encodedMessage = encodeURIComponent(message);
    window.open(`https://wa.me/?text=${encodedMessage}`, '_blank');
  };

  const handleSharePDFWhatsApp = async () => {
    if (!projectionRef.current) return;
    
    setIsExporting(true);
    try {
      let breakdownText = `📊 *WELILE EARNINGS PROJECTION*\n`;
      breakdownText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      breakdownText += `💰 Initial Contribution: ${formatUGX(calculations.requiredContribution)}\n`;
      breakdownText += `📈 Monthly Rewards: 15%\n`;
      breakdownText += `⏱️ Duration: ${duration} months\n`;
      breakdownText += `🔄 Reinvesting Rewards: ${isCompounding ? 'Yes' : 'No'}\n\n`;
      breakdownText += `📋 *MONTHLY BREAKDOWN*\n`;
      breakdownText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      projections.forEach((row) => {
        breakdownText += `*Month ${row.month}*\n`;
        breakdownText += `  Contribution: ${formatUGX(row.principal)}\n`;
        breakdownText += `  Rewards: +${formatUGX(row.earnings)}\n`;
        breakdownText += `  Total Earned: ${formatUGX(row.totalEarnings)}\n`;
        breakdownText += `  Balance: ${formatUGX(row.balance)}\n\n`;
      });
      
      breakdownText += `━━━━━━━━━━━━━━━━━━━━\n`;
      breakdownText += `🏆 *FINAL RESULTS*\n`;
      breakdownText += `💵 Total Earnings: ${formatUGX(projections[projections.length - 1]?.totalEarnings || 0)}\n`;
      breakdownText += `🏦 Final Balance: ${formatUGX(projections[projections.length - 1]?.balance || 0)}\n\n`;
      breakdownText += `━━━━━━━━━━━━━━━━━━━━\n`;
      breakdownText += `✅ *WHY SUPPORT WITH WELILE?*\n`;
      breakdownText += `• Earn by helping tenants access rent facilitation\n`;
      breakdownText += `• Welile coordinates rent collection through our Agent Network\n`;
      breakdownText += `• Withdraw capital with 90-day notice\n\n`;
      breakdownText += `🚀 Start earning 15% monthly rewards today!\n`;
      breakdownText += `📱 Visit Welile to become a Supporter`;
      
      const encodedMessage = encodeURIComponent(breakdownText);
      window.open(`https://wa.me/?text=${encodedMessage}`, '_blank');
      
      toast({
        title: "Opening WhatsApp",
        description: "Monthly breakdown ready to share!",
      });
    } catch (error) {
      toast({
        title: "Share Failed",
        description: "Could not prepare share content. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleShareEmail = () => {
    let body = `WELILE EARNINGS PROJECTION\n\n`;
    body += `Initial Contribution: ${formatUGX(calculations.requiredContribution)}\n`;
    body += `Monthly Rewards: 15%\n`;
    body += `Duration: ${duration} months\n`;
    body += `Reinvesting Rewards: ${isCompounding ? 'Yes' : 'No'}\n\n`;
    body += `MONTHLY BREAKDOWN\n`;
    body += `${'—'.repeat(30)}\n\n`;

    projections.forEach((row) => {
      body += `Month ${row.month}\n`;
      body += `  Contribution: ${formatUGX(row.principal)}\n`;
      body += `  Rewards: +${formatUGX(row.earnings)}\n`;
      body += `  Total Earned: ${formatUGX(row.totalEarnings)}\n`;
      body += `  Balance: ${formatUGX(row.balance)}\n\n`;
    });

    body += `${'—'.repeat(30)}\n`;
    body += `FINAL RESULTS\n`;
    body += `Total Earnings: ${formatUGX(projections[projections.length - 1]?.totalEarnings || 0)}\n`;
    body += `Final Balance: ${formatUGX(projections[projections.length - 1]?.balance || 0)}\n\n`;
    body += `Start earning 15% monthly rewards with Welile today!`;

    const subject = `Welile Earnings Projection – ${formatUGX(calculations.requiredContribution)} over ${duration} months`;
    window.open(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_self');

    toast({
      title: "Opening Email",
      description: "Monthly breakdown ready to send!",
    });
  };

  return (
    <div className="space-y-3 sm:space-y-6">
      <GooeyFilter />
      {/* Calculator — minimalistic flat card */}
      <div className="rounded-xl border border-border/40 bg-card">
        <div className="p-4 sm:p-6 space-y-5">

          {/* Mode toggle — clean pill switcher */}
          <div className="max-w-sm mx-auto">
            <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-muted/50">
              <button
                type="button"
                onClick={() => setMode('invest')}
                className={`py-2.5 rounded-md text-xs font-semibold transition-all ${
                  mode === 'invest'
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                I have an amount
              </button>
              <button
                type="button"
                onClick={() => setMode('earn')}
                className={`py-2.5 rounded-md text-xs font-semibold transition-all ${
                  mode === 'earn'
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                I have a goal
              </button>
            </div>
          </div>

          {/* Input section */}
          <div className="space-y-4 max-w-sm mx-auto">
            {mode === 'invest' ? (
              <div className="space-y-2">
                <Label className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                  Contribution amount
                </Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-medium">
                    UGX
                  </span>
                  <Input
                    type="text"
                    value={investAmount.toLocaleString()}
                    onChange={(e) => {
                      const value = parseInt(e.target.value.replace(/,/g, '')) || 0;
                      setInvestAmount(Math.max(0, Math.min(value, 300000000)));
                    }}
                    className="pl-12 text-xl font-bold h-14 rounded-lg border-border/60 text-center"
                  />
                </div>
                <Slider
                  value={[investAmount]}
                  onValueChange={([value]) => setInvestAmount(value)}
                  min={50000}
                  max={300000000}
                  step={50000}
                  showTooltip
                  tooltipContent={(value) => `UGX ${value.toLocaleString()}`}
                  className="py-2"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>50K</span>
                  <span>300M</span>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Label className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                  Monthly earnings goal
                </Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-medium">
                    UGX
                  </span>
                  <Input
                    type="text"
                    value={desiredEarnings.toLocaleString()}
                    onChange={(e) => {
                      const value = parseInt(e.target.value.replace(/,/g, '')) || 0;
                      setDesiredEarnings(Math.max(0, Math.min(value, 30000000000)));
                    }}
                    className="pl-12 text-xl font-bold h-14 rounded-lg border-border/60 text-center"
                  />
                </div>
                <Slider
                  value={[desiredEarnings]}
                  onValueChange={([value]) => setDesiredEarnings(value)}
                  min={50000}
                  max={30000000000}
                  step={100000}
                  showTooltip
                  tooltipContent={(value) => `UGX ${value.toLocaleString()}`}
                  className="py-2"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>50K</span>
                  <span>30B</span>
                </div>
              </div>
            )}

            {/* Duration */}
            <div className="space-y-2">
              <Label className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                Duration · {duration} month{duration !== 1 ? 's' : ''}
              </Label>
              <Slider
                value={[duration]}
                onValueChange={([value]) => setDuration(value)}
                min={1}
                max={24}
                step={1}
                showTooltip
                tooltipContent={(value) => `${value} month${value === 1 ? '' : 's'}`}
                className="py-1.5"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>1</span>
                <span>24</span>
              </div>
            </div>

            {/* Toggles — flat rows */}
            <div className="space-y-1">
              <button
                onClick={() => setIsCompounding(!isCompounding)}
                className="flex items-center justify-between w-full py-3 border-b border-border/20"
              >
                <div className="flex items-center gap-2.5">
                  <RefreshCw className={`h-4 w-4 ${isCompounding ? 'text-emerald-600' : 'text-muted-foreground'}`} />
                  <span className="text-sm">Reinvest returns</span>
                </div>
                <Toggle
                  checked={isCompounding}
                  onCheckedChange={setIsCompounding}
                  variant="success"
                  className="pointer-events-none"
                />
              </button>
              <button
                onClick={() => setShowComparison(!showComparison)}
                className="flex items-center justify-between w-full py-3"
              >
                <div className="flex items-center gap-2.5">
                  <GitCompare className={`h-4 w-4 ${showComparison ? 'text-primary' : 'text-muted-foreground'}`} />
                  <span className="text-sm">Compare scenarios</span>
                </div>
                <Toggle
                  checked={showComparison}
                  onCheckedChange={setShowComparison}
                  variant="default"
                  className="pointer-events-none"
                />
              </button>
            </div>
          </div>

          {/* Results — two clean stat boxes */}
          <div className="grid grid-cols-2 gap-3 max-w-sm mx-auto">
            <div className="p-4 rounded-xl border border-primary/20 bg-primary/5">
              <p className="text-[10px] font-bold text-primary uppercase tracking-wider mb-1">Contribute</p>
              <AnimatePresence mode="wait">
                <motion.div
                  key={calculations.requiredContribution}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                >
                  <p className="text-lg font-bold tabular-nums leading-tight break-all">
                    {formatUGX(calculations.requiredContribution)}
                  </p>
                  {currency.code !== 'UGX' && (
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      ≈ {formatAmount(calculations.requiredContribution)}
                    </p>
                  )}
                </motion.div>
              </AnimatePresence>
              <p className="text-[9px] text-muted-foreground mt-1">One-time</p>
            </div>

            <div className="p-4 rounded-xl border border-emerald-200/60 dark:border-emerald-800/40 bg-emerald-50/50 dark:bg-emerald-950/20">
              <p className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider mb-1">
                {isCompounding ? `Earn (${duration}mo)` : 'Monthly'}
              </p>
              <AnimatePresence mode="wait">
                <motion.div
                  key={`${isCompounding}-${projections[projections.length - 1]?.totalEarnings}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                >
                  <p className="text-lg font-bold text-emerald-700 dark:text-emerald-400 tabular-nums break-all leading-tight">
                    {formatUGX(isCompounding ? projections[projections.length - 1]?.totalEarnings || 0 : calculations.monthlyReward)}
                  </p>
                  {currency.code !== 'UGX' && (
                    <p className="text-[10px] text-emerald-600 dark:text-emerald-500 mt-0.5">
                      ≈ {formatAmount(isCompounding ? projections[projections.length - 1]?.totalEarnings || 0 : calculations.monthlyReward)}
                    </p>
                  )}
                </motion.div>
              </AnimatePresence>
              <p className="text-[9px] text-muted-foreground mt-1">
                {isCompounding ? 'Reinvested' : 'Every month'}
              </p>
            </div>
          </div>

            {/* Action Buttons - Collapsible on mobile */}
            <Collapsible open={showActions} onOpenChange={setShowActions}>
              <div className="space-y-2">
                {/* Primary actions always visible */}
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    onClick={handleShareWhatsApp}
                    className="gap-1.5 min-h-[44px] text-xs sm:text-sm bg-success/90 hover:bg-success text-success-foreground"
                  >
                    <Share2 className="h-3.5 w-3.5" />
                    WhatsApp
                  </Button>
                  <Button
                    onClick={handleExportPDF}
                    disabled={isExporting}
                    variant="outline"
                    className="gap-1.5 min-h-[44px] text-xs sm:text-sm"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {isExporting ? '...' : 'PDF'}
                  </Button>
                </div>
                
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" className="w-full gap-1.5 text-xs min-h-[44px] text-muted-foreground">
                    {showActions ? 'Less options' : 'More options'}
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showActions ? 'rotate-180' : ''}`} />
                  </Button>
                </CollapsibleTrigger>
                
                <CollapsibleContent className="space-y-2">
                  <Button
                    onClick={handleSharePDFWhatsApp}
                    disabled={isExporting}
                    variant="outline"
                    className="w-full gap-1.5 min-h-[44px] text-xs sm:text-sm"
                  >
                    <Share2 className="h-3.5 w-3.5" />
                    📊 Share Breakdown on WhatsApp
                  </Button>
                  <Button
                    onClick={handleShareEmail}
                    variant="outline"
                    className="w-full gap-1.5 min-h-[44px] text-xs sm:text-sm"
                  >
                    <Mail className="h-3.5 w-3.5" />
                    📧 Share via Email
                  </Button>

                  {/* Save Scenario */}
                  <div className="flex gap-2">
                    <Input
                      placeholder="Scenario name..."
                      value={scenarioName}
                      onChange={(e) => setScenarioName(e.target.value)}
                      className="flex-1 min-h-[44px] text-sm"
                    />
                    <Button
                      onClick={handleSaveScenario}
                      variant="outline"
                      className="gap-1 min-h-[44px] text-xs shrink-0 border-warning/50 text-warning hover:bg-warning/10"
                    >
                      <Save className="h-3.5 w-3.5" />
                      Save
                    </Button>
                  </div>
                  
                  {savedScenarios.length > 0 && (
                    <Button
                      onClick={() => setShowSavedScenarios(!showSavedScenarios)}
                      variant="ghost"
                      className="w-full gap-1.5 min-h-[44px] text-xs"
                    >
                      <Layers className="h-3.5 w-3.5" />
                      {showSavedScenarios ? 'Hide' : 'Show'} Saved ({savedScenarios.length})
                      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showSavedScenarios ? 'rotate-180' : ''}`} />
                    </Button>
                  )}
                </CollapsibleContent>
              </div>
            </Collapsible>
            
            {/* Saved Scenarios */}
            <AnimatePresence>
              {showSavedScenarios && savedScenarios.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div ref={comparisonRef} className="space-y-3 pt-3 border-t border-border/50 bg-background">
                    <div className="hidden print:block p-4 border-b border-border">
                      <h2 className="text-2xl font-bold text-primary" style={{ fontFamily: "'Chewy', cursive" }}>Welile</h2>
                      <p className="text-xs text-muted-foreground">Support Scenarios Comparison • {new Date().toLocaleDateString()}</p>
                    </div>
                    
                    <h4 className="font-bold text-sm flex items-center gap-2">
                      <Layers className="h-4 w-4 text-primary" />
                      Saved ({savedScenarios.length}/5)
                    </h4>
                    
                    <div className="space-y-2">
                      {savedScenarios.map((scenario) => (
                        <div
                          key={scenario.id}
                          className="p-2.5 rounded-xl border border-border/60 bg-card/50 relative"
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-1.5">
                              <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: scenario.color }} />
                              <span className="font-bold text-xs truncate">{scenario.name}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-[10px] px-2"
                                onClick={() => handleLoadScenario(scenario)}
                              >
                                Load
                              </Button>
                              <button
                                onClick={() => handleDeleteScenario(scenario.id)}
                                className="p-1 rounded-lg hover:bg-destructive/10"
                              >
                                <X className="h-3 w-3 text-destructive" />
                              </button>
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-3 text-[11px]">
                            <span>{formatUGX(scenario.requiredContribution)}</span>
                            <span className="text-success font-semibold">→ {formatUGX(scenario.totalEarnings)}</span>
                            <Badge variant="secondary" className="text-[9px] h-4 px-1.5">{scenario.duration}mo</Badge>
                            {scenario.isCompounding && (
                              <Badge variant="outline" className="text-[9px] h-4 px-1.5 gap-0.5">
                                <RefreshCw className="h-2 w-2" /> Yes
                              </Badge>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                    
                    {/* Scenario Chart */}
                    {scenarioComparisonData.length > 0 && (
                      <div className="space-y-2">
                        <h5 className="text-xs font-medium flex items-center gap-1.5">
                          <BarChart3 className="h-3.5 w-3.5 text-primary" />
                          Earnings Comparison
                        </h5>
                        <div className="h-48 sm:h-72">
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={scenarioComparisonData} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
                              <defs>
                                <linearGradient id="currentGradient" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.05} />
                                </linearGradient>
                                {savedScenarios.map((s) => (
                                  <linearGradient key={`grad-${s.id}`} id={`gradient-${s.id}`} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor={s.color} stopOpacity={0.4} />
                                    <stop offset="95%" stopColor={s.color} stopOpacity={0.05} />
                                  </linearGradient>
                                ))}
                              </defs>
                              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                              <XAxis dataKey="month" tick={{ fontSize: 10 }} tickFormatter={(v) => `M${v}`} />
                              <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => {
                                if (v >= 1000000000) return `${(v / 1000000000).toFixed(1)}B`;
                                if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
                                if (v >= 1000) return `${(v / 1000).toFixed(0)}K`;
                                return v.toString();
                              }} />
                              <Tooltip content={({ active, payload, label }) => {
                                if (active && payload && payload.length) {
                                  return (
                                    <div className="bg-background/95 border border-border rounded-lg p-2 shadow-lg text-xs">
                                      <p className="font-semibold mb-1">Month {label}</p>
                                      {payload.map((entry, i) => (
                                        <p key={i} style={{ color: entry.color }}>
                                          {entry.name}: {formatUGX(entry.value as number)}
                                        </p>
                                      ))}
                                    </div>
                                  );
                                }
                                return null;
                              }} />
                              <Legend wrapperStyle={{ fontSize: '10px' }} />
                              <Area type="monotone" dataKey="current" name="Current" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#currentGradient)" />
                              {savedScenarios.map((s) => (
                                <Area key={s.id} type="monotone" dataKey={s.id} name={s.name} stroke={s.color} strokeWidth={2} fill={`url(#gradient-${s.id})`} />
                              ))}
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}
                    
                    {/* Export Comparison */}
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        onClick={handleExportComparisonPDF}
                        disabled={isExportingComparison}
                        size="sm"
                        className="gap-1.5 min-h-[44px] text-xs"
                      >
                        <Download className="h-3.5 w-3.5" />
                        {isExportingComparison ? '...' : 'PDF'}
                      </Button>
                      <Button
                        onClick={handleShareComparisonWhatsApp}
                        variant="outline"
                        size="sm"
                        className="gap-1.5 min-h-[44px] text-xs border-success/50 text-success"
                      >
                        <Share2 className="h-3.5 w-3.5" />
                        WhatsApp
                      </Button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
        </div>
      </div>

      {/* Projection Table & Chart */}
      <div ref={projectionRef} className="bg-background rounded-xl sm:rounded-2xl border border-border overflow-hidden">
        {/* PDF Header */}
        <div className="p-3 sm:p-6 border-b border-border bg-gradient-to-r from-primary/10 to-primary/5">
          <div className="flex items-center justify-between">
            <div>
              <img src={welileWordmark.url} alt="Welile" className="h-6 sm:h-9 w-auto" />
              <p className="text-[10px] sm:text-xs text-muted-foreground">Earnings Projection</p>
            </div>
            <div className="text-right text-[10px] sm:text-sm text-muted-foreground">
              <p className="font-semibold text-foreground text-xs">Report</p>
              <p>{new Date().toLocaleDateString()}</p>
            </div>
          </div>
        </div>

        {/* Summary Stats */}
        <div className="p-3 sm:p-6 border-b border-border">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
            <div className="text-center p-2 sm:p-3 rounded-lg bg-primary/10">
              <p className="text-[10px] sm:text-xs text-muted-foreground mb-0.5">Contribution</p>
              <p className="font-bold text-primary text-xs sm:text-sm">{formatUGX(calculations.requiredContribution)}</p>
            </div>
            <div className="text-center p-2 sm:p-3 rounded-lg bg-success/10">
              <p className="text-[10px] sm:text-xs text-muted-foreground mb-0.5">Rewards</p>
              <p className="font-bold text-success text-xs sm:text-sm">15%</p>
            </div>
            <div className="text-center p-2 sm:p-3 rounded-lg bg-muted">
              <p className="text-[10px] sm:text-xs text-muted-foreground mb-0.5">Duration</p>
              <p className="font-bold text-xs sm:text-sm">{duration}mo</p>
            </div>
            <div className="text-center p-2 sm:p-3 rounded-lg bg-warning/10">
              <p className="text-[10px] sm:text-xs text-muted-foreground mb-0.5">Reinvest</p>
              <p className="font-bold text-warning text-xs sm:text-sm">{isCompounding ? 'Yes' : 'No'}</p>
            </div>
          </div>
        </div>

        {/* Chart */}
        <div className="p-3 sm:p-6 border-b border-border">
          <h3 className="font-bold text-sm sm:text-lg mb-3 flex items-center gap-1.5">
            <BarChart3 className="h-4 w-4 text-primary" />
            {showComparison ? 'Reinvest vs Standard' : 'Earnings Growth'}
          </h3>
          <div className="h-48 sm:h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={showComparison 
                  ? comparisonData 
                  : [
                      { month: 0, balance: calculations.requiredContribution, earnings: 0 },
                      ...projections.map(p => ({
                        month: p.month,
                        balance: p.balance,
                        earnings: p.totalEarnings,
                      }))
                    ]
                }
                margin={{ top: 5, right: 5, left: -15, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="balanceGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="earningsGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--success))" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="hsl(var(--success))" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="compoundGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="simpleGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--warning))" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="hsl(var(--warning))" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis 
                  dataKey="month" 
                  tick={{ fontSize: 10 }}
                  tickFormatter={(value) => `M${value}`}
                />
                <YAxis 
                  tick={{ fontSize: 9 }}
                  tickFormatter={(value) => {
                    if (value >= 1000000000) return `${(value / 1000000000).toFixed(1)}B`;
                    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
                    if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
                    return value.toString();
                  }}
                />
                <Tooltip 
                  content={({ active, payload, label }) => {
                    if (active && payload && payload.length) {
                      return (
                        <div className="bg-background/95 border border-border rounded-lg p-2 shadow-lg text-xs">
                          <p className="font-semibold mb-1">Month {label}</p>
                          {payload.map((entry, index) => (
                            <p key={index} style={{ color: entry.color }}>
                              {entry.name}: {formatUGX(entry.value as number)}
                            </p>
                          ))}
                          {showComparison && label > 0 && (
                            <p className="text-muted-foreground mt-1 border-t border-border pt-1">
                              Diff: {formatUGX(
                                (payload.find(p => p.dataKey === 'compoundingEarnings')?.value as number || 0) -
                                (payload.find(p => p.dataKey === 'simpleEarnings')?.value as number || 0)
                              )}
                            </p>
                          )}
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Legend wrapperStyle={{ fontSize: '10px' }} />
                {showComparison ? (
                  <>
                    <Area type="monotone" dataKey="compoundingEarnings" name="Reinvested" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#compoundGradient)" />
                    <Area type="monotone" dataKey="simpleEarnings" name="Standard" stroke="hsl(var(--warning))" strokeWidth={2} fill="url(#simpleGradient)" />
                  </>
                ) : (
                  <>
                    <Area type="monotone" dataKey="balance" name="Balance" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#balanceGradient)" />
                    <Area type="monotone" dataKey="earnings" name="Earnings" stroke="hsl(var(--success))" strokeWidth={2} fill="url(#earningsGradient)" />
                  </>
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {showComparison && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="p-2 rounded-lg bg-primary/10 border border-primary/30 text-center">
                <p className="text-[10px] text-muted-foreground mb-0.5">Reinvested</p>
                <p className="font-bold text-primary text-xs">{formatUGX(comparisonData[comparisonData.length - 1]?.compoundingEarnings || 0)}</p>
              </div>
              <div className="p-2 rounded-lg bg-warning/10 border border-warning/30 text-center">
                <p className="text-[10px] text-muted-foreground mb-0.5">Standard</p>
                <p className="font-bold text-warning text-xs">{formatUGX(comparisonData[comparisonData.length - 1]?.simpleEarnings || 0)}</p>
              </div>
              <div className="col-span-2 p-2 rounded-lg bg-success/10 border border-success/30 text-center">
                <p className="text-[10px] text-muted-foreground mb-0.5">Extra with Reinvesting</p>
                <p className="font-bold text-success text-xs">
                  +{formatUGX(
                    (comparisonData[comparisonData.length - 1]?.compoundingEarnings || 0) - 
                    (comparisonData[comparisonData.length - 1]?.simpleEarnings || 0)
                  )}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Monthly Breakdown - Collapsible */}
        <Collapsible open={showBreakdown} onOpenChange={setShowBreakdown}>
          <div className="p-3 sm:p-6">
            <CollapsibleTrigger asChild>
              <Button 
                variant="outline" 
                className="w-full justify-between gap-2 min-h-[44px] text-left"
              >
                <div className="flex items-center gap-2">
                  <Coins className="h-4 w-4 text-warning" />
                  <span className="font-bold text-xs sm:text-sm">Monthly Breakdown</span>
                </div>
                <ChevronDown className={`h-4 w-4 transition-transform ${showBreakdown ? 'rotate-180' : ''}`} />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3">
              <div className="overflow-x-auto -mx-3 px-3">
                <table className="w-full text-[11px] sm:text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 px-1.5 font-semibold text-muted-foreground">Mo</th>
                      <th className="text-right py-2 px-1.5 font-semibold text-muted-foreground">Contrib.</th>
                      <th className="text-right py-2 px-1.5 font-semibold text-muted-foreground">Reward</th>
                      <th className="text-right py-2 px-1.5 font-semibold text-muted-foreground">Earned</th>
                      <th className="text-right py-2 px-1.5 font-semibold text-muted-foreground">Bal.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projections.map((row, index) => (
                      <tr 
                        key={row.month} 
                        className={`border-b border-border/50 ${index % 2 === 0 ? 'bg-muted/20' : ''}`}
                      >
                        <td className="py-2 px-1.5 font-medium">{row.month}</td>
                        <td className="py-2 px-1.5 text-right">{formatUGX(row.principal)}</td>
                        <td className="py-2 px-1.5 text-right text-success">+{formatUGX(row.earnings)}</td>
                        <td className="py-2 px-1.5 text-right text-primary font-medium">{formatUGX(row.totalEarnings)}</td>
                        <td className="py-2 px-1.5 text-right font-bold">{formatUGX(row.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-success/10 font-bold">
                      <td className="py-2 px-1.5">Total</td>
                      <td className="py-2 px-1.5 text-right">-</td>
                      <td className="py-2 px-1.5 text-right text-success">-</td>
                      <td className="py-2 px-1.5 text-right text-success">{formatUGX(projections[projections.length - 1]?.totalEarnings || 0)}</td>
                      <td className="py-2 px-1.5 text-right">{formatUGX(projections[projections.length - 1]?.balance || 0)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        {/* Footer */}
        <div className="p-3 sm:p-6 border-t border-border bg-muted/20">
          <div className="space-y-3">
            {/* How It Works - Compact on mobile */}
            <div className="space-y-2 sm:grid sm:grid-cols-3 sm:gap-3 sm:space-y-0">
              <div className="flex items-center gap-2 p-2 rounded-lg bg-background/50 border border-border/50">
                <div className="p-1 rounded-full bg-success/20 shrink-0">
                  <Heart className="h-3 w-3 text-success" />
                </div>
                <div>
                  <p className="text-[10px] font-semibold">Support Tenants</p>
                  <p className="text-[9px] text-muted-foreground hidden sm:block">Help tenants access rent facilitation.</p>
                </div>
              </div>
              <div className="flex items-center gap-2 p-2 rounded-lg bg-background/50 border border-border/50">
                <div className="p-1 rounded-full bg-primary/20 shrink-0">
                  <Shield className="h-3 w-3 text-primary" />
                </div>
                <div>
                  <p className="text-[10px] font-semibold">Trusted Collection</p>
                  <p className="text-[9px] text-muted-foreground hidden sm:block">Collection via agent network.</p>
                </div>
              </div>
              <div className="flex items-center gap-2 p-2 rounded-lg bg-background/50 border border-border/50">
                <div className="p-1 rounded-full bg-warning/20 shrink-0">
                  <Clock className="h-3 w-3 text-warning" />
                </div>
                <div>
                  <p className="text-[10px] font-semibold">90-Day Notice</p>
                  <p className="text-[9px] text-muted-foreground hidden sm:block">Withdraw capital with notice.</p>
                </div>
              </div>
            </div>
            
            {/* Disclaimer */}
            <div className="text-center pt-2 border-t border-border/50 space-y-2">
              <p className="text-[9px] sm:text-[10px] text-muted-foreground leading-relaxed">
                <strong>Disclaimer:</strong>&nbsp;Welile Technologies is a pioneering technology platform that connects tenants seeking rent support with thoroughly verified supporters, enabling seamless facilitation of their housing needs. As a neutral facilitation marketplace only, Welile Technologies is NOT a financial institution, lender, or deposit-taking entity. We don't provide credit, or engage in regulated financial activities.
              </p>
              
              <div className="pt-2">
                <Link to="/become-supporter">
                  <Button 
                    className="w-full gap-2 min-h-[44px] bg-gradient-to-r from-success to-success/80 hover:from-success/90 hover:to-success/70 text-success-foreground font-bold"
                  >
                    <Heart className="h-4 w-4" />
                    Become a Supporter
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </Link>
                <p className="text-[9px] text-muted-foreground mt-1.5">
                  Start earning monthly rewards by supporting tenants
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
