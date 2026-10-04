import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { Search, Loader2, ArrowDownLeft, ArrowUpRight, X } from 'lucide-react';

interface LedgerResult {
  id: string;
  amount: number;
  direction: string;
  category: string;
  description: string | null;
  linked_party: string | null;
  reference_id: string | null;
  transaction_date: string;
  user_id: string | null;
  ledger_scope: string;
  source_table: string;
}

export function TransactionSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LedgerResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [profileMap, setProfileMap] = useState<Map<string, string>>(new Map());

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);

    try {
      const q = query.trim();

      // Multi-strategy search: reference_id, linked_party, description, user phone
      const [byRef, byParty, byDesc] = await Promise.all([
        supabase.from('general_ledger')
          .select('*')
          .ilike('reference_id', `%${q}%`)
          .order('transaction_date', { ascending: false })
          .limit(50),
        supabase.from('general_ledger')
          .select('*')
          .ilike('linked_party', `%${q}%`)
          .order('transaction_date', { ascending: false })
          .limit(50),
        supabase.from('general_ledger')
          .select('*')
          .ilike('description', `%${q}%`)
          .order('transaction_date', { ascending: false })
          .limit(50),
      ]);

      // Merge and deduplicate
      const allData = [...(byRef.data || []), ...(byParty.data || []), ...(byDesc.data || [])];
      const seen = new Set<string>();
      const unique: LedgerResult[] = [];
      for (const item of allData) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          unique.push(item);
        }
      }

      // Also search by phone number → find user → find their transactions
      if (/^\d{4,}$/.test(q)) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .ilike('phone', `%${q}%`)
          .limit(10);

        if (profiles?.length) {
          const userIds = profiles.map(p => p.id);
          const { data: userTx } = await supabase
            .from('general_ledger')
            .select('*')
            .in('user_id', userIds)
            .order('transaction_date', { ascending: false })
            .limit(50);

          for (const tx of userTx || []) {
            if (!seen.has(tx.id)) {
              seen.add(tx.id);
              unique.push(tx);
            }
          }

          // Build profile map
          const newMap = new Map(profileMap);
          profiles.forEach(p => newMap.set(p.id, p.full_name || p.phone || ''));
          setProfileMap(newMap);
        }
      }

      // Sort by date descending
      unique.sort((a, b) => new Date(b.transaction_date).getTime() - new Date(a.transaction_date).getTime());

      // Resolve user names for results
      const userIds = [...new Set(unique.filter(u => u.user_id && !profileMap.has(u.user_id)).map(u => u.user_id!))];
      if (userIds.length > 0) {
        const batches: string[][] = [];
        for (let i = 0; i < userIds.length; i += 50) batches.push(userIds.slice(i, i + 50));
        const newMap = new Map(profileMap);
        for (const batch of batches) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, full_name, phone')
            .in('id', batch);
          profiles?.forEach(p => newMap.set(p.id, p.full_name || p.phone || ''));
        }
        setProfileMap(newMap);
      }

      setResults(unique.slice(0, 100));
    } catch (err) {
      console.error('Search error:', err);
    } finally {
      setLoading(false);
    }
  }, [query, profileMap]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Search className="h-4 w-4 text-primary" /> Transaction Search
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search by TID, phone, name, description, reference…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && search()}
              className="pl-9 h-9 text-sm"
            />
            {query && (
              <button onClick={() => { setQuery(''); setResults([]); setSearched(false); }}
                className="absolute right-3 top-1/2 -translate-y-1/2">
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
          <Button size="sm" onClick={search} disabled={loading || !query.trim()} className="h-9">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Search'}
          </Button>
        </div>

        {searched && (
          <p className="text-xs text-muted-foreground">
            {loading ? 'Searching…' : `${results.length} result${results.length !== 1 ? 's' : ''} found`}
          </p>
        )}

        <ScrollArea className="max-h-[450px]">
          <div className="space-y-1">
            {results.map(tx => (
              <div key={tx.id} className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors">
                <div className={`p-1.5 rounded-lg ${tx.direction === 'cash_in' ? 'bg-emerald-500/10' : 'bg-destructive/10'}`}>
                  {tx.direction === 'cash_in'
                    ? <ArrowDownLeft className="h-3.5 w-3.5 text-emerald-600" />
                    : <ArrowUpRight className="h-3.5 w-3.5 text-destructive" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-medium truncate">
                      {tx.user_id && profileMap.has(tx.user_id) ? profileMap.get(tx.user_id) : tx.linked_party || 'Unknown'}
                    </p>
                    <Badge variant="outline" className="text-[9px] px-1 shrink-0">{tx.category.replace(/_/g, ' ')}</Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {tx.description || '—'}
                  </p>
                  <p className="text-[10px] text-muted-foreground/70">
                    Ref: {(tx.reference_id || '—').slice(0, 16)} · {format(new Date(tx.transaction_date), 'MMM d, yyyy HH:mm')}
                    {tx.ledger_scope !== 'wallet' && <> · <span className="text-amber-600">{tx.ledger_scope}</span></>}
                  </p>
                </div>
                <p className={`text-sm font-bold tabular-nums whitespace-nowrap ${tx.direction === 'cash_in' ? 'text-emerald-600' : 'text-destructive'}`}>
                  {tx.direction === 'cash_in' ? '+' : '-'}{formatUGX(tx.amount)}
                </p>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
