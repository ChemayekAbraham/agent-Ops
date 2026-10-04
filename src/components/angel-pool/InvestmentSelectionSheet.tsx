import { TrendingUp, Shield, Home, Clock, Coins, BarChart3, Lock, Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from '@/components/ui/drawer';

export type PoolType = 'tenant' | 'angel';

interface InvestmentSelectionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (pool: PoolType) => void;
}

function OptionCards({ onSelect }: { onSelect: (pool: PoolType) => void }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4">
      {/* Tenant Support Pool */}
      <div className="rounded-2xl border border-border/80 bg-card p-4 space-y-3 flex flex-col">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-success/10">
            <Home className="h-4 w-4 text-success" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-black text-sm text-foreground tracking-tight">Tenant Support Pool</h3>
          </div>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Fund verified rent requests, earn monthly returns
        </p>
        <div className="space-y-2 flex-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <TrendingUp className="h-3 w-3" /> Monthly Return
            </span>
            <span className="font-bold text-success">15%</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <Clock className="h-3 w-3" /> Deploy Speed
            </span>
            <span className="font-bold">24–72hrs</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <Coins className="h-3 w-3" /> Payout
            </span>
            <span className="font-bold">Monthly</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 pt-1">
          <Shield className="h-3 w-3 text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground font-medium">Verified & insured</span>
        </div>
        <Button
          onClick={() => onSelect('tenant')}
          variant="success"
          className="w-full h-11 rounded-2xl text-sm font-bold gap-2"
        >
          <Home className="h-4 w-4" />
          Support Tenant
        </Button>
      </div>

      {/* Angel Pool */}
      <div className="rounded-2xl border border-border/80 bg-card p-4 space-y-3 flex flex-col">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-primary/10">
            <Rocket className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-black text-sm text-foreground tracking-tight">Angel Pool</h3>
          </div>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Own shares in Welile's future growth
        </p>
        <div className="space-y-2 flex-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <BarChart3 className="h-3 w-3" /> Equity
            </span>
            <span className="font-bold text-primary">Up to 8%</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <Lock className="h-3 w-3" /> Horizon
            </span>
            <span className="font-bold">Long-term</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <Coins className="h-3 w-3" /> Ownership
            </span>
            <span className="font-bold">Shares</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 pt-1">
          <Rocket className="h-3 w-3 text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground font-medium">Early-stage opportunity</span>
        </div>
        <Button
          onClick={() => onSelect('angel')}
          className="w-full h-11 rounded-2xl text-sm font-bold gap-2"
        >
          <Rocket className="h-4 w-4" />
          Invest in Angel Pool
        </Button>
      </div>
    </div>
  );
}

export function InvestmentSelectionSheet({ open, onOpenChange, onSelect }: InvestmentSelectionSheetProps) {
  const isMobile = useIsMobile();

  const handleSelect = (pool: PoolType) => {
    onSelect(pool);
    onOpenChange(false);
  };

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[90vh]">
          <DrawerHeader className="text-left">
            <DrawerTitle className="text-base font-black">Choose Your Investment</DrawerTitle>
            <DrawerDescription className="text-xs">
              Select where to allocate your capital
            </DrawerDescription>
          </DrawerHeader>
          <div className="overflow-y-auto pb-6">
            <OptionCards onSelect={handleSelect} />
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base font-black">Choose Your Investment</DialogTitle>
          <DialogDescription className="text-xs">
            Select where to allocate your capital
          </DialogDescription>
        </DialogHeader>
        <OptionCards onSelect={handleSelect} />
      </DialogContent>
    </Dialog>
  );
}
