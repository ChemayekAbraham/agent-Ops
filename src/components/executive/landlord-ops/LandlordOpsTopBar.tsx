import { useState } from 'react';
import { Search, Calendar as CalendarIcon, Bell, Settings, ChevronDown, X, Menu } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { LandlordOpsSidebar } from './LandlordOpsSidebar';

interface TopBarProps {
  activePath: string;
  onNavigate: (path: string) => void;
  badges?: Record<string, number>;
}

export function LandlordOpsTopBar({ activePath, onNavigate, badges }: TopBarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [dateText, setDateText] = useState('Thu, 4 Sep 2026');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="h-14 border-b border-border bg-card px-4 lg:px-6 flex items-center justify-between sticky top-0 z-30 shadow-xs">
      {/* Left: Mobile Trigger + Logo & Title */}
      <div className="flex items-center gap-3">
        <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 lg:hidden" aria-label="Open menu">
              <Menu className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0">
            <div className="p-4 border-b border-border flex items-center gap-2">
              <span className="font-black text-base tracking-tight text-[#0FA958]">WELILE</span>
              <span className="text-xs font-bold text-foreground">Landlord Operations</span>
            </div>
            <LandlordOpsSidebar
              activePath={activePath}
              onNavigate={(p) => {
                onNavigate(p);
                setMobileMenuOpen(false);
              }}
              badges={badges}
            />
          </SheetContent>
        </Sheet>

        <div className="flex items-center gap-2 cursor-pointer" onClick={() => onNavigate('')}>
          <span className="font-black text-base lg:text-lg tracking-tight text-[#0FA958]">WELILE</span>
          <span className="text-xs lg:text-sm font-bold text-foreground pl-1 border-l border-border">
            Landlord Operations
          </span>
        </div>
      </div>

      {/* Right: Search, Date, Notifications, Settings, Profile */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Search Input */}
        <div className="relative hidden md:block w-64 lg:w-80">
          <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search landlords, houses, requests, LC1..."
            className="h-8 pl-8 pr-7 text-xs bg-muted/30 border-border rounded-lg"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Date Chip */}
        <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border bg-background text-xs text-muted-foreground hover:text-foreground cursor-pointer">
          <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-[11px] text-foreground">{dateText}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setDateText(new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }));
            }}
            className="hover:text-destructive text-muted-foreground ml-0.5"
          >
            <X className="h-3 w-3" />
          </button>
        </div>

        {/* Notification Bell with Badge 3 */}
        <div className="relative">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
            <Bell className="h-4 w-4" />
          </Button>
          <span className="absolute 1 top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold text-white ring-2 ring-card">
            3
          </span>
        </div>

        {/* Settings Button */}
        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
          <Settings className="h-4 w-4" />
        </Button>

        {/* User Profile */}
        <div className="flex items-center gap-2 pl-1 sm:pl-2 border-l border-border cursor-pointer group">
          <div className="h-7 w-7 rounded-full bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 flex items-center justify-center font-bold text-[10px]">
            JW
          </div>
          <div className="hidden xl:block text-left leading-tight">
            <p className="text-xs font-semibold text-foreground group-hover:text-[#0FA958] transition-colors">
              Joshua Wanda
            </p>
            <p className="text-[10px] text-muted-foreground">Landlord Ops</p>
          </div>
          <ChevronDown className="h-3 w-3 text-muted-foreground hidden xl:block" />
        </div>
      </div>
    </header>
  );
}
