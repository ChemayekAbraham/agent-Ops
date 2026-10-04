import { useState, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { addMonths } from 'date-fns';
// xlsx is ~430 KB — loaded on demand so the COO dashboard chunk stays light.
const loadXLSX = () => import('xlsx');
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from '@/components/ui/table';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  dateOnlyToLocalDate,
  dateOnlyToUtcMiddayIso,
  extractDateOnly,
  formatLocalDateOnly,
  parseContributionDate,
} from '@/lib/portfolioDates';
import { Upload, CalendarIcon, Loader2, Download, CheckCircle2, AlertTriangle } from 'lucide-react';

interface MatchedRow {
  uploadName: string;
  uploadAmount: number;
  uploadDate: string; // YYYY-MM-DD
  portfolioId: string | null;
  portfolioCode: string | null;
  ownerName: string | null;
  currentDate: string | null;
  newDate: string; // editable
  durationMonths: number;
  matched: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}

export default function UpdateContributionDatesDialog({ open, onOpenChange, onSuccess }: Props) {
  const [step, setStep] = useState<'upload' | 'preview' | 'saving'>('upload');
  const [rows, setRows] = useState<MatchedRow[]>([]);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setStep('upload');
    setRows([]);
    setSaving(false);
  };

  const handleClose = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  /* ─── Template download ─── */
  const downloadTemplate = async () => {
    const XLSX = await loadXLSX();
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Partner Name', 'Investment Amount', 'Contribution Date'],
      ['ASIIMWE PAMELA', 500000, '2026-01-07'],
      ['ALEETE LILIAN', 1000000, '2026-03-01'],
    ]);
    ws['!cols'] = [{ wch: 25 }, { wch: 18 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Template');
    XLSX.writeFile(wb, 'update_dates_template.xlsx');
  };

  /* ─── File upload & matching ─── */
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const data = await file.arrayBuffer();
      const XLSX = await loadXLSX();
      const wb = XLSX.read(data, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json<Record<string, any>>(ws);

      if (!json.length) {
        toast.error('No data found in file');
        return;
      }

      // Parse uploaded rows
      const parsed = json.map(row => {
        const keys = Object.keys(row);
        const nameKey = keys.find(k => /name/i.test(k)) || keys[0];
        const amtKey = keys.find(k => /amount|invest/i.test(k)) || keys[1];
        const dateKey = keys.find(k => /date|contrib/i.test(k)) || keys[2];
        return {
          name: String(row[nameKey] || '').trim().toUpperCase(),
          amount: Number(String(row[amtKey] || '0').replace(/[^0-9.]/g, '')),
          date: parseContributionDate(row[dateKey]),
        };
      }).filter(r => r.name && r.amount > 0 && r.date);

      if (!parsed.length) {
        toast.error('No valid rows found. Ensure columns: Partner Name, Investment Amount, Contribution Date');
        return;
      }

      // Fetch all portfolios with owner names
      const { data: portfolios, error } = await supabase
        .from('investor_portfolios')
          .select('id, portfolio_code, investment_amount, created_at, duration_months, investor_id, profiles!investor_portfolios_investor_id_fkey(full_name)')
          .in('status', ['active', 'pending', 'pending_approval', 'matured']);

      if (error) throw error;

      // Match by name + amount
      const matched: MatchedRow[] = parsed.map(p => {
        const match = (portfolios || []).find(port => {
          const ownerName = (port.profiles as any)?.full_name?.toUpperCase() || '';
          return ownerName === p.name && Math.abs(port.investment_amount - p.amount) < 1;
        });
        return {
          uploadName: p.name,
          uploadAmount: p.amount,
          uploadDate: p.date!,
          portfolioId: match?.id || null,
          portfolioCode: match?.portfolio_code || null,
          ownerName: match ? (match.profiles as any)?.full_name : null,
          currentDate: extractDateOnly(match?.created_at),
          newDate: p.date!,
          durationMonths: match?.duration_months || 12,
          matched: !!match,
        };
      });

      setRows(matched);
      setStep('preview');
    } catch (err: any) {
      toast.error('Failed to parse file: ' + (err.message || 'Unknown error'));
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  /* ─── Update date for a row ─── */
  const updateRowDate = (idx: number, date: Date) => {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, newDate: formatLocalDateOnly(date) } : r));
  };

  /* ─── Save ─── */
  const handleSave = async () => {
    const toUpdate = rows.filter(r => r.matched && r.portfolioId);
    if (!toUpdate.length) {
      toast.error('No matched portfolios to update');
      return;
    }
    setSaving(true);
    setStep('saving');
    let success = 0;
    let failed = 0;

    for (const row of toUpdate) {
      const contributionDate = dateOnlyToLocalDate(row.newDate);
      const payoutDay = Math.min(contributionDate.getDate(), 28);
      const nextRoiDate = addMonths(contributionDate, 1);
      const maturityDate = addMonths(contributionDate, row.durationMonths);

      const { error } = await supabase
        .from('investor_portfolios')
        .update({
          created_at: dateOnlyToUtcMiddayIso(row.newDate),
          payout_day: payoutDay,
          next_roi_date: formatLocalDateOnly(nextRoiDate),
          maturity_date: formatLocalDateOnly(maturityDate),
        })
        .eq('id', row.portfolioId!);

      if (error) {
        console.error('Update failed for', row.portfolioId, error);
        failed++;
      } else {
        success++;
      }
    }

    setSaving(false);
    if (failed === 0) {
      toast.success(`Updated ${success} portfolio contribution dates`);
    } else {
      toast.warning(`Updated ${success}, failed ${failed}`);
    }
    onSuccess();
    handleClose(false);
  };

  const matchedCount = rows.filter(r => r.matched).length;
  const unmatchedCount = rows.filter(r => !r.matched).length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarIcon className="h-5 w-5 text-primary" />
            Update Contribution Dates
          </DialogTitle>
          <DialogDescription>
            Upload a file to bulk-update contribution dates on existing portfolios. Dates will also update payout schedules.
          </DialogDescription>
        </DialogHeader>

        {step === 'upload' && (
          <div className="space-y-4 py-4">
            <div className="border-2 border-dashed border-border rounded-xl p-8 text-center space-y-3">
              <Upload className="h-10 w-10 mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Upload <strong>.xlsx</strong> with columns: Partner Name, Investment Amount, Contribution Date
              </p>
              <div className="flex justify-center gap-2">
                <Button size="sm" onClick={() => fileRef.current?.click()}>
                  <Upload className="h-4 w-4 mr-1" /> Select File
                </Button>
                <Button size="sm" variant="outline" onClick={downloadTemplate}>
                  <Download className="h-4 w-4 mr-1" /> Template
                </Button>
              </div>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
            </div>
          </div>
        )}

        {step === 'preview' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Badge variant="default" className="gap-1">
                <CheckCircle2 className="h-3 w-3" /> {matchedCount} matched
              </Badge>
              {unmatchedCount > 0 && (
                <Badge variant="secondary" className="gap-1 bg-warning/20 text-warning-foreground">
                  <AlertTriangle className="h-3 w-3" /> {unmatchedCount} not found
                </Badge>
              )}
            </div>

            <div className="border rounded-lg overflow-auto max-h-[50vh]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Partner</TableHead>
                    <TableHead className="text-xs">Portfolio</TableHead>
                    <TableHead className="text-xs text-right">Amount</TableHead>
                    <TableHead className="text-xs">Contribution Date</TableHead>
                    <TableHead className="text-xs">New Date</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, idx) => (
                    <TableRow key={idx} className={cn(!row.matched && 'bg-warning/5')}>
                      <TableCell className="text-xs font-medium">{row.uploadName}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{row.portfolioCode || '—'}</TableCell>
                      <TableCell className="text-xs text-right font-mono">
                        {row.uploadAmount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.currentDate || '—'}
                      </TableCell>
                      <TableCell>
                        {row.matched ? (
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button variant="outline" size="sm" className="h-7 text-xs gap-1 w-[120px] justify-start">
                                <CalendarIcon className="h-3 w-3" />
                                {row.newDate}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0" align="start">
                              <Calendar
                                mode="single"
                                selected={dateOnlyToLocalDate(row.newDate)}
                                onSelect={(d) => d && updateRowDate(idx, d)}
                                className={cn("p-3 pointer-events-auto")}
                              />
                            </PopoverContent>
                          </Popover>
                        ) : (
                          <span className="text-xs text-muted-foreground">{row.uploadDate}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.matched ? (
                          <Badge variant="default" className="text-[10px]">Matched</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px] bg-warning/20">Not Found</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => { reset(); }}>Cancel</Button>
              <Button onClick={handleSave} disabled={matchedCount === 0}>
                Update {matchedCount} Portfolios
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'saving' && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Updating contribution dates…</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
