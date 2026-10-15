import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  X, Search, AlertCircle, Wallet, ArrowDownToLine, ArrowUpFromLine, Send, Users, UserPlus, Home,
  FileText, Calculator, MapPin, Trophy, BarChart3, HelpCircle, Settings, User, LogOut, Monitor,
  Building2, Receipt, type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

interface MenuItem {
  name: string;
  icon: LucideIcon;
  route?: string;
  action?: 'sign_out' | 'desktop';
  keywords?: string;
  /** Icon tint tone — each item gets its own hue while staying theme-consistent. */
  tone: keyof typeof toneClasses;
}

const toneClasses = {
  violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  blue: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  green: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  rose: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  cyan: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
  indigo: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  orange: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  teal: 'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  slate: 'bg-slate-500/10 text-slate-600 dark:text-slate-400',
  danger: 'bg-destructive/10 text-destructive',
} as const;

interface MenuSection { title: string; items: MenuItem[] }

const menuData: MenuSection[] = [
  { title: 'Money', items: [
    { name: 'Wallet', icon: Wallet, keywords: 'balance float', tone: 'violet' },
    { name: 'Deposit', icon: ArrowDownToLine, keywords: 'top up', tone: 'blue' },
    { name: 'Withdraw', icon: ArrowUpFromLine, keywords: 'cash out', tone: 'amber' },
    { name: 'Send Money', icon: Send, keywords: 'transfer', tone: 'rose' },
  ]},
  { title: 'Tenants', items: [
    { name: 'My Tenants', icon: Users, tone: 'blue' },
    { name: 'Register Tenant', icon: UserPlus, keywords: 'onboard new', tone: 'green' },
    { name: 'Rent Requests', icon: FileText, keywords: 'rent plan', tone: 'violet' },
    { name: 'Collections', icon: Receipt, keywords: 'payments', tone: 'teal' },
  ]},
  { title: 'Properties', items: [
    { name: 'Find Rentals', icon: Home, route: '/find-a-house', keywords: 'house listing', tone: 'orange' },
    { name: 'Landlords', icon: Building2, tone: 'cyan' },
    { name: 'Map View', icon: MapPin, keywords: 'location', tone: 'indigo' },
  ]},
  { title: 'Tools', items: [
    { name: 'Calculator', icon: Calculator, keywords: 'rent', tone: 'blue' },
    { name: 'Leaderboard', icon: Trophy, route: '/dashboard/agent', keywords: 'rank', tone: 'green' },
    { name: 'Reports', icon: BarChart3, tone: 'violet' },
  ]},
  { title: 'Account', items: [
    { name: 'Profile', icon: User, route: '/settings', tone: 'blue' },
    { name: 'Settings', icon: Settings, route: '/settings', tone: 'slate' },
    { name: 'Help', icon: HelpCircle, route: 'https://help.welileapp.com/', keywords: 'support', tone: 'amber' },
    { name: 'Use Desktop Version', icon: Monitor, action: 'desktop', route: '/dashboard/agent', tone: 'indigo' },
    { name: 'Sign Out', icon: LogOut, action: 'sign_out', keywords: 'logout', tone: 'danger' },
  ]},
];

interface Props { open: boolean; onClose: () => void }

export function AgentHubDrawer({ open, onClose }: Props) {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => { if (!open) setSearchQuery(''); }, [open]);
  useEffect(() => {
    if (!toastMessage) return;
    const t = setTimeout(() => setToastMessage(null), 2200);
    return () => clearTimeout(t);
  }, [toastMessage]);

  const filteredData = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return menuData;
    return menuData
      .map((s) => ({ ...s, items: s.items.filter((i) => `${i.name} ${i.keywords ?? ''} ${s.title}`.toLowerCase().includes(query)) }))
      .filter((s) => s.items.length > 0);
  }, [searchQuery]);

  const handleItemClick = (item: MenuItem) => {
    onClose();
    setTimeout(() => {
      if (item.action === 'sign_out') signOut();
      else if (item.route?.startsWith('http')) window.open(item.route, '_blank', 'noopener,noreferrer');
      else if (item.route) navigate(item.route);
      else setToastMessage(`"${item.name}" is coming soon`);
    }, 200);
  };

  return (
    <>
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={onClose}
              className="fixed inset-0 bg-foreground/45 z-[105] cursor-pointer"
            />
            <motion.div
              role="dialog" aria-label="Agent Hub"
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 220 }}
              className="fixed bottom-0 left-0 right-0 max-w-md mx-auto max-h-[88vh] min-h-[420px] bg-muted text-foreground rounded-t-3xl shadow-xl z-[110] flex flex-col overflow-hidden border-t border-border"
            >
              <div className="w-full flex justify-center py-2 shrink-0 cursor-pointer" onClick={onClose}>
                <div className="w-10 h-1 bg-border rounded-full" />
              </div>

              <div className="px-4 pb-3 flex items-center justify-between shrink-0">
                <h2 className="text-base font-bold">More Actions</h2>
                <button
                  onClick={onClose}
                  className="h-8 w-8 rounded-full bg-border/60 flex items-center justify-center text-muted-foreground hover:bg-border active:scale-95 transition-all focus:outline-none focus:ring-2 focus:ring-primary"
                  aria-label="Close menu"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="px-4 pb-3 shrink-0">
                <div className="relative flex items-center w-full bg-card border border-border rounded-lg h-12 px-3.5 transition-all focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
                  <Search className="h-5 w-5 text-muted-foreground shrink-0" />
                  <input
                    type="text" value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search actions, forms, settings..."
                    className="w-full h-full bg-transparent text-sm font-semibold placeholder:text-muted-foreground focus:outline-none pl-3"
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery('')} aria-label="Clear search"
                      className="h-7 w-7 rounded-full flex items-center justify-center text-muted-foreground hover:bg-muted focus:outline-none">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-4 pb-12">
                {filteredData.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <AlertCircle className="h-8 w-8 text-destructive mb-2 opacity-50" />
                    <p className="text-xs font-semibold mb-0.5">No matching actions found</p>
                    <p className="text-[10px] text-muted-foreground max-w-[200px]">Try a different term, like "tenant" or "wallet".</p>
                  </div>
                ) : (
                  <div className="space-y-6 mt-2">
                    {filteredData.map((section) => (
                      <div key={section.title} className="space-y-3">
                        <h3 className="text-xs font-bold text-muted-foreground tracking-wider uppercase pl-0.5">{section.title}</h3>
                        <div className="grid grid-cols-2 gap-2.5">
                          {section.items.map((item) => {
                            const Icon = item.icon;
                            return (
                              <button
                                key={item.name}
                                onClick={() => handleItemClick(item)}
                                className="flex items-center gap-3 p-3 bg-card border border-border rounded-2xl hover:bg-accent active:scale-[0.98] transition-all text-left focus:outline-none focus:ring-1 focus:ring-primary"
                              >
                                <div className={`h-8 w-8 rounded-xl flex items-center justify-center shrink-0 ${toneClasses[item.tone]}`}>
                                  <Icon className="h-4 w-4 stroke-[2.2]" />
                                </div>
                                <span className="text-[11px] font-bold leading-tight">{item.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: 30, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 30, scale: 0.95 }}
            className="fixed bottom-20 left-1/2 -translate-x-1/2 bg-foreground/90 backdrop-blur-sm text-background text-[11px] font-bold py-2.5 px-4 rounded-xl shadow-lg z-[999] pointer-events-none max-w-[280px] text-center"
          >
            {toastMessage}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default AgentHubDrawer;
