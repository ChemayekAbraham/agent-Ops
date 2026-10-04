import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Download, Loader2, Search, Database } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { format } from 'date-fns';

type ProfileMatch = { id: string; full_name: string | null; phone: string | null; email: string | null };

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// This screen exports raw general_ledger rows -- the entire ledger in one
// shot, or one specific user's full financial history -- to a plain CSV
// file with no logging at all beyond a toast. That is exactly the bulk
// data-exfiltration risk the "tie every action to an IP" series exists for.
// Plain client-side insert so the audit_logs IP-capture trigger (item 8)
// sees the real browser IP directly. Never blocks the actual export.
async function logLedgerExport(actionType: 'bulk_ledger_export_all' | 'ledger_export_single_user', rowCount: number, targetUserId?: string) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('audit_logs').insert({
      user_id: user?.id ?? null,
      action_type: actionType,
      table_name: 'general_ledger',
      record_id: targetUserId ?? null,
      metadata: { row_count: rowCount, target_user_id: targetUserId ?? null },
    });
  } catch (e) {
    console.warn('[CTOLedgerExport] audit log insert failed:', e);
  }
}

export function CTOLedgerExport() {
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<ProfileMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportingAll, setExportingAll] = useState(false);
  const [allProgress, setAllProgress] = useState(0);

  const runSearch = async () => {
    const term = search.trim();
    if (term.length < 3) {
      toast({ title: 'Enter at least 3 characters', description: 'Search by name, phone, or email.' });
      return;
    }
    setSearching(true);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone, email')
        .or(`full_name.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%`)
        .limit(20);
      if (error) throw error;
      setMatches((data ?? []) as ProfileMatch[]);
      if (!data?.length) toast({ title: 'No users found' });
    } catch (e) {
      toast({ title: 'Search failed', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setSearching(false);
    }
  };

  const exportCsv = async (profile: ProfileMatch) => {
    setExporting(profile.id);
    try {
      const pageSize = 1000;
      let from = 0;
      const all: Record<string, unknown>[] = [];
      while (true) {
        const { data, error } = await supabase
          .from('general_ledger')
          .select('id, created_at, transaction_date, ledger_scope, classification, category, direction, amount, currency, account, reference_id, linked_party, source_table, source_id, transaction_group_id, description')
          .eq('user_id', profile.id)
          .order('created_at', { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw error;
        if (!data?.length) break;
        all.push(...(data as unknown as Record<string, unknown>[]));
        if (data.length < pageSize) break;
        from += pageSize;
      }

      if (!all.length) {
        toast({ title: 'No ledger entries', description: 'This user has no ledger history.' });
        return;
      }

      const headers = [
        'created_at','transaction_date','ledger_scope','classification','category','direction','amount','currency','account','reference_id','linked_party','source_table','source_id','transaction_group_id','description','id',
      ];
      const lines = [headers.join(',')];
      for (const r of all) {
        lines.push(headers.map(h => csvEscape(r[h])).join(','));
      }
      const csv = lines.join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeName = (profile.full_name || profile.phone || profile.id).replace(/[^a-z0-9_-]+/gi, '_');
      a.href = url;
      a.download = `ledger_${safeName}_${format(new Date(), 'yyyyMMdd_HHmm')}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: 'Export ready', description: `${all.length} ledger rows exported.` });
      void logLedgerExport('ledger_export_single_user', all.length, profile.id);
    } catch (e) {
      toast({ title: 'Export failed', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setExporting(null);
    }
  };

  const exportAll = async () => {
    setExportingAll(true);
    setAllProgress(0);
    try {
      const pageSize = 1000;
      let from = 0;
      const headers = [
        'created_at','transaction_date','ledger_scope','classification','category','direction','amount','currency','account','user_id','reference_id','linked_party','source_table','source_id','transaction_group_id','description','id',
      ];
      const lines: string[] = [headers.join(',')];
      let total = 0;
      while (true) {
        const { data, error } = await supabase
          .from('general_ledger')
          .select('id, created_at, transaction_date, ledger_scope, classification, category, direction, amount, currency, account, user_id, reference_id, linked_party, source_table, source_id, transaction_group_id, description')
          .order('created_at', { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw error;
        if (!data?.length) break;
        for (const r of data as unknown as Record<string, unknown>[]) {
          lines.push(headers.map(h => csvEscape(r[h])).join(','));
        }
        total += data.length;
        setAllProgress(total);
        if (data.length < pageSize) break;
        from += pageSize;
      }
      if (!total) {
        toast({ title: 'Ledger is empty' });
        return;
      }
      const csv = lines.join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `general_ledger_full_${format(new Date(), 'yyyyMMdd_HHmm')}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: 'Full ledger exported', description: `${total.toLocaleString()} rows.` });
      void logLedgerExport('bulk_ledger_export_all', total);
    } catch (e) {
      toast({ title: 'Full export failed', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setExportingAll(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold">Ledger Audit Export</h3>
          <p className="text-xs text-muted-foreground">Export the entire ledger, or search a specific user. CSV includes classification & category for audit.</p>
        </div>
        <Button onClick={exportAll} disabled={exportingAll} variant="default">
          {exportingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
          <span className="ml-2">{exportingAll ? `Exporting… ${allProgress.toLocaleString()}` : 'Export Entire Ledger'}</span>
        </Button>
      </div>
      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        <div className="flex-1">
          <Label htmlFor="ledger-export-search" className="sr-only">Search user</Label>
          <Input
            id="ledger-export-search"
            placeholder="Search by name, phone, or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
          />
        </div>
        <Button onClick={runSearch} disabled={searching} variant="secondary">
          {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          <span className="ml-2">Search</span>
        </Button>
      </div>

      {matches.length > 0 && (
        <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
          {matches.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-3 p-3 bg-background">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{m.full_name || '(no name)'}</p>
                <p className="text-xs text-muted-foreground truncate">{m.phone || '—'} · {m.email || '—'}</p>
                <p className="text-[10px] text-muted-foreground font-mono truncate">{m.id}</p>
              </div>
              <Button
                size="sm"
                onClick={() => exportCsv(m)}
                disabled={exporting === m.id}
              >
                {exporting === m.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                <span className="ml-2">CSV</span>
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}