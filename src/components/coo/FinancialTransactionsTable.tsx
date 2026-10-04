import { useState, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { Search, Loader2, Download, ChevronLeft, ChevronRight, Wallet, Banknote, HandCoins, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

const PAGE_SIZE = 50;

function KpiCard({ icon: Icon, label, value, hint, tone }: { icon: any; label: string; value: string; hint?: string; tone: string }) {
  return (
    <Card className="border-l-4" style={{ borderLeftColor: 'transparent' }}>
      <CardContent className="p-3">
        <div className="flex items-start gap-2">
          <div className={`p-1.5 rounded-md ${tone}`}><Icon className="h-4 w-4" /></div>
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground truncate">{label}</p>
            <p className="text-base sm:text-lg font-bold leading-tight break-words">{value}</p>
            {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function FinancialTransactionsTable() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [directionFilter, setDirectionFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<any | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearch = useCallback((value: string) => {
    setSearch(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(0);
    }, 400);
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ['coo-ledger-transactions', debouncedSearch, directionFilter, categoryFilter, page],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_paginated_transactions', {
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
        p_direction: directionFilter === 'all' ? null : directionFilter,
        p_category: categoryFilter === 'all' ? null : categoryFilter,
        p_search: debouncedSearch || null,
      });
      if (error) throw error;
      return data || [];
    },
    staleTime: 2 * 60 * 1000,
  });

  const transactions = data || [];
  const totalCount = transactions.length > 0 ? Number(transactions[0].total_count) : 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const { data: kpis, isLoading: kpisLoading } = useQuery({
    queryKey: ['coo-transaction-kpis'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_coo_transaction_kpis');
      if (error) throw error;
      return data as any;
    },
    staleTime: 5 * 60 * 1000,
  });

  // Fetch categories once (lightweight)
  const { data: categories = [] } = useQuery({
    queryKey: ['ledger-categories'],
    queryFn: async () => {
      const { data } = await supabase
        .from('general_ledger')
        .select('category')
        .limit(200);
      if (!data) return [];
      return [...new Set(data.map(t => t.category))].sort();
    },
    staleTime: 10 * 60 * 1000,
  });

  const exportCSV = () => {
    const headers = ['Date', 'Reference', 'Category', 'Direction', 'Amount', 'Linked Party', 'Description'];
    const rows = transactions.map((t: any) => [
      t.transaction_date, t.reference_id || '', t.category, t.direction,
      t.amount, t.linked_party || '', (t.description || '').replace(/,/g, ' '),
    ]);
    const csv = [headers.join(','), ...rows.map((r: any) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transactions-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
  };

  return (
    <div className="space-y-4">
      {kpisLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[74px] w-full" />)}
        </div>
      ) : kpis ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard icon={HandCoins} label="Agent commission earned" value={formatUGX(Number(kpis.agent_commission_earned || 0))} hint="From rent collection commissions" tone="bg-emerald-500/10 text-emerald-600" />
          <KpiCard icon={Banknote} label="Float used in rent repayments" value={formatUGX(Number(kpis.float_used_in_rent || 0))} hint="Agent float spent collecting rent" tone="bg-amber-500/10 text-amber-600" />
          <KpiCard icon={Wallet} label="Agent float balances" value={formatUGX(Number(kpis.agent_float_balance || 0))} hint={`${Number(kpis.agent_float_agents || 0)} agents with collection history`} tone="bg-sky-500/10 text-sky-600" />
          <KpiCard icon={Home} label="Total spent in rent collection" value={formatUGX(Number(kpis.rent_collection_spend || 0))} hint="Landlord float disbursement" tone="bg-violet-500/10 text-violet-600" />
        </div>
      ) : null}

    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <CardTitle className="text-lg">Financial Transactions</CardTitle>
            {totalCount > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {totalCount.toLocaleString()} total transactions
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search ref, party, category..." value={search} onChange={e => handleSearch(e.target.value)} className="pl-9 h-9" />
            </div>
            <Select value={directionFilter} onValueChange={v => { setDirectionFilter(v); setPage(0); }}>
              <SelectTrigger className="w-[110px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Flow</SelectItem>
                <SelectItem value="cash_in">Cash In</SelectItem>
                <SelectItem value="cash_out">Cash Out</SelectItem>
              </SelectContent>
            </Select>
            <Select value={categoryFilter} onValueChange={v => { setCategoryFilter(v); setPage(0); }}>
              <SelectTrigger className="w-[140px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map(c => <SelectItem key={c} value={c}>{c.replace(/_/g, ' ')}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={exportCSV} className="h-9">
              <Download className="h-3.5 w-3.5 mr-1" /> CSV
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
        ) : (
          <>
            <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Linked Party</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Direction</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transactions.length === 0 ? (
                    <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No transactions found</TableCell></TableRow>
                  ) : transactions.map((tx: any) => (
                    <TableRow key={tx.id} onClick={() => setSelected(tx)} className="cursor-pointer">
                      <TableCell className="text-xs max-w-[180px] truncate">{tx.linked_party || '—'}</TableCell>
                      <TableCell><Badge variant="outline" className="text-[10px]">{tx.category.replace(/_/g, ' ')}</Badge></TableCell>
                      <TableCell>
                        <Badge variant={tx.direction === 'cash_in' ? 'default' : 'secondary'} className="text-[10px]">
                          {tx.direction === 'cash_in' ? '↓ IN' : '↑ OUT'}
                        </Badge>
                      </TableCell>
                      <TableCell className={`text-right font-semibold whitespace-nowrap ${tx.direction === 'cash_in' ? 'text-emerald-600' : 'text-foreground'}`}>
                        {tx.direction === 'cash_in' ? '+' : '-'}{formatUGX(tx.amount)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {format(new Date(tx.transaction_date), 'MMM d, yyyy')}<br />
                        <span className="text-muted-foreground">{format(new Date(tx.transaction_date), 'HH:mm')}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {/* Server-side pagination controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t">
                <p className="text-xs text-muted-foreground">
                  Page {page + 1} of {totalPages.toLocaleString()} · {totalCount.toLocaleString()} records
                </p>
                <div className="flex gap-1">
                  <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)} className="h-8 w-8 p-0">
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} className="h-8 w-8 p-0">
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>

      <Dialog open={!!selected} onOpenChange={o => !o && setSelected(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle className="text-base">Transaction details</DialogTitle></DialogHeader>
          {selected && (
            <div className="space-y-3 text-sm">
              <div className={`text-2xl font-bold ${selected.direction === 'cash_in' ? 'text-emerald-600' : 'text-foreground'}`}>
                {selected.direction === 'cash_in' ? '+' : '-'}{formatUGX(selected.amount)}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[
                  ['Linked party', selected.linked_party || '—'],
                  ['Category', String(selected.category || '').replace(/_/g, ' ')],
                  ['Direction', selected.direction === 'cash_in' ? 'Cash in' : 'Cash out'],
                  ['Date', format(new Date(selected.transaction_date), 'MMM d, yyyy HH:mm')],
                  ['Reference', selected.reference_id || '—'],
                  ['Flow scope', selected.ledger_scope || '—'],
                ].map(([k, v]) => (
                  <div key={String(k)}>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</p>
                    <p className="font-medium break-words">{v as string}</p>
                  </div>
                ))}
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Description</p>
                <p className="break-words">{selected.description || '—'}</p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
