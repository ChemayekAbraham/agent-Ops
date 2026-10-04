import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Printer, Download, RefreshCw, ArrowDownLeft, ArrowUpRight, Search, Filter, ChevronLeft, ChevronRight, Share2, Loader2, Trash2, History, AlertTriangle } from 'lucide-react';
import { DayGroupedLedger } from './DayGroupedLedger';
import { formatUGX } from '@/lib/rentCalculations';
import { format, startOfDay, endOfDay, subDays, startOfMonth, startOfYear } from 'date-fns';
import { cn } from '@/lib/utils';
import { exportToCSV } from '@/lib/exportUtils';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface LedgerEntry {
  id: string;
  date: string;
  description: string;
  category: string;
  debit: number;
  credit: number;
  reference: string;
  party: string;
}

interface LedgerSummary {
  totalDebits: number;
  totalCredits: number;
  entryCount: number;
}

type DatePreset = 'all' | 'today' | '7days' | '30days' | 'month' | 'year';
type CategoryFilter = 'all' | string;
type DirectionFilter = 'all' | 'cash_in' | 'cash_out';
type ScopeFilter = 'all' | 'wallet' | 'platform' | 'bridge';

const PAGE_SIZE = 50;

const categoryOptions: { value: CategoryFilter; label: string }[] = [
  { value: 'all', label: 'All Categories' },
  { value: 'deposit', label: 'Wallet Top-ups' },
  { value: 'wallet_deposit', label: 'Wallet Deposits' },
  { value: 'wallet_withdrawal', label: 'Withdrawals' },
  { value: 'wallet_transfer', label: 'Transfers' },
  { value: 'rent_repayment', label: 'Rent Repayments' },
  { value: 'loan_repayment', label: 'Rent Paybacks' },
  { value: 'agent_commission', label: 'Agent Commissions' },
  { value: 'agent_payout', label: 'Agent Payouts' },
  { value: 'landlord_payout', label: 'Landlord Payouts' },
  { value: 'landlord_payout_request', label: 'Landlord Payout Requests' },
];

const presets: { value: DatePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7days', label: '7 Days' },
  { value: '30days', label: '30 Days' },
  { value: 'month', label: 'This Month' },
  { value: 'year', label: 'This Year' },
  { value: 'all', label: 'All Time' },
];

export function GeneralLedger() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [summary, setSummary] = useState<LedgerSummary>({ totalDebits: 0, totalCredits: 0, entryCount: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [datePreset, setDatePreset] = useState<DatePreset>('30days');
  const [startDate, setStartDate] = useState<Date | undefined>(startOfDay(subDays(new Date(), 30)));
  const [endDate, setEndDate] = useState<Date | undefined>(endOfDay(new Date()));
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const printRef = useRef<HTMLDivElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>();

  // Void state
  const [entryToVoid, setEntryToVoid] = useState<LedgerEntry | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);
  const [activeTab, setActiveTab] = useState<'ledger' | 'voided'>('ledger');
  const [voidedEntries, setVoidedEntries] = useState<any[]>([]);
  const [loadingVoided, setLoadingVoided] = useState(false);

  // Debounce search input
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setDebouncedSearch(searchTerm);
      setPage(0);
    }, 400);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [searchTerm]);

  // Reset page on filter change
  useEffect(() => { setPage(0); }, [startDate, endDate, categoryFilter, directionFilter, scopeFilter]);

  // Fetch data when filters or page change
  useEffect(() => {
    fetchLedgerData();
    fetchSummary();
  }, [startDate, endDate, categoryFilter, directionFilter, scopeFilter, debouncedSearch, page]);

  const buildQuery = useCallback(() => {
    let query = supabase
      .from('general_ledger')
      .select('id, transaction_date, amount, direction, category, description, reference_id, linked_party, ledger_scope');

    if (startDate) query = query.gte('transaction_date', startDate.toISOString());
    if (endDate) query = query.lte('transaction_date', endDate.toISOString());
    if (categoryFilter !== 'all') query = query.eq('category', categoryFilter);
    if (directionFilter !== 'all') query = query.eq('direction', directionFilter);
    if (scopeFilter !== 'all') query = query.eq('ledger_scope', scopeFilter);
    if (debouncedSearch) {
      query = query.or(
        `description.ilike.%${debouncedSearch}%,linked_party.ilike.%${debouncedSearch}%,category.ilike.%${debouncedSearch}%,reference_id.ilike.%${debouncedSearch}%`
      );
    }
    return query;
  }, [startDate, endDate, categoryFilter, directionFilter, scopeFilter, debouncedSearch]);

  const fetchLedgerData = async () => {
    setLoading(true);
    try {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      const { data, error } = await buildQuery()
        .order('transaction_date', { ascending: false })
        .range(from, to);

      if (error) throw error;

      const mapped: LedgerEntry[] = (data || []).map(row => ({
        id: row.id,
        date: row.transaction_date,
        description: row.description || row.category || 'Transaction',
        category: row.category || 'Other',
        debit: row.direction === 'cash_out' ? Number(row.amount) : 0,
        credit: row.direction === 'cash_in' ? Number(row.amount) : 0,
        reference: row.reference_id || '-',
        party: row.linked_party || '-',
      }));

      setEntries(mapped);
    } catch (err) {
      console.error('Failed to fetch ledger data:', err);
      toast.error('Failed to load ledger data');
    } finally {
      setLoading(false);
    }
  };

  const fetchSummary = async () => {
    try {
      const { data, error } = await supabase.rpc('get_ledger_summary', {
        p_start_date: startDate?.toISOString() || null,
        p_end_date: endDate?.toISOString() || null,
        p_category: categoryFilter !== 'all' ? categoryFilter : null,
        p_direction: directionFilter !== 'all' ? directionFilter : null,
        p_search: debouncedSearch || null,
      });

      if (error) throw error;
      if (data && data.length > 0) {
        setSummary({
          totalDebits: Number(data[0].total_debits) || 0,
          totalCredits: Number(data[0].total_credits) || 0,
          entryCount: Number(data[0].entry_count) || 0,
        });
      }
    } catch (err) {
      console.error('Failed to fetch summary:', err);
    }
  };

  const handlePresetChange = (preset: DatePreset) => {
    setDatePreset(preset);
    const now = new Date();
    switch (preset) {
      case 'all': setStartDate(undefined); setEndDate(undefined); break;
      case 'today': setStartDate(startOfDay(now)); setEndDate(endOfDay(now)); break;
      case '7days': setStartDate(startOfDay(subDays(now, 7))); setEndDate(endOfDay(now)); break;
      case '30days': setStartDate(startOfDay(subDays(now, 30))); setEndDate(endOfDay(now)); break;
      case 'month': setStartDate(startOfMonth(now)); setEndDate(endOfDay(now)); break;
      case 'year': setStartDate(startOfYear(now)); setEndDate(endOfDay(now)); break;
    }
  };

  const totalPages = Math.ceil(summary.entryCount / PAGE_SIZE);
  const hasNextPage = page < totalPages - 1;
  const hasPrevPage = page > 0;

  // Fetch voided entries
  const fetchVoidedEntries = useCallback(async () => {
    setLoadingVoided(true);
    try {
      const { data, error } = await supabase
        .from('voided_ledger_entries')
        .select('*')
        .order('voided_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      setVoidedEntries(data || []);
    } catch (err) {
      console.error('Failed to fetch voided entries:', err);
    } finally {
      setLoadingVoided(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'voided') fetchVoidedEntries();
  }, [activeTab, fetchVoidedEntries]);

  // Handle void/remove entry
  const handleVoidEntry = async () => {
    if (!entryToVoid || !voidReason.trim()) {
      toast.error('Please provide a reason for removing this entry');
      return;
    }
    setVoiding(true);
    try {
      // Use the secure RPC function that handles archive + delete atomically
      const { error } = await supabase.rpc('void_ledger_entry', {
        p_ledger_id: entryToVoid.id,
        p_reason: voidReason.trim(),
      });
      if (error) throw error;

      toast.success('Entry removed and archived');
      setEntryToVoid(null);
      setVoidReason('');
      fetchLedgerData();
      fetchSummary();
    } catch (err: any) {
      console.error('Void failed:', err);
      toast.error(err.message || 'Failed to remove entry');
    } finally {
      setVoiding(false);
    }
  };

  const handlePrint = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) { toast.error('Please allow popups to print'); return; }

    printWindow.document.write(`
      <!DOCTYPE html><html><head><title>General Ledger - Welile</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; color: #333; }
        h1 { text-align: center; margin-bottom: 5px; }
        .subtitle { text-align: center; color: #666; margin-bottom: 20px; font-size: 14px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th { background: #f3f4f6; padding: 8px 6px; text-align: left; border-bottom: 2px solid #d1d5db; font-weight: 600; }
        td { padding: 6px; border-bottom: 1px solid #e5e7eb; }
        .debit { color: #dc2626; } .credit { color: #16a34a; }
        .total-row { font-weight: bold; border-top: 2px solid #333; background: #f9fafb; }
        .summary { display: flex; justify-content: space-between; margin-top: 20px; padding: 15px; background: #f3f4f6; border-radius: 8px; }
        .summary-item { text-align: center; }
        .summary-label { font-size: 11px; color: #666; }
        .summary-value { font-size: 18px; font-weight: bold; }
        @media print { body { padding: 0; } }
      </style></head><body>
        <h1>WELILE - General Ledger</h1>
        <p class="subtitle">
          Period: ${startDate ? format(startDate, 'dd MMM yyyy') : 'All time'} - ${endDate ? format(endDate, 'dd MMM yyyy') : 'Present'}
          ${categoryFilter !== 'all' ? '<br/>Filter: ' + categoryFilter : ''}${directionFilter !== 'all' ? ' | ' + directionFilter : ''}
          <br/>Page ${page + 1} of ${totalPages} | Generated: ${format(new Date(), 'dd MMM yyyy, HH:mm')}
        </p>
        <div class="summary">
          <div class="summary-item"><div class="summary-label">Total Debits</div><div class="summary-value debit">UGX ${summary.totalDebits.toLocaleString()}</div></div>
          <div class="summary-item"><div class="summary-label">Total Credits</div><div class="summary-value credit">UGX ${summary.totalCredits.toLocaleString()}</div></div>
          <div class="summary-item"><div class="summary-label">Net Balance</div><div class="summary-value">UGX ${(summary.totalCredits - summary.totalDebits).toLocaleString()}</div></div>
          <div class="summary-item"><div class="summary-label">Entries</div><div class="summary-value">${summary.entryCount.toLocaleString()}</div></div>
        </div><br/>
        <table><thead><tr><th>#</th><th>Date</th><th>Description</th><th>Category</th><th>Reference</th><th>Debit (UGX)</th><th>Credit (UGX)</th></tr></thead>
        <tbody>
          ${entries.map((e, i) => `<tr>
            <td>${page * PAGE_SIZE + i + 1}</td>
            <td>${format(new Date(e.date), 'dd/MM/yyyy')}</td>
            <td>${e.description}</td><td>${e.category}</td><td>${e.reference}</td>
            <td class="debit">${e.debit > 0 ? e.debit.toLocaleString() : '-'}</td>
            <td class="credit">${e.credit > 0 ? e.credit.toLocaleString() : '-'}</td>
          </tr>`).join('')}
        </tbody></table></body></html>
    `);
    printWindow.document.close();
    setTimeout(() => printWindow.print(), 500);
  };

  const handleExportCSV = () => {
    exportToCSV({
      headers: ['#', 'Date', 'Description', 'Category', 'Reference', 'Party', 'Debit', 'Credit'],
      rows: entries.map((e, i) => [
        page * PAGE_SIZE + i + 1,
        format(new Date(e.date), 'dd/MM/yyyy'),
        e.description, e.category, e.reference, e.party,
        e.debit, e.credit,
      ]),
    }, 'general_ledger');
    toast.success('CSV exported successfully');
  };

  const [sharing, setSharing] = useState(false);

  const handleSharePDF = async () => {
    if (entries.length === 0) {
      toast.error('No ledger entries to share');
      return;
    }
    setSharing(true);
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const margin = 10;
      let y = 15;

      // Header
      pdf.setFontSize(16);
      pdf.setFont('helvetica', 'bold');
      pdf.text('WELILE — General Ledger', margin, y);
      y += 7;
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(100, 100, 100);
      pdf.text(
        `Period: ${startDate ? format(startDate, 'dd MMM yyyy') : 'All time'} — ${endDate ? format(endDate, 'dd MMM yyyy') : 'Present'}  •  Page ${page + 1}  •  Generated: ${format(new Date(), 'dd MMM yyyy, HH:mm')}`,
        margin, y
      );
      y += 8;

      // Summary row
      pdf.setTextColor(0, 0, 0);
      pdf.setFillColor(243, 244, 246);
      pdf.rect(margin, y - 4, pageWidth - margin * 2, 14, 'F');
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'bold');
      pdf.text(`Debits: UGX ${summary.totalDebits.toLocaleString()}`, margin + 5, y + 2);
      pdf.text(`Credits: UGX ${summary.totalCredits.toLocaleString()}`, margin + 75, y + 2);
      pdf.text(`Net: UGX ${(summary.totalCredits - summary.totalDebits).toLocaleString()}`, margin + 150, y + 2);
      pdf.text(`Entries: ${summary.entryCount.toLocaleString()}`, margin + 220, y + 2);
      y += 16;

      // Table header
      const cols = [margin, margin + 10, margin + 35, margin + 95, margin + 130, margin + 165, margin + 205, margin + 240];
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(80, 80, 80);
      ['#', 'Date', 'Description', 'Category', 'Reference', 'Debit (UGX)', 'Credit (UGX)'].forEach((h, i) => {
        pdf.text(h, cols[i], y);
      });
      y += 2;
      pdf.setDrawColor(180, 180, 180);
      pdf.line(margin, y, pageWidth - margin, y);
      y += 5;

      // Rows
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(0, 0, 0);
      for (let i = 0; i < entries.length; i++) {
        if (y > pdf.internal.pageSize.getHeight() - 15) {
          pdf.addPage();
          y = 15;
        }
        const e = entries[i];
        pdf.setFontSize(7);
        pdf.text(`${page * PAGE_SIZE + i + 1}`, cols[0], y);
        pdf.text(format(new Date(e.date), 'dd/MM/yy'), cols[1], y);
        pdf.text(e.description.substring(0, 40), cols[2], y);
        pdf.text(e.category.substring(0, 20), cols[3], y);
        pdf.text(e.reference.substring(0, 20), cols[4], y);
        pdf.setTextColor(220, 38, 38);
        pdf.text(e.debit > 0 ? e.debit.toLocaleString() : '-', cols[5], y);
        pdf.setTextColor(22, 163, 74);
        pdf.text(e.credit > 0 ? e.credit.toLocaleString() : '-', cols[6], y);
        pdf.setTextColor(0, 0, 0);
        y += 5;
      }

      // Total row
      y += 2;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.text(`Page Total — Debits: UGX ${entries.reduce((s, e) => s + e.debit, 0).toLocaleString()}  |  Credits: UGX ${entries.reduce((s, e) => s + e.credit, 0).toLocaleString()}`, margin, y);

      const fileName = `welile-ledger-${format(new Date(), 'yyyy-MM-dd')}.pdf`;
      const pdfBlob = pdf.output('blob');
      const pdfFile = new File([pdfBlob], fileName, { type: 'application/pdf' });

      // Try Web Share API (works on mobile for WhatsApp sharing)
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
        await navigator.share({
          title: 'Welile General Ledger',
          text: `Welile Ledger Report — ${startDate ? format(startDate, 'dd MMM yyyy') : 'All time'} to ${endDate ? format(endDate, 'dd MMM yyyy') : 'Present'}`,
          files: [pdfFile],
        });
        toast.success('Shared successfully!');
      } else {
        // Fallback: download the PDF and open WhatsApp with a message
        pdf.save(fileName);
        const message = encodeURIComponent(
          `📊 Welile General Ledger Report\n📅 Period: ${startDate ? format(startDate, 'dd MMM yyyy') : 'All time'} — ${endDate ? format(endDate, 'dd MMM yyyy') : 'Present'}\n💰 Debits: UGX ${summary.totalDebits.toLocaleString()}\n💰 Credits: UGX ${summary.totalCredits.toLocaleString()}\n📄 PDF downloaded — please attach it to this chat.`
        );
        window.open(`https://wa.me/?text=${message}`, '_blank');
        toast.success('PDF downloaded! Attach it in WhatsApp.');
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error('Share failed:', err);
        toast.error('Failed to share PDF');
      }
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Tab switcher: Ledger vs Removed History */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'ledger' | 'voided')}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="ledger" className="gap-2 text-xs">
            <ArrowDownLeft className="h-3.5 w-3.5" /> General Ledger
          </TabsTrigger>
          <TabsTrigger value="voided" className="gap-2 text-xs">
            <History className="h-3.5 w-3.5" /> Removed History
            {voidedEntries.length > 0 && (
              <Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1">{voidedEntries.length}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="ledger" className="space-y-4 mt-4">
          {/* Ledger Scope Selector */}
          <div className="flex gap-1 p-1 bg-muted/50 rounded-lg w-fit">
            {([
              { value: 'all', label: '📊 All Scopes' },
              { value: 'wallet', label: '👛 Wallet Ledger' },
              { value: 'platform', label: '🏢 Platform Ledger' },
              { value: 'bridge', label: '🔗 Bridge' },
            ] as { value: ScopeFilter; label: string }[]).map(s => (
              <Button
                key={s.value}
                size="sm"
                variant={scopeFilter === s.value ? 'default' : 'ghost'}
                onClick={() => setScopeFilter(s.value)}
                className="text-xs h-8 px-3"
              >
                {s.label}
              </Button>
            ))}
          </div>

          {/* Scope Description */}
          {scopeFilter !== 'all' && (
            <div className="text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-2">
              {scopeFilter === 'wallet' && '👛 Wallet Ledger — User-owned fund movements: deposits, withdrawals, transfers, commissions'}
              {scopeFilter === 'platform' && '🏢 Platform Ledger — Internal operations: pool deployments, platform expenses, revenue recognition'}
              {scopeFilter === 'bridge' && '🔗 Bridge — Events affecting both user wallets and platform: capital inflows, rent disbursements'}
            </div>
          )}

          {/* Date Presets */}
          <div className="flex flex-wrap gap-2">
            {presets.map(p => (
              <Button key={p.value} size="sm" variant={datePreset === p.value ? 'default' : 'outline'}
                onClick={() => handlePresetChange(p.value)} className="text-xs">
                {p.label}
              </Button>
            ))}
          </div>

          {/* Server-side Filters */}
          <div className="flex flex-wrap gap-2 items-center">
            <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v as CategoryFilter)}>
              <SelectTrigger className="w-[160px] h-9 text-xs">
                <Filter className="h-3 w-3 mr-1" />
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                {categoryOptions.map(c => (
                  <SelectItem key={c.value} value={c.value} className="text-xs">{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={directionFilter} onValueChange={(v) => setDirectionFilter(v as DirectionFilter)}>
              <SelectTrigger className="w-[140px] h-9 text-xs">
                <SelectValue placeholder="Direction" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All Directions</SelectItem>
                <SelectItem value="cash_out" className="text-xs">Debits Only</SelectItem>
                <SelectItem value="cash_in" className="text-xs">Credits Only</SelectItem>
              </SelectContent>
            </Select>

            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <Input placeholder="Search..." value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-7 h-9 w-[180px] text-xs" />
            </div>

            {(categoryFilter !== 'all' || directionFilter !== 'all' || searchTerm) && (
              <Button size="sm" variant="ghost" className="text-xs h-9"
                onClick={() => { setCategoryFilter('all'); setDirectionFilter('all'); setSearchTerm(''); }}>
                Clear Filters
              </Button>
            )}
          </div>

          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card>
              <CardContent className="p-3 text-center">
                <ArrowUpRight className="h-4 w-4 text-destructive mx-auto mb-1" />
                <p className="text-xs text-muted-foreground">Total Debits</p>
                <p className="text-sm font-bold text-destructive">{formatUGX(summary.totalDebits)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 text-center">
                <ArrowDownLeft className="h-4 w-4 text-success mx-auto mb-1" />
                <p className="text-xs text-muted-foreground">Total Credits</p>
                <p className="text-sm font-bold text-success">{formatUGX(summary.totalCredits)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 text-center">
                <p className="text-xs text-muted-foreground">Net Balance</p>
                <p className={cn("text-sm font-bold", summary.totalCredits - summary.totalDebits >= 0 ? 'text-success' : 'text-destructive')}>
                  {formatUGX(summary.totalCredits - summary.totalDebits)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 text-center">
                <p className="text-xs text-muted-foreground">Entries</p>
                <p className="text-sm font-bold">{summary.entryCount.toLocaleString()}</p>
              </CardContent>
            </Card>
          </div>

          {/* Actions */}
          <div className="flex gap-2 flex-wrap items-center">
            <Button onClick={handlePrint} size="sm" className="gap-2">
              <Printer className="h-4 w-4" /> Print
            </Button>
            <Button onClick={handleExportCSV} size="sm" variant="outline" className="gap-2">
              <Download className="h-4 w-4" /> CSV
            </Button>
            <Button onClick={handleSharePDF} size="sm" variant="outline" className="gap-2 text-success border-success/30 hover:bg-success/10" disabled={sharing || entries.length === 0}>
              {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
              WhatsApp
            </Button>
            <Button onClick={() => { fetchLedgerData(); fetchSummary(); }} size="sm" variant="ghost" className="gap-2" disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>

            {/* Pagination Controls */}
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Page {page + 1} of {Math.max(totalPages, 1)}
              </span>
              <Button size="sm" variant="outline" disabled={!hasPrevPage} onClick={() => setPage(p => p - 1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="outline" disabled={!hasNextPage} onClick={() => setPage(p => p + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Ledger Table - Day Grouped */}
          <div ref={printRef}>
            {loading ? (
              <Card><CardContent className="p-8 text-center text-muted-foreground">Loading ledger...</CardContent></Card>
            ) : entries.length === 0 ? (
              <Card><CardContent className="p-8 text-center text-muted-foreground">No transactions match the current filters</CardContent></Card>
            ) : (
              <DayGroupedLedger entries={entries} page={page} onRemoveEntry={(entry) => setEntryToVoid(entry)} />
            )}
          </div>
        </TabsContent>

        <TabsContent value="voided" className="space-y-4 mt-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <History className="h-4 w-4 text-muted-foreground" />
                Removed Transactions History
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                All ledger entries that were removed by managers are kept here for audit
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={fetchVoidedEntries} disabled={loadingVoided}>
              <RefreshCw className={cn("h-4 w-4", loadingVoided && "animate-spin")} />
            </Button>
          </div>

          {loadingVoided ? (
            <Card><CardContent className="p-8 text-center text-muted-foreground">Loading...</CardContent></Card>
          ) : voidedEntries.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <Trash2 className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p>No removed transactions yet</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Direction</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Removed At</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {voidedEntries.map((v) => (
                      <TableRow key={v.id} className="bg-destructive/5">
                        <TableCell className="text-xs whitespace-nowrap">
                          {format(new Date(v.transaction_date), 'dd MMM yyyy HH:mm')}
                        </TableCell>
                        <TableCell className="text-xs max-w-[150px] truncate">
                          {v.description || v.category}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">{v.category}</Badge>
                        </TableCell>
                        <TableCell className={cn(
                          "text-right text-xs font-bold",
                          v.direction === 'cash_in' ? 'text-success' : 'text-destructive'
                        )}>
                          {formatUGX(v.amount)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={v.direction === 'cash_in' ? 'default' : 'destructive'} className="text-[10px]">
                            {v.direction === 'cash_in' ? 'Credit' : 'Debit'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs max-w-[200px]">
                          <span className="text-destructive font-medium">{v.void_reason}</span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {format(new Date(v.voided_at), 'dd MMM yyyy HH:mm')}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="p-3 border-t bg-muted/30 text-xs text-muted-foreground">
                {voidedEntries.length} removed {voidedEntries.length === 1 ? 'entry' : 'entries'} — 
                Total voided: {formatUGX(voidedEntries.reduce((s: number, v: any) => s + Number(v.amount), 0))}
              </div>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* Void Confirmation Dialog */}
      <AlertDialog open={!!entryToVoid} onOpenChange={(open) => { if (!open) { setEntryToVoid(null); setVoidReason(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Remove Ledger Entry
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>This will remove the entry from the active ledger and archive it in removed history.</p>
                {entryToVoid && (
                  <div className="p-3 rounded-lg bg-muted space-y-1 text-sm">
                    <p><strong>Description:</strong> {entryToVoid.description}</p>
                    <p><strong>Category:</strong> {entryToVoid.category}</p>
                    <p><strong>Amount:</strong> {entryToVoid.debit > 0 ? `Debit ${formatUGX(entryToVoid.debit)}` : `Credit ${formatUGX(entryToVoid.credit)}`}</p>
                    <p><strong>Date:</strong> {format(new Date(entryToVoid.date), 'dd MMM yyyy HH:mm')}</p>
                    <p><strong>Reference:</strong> {entryToVoid.reference}</p>
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="void-reason" className="text-foreground font-medium">Reason for removal *</Label>
                  <Textarea
                    id="void-reason"
                    placeholder="e.g. Duplicate entry, incorrect amount, test transaction..."
                    value={voidReason}
                    onChange={(e) => setVoidReason(e.target.value)}
                    className="min-h-[80px]"
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={voiding}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleVoidEntry(); }}
              disabled={voiding || !voidReason.trim()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {voiding ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
              Remove Entry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
