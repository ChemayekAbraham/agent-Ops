import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  Home, Wallet, Building2, Shield, Users, UsersRound, FileText, Banknote,
  ShoppingCart, Receipt, ChartBar, Award, Download, ClipboardList, Calendar, Activity, Menu
} from 'lucide-react';

type ManagerHub = 'home' | 'wallets' | 'rent-investments' | 'buffer';

interface DesktopManagerSidebarProps {
  activeHub: ManagerHub;
  onHubChange: (hub: ManagerHub) => void;
  onScrollToProductivity?: () => void;
}

const hubItems: { id: ManagerHub; icon: typeof Home; label: string; description: string }[] = [
  { id: 'home', icon: Home, label: 'Overview', description: 'KPIs & quick actions' },
  { id: 'wallets', icon: Wallet, label: 'Wallets', description: 'Deposits & withdrawals' },
  { id: 'rent-investments', icon: Building2, label: 'Rent Management', description: 'Requests & receivables' },
  { id: 'buffer', icon: Shield, label: 'Buffer Account', description: 'Solvency & coverage' },
];

const quickLinks = [
  { icon: Calendar, label: 'Schedules', path: '/users' },
  { icon: Users, label: 'Company Stuff', path: '/users' },
  { icon: UsersRound, label: 'Platform Users', path: '/platform-users' },
  { icon: FileText, label: 'Rent Requests', path: '/manager-access' },
  { icon: Banknote, label: 'Loans', path: '/manager-access?tab=loans' },
  { icon: ShoppingCart, label: 'Orders', path: '/manager-access?tab=orders' },
  { icon: Receipt, label: 'Receipts', path: '/manager-access?tab=receipts' },
  { icon: ChartBar, label: 'Finance', path: '/manager-access?tab=financials' },
  { icon: ClipboardList, label: 'Audit Log', path: '/audit-log' },
];

export function DesktopManagerSidebar({ activeHub, onHubChange, onScrollToProductivity }: DesktopManagerSidebarProps) {
  const navigate = useNavigate();

  return (
    <aside className="hidden lg:flex flex-col w-64 min-h-screen border-r border-border bg-card/50 p-4 gap-6 sticky top-0 overflow-y-auto">
      {/* Hub Navigation */}
      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3 px-2">
          Dashboard
        </p>
        <nav className="space-y-1">
          {hubItems.map((item) => (
            <button
              key={item.id}
              onClick={() => onHubChange(item.id)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors',
                activeHub === item.id
                  ? 'bg-primary/10 text-primary font-semibold'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm truncate">{item.label}</p>
                <p className="text-[10px] text-muted-foreground truncate">{item.description}</p>
              </div>
            </button>
          ))}
        </nav>
        {/* Admin Dashboard Access */}
        <button
          onClick={() => navigate('/admin/dashboard')}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left text-muted-foreground hover:bg-muted hover:text-foreground transition-colors mt-1"
        >
          <Activity className="h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm truncate">Admin Hub</p>
            <p className="text-[10px] text-muted-foreground truncate">Executive & Ops access</p>
          </div>
        </button>
      </div>

      {/* Quick Links */}
      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3 px-2">
          Quick Access
        </p>
        <nav className="space-y-0.5">
          {quickLinks.map((item) => (
            <button
              key={item.label}
              onClick={() => navigate(item.path)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <item.icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Bottom Actions */}
      <div className="mt-auto space-y-2">
        {onScrollToProductivity && (
          <button
            onClick={onScrollToProductivity}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <Award className="h-4 w-4" />
            <span>Productivity</span>
          </button>
        )}
        <button
          onClick={() => navigate('/install')}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <Download className="h-4 w-4" />
          <span>Share App</span>
        </button>

        {/* Floating-style Menu Button */}
        <div className="flex justify-center pt-3">
          <button
            onClick={() => navigate('/manager-access')}
            className="h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 flex items-center justify-center hover:bg-primary/90 hover:shadow-xl transition-all active:scale-95 ring-2 ring-background"
          >
            <Menu className="h-6 w-6" />
          </button>
        </div>
      </div>
    </aside>
  );
}
