import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Home, UserPlus, Coins, Percent, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import heroAsset from '@/assets/agent-list-register-earn.png.asset.json';

const STORAGE_KEY = 'welile.listRegisterEarnDialog.dismissedAt';
const SUPPRESS_MS = 12 * 60 * 60 * 1000; // once every 12 hours

interface Props {
  onListHouse: () => void;
  onRegisterTenant: () => void;
}

/**
 * On-load earnings dialog for agents: list an empty house + register the tenant
 * on it and earn UGX 12,000 plus the standard rent commissions (8% / 10%).
 */
export function ListRegisterEarnDialog({ onListHouse, onRegisterTenant }: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      const dismissedAt = Number(localStorage.getItem(STORAGE_KEY) || '0');
      if (dismissedAt && Date.now() - dismissedAt < SUPPRESS_MS) return;
    } catch {}
    const t = setTimeout(() => setOpen(true), 900);
    return () => clearTimeout(t);
  }, []);

  const close = () => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {}
    setOpen(false);
  };

  const act = (fn: () => void) => {
    close();
    setTimeout(fn, 200);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent
        className="w-[calc(100vw-1rem)] sm:w-full max-w-sm p-0 gap-0 overflow-hidden max-h-[90dvh] flex flex-col rounded-2xl [&>button]:hidden"
      >
        {/* Hero image — shorter on small screens so copy stays visible */}
        <div className="relative shrink-0">
          <img
            src={heroAsset.url}
            alt="House listing, checklist, phone and wallet with coins illustrating agent earnings"
            width={1664}
            height={950}
            loading="lazy"
            className="w-full h-24 sm:h-32 object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-transparent" />
          <button
            onClick={close}
            aria-label="Close"
            className="absolute top-2 right-2 h-8 w-8 rounded-full flex items-center justify-center bg-background/90 text-foreground hover:bg-background shadow-sm"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="absolute bottom-2 left-3 right-3">
            <h2 className="text-base sm:text-lg font-bold leading-tight text-foreground">
              List + register, earn twice
            </h2>
          </div>
        </div>

        <div className="p-3 sm:p-4 space-y-3 overflow-y-auto">
          {/* Headline amounts */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-2xl border border-warning/40 bg-warning/10 p-3">
              <div className="flex items-center gap-1.5 text-warning">
                <Coins className="h-3.5 w-3.5" />
                <span className="text-[10px] font-bold uppercase tracking-wider">Bonus</span>
              </div>
              <p className="mt-0.5 text-lg sm:text-2xl font-bold tabular-nums text-foreground">UGX 12,000</p>
              <p className="text-[11px] text-muted-foreground leading-snug">One-off</p>
            </div>
            <div className="rounded-2xl border border-success/40 bg-success/10 p-3">
              <div className="flex items-center gap-1.5 text-success">
                <Percent className="h-3.5 w-3.5" />
                <span className="text-[10px] font-bold uppercase tracking-wider">Commission</span>
              </div>
              <p className="mt-0.5 text-lg sm:text-2xl font-bold tabular-nums text-foreground">8% – 10%</p>
              <p className="text-[11px] text-muted-foreground leading-snug">Every rent cycle</p>
            </div>
          </div>

          {/* Condensed steps */}
          <ol className="flex flex-col gap-1.5 text-[12px] text-foreground">
            <li className="flex items-center gap-2 rounded-xl bg-muted/40 px-3 py-2">
              <span className="h-5 w-5 shrink-0 rounded-full bg-primary/15 text-primary text-[11px] font-bold flex items-center justify-center">1</span>
              <span><strong>List</strong> an empty house</span>
            </li>
            <li className="flex items-center gap-2 rounded-xl bg-muted/40 px-3 py-2">
              <span className="h-5 w-5 shrink-0 rounded-full bg-primary/15 text-primary text-[11px] font-bold flex items-center justify-center">2</span>
              <span><strong>Register</strong> the tenant moving in</span>
            </li>
            <li className="flex items-center gap-2 rounded-xl bg-muted/40 px-3 py-2">
              <span className="h-5 w-5 shrink-0 rounded-full bg-primary/15 text-primary text-[11px] font-bold flex items-center justify-center">3</span>
              <span><strong>Get paid</strong> into your wallet</span>
            </li>
          </ol>

          {/* CTA stack — thumb-friendly on mobile */}
          <div className="flex flex-col gap-2 pt-1">
            <Button onClick={() => act(onListHouse)} className="gap-2 font-semibold h-11 text-base text-white">
              <Home className="h-4 w-4" /> List a house
            </Button>
            <Button variant="outline" onClick={() => act(onRegisterTenant)} className="gap-2 font-semibold h-11 text-base">
              <UserPlus className="h-4 w-4" /> Register a tenant
            </Button>
          </div>
          <button
            onClick={close}
            className="w-full text-[12px] text-muted-foreground py-2 hover:text-foreground"
          >
            Maybe later
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ListRegisterEarnDialog;