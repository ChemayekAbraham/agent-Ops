import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Building2, HandCoins, MoreVertical, ChevronDown,
  ChevronUp, PlusCircle, BarChart3, Home, Activity,
  Lock, CheckCircle2, Shield, Users, Landmark,
  TrendingUp, Calendar, FileText, Share2, Eye,
  ArrowRight, RefreshCw, Layers, CircleDollarSign } from
'lucide-react';
import { useCurrency } from '@/hooks/useCurrency';
import { calculateSupporterReward } from '@/lib/rentCalculations';

import { hapticTap } from '@/lib/haptics';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger } from
'@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle } from
'@/components/ui/dialog';
import React from 'react';

export interface RentCategory {
  category: string;
  totalHouses: number;
  totalRent: number;
  avgRent: number;
  expectedReturn: number;
}

interface RentCategoryFeedProps {
  onFundCategory: (category: RentCategory) => void;
  isLocked?: boolean;
  onLockedClick?: () => void;
  onRefreshRef?: React.MutableRefObject<(() => Promise<void>) | null>;
}

const CACHE_KEY = 'welile_rent_categories';
const CACHE_TTL = 10 * 60 * 1000;
const VISIBLE_LIMIT = 3;

interface CategoryTier {
  name: string;
  label: string;
  emoji: string;
  rentRange: [number, number];
}

const WELILE_TIERS: CategoryTier[] = [
{ name: 'single-room', label: 'Welile Single Room', emoji: '🚪', rentRange: [0, 150000] },
{ name: 'double-room', label: 'Welile Double Room', emoji: '🛏️', rentRange: [150001, 250000] },
{ name: '1-bed', label: 'Welile 1 Bed House', emoji: '🏠', rentRange: [250001, 400000] },
{ name: '2-bed', label: 'Welile 2 Bedroom House', emoji: '🏡', rentRange: [400001, 700000] },
{ name: '2-bed-full', label: 'Welile 2 Bed + Sitting Room, Kitchen & 2 Toilets', emoji: '🏘️', rentRange: [700001, 1200000] },
{ name: '3-bed', label: 'Welile 3 Bedroom Apartment', emoji: '🏢', rentRange: [1200001, 2500000] },
{ name: '3-bed-luxury', label: 'Welile 3 Bed Luxury + Boys Quarter', emoji: '🏰', rentRange: [2500001, 5000000] },
{ name: '4-bed', label: 'Welile 4+ Bedroom Villa', emoji: '🏛️', rentRange: [5000001, 10000000] },
{ name: 'commercial', label: 'Welile Commercial Property', emoji: '🏪', rentRange: [10000001, Infinity] }];


const getTierForRent = (amount: number): CategoryTier => {
  return WELILE_TIERS.find((t) => amount >= t.rentRange[0] && amount <= t.rentRange[1]) || WELILE_TIERS[0];
};

// ─── Deposit Instructions Dialog (Fund Category) ───
function DepositInstructionsDialog({
  open,
  onOpenChange,
  cat,
  onProceed,
  formatAmount






}: {open: boolean;onOpenChange: (v: boolean) => void;cat: RentCategory;onProceed: () => void;formatAmount: (v: number) => string;}) {
  const monthlyReward = Math.round(cat.totalRent * 0.15);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-2xl" stable>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-black">
            <HandCoins className="h-5 w-5 text-primary" />
            Fund — {cat.category}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-1">
          {/* 90-Day Capital Lock Policy */}
          <div className="rounded-xl border border-amber-200/60 dark:border-amber-800/40 bg-gradient-to-br from-amber-50/50 to-transparent dark:from-amber-950/20 p-4 space-y-2.5">
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-amber-600" />
              <h4 className="text-sm font-black text-foreground">90-Day Capital Lock Policy</h4>
            </div>
            <ul className="space-y-2 text-xs text-muted-foreground leading-relaxed">
              <li className="flex items-start gap-2">
                <span className="mt-1 w-1 h-1 rounded-full bg-muted-foreground/60 shrink-0" />
                <span>Your capital is <strong className="text-foreground">locked for 90 days</strong> — Welile pays rent upfront for tenants, and agents need this window to collect repayments</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1 w-1 h-1 rounded-full bg-muted-foreground/60 shrink-0" />
                <span>During the 90-day lock period, <strong className="text-foreground">your capital is not accessible</strong> for withdrawal</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1 w-1 h-1 rounded-full bg-emerald-500 shrink-0" />
                <span className="text-emerald-700 dark:text-emerald-400 font-medium">Reward payouts continue monthly throughout the lock-in period</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1 w-1 h-1 rounded-full bg-muted-foreground/60 shrink-0" />
                <span>Early withdrawal is <strong className="text-foreground">not permitted</strong> during the 90-day period</span>
              </li>
            </ul>
          </div>

          {/* Supporter Options */}
          <div className="rounded-xl border border-blue-200/50 dark:border-blue-800/40 bg-gradient-to-br from-blue-50/30 to-transparent dark:from-blue-950/20 p-4 space-y-2.5">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-blue-600" />
              <h4 className="text-sm font-black text-foreground">Supporter Options</h4>
            </div>
            <ul className="space-y-2 text-xs text-muted-foreground leading-relaxed">
              <li className="flex items-start gap-2">
                <span className="mt-1 w-1 h-1 rounded-full bg-muted-foreground/60 shrink-0" />
                <span><strong className="text-foreground">Renew Contract</strong> — After 90 days, renew for another cycle to keep earning</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1 w-1 h-1 rounded-full bg-muted-foreground/60 shrink-0" />
                <span><strong className="text-foreground">Top Up</strong> — Add more funds to an existing package anytime</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1 w-1 h-1 rounded-full bg-muted-foreground/60 shrink-0" />
                <span><strong className="text-foreground">Multiple Accounts</strong> — Create up to <strong>12 different support accounts</strong> across categories</span>
              </li>
            </ul>
          </div>

          {/* Verification notice */}
          <div className="rounded-xl border border-border/40 bg-muted/20 p-3 flex items-start gap-2.5">
            <Shield className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              All facilitations are verified by a <strong className="text-foreground">Welile Manager</strong> before your support account is activated. You'll be notified once approved.
            </p>
          </div>

          {/* PDF actions */}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="flex-1 gap-1.5 rounded-xl text-xs font-bold h-9">
              <FileText className="h-3.5 w-3.5" />
              PDF
            </Button>
            <Button variant="outline" size="sm" className="flex-1 gap-1.5 rounded-xl text-xs font-bold h-9 border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10">
              <Share2 className="h-3.5 w-3.5" />
              Share PDF
            </Button>
          </div>

          {/* Accept CTA */}
          <Button
            onClick={() => {hapticTap();onProceed();onOpenChange(false);}}
            className="w-full gap-2 rounded-xl font-black h-12 text-sm bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-700 hover:to-purple-600 shadow-lg shadow-purple-500/25 text-white">
            
            <CheckCircle2 className="h-4 w-4" />
            Accept & Proceed to Deposit
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>);

}

// ─── View Details Dialog ───
function ViewDetailsDialog({
  open,
  onOpenChange,
  cat,
  formatAmount





}: {open: boolean;onOpenChange: (v: boolean) => void;cat: RentCategory;formatAmount: (v: number) => string;}) {
  const monthlyReward = Math.round(cat.totalRent * 0.15);
  const yearlyReward = monthlyReward * 12;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-2xl" stable>
        {/* Hero header */}
        <div className="rounded-xl bg-gradient-to-br from-blue-600 to-blue-700 p-5 -mx-1 text-white space-y-3">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            <div>
              <h3 className="text-base font-black">{cat.category}</h3>
              <p className="text-[11px] text-blue-200 font-medium">Welile Supporters Program</p>
            </div>
          </div>
          <div>
            <p className="text-[10px] text-blue-200 uppercase font-semibold tracking-wider">Facilitation Amount</p>
            <p className="text-2xl font-black tracking-tight">{formatAmount(cat.totalRent)}</p>
          </div>
          <Badge className="bg-emerald-500/20 text-emerald-200 border-emerald-400/30 text-[10px] font-bold">
            15% Monthly Reward
          </Badge>
        </div>

        <div className="space-y-4 mt-2">
          {/* Stats row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-border/40 bg-muted/20 p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Users className="h-3 w-3 text-muted-foreground" />
                <span className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wider">Tenants</span>
              </div>
              <p className="text-xl font-black text-foreground">{cat.totalHouses}</p>
            </div>
            <div className="rounded-xl border border-border/40 bg-muted/20 p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Landmark className="h-3 w-3 text-muted-foreground" />
                <span className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wider">Landlords</span>
              </div>
              <p className="text-xl font-black text-foreground">~{Math.max(1, Math.ceil(cat.totalHouses * 0.7))}</p>
            </div>
          </div>

          {/* Reward cards */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <CircleDollarSign className="h-3 w-3 text-emerald-600" />
                <span className="text-[9px] text-emerald-600 font-semibold uppercase tracking-wider">Monthly Reward</span>
              </div>
              <p className="text-sm font-black text-emerald-600">{formatAmount(monthlyReward)}</p>
            </div>
            <div className="rounded-xl border border-border/40 bg-muted/20 p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Calendar className="h-3 w-3 text-muted-foreground" />
                <span className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wider">12-Mo Rewards</span>
              </div>
              <p className="text-sm font-black text-foreground">{formatAmount(yearlyReward)}</p>
            </div>
          </div>

          {/* How Welile Guarantees */}
          <div className="rounded-xl border border-border/40 bg-muted/10 p-4 space-y-2.5">
            <h4 className="text-sm font-black text-foreground flex items-center gap-2">
              <Shield className="h-4 w-4 text-blue-500" />
              How Welile Guarantees Your Rewards
            </h4>
            <div className="space-y-2">
              {[
              'Welile pays rent upfront for tenants — never in arrears. Your funds are deployed immediately.',
              'Welile Agents hold tenant placement rights — if a tenant defaults, the agent replaces them with a paying tenant.',
              'Defaults do not affect supporters. Welile\'s operational model absorbs and mitigates all default risk.',
              'Your 15% monthly reward is a platform service reward — not an investment return.'].
              map((text, i) =>
              <div key={i} className="flex items-start gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mt-0.5 shrink-0" />
                  <p className="text-xs text-muted-foreground leading-relaxed">{text}</p>
                </div>
              )}
            </div>
          </div>

          {/* Auto-Compound */}
          <div className="rounded-xl border border-border/40 bg-muted/10 p-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-xs font-bold text-foreground">Auto-Compound Rewards</p>
                <p className="text-[10px] text-muted-foreground">Reinvest rewards — tenants supported grow each month</p>
              </div>
            </div>
            <div className="w-10 h-5 rounded-full bg-emerald-500 relative">
              <div className="absolute right-0.5 top-0.5 w-4 h-4 rounded-full bg-card shadow-sm" />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>);

}

// ─── Analytics Dialog (12-Month Reward Schedule) ───
function AnalyticsDialog({
  open,
  onOpenChange,
  cat,
  formatAmount





}: {open: boolean;onOpenChange: (v: boolean) => void;cat: RentCategory;formatAmount: (v: number) => string;}) {
  const monthlyReward = Math.round(cat.totalRent * 0.15);
  const totalRewards = monthlyReward * 12;
  const now = new Date();

  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
    return {
      month: i + 1,
      date: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
      reward: monthlyReward
    };
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-2xl" stable>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-black">
            <TrendingUp className="h-5 w-5 text-blue-500" />
            12-Month Reward Schedule
          </DialogTitle>
          <p className="text-xs text-muted-foreground font-medium">{cat.category}</p>
        </DialogHeader>

        <div className="space-y-4 mt-1">
          {/* Schedule table */}
          <div className="rounded-xl border border-border/40 overflow-hidden">
            {/* Header */}
            <div className="grid grid-cols-3 gap-2 px-4 py-2.5 bg-muted/30 border-b border-border/30">
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Month</span>
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Date</span>
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-right">Reward</span>
            </div>
            {/* Rows */}
            <div className="max-h-[320px] overflow-y-auto">
              {months.map((m, i) =>
              <div
                key={i}
                className={`grid grid-cols-3 gap-2 px-4 py-2.5 text-xs ${
                i % 2 === 0 ? 'bg-transparent' : 'bg-muted/10'} ${
                i < months.length - 1 ? 'border-b border-border/20' : ''}`}>
                
                  <span className="font-medium text-foreground">Month {m.month}</span>
                  <span className="text-muted-foreground font-medium">{m.date}</span>
                  <span className="text-right font-bold text-emerald-600">+{formatAmount(m.reward)}</span>
                </div>
              )}
            </div>
            {/* Total row */}
            <div className="grid grid-cols-3 gap-2 px-4 py-3 bg-muted/30 border-t border-border/40">
              <span className="text-xs font-black text-foreground col-span-2">Total Rewards</span>
              <span className="text-right text-sm font-black text-emerald-600">{formatAmount(totalRewards)}</span>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>);

}

// ─── Share Dialog ───
function ShareDialog({
  open,
  onOpenChange,
  cat




}: {open: boolean;onOpenChange: (v: boolean) => void;cat: RentCategory;}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm rounded-2xl" stable>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-black">
            <Share2 className="h-5 w-5 text-blue-500" />
            Share — {cat.category}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 mt-2">
          <Button variant="outline" className="w-full gap-2 rounded-xl font-bold h-11 text-sm">
            <FileText className="h-4 w-4" />
            Download PDF Report
          </Button>
          <Button className="w-full gap-2 rounded-xl font-bold h-11 text-sm border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 bg-emerald-500/5" variant="outline">
            <Share2 className="h-4 w-4" />
            Share PDF via Link
          </Button>
          <p className="text-[10px] text-muted-foreground text-center">
            Share your support category details securely with partners.
          </p>
        </div>
      </DialogContent>
    </Dialog>);

}

// ─── Empty State ───
function EmptyState({ onAdd }: {onAdd: () => void;}) {
  return (
    <div
      className="flex flex-col items-center justify-center py-14 px-6 rounded-2xl border border-blue-200/30 dark:border-blue-900/30 bg-gradient-to-br from-blue-50/40 via-white to-blue-100/20 dark:from-blue-950/20 dark:via-card dark:to-blue-900/10 shadow-sm">
      
      <div className="p-4 rounded-2xl bg-blue-500/10 dark:bg-blue-500/15 mb-5">
        <BarChart3 className="h-8 w-8 text-blue-500" />
      </div>
      <h4 className="text-lg font-black text-foreground tracking-tight mb-1.5">
        No Support Categories
      </h4>
      <p className="text-sm text-muted-foreground font-medium text-center max-w-[260px] mb-6">
        Start building your support account by adding your first category.
      </p>
      <Button
        onClick={() => {hapticTap();onAdd();}}
        className="gap-2 rounded-xl font-bold h-11 px-6 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600 shadow-lg shadow-blue-500/20 text-white">
        
        <PlusCircle className="h-4 w-4" />
        Add Category
      </Button>
    </div>);

}

// ─── Category Card ───
function CategoryCard({
  cat,
  index,
  tier,
  isLocked,
  onFund,
  onLockedClick,
  formatAmount,
  comingSoon









}: {cat: RentCategory;index: number;tier: CategoryTier | undefined;isLocked?: boolean;onFund: () => void;onLockedClick?: () => void;formatAmount: (v: number) => string;comingSoon?: boolean;}) {
  const [showDeposit, setShowDeposit] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showShare, setShowShare] = useState(false);

  const utilization = Math.min(cat.totalHouses / 20 * 100, 100);

  return (
    <>
      <div
        className="group relative rounded-2xl border overflow-hidden transition-all duration-300 border-blue-200/40 dark:border-blue-900/30 bg-gradient-to-br from-white via-blue-50/20 to-blue-100/10 dark:from-card dark:via-blue-950/10 dark:to-blue-900/5 shadow-sm hover:shadow-md hover:shadow-blue-500/8 hover:border-blue-300/60 dark:hover:border-blue-700/50">
        
        {/* Card header */}
        <div className="p-4 pb-3 flex items-start justify-between">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl shrink-0 bg-blue-500/10 dark:bg-blue-500/15">
              {tier?.emoji || '🏠'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-bold text-sm text-foreground leading-tight truncate">{cat.category}</p>
              <p className="text-[11px] text-muted-foreground font-medium mt-0.5">
                {cat.totalHouses} {cat.totalHouses === 1 ? 'house' : 'houses'} available
              </p>
            </div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="p-1.5 rounded-lg hover:bg-muted/60 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                onClick={(e) => e.stopPropagation()}>
                
                <MoreVertical className="h-4 w-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                className="text-xs font-medium gap-2"
                onClick={() => setShowDetails(true)}>
                
                <Eye className="h-3.5 w-3.5" />
                View Details
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs font-medium gap-2"
                onClick={() => setShowAnalytics(true)}>
                
                <TrendingUp className="h-3.5 w-3.5" />
                Analytics
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs font-medium gap-2"
                onClick={() => setShowShare(true)}>
                
                <Share2 className="h-3.5 w-3.5" />
                Share
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Metrics */}
        <div className="px-4 pb-3 space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">Utilization</span>
              <span className="text-[10px] font-bold text-purple-600 dark:text-purple-400">{utilization.toFixed(0)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-purple-100/60 dark:bg-purple-900/30 overflow-hidden">
              <div
                style={{ width: `${utilization}%` }}
                className="h-full rounded-full bg-gradient-to-r from-purple-400 to-purple-500 transition-all duration-500" />
              
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-blue-500/5 dark:bg-blue-500/8 p-2">
              <p className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wider mb-0.5">Avg. Rent</p>
              <p className="text-xs font-black text-foreground">{formatAmount(cat.avgRent)}</p>
            </div>
            <div className="rounded-lg bg-emerald-500/5 dark:bg-emerald-500/8 p-2">
              <p className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wider mb-0.5">Expected Return</p>
              <p className="text-xs font-black text-emerald-600 dark:text-emerald-400">+{formatAmount(cat.expectedReturn)}</p>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="px-4 pb-4">
          {comingSoon ?
          <Button
            size="sm"
            disabled
            className="w-full gap-1.5 rounded-xl font-bold text-xs h-9 bg-purple-500/20 text-purple-600 dark:text-purple-400 cursor-not-allowed border border-purple-500/30">
            
              <Lock className="h-3.5 w-3.5" />
              Coming Soon
            </Button> :

          <Button
            size="sm"
            onClick={() => {
              hapticTap();
              if (isLocked) {onLockedClick?.();return;}
              setShowDeposit(true);
            }}
            className="w-full gap-1.5 rounded-xl font-bold text-xs h-9 bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-700 hover:to-purple-600 shadow-md shadow-purple-500/20 text-white">
            
              <HandCoins className="h-3.5 w-3.5" />
              Fund Category
            </Button>
          }
        </div>
      </div>

      {/* Dialogs */}
      <DepositInstructionsDialog
        open={showDeposit}
        onOpenChange={setShowDeposit}
        cat={cat}
        onProceed={() => onFund()}
        formatAmount={formatAmount} />
      
      <ViewDetailsDialog
        open={showDetails}
        onOpenChange={setShowDetails}
        cat={cat}
        formatAmount={formatAmount} />
      
      <AnalyticsDialog
        open={showAnalytics}
        onOpenChange={setShowAnalytics}
        cat={cat}
        formatAmount={formatAmount} />
      
      <ShareDialog
        open={showShare}
        onOpenChange={setShowShare}
        cat={cat} />
      
    </>);

}

// ─── Main Component ───
export function RentCategoryFeed({ onFundCategory, isLocked, onLockedClick, onRefreshRef }: RentCategoryFeedProps) {
  const { formatAmount } = useCurrency();
  const [categories, setCategories] = useState<RentCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  const fetchCategories = useCallback(async () => {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < CACHE_TTL && data?.length === WELILE_TIERS.length) {
          setCategories(data);
          setLoading(false);
          return;
        }
      }
    } catch {}

    setLoading(true);

    const { data, error } = await supabase.
    from('rent_requests').
    select('id, rent_amount, request_city, duration_days, house_category').
    eq('status', 'approved').
    limit(200);

    const tierMap = new Map<string, {tier: CategoryTier;count: number;totalRent: number;totalReward: number;}>();
    WELILE_TIERS.forEach((t) => tierMap.set(t.name, { tier: t, count: 0, totalRent: 0, totalReward: 0 }));

    if (!error && data) {
      data.forEach((r) => {
        const amount = Number(r.rent_amount);
        const houseCategory = (r as any).house_category as string | null;
        const tier = houseCategory ?
        WELILE_TIERS.find((t) => t.name === houseCategory) || getTierForRent(amount) :
        getTierForRent(amount);
        const existing = tierMap.get(tier.name)!;
        existing.count += 1;
        existing.totalRent += amount;
        existing.totalReward += calculateSupporterReward(amount);
      });
    }

    const cats: RentCategory[] = Array.from(tierMap.values()).
    map((v) => ({
      category: v.tier.label,
      totalHouses: v.count,
      totalRent: v.totalRent,
      avgRent: v.count > 0 ? Math.round(v.totalRent / v.count) : 0,
      expectedReturn: v.totalReward
    }));

    setCategories(cats);
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data: cats, timestamp: Date.now() }));
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  useEffect(() => {
    if (onRefreshRef) {
      onRefreshRef.current = fetchCategories;
      return () => {onRefreshRef.current = null;};
    }
  }, [onRefreshRef, fetchCategories]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-48 rounded-lg bg-muted/50 animate-pulse" />
        <div className="space-y-3">
          {[1, 2, 3].map((i) =>
          <div key={i} className="h-44 rounded-2xl bg-muted/30 animate-pulse" />
          )}
        </div>
      </div>);

  }

  const totalHouses = categories.reduce((s, c) => s + c.totalHouses, 0);
  const hasCategories = categories.length > 0;
  const visibleCategories = showAll ? categories : categories.slice(0, VISIBLE_LIMIT);
  const hasMore = categories.length > VISIBLE_LIMIT;

  return (
    <div className="space-y-4">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 shadow-md shadow-blue-500/20 bg-primary">
            <Building2 className="h-5 w-5 text-white" />
          </div>
          <div>
            <h3 className="font-black text-foreground text-base tracking-tight">Support Categories</h3>
            <p className="text-[11px] text-muted-foreground font-medium">
              {hasCategories ?
              `${totalHouses} houses across ${categories.length} tiers` :
              'No categories configured yet'
              }
            </p>
          </div>
        </div>
        {hasCategories &&
        <Badge className="text-[9px] px-2 py-0.5 bg-emerald-500/10 text-emerald-600 border-emerald-500/30 font-bold uppercase tracking-wider gap-1">
            <Activity className="h-2.5 w-2.5" />
            {categories.length} Tiers
          </Badge>
        }
      </div>

      {/* Content */}
      {!hasCategories ?
      <EmptyState onAdd={() => setShowAddModal(true)} /> :

      <>
          <div className="space-y-3">
            
              {[...visibleCategories].sort((a, b) => {
                const aComingSoon = a.category !== 'Welile Double Room';
                const bComingSoon = b.category !== 'Welile Double Room';
                return Number(aComingSoon) - Number(bComingSoon);
              }).map((cat, i) => {
              const tier = WELILE_TIERS.find((t) => t.label === cat.category);
              const isComingSoon = cat.category !== 'Welile Double Room';
              return (
                <CategoryCard
                  key={cat.category}
                  cat={cat}
                  index={i}
                  tier={tier}
                  isLocked={isLocked}
                  onFund={() => onFundCategory(cat)}
                  onLockedClick={onLockedClick}
                  formatAmount={formatAmount}
                  comingSoon={isComingSoon} />);


            })}
            
          </div>

          {hasMore &&
        <div
          className="flex justify-center pt-1">
          
              <Button
            variant="ghost"
            size="sm"
            onClick={() => {hapticTap();setShowAll(!showAll);}}
            className="gap-1.5 text-xs font-bold text-blue-600 dark:text-blue-400 hover:bg-blue-500/10">
            
                {showAll ?
            <>Show Less <ChevronUp className="h-3.5 w-3.5" /></> :

            <>View All {categories.length} Categories <ChevronDown className="h-3.5 w-3.5" /></>
            }
              </Button>
            </div>
        }
        </>
      }

      {/* Add Category Modal */}
      <Dialog open={showAddModal} onOpenChange={setShowAddModal}>
        <DialogContent className="sm:max-w-md rounded-2xl border-blue-200/40 dark:border-blue-900/30 bg-gradient-to-br from-white via-blue-50/20 to-white dark:from-card dark:via-blue-950/10 dark:to-card">
          <DialogHeader>
            <div className="flex items-center gap-3 mb-1">
              <div className="p-2 rounded-xl bg-blue-500/10">
                <PlusCircle className="h-5 w-5 text-blue-500" />
              </div>
              <DialogTitle className="text-lg font-black tracking-tight">Add Support Category</DialogTitle>
            </div>
            <p className="text-sm text-muted-foreground font-medium pl-12">
              Configure a new tier for your support account.
            </p>
          </DialogHeader>
          <div className="py-8 flex flex-col items-center justify-center text-center">
            <div className="p-3 rounded-2xl bg-muted/30 mb-4">
              <Home className="h-6 w-6 text-muted-foreground/60" />
            </div>
            <p className="text-sm text-muted-foreground font-medium">
              Category configuration coming soon.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>);

}