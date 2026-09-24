import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Search, UserCheck } from 'lucide-react';
import { invokeShareFn, useInvalidateShares } from './useShareOnboarding';

const PRICE = 20_000, TOTAL = 25_000, POOL = 8;
const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString('en-US')}`;

interface Person { id: string; full_name: string | null; phone: string | null; email: string | null }

export default function CreateShareholderDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const invalidate = useInvalidateShares();
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picked, setPicked] = useState<Person | null>(null);
  const [np, setNp] = useState({ fullName: '', phone: '', email: '' });
  const [amountStr, setAmountStr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { if (!open) { setPicked(null); setQ(''); setAmountStr(''); setNp({ fullName: '', phone: '', email: '' }); } }, [open]);

  const { data: people = [], isFetching } = useQuery({
    queryKey: ['share-person-search', debounced],
    enabled: open && mode === 'existing' && debounced.length >= 2 && !picked,
    queryFn: async () => {
      const s = debounced.replace(/[%,()]/g, '');
      const { data, error } = await supabase.from('profiles').select('id, full_name, phone, email')
        .or(`full_name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%`).limit(8);
      if (error) throw error;
      return (data ?? []) as Person[];
    },
  });

  const { data: balance } = useQuery({
    queryKey: ['share-person-balance', picked?.id],
    enabled: !!picked,
    queryFn: async () => {
      // Shares are funded from the operational float, not withdrawable.
      const { data } = await supabase.from('wallets').select('float_balance').eq('user_id', picked!.id).maybeSingle();
      return Number(data?.float_balance ?? 0);
    },
  });

  const amount = Number(amountStr.replace(/[^0-9]/g, '')) || 0;
  const calc = useMemo(() => {
    const shares = amount / PRICE;
    return { shares, pool: (shares / TOTAL) * 100, company: (shares / TOTAL) * POOL };
  }, [amount]);

  const canSubmit = amount >= PRICE && (mode === 'existing' ? !!picked
    : np.fullName.trim().length >= 3 && np.phone.trim().length >= 7 && /\S+@\S+\.\S+/.test(np.email));

  const submit = async () => {
    setBusy(true);
    try {
      const res = await invokeShareFn('create-share-onboarding', {
        amount,
        ...(mode === 'existing' ? { shareholderId: picked!.id } : { newPerson: np }),
      });
      toast({
        title: 'Shares created',
        description: res.emailed ? `Signing link emailed to ${res.email}.` : 'No email on file — copy the signing link from the list to share it.',
      });
      invalidate();
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: 'Could not create shares', description: e.message, variant: 'destructive' });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add new shareholder</DialogTitle>
          <DialogDescription>Shares are paid from the shareholder's operational float when you countersign.</DialogDescription>
        </DialogHeader>

        <Tabs value={mode} onValueChange={(v) => { setMode(v as any); setPicked(null); }}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="existing">Existing user</TabsTrigger>
            <TabsTrigger value="new">New person</TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === 'existing' ? (
          picked ? (
            <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 font-medium"><UserCheck className="h-4 w-4 text-primary" />{picked.full_name || 'Unnamed'}</p>
                <p className="truncate text-xs text-muted-foreground">{[picked.phone, picked.email].filter(Boolean).join(' • ')}</p>
                <p className="mt-1 text-xs">Operational float: <strong>{balance === undefined ? '…' : ugx(balance)}</strong></p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>Change</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input className="pl-8" placeholder="Search name, phone or email" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              {isFetching && <p className="text-xs text-muted-foreground">Searching…</p>}
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {people.map((p) => (
                  <button key={p.id} type="button" onClick={() => setPicked(p)}
                    className="w-full rounded-md border px-3 py-2 text-left hover:bg-muted">
                    <p className="text-sm font-medium">{p.full_name || 'Unnamed'}</p>
                    <p className="truncate text-xs text-muted-foreground">{[p.phone, p.email].filter(Boolean).join(' • ')}</p>
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          <div className="grid gap-3">
            <div><Label>Full name</Label><Input value={np.fullName} onChange={(e) => setNp({ ...np, fullName: e.target.value })} /></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div><Label>Phone</Label><Input value={np.phone} onChange={(e) => setNp({ ...np, phone: e.target.value })} /></div>
              <div><Label>Email</Label><Input type="email" value={np.email} onChange={(e) => setNp({ ...np, email: e.target.value })} /></div>
            </div>
            <p className="text-xs text-muted-foreground">An account is created for them. They need money in their operational float before you can countersign.</p>
          </div>
        )}

        <div>
          <Label>Amount (UGX)</Label>
          <Input inputMode="numeric" placeholder="e.g. 1,000,000" value={amount ? amount.toLocaleString('en-US') : amountStr}
            onChange={(e) => setAmountStr(e.target.value)} />
          <p className="mt-1 text-xs text-muted-foreground">UGX 20,000 per share • minimum 1 share</p>
        </div>

        <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 p-3 text-center">
          <div><p className="text-[11px] text-muted-foreground">Shares</p><p className="font-semibold">{calc.shares.toLocaleString('en-US', { maximumFractionDigits: 2 })}</p></div>
          <div><p className="text-[11px] text-muted-foreground">Pool</p><p className="font-semibold">{calc.pool.toFixed(4)}%</p></div>
          <div><p className="text-[11px] text-muted-foreground">Company</p><p className="font-semibold">{calc.company.toFixed(4)}%</p></div>
        </div>
        {picked && balance !== undefined && amount > balance && (
          <p className="text-xs text-destructive">Operational float is below this amount — countersigning will be refused until it is topped up.</p>
        )}

        <Button className="w-full" disabled={!canSubmit || busy} onClick={submit}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create shares & send email
        </Button>
      </DialogContent>
    </Dialog>
  );
}
