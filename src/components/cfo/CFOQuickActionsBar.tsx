import {
  BarChart3, Banknote, Wallet, Home, ShieldCheck, BookOpen,
  TrendingUp, ClipboardList, Receipt, Landmark, HandCoins,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';

type Action = {
  id: string;
  label: string;
  icon: typeof BarChart3;
  group: 'nav' | 'approvals' | 'reports' | 'exports';
};

/**
 * One-tap shortcuts to the CFO's most-used views. Horizontally scrollable and
 * sticky to the top of the dashboard content so it stays reachable on a phone.
 * Each chip just switches the dashboard's active tab.
 */
const ACTIONS: Action[] = [
  { id: 'overview', label: 'Home', icon: BarChart3, group: 'nav' },
  { id: 'wallet-payout', label: 'Send Money', icon: Wallet, group: 'nav' },
  // Approvals
  { id: 'rent-payouts', label: 'Rent Payouts', icon: Banknote, group: 'approvals' },
  { id: 'landlord-payout-float', label: 'Landlord Float', icon: Home, group: 'approvals' },
  { id: 'withdrawals', label: 'Withdrawals', icon: Wallet, group: 'approvals' },
  { id: 'merchant-float', label: 'Merchant Float', icon: HandCoins, group: 'approvals' },
  { id: 'unfunding-approvals', label: 'Mark-Not-Funded', icon: ShieldCheck, group: 'approvals' },
  { id: 'already-funded-landlords', label: 'Funded Landlords', icon: Landmark, group: 'approvals' },
  // Reports
  { id: 'statements', label: 'Financial Reports', icon: BookOpen, group: 'reports' },
  { id: 'revenue-expenses', label: 'Revenue & Expenses', icon: TrendingUp, group: 'reports' },
  { id: 'rent-collections', label: 'Rent Collections', icon: Receipt, group: 'reports' },
  // Exports / ledger
  { id: 'ledger', label: 'Full Ledger', icon: ClipboardList, group: 'exports' },
  { id: 'advanced-ledgers', label: 'Detailed Ledgers', icon: BookOpen, group: 'exports' },
];

const GROUP_LABEL: Record<Action['group'], string> = {
  nav: 'Go to',
  approvals: 'Approvals',
  reports: 'Reports',
  exports: 'Exports',
};

const GROUP_ORDER: Action['group'][] = ['nav', 'approvals', 'reports', 'exports'];

export function CFOQuickActionsBar({
  activeTab,
  onJump,
}: {
  activeTab: string;
  onJump: (tab: string) => void;
}) {
  return (
    <div className="sticky top-0 z-30 -mx-2 sm:-mx-4 lg:-mx-6 mb-4 bg-muted/40 backdrop-blur border-b border-border">
      <div className="flex items-center gap-2.5 overflow-x-auto px-2 sm:px-4 lg:px-6 py-3 no-scrollbar">
        {GROUP_ORDER.map((group, gi) => {
          const items = ACTIONS.filter((a) => a.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="flex items-center gap-2 shrink-0">
              {gi > 0 && <span className="h-8 w-px bg-border shrink-0 mx-1" aria-hidden />}
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground shrink-0 hidden sm:inline">
                {GROUP_LABEL[group]}
              </span>
              {items.map((a) => {
                const Icon = a.icon;
                const isActive = activeTab === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => {
                      hapticTap();
                      onJump(a.id);
                    }}
                    className={cn(
                      'flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold whitespace-nowrap shrink-0 transition-colors active:scale-95 touch-manipulation border shadow-sm',
                      isActive
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card text-foreground border-border hover:bg-accent hover:text-accent-foreground',
                    )}
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    {a.label}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}