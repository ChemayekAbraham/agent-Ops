import { useMemo, useState } from 'react';
import { format, subDays, subMonths, startOfMonth } from 'date-fns';
import { CalendarRange, FileDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import {
  loadPeriodStatement, generatePeriodStatementPdf, generatePeriodStatementCsv,
  categoryLabel, type PeriodStatement,
} from '@/lib/walletPeriodStatement';

type Format = 'pdf' | 'csv';
type Dir = 'all' | 'cash_in' | 'cash_out';

const ymd = (d: Date) => format(d, 'yyyy-MM-dd');

export function WalletPeriodStatementButton() {
  const { user, profile } = useAuth() as any;
  const today = new Date();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(ymd(subMonths(today, 3)));
  const [to, setTo] = useState(ymd(today));
  const [busy, setBusy] = useState(false);
  const [fmt, setFmt] = useState<Format>('pdf');
  const [dir, setDir] = useState<Dir>('all');
  const [cat, setCat] = useState('all');
  const [src, setSrc] = useState('all');
  const [loaded, setLoaded] = useState<PeriodStatement | null>(null);
  const [loadedRange, setLoadedRange] = useState('');

  const presets = [
    { label: 'Last 7 days', from: subDays(today, 7) },
    { label: 'Last 30 days', from: subDays(today, 30) },
    { label: 'This month', from: startOfMonth(today) },
    { label: 'Last 3 months', from: subMonths(today, 3) },
    { label: 'Last 12 months', from: subMonths(today, 12) },
  ];

  const invalid = !from || !to || from > to || to > ymd(today);
  const rangeKey = `${from}|${to}`;

  const load = async () => {
    if (!user?.id || invalid) return;
    setBusy(true);
    try {
      const st = await loadPeriodStatement(user.id, from, to);
      setLoaded(st);
      setLoadedRange(rangeKey);
      setDir('all'); setCat('all'); setSrc('all');
      toast.success(`Period loaded: ${st.rows.length} transaction${st.rows.length === 1 ? '' : 's'}. Pick filters, then download.`);
    } catch (e: any) {
      console.error('[WalletPeriodStatement]', e);
      toast.error(e?.message || 'Could not load the period. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const categories = useMemo(() => {
    if (!loaded) return [] as string[];
    return [...new Set(loaded.rows.map((r) => categoryLabel(r.category, r.description)))].sort();
  }, [loaded]);

  const sources = useMemo(() => {
    if (!loaded) return [] as string[];
    return [...new Set(loaded.rows.map((r) => r.source_table || 'Unknown'))].sort();
  }, [loaded]);

  const filtered = useMemo<PeriodStatement | null>(() => {
    if (!loaded) return null;
    const rows = loaded.rows.filter((r) =>
      (dir === 'all' || r.direction === dir) &&
      (cat === 'all' || categoryLabel(r.category, r.description) === cat) &&
      (src === 'all' || (r.source_table || 'Unknown') === src));
    return {
      ...loaded,
      rows,
      totalIn: rows.filter((r) => r.direction === 'cash_in').reduce((s, r) => s + r.amount, 0),
      totalOut: rows.filter((r) => r.direction === 'cash_out').reduce((s, r) => s + r.amount, 0),
    };
  }, [loaded, dir, cat, src]);

  const download = async () => {
    if (!filtered) return;
    setBusy(true);
    try {
      const owner = { name: profile?.full_name || 'Welile user', phone: profile?.phone };
      const blob = fmt === 'pdf'
        ? await generatePeriodStatementPdf(filtered, owner)
        : generatePeriodStatementCsv(filtered, owner);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Welile_Wallet_Statement_${from}_to_${to}.${fmt}`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Statement ready (${fmt.toUpperCase()}): ${filtered.rows.length} transaction${filtered.rows.length === 1 ? '' : 's'}`);
      setOpen(false);
    } catch (e: any) {
      console.error('[WalletPeriodStatement]', e);
      toast.error(e?.message || 'Could not create the statement. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!user?.id) return null;

  const stale = loaded && loadedRange !== rangeKey;

  return (
    <>
      <Button variant="outline" size="sm" className="w-full gap-2 text-xs mb-4" onClick={() => setOpen(true)}>
        <CalendarRange className="h-3.5 w-3.5" />
        Statement for any period (PDF or CSV)
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl max-h-[90vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Wallet statement</SheetTitle>
            <SheetDescription>Choose the dates, load the period, narrow it with filters, then download.</SheetDescription>
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
            <Button className="w-full" variant="secondary" disabled={busy || invalid} onClick={load}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {busy ? 'Loading…' : loaded && !stale ? 'Reload this period' : 'Load this period'}
            </Button>

            {loaded && !stale && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label>Money</Label>
                    <select className="w-full h-9 rounded-md border border-input bg-background px-2 text-xs"
                      value={dir} onChange={(e) => setDir(e.target.value as Dir)}>
                      <option value="all">In and out</option>
                      <option value="cash_in">Money in only</option>
                      <option value="cash_out">Money out only</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label>Category</Label>
                    <select className="w-full h-9 rounded-md border border-input bg-background px-2 text-xs"
                      value={cat} onChange={(e) => setCat(e.target.value)}>
                      <option value="all">All categories</option>
                      {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label>Source</Label>
                    <select className="w-full h-9 rounded-md border border-input bg-background px-2 text-xs"
                      value={src} onChange={(e) => setSrc(e.target.value)}>
                      <option value="all">All sources</option>
                      {sources.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Showing {filtered?.rows.length ?? 0} of {loaded.rows.length} transactions.
                </p>
                <div className="space-y-1">
                  <Label>File format</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {(['pdf', 'csv'] as Format[]).map((f) => (
                      <Button key={f} type="button" size="sm" variant={fmt === f ? 'default' : 'outline'} className="text-xs"
                        onClick={() => setFmt(f)}>
                        {f === 'pdf' ? 'PDF (statement)' : 'CSV (spreadsheet)'}
                      </Button>
                    ))}
                  </div>
                </div>
                <Button className="w-full gap-2" disabled={busy || !filtered?.rows.length} onClick={download}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
                  {busy ? 'Preparing…' : `Download ${fmt.toUpperCase()}`}
                </Button>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
