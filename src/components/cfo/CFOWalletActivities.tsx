import { useState, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Download, FileText, ArrowDownLeft, ArrowUpRight, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UserSearchPicker } from './UserSearchPicker';
import { formatUGX } from '@/lib/rentCalculations';
import { format, parseISO } from 'date-fns';
import { toast } from 'sonner';

interface UserResult {
  id: string;
  full_name: string;
  phone: string;
}

interface LedgerEntry {
  id: string;
  transaction_date: string;
  amount: number;
  direction: string;
  category: string;
  description: string | null;
  reference_id: string | null;
  linked_party: string | null;
  source_table: string;
  ledger_scope: string;
  classification: string | null;
}

const PAGE = 1000;
const WITHDRAWAL_CATEGORIES = new Set([
  'wallet_withdrawal',
  'agent_commission_withdrawal',
  'proxy_partner_withdrawal',
]);

export function CFOWalletActivities() {
  const [selectedUser, setSelectedUser] = useState<UserResult | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [directionFilter, setDirectionFilter] = useState<'all' | 'cash_in' | 'cash_out'>('all');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');

  const loadActivities = async (user: UserResult) => {
    setLoading(true);
    setEntries([]);
    try {
      const all: LedgerEntry[] = [];
      let from = 0;
      // CFO scope: full visibility on wallet + bridge legs (no admin_correction filter)
      while (true) {
        const { data, error } = await supabase
          .from('general_ledger')
          .select('id, transaction_date, amount, direction, category, description, reference_id, linked_party, source_table, ledger_scope, classification')
          .eq('user_id', user.id)
          .in('ledger_scope', ['wallet', 'bridge'])
          .order('transaction_date', { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        all.push(...(data as LedgerEntry[]));
        if (data.length < PAGE) break;
        from += PAGE;
      }
      setEntries(all);
    } catch (err: any) {
      console.error('[CFOWalletActivities] load failed:', err);
      toast.error(err.message || 'Failed to load wallet activities');
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (u: UserResult | null) => {
    setSelectedUser(u);
    setEntries([]);
    if (u) loadActivities(u);
  };

  const filteredEntries = useMemo(() => {
    const fromMs = dateFrom ? new Date(dateFrom + 'T00:00:00').getTime() : null;
    const toMs = dateTo ? new Date(dateTo + 'T23:59:59').getTime() : null;
    return entries.filter(e => {
      if (directionFilter !== 'all' && e.direction !== directionFilter) return false;
      const t = new Date(e.transaction_date).getTime();
      if (fromMs !== null && t < fromMs) return false;
      if (toMs !== null && t > toMs) return false;
      return true;
    });
  }, [entries, directionFilter, dateFrom, dateTo]);

  const totalIn = filteredEntries.filter(e => e.direction === 'cash_in').reduce((s, e) => s + Number(e.amount), 0);
  const totalOut = filteredEntries.filter(e => e.direction === 'cash_out').reduce((s, e) => s + Number(e.amount), 0);
  const netBalance = totalIn - totalOut;
  const hasFilters = directionFilter !== 'all' || dateFrom || dateTo;
  const clearFilters = () => { setDirectionFilter('all'); setDateFrom(''); setDateTo(''); };

  // Since-last-withdrawal tracker: `entries` is desc by date, so the first
  // withdrawal we find is the most recent. Everything BEFORE it in the array
  // (i.e. more recent) is post-withdrawal activity.
  const sinceLastWithdrawal = useMemo(() => {
    const lastIdx = entries.findIndex(
      e => e.direction === 'cash_out' && WITHDRAWAL_CATEGORIES.has(e.category),
    );
    if (lastIdx === -1) return null;
    const last = entries[lastIdx];
    const after = entries.slice(0, lastIdx); // newer than last withdrawal
    const inSince = after
      .filter(e => e.direction === 'cash_in')
      .reduce((s, e) => s + Number(e.amount), 0);
    const outSince = after
      .filter(e => e.direction === 'cash_out')
      .reduce((s, e) => s + Number(e.amount), 0);
    return {
      last,
      countSince: after.length,
      inSince,
      outSince,
      netSince: inSince - outSince,
    };
  }, [entries]);

  const exportPdf = async () => {
    if (!selectedUser || filteredEntries.length === 0) {
      toast.error('Nothing to export');
      return;
    }
    setExporting(true);
    try {
      const { default: jsPDF } = await import('jspdf');
      const autoTableMod: any = await import('jspdf-autotable');
      const autoTable = autoTableMod.default || autoTableMod;

      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const pageWidth = doc.internal.pageSize.getWidth();
      const margin = 14;

      // Header
      doc.setFillColor(15, 23, 42);
      doc.rect(0, 0, pageWidth, 22, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text('WELILE', margin, 10);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.text('Wallet Activities Statement', margin, 16);
      doc.setFontSize(8);
      doc.text(`Generated: ${new Date().toLocaleString('en-GB')}`, pageWidth - margin, 10, { align: 'right' });
      doc.text('CFO Export — Confidential', pageWidth - margin, 16, { align: 'right' });

      // Owner block
      doc.setTextColor(0, 0, 0);
      let y = 30;
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text('Wallet Owner', margin, y);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      y += 5;
      doc.text(`Name: ${selectedUser.full_name || '—'}`, margin, y);
      y += 5;
      doc.text(`Phone: ${selectedUser.phone || '—'}`, margin, y);
      y += 5;
      doc.text(`User ID: ${selectedUser.id}`, margin, y);
      y += 8;

      // Summary
      doc.setFont('helvetica', 'bold');
      doc.text('Summary', margin, y);
      y += 5;
      doc.setFont('helvetica', 'normal');
      const filterLabel =
        directionFilter === 'cash_in' ? 'Deposits only' :
        directionFilter === 'cash_out' ? 'Withdrawals only' : 'All directions';
      const rangeLabel = `${dateFrom || 'earliest'} → ${dateTo || 'latest'}`;
      doc.text(`Filter:    ${filterLabel}`, margin, y);
      y += 5;
      doc.text(`Range:     ${rangeLabel}`, margin, y);
      y += 5;
      doc.text(`Total In:  ${formatUGX(totalIn)}`, margin, y);
      y += 5;
      doc.text(`Total Out: ${formatUGX(totalOut)}`, margin, y);
      y += 5;
      doc.text(`Net:       ${formatUGX(netBalance)}`, margin, y);
      y += 5;
      doc.text(`Entries:   ${filteredEntries.length}`, margin, y);
      y += 6;

      // Table
      const rows = filteredEntries.map(e => [
        format(parseISO(e.transaction_date), 'dd MMM yyyy HH:mm'),
        e.direction === 'cash_in' ? 'IN' : 'OUT',
        e.category.replace(/_/g, ' '),
        e.description || '—',
        formatUGX(Number(e.amount)),
      ]);

      autoTable(doc, {
        startY: y,
        head: [['Date', 'Dir', 'Category', 'Description', 'Amount']],
        body: rows,
        styles: { fontSize: 7, cellPadding: 1.5 },
        headStyles: { fillColor: [15, 23, 42], textColor: 255 },
        columnStyles: {
          0: { cellWidth: 28 },
          1: { cellWidth: 12 },
          2: { cellWidth: 35 },
          3: { cellWidth: 75 },
          4: { cellWidth: 28, halign: 'right' },
        },
        margin: { left: margin, right: margin },
      });

      const safe = (selectedUser.full_name || 'wallet').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 50);
      const filename = `wallet-activities_${safe}_${format(new Date(), 'yyyyMMdd_HHmm')}.pdf`;
      doc.save(filename);
      toast.success('PDF exported');

      // A CFO exporting another user's full wallet transaction history --
      // not logged before this. Plain client-side insert so the audit_logs
      // IP-capture trigger sees the real browser IP directly. Never blocks
      // the actual download.
      (async () => {
        try {
          const { data: { user: actor } } = await supabase.auth.getUser();
          await supabase.from('audit_logs').insert({
            user_id: actor?.id ?? null,
            action_type: 'pdf_report_exported',
            table_name: 'export',
            record_id: selectedUser.id,
            metadata: { filename, target_user_id: selectedUser.id, row_count: filteredEntries.length },
          });
        } catch (e) {
          console.warn('[CFOWalletActivities] audit log insert failed:', e);
        }
      })();
    } catch (err: any) {
      console.error('[CFOWalletActivities] export failed:', err);
      toast.error(err.message || 'Failed to export PDF');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2">📒 Wallet Activities</h1>
        <p className="text-sm text-muted-foreground">
          Search a wallet owner by name or phone to view every wallet ledger entry, then export as PDF.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <UserSearchPicker
            label="Wallet Owner"
            placeholder="Search by name or phone..."
            selectedUser={selectedUser}
            onSelect={handleSelect}
          />
        </CardContent>
      </Card>

      {selectedUser && (
        <>
          <Card>
            <CardContent className="pt-4">
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
                <div>
                  <Label className="text-xs">Type</Label>
                  <Select value={directionFilter} onValueChange={(v: any) => setDirectionFilter(v)}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="cash_in">Deposits (In)</SelectItem>
                      <SelectItem value="cash_out">Withdrawals (Out)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">From</Label>
                  <Input type="date" value={dateFrom} max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)} className="mt-1" />
                </div>
                <div>
                  <Label className="text-xs">To</Label>
                  <Input type="date" value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)} className="mt-1" />
                </div>
                <div>
                  <Button variant="outline" size="sm" onClick={clearFilters} disabled={!hasFilters} className="w-full">
                    <X className="h-4 w-4 mr-1" /> Clear filters
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card><CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Total In</p>
              <p className="text-lg font-bold text-success">{formatUGX(totalIn)}</p>
            </CardContent></Card>
            <Card><CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Total Out</p>
              <p className="text-lg font-bold text-destructive">{formatUGX(totalOut)}</p>
            </CardContent></Card>
            <Card><CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Net</p>
              <p className={`text-lg font-bold ${netBalance >= 0 ? 'text-success' : 'text-destructive'}`}>{formatUGX(netBalance)}</p>
            </CardContent></Card>
            <Card><CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Entries</p>
              <p className="text-lg font-bold">{filteredEntries.length}<span className="text-xs text-muted-foreground font-normal"> / {entries.length}</span></p>
            </CardContent></Card>
          </div>

          {/* Since Last Withdrawal — track funds after the most recent payout,
              instead of aggregating the entire ledger. */}
          {!loading && (
            <Card className="border-primary/30 bg-primary/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <ArrowUpRight className="h-4 w-4" /> Since Last Withdrawal
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {sinceLastWithdrawal ? (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">Last withdrawal</p>
                      <p className="text-sm font-semibold text-destructive">
                        −{formatUGX(Number(sinceLastWithdrawal.last.amount))}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {format(parseISO(sinceLastWithdrawal.last.transaction_date), 'dd MMM yyyy HH:mm')}
                      </p>
                      <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 mt-1">
                        {sinceLastWithdrawal.last.category}
                      </Badge>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">Credited since</p>
                      <p className="text-sm font-bold text-success">{formatUGX(sinceLastWithdrawal.inSince)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">Debited since</p>
                      <p className="text-sm font-bold text-destructive">{formatUGX(sinceLastWithdrawal.outSince)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">
                        Balance since ({sinceLastWithdrawal.countSince} entr{sinceLastWithdrawal.countSince === 1 ? 'y' : 'ies'})
                      </p>
                      <p className={`text-sm font-bold ${sinceLastWithdrawal.netSince >= 0 ? 'text-success' : 'text-destructive'}`}>
                        {formatUGX(sinceLastWithdrawal.netSince)}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No withdrawal on record yet — nothing to anchor against.</p>
                )}
              </CardContent>
            </Card>
          )}

          <div className="flex justify-end">
            <Button onClick={exportPdf} disabled={exporting || loading || filteredEntries.length === 0} size="sm">
              {exporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
              Export PDF
            </Button>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Activities ({filteredEntries.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading...
                </div>
              ) : filteredEntries.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">No wallet activities match the current filters.</div>
              ) : (
                <div className="space-y-1 max-h-[600px] overflow-y-auto">
                  {filteredEntries.map(e => {
                    const isIn = e.direction === 'cash_in';
                    return (
                      <div key={e.id} className="flex items-start justify-between gap-2 p-2 rounded-lg hover:bg-muted/30 border-b last:border-0">
                        <div className="flex items-start gap-2 min-w-0 flex-1">
                          {isIn
                            ? <ArrowDownLeft className="h-4 w-4 text-success shrink-0 mt-0.5" />
                            : <ArrowUpRight className="h-4 w-4 text-destructive shrink-0 mt-0.5" />}
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">{e.description || e.category.replace(/_/g, ' ')}</p>
                            <div className="flex items-center gap-2 flex-wrap mt-0.5">
                              <span className="text-[10px] text-muted-foreground">
                                {format(parseISO(e.transaction_date), 'dd MMM yyyy HH:mm')}
                              </span>
                              <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">{e.category}</Badge>
                              {e.classification && e.classification !== 'production' && (
                                <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4">{e.classification}</Badge>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className={`text-sm font-mono font-semibold shrink-0 ${isIn ? 'text-success' : 'text-destructive'}`}>
                          {isIn ? '+' : '−'}{formatUGX(Number(e.amount))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}