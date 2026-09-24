import { useState } from 'react';
import { format, subDays, subMonths, startOfMonth } from 'date-fns';
import { CalendarRange, FileDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { loadPeriodStatement, generatePeriodStatementPdf } from '@/lib/walletPeriodStatement';

const ymd = (d: Date) => format(d, 'yyyy-MM-dd');

export function WalletPeriodStatementButton() {
  const { user, profile } = useAuth() as any;
  const today = new Date();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(ymd(subMonths(today, 3)));
  const [to, setTo] = useState(ymd(today));
  const [busy, setBusy] = useState(false);

  const presets = [
    { label: 'Last 7 days', from: subDays(today, 7) },
    { label: 'Last 30 days', from: subDays(today, 30) },
    { label: 'This month', from: startOfMonth(today) },
    { label: 'Last 3 months', from: subMonths(today, 3) },
    { label: 'Last 12 months', from: subMonths(today, 12) },
  ];

  const invalid = !from || !to || from > to || to > ymd(today);

  const generate = async () => {
    if (!user?.id || invalid) return;
    setBusy(true);
    try {
      const st = await loadPeriodStatement(user.id, from, to);
      const blob = await generatePeriodStatementPdf(st, { name: profile?.full_name || 'Welile user', phone: profile?.phone });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Welile_Wallet_Statement_${from}_to_${to}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Statement ready: ${st.rows.length} transaction${st.rows.length === 1 ? '' : 's'}`);
      setOpen(false);
    } catch (e: any) {
      console.error('[WalletPeriodStatement]', e);
      toast.error(e?.message || 'Could not create the statement. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!user?.id) return null;

  return (
    <>
      <Button variant="outline" size="sm" className="w-full gap-2 text-xs mb-4" onClick={() => setOpen(true)}>
        <CalendarRange className="h-3.5 w-3.5" />
        Statement for any period (PDF)
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader>
            <SheetTitle>Wallet statement</SheetTitle>
            <SheetDescription>Choose the dates. You get every transaction, totals, and where money came from and went.</SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap gap-2">
              {presets.map((p) => {
                const active = from === ymd(p.from) && to === ymd(today);
                return (
                  <Button key={p.label} size="sm" variant={active ? 'default' : 'outline'} className="text-xs"
                    onClick={() => { setFrom(ymd(p.from)); setTo(ymd(today)); }}>
                    {p.label}
                  </Button>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="stmt-from">From</Label>
                <Input id="stmt-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="stmt-to">To</Label>
                <Input id="stmt-to" type="date" value={to} min={from} max={ymd(today)} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
            {invalid && <p className="text-xs text-destructive">Pick a start date on or before the end date, and not in the future.</p>}
            <Button className="w-full gap-2" disabled={busy || invalid} onClick={generate}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
              {busy ? 'Preparing…' : 'Download statement'}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
