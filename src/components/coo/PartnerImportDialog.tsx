import { useState, useCallback, useRef } from 'react';
// xlsx is ~430 KB — loaded on demand so the COO dashboard chunk stays light.
const loadXLSX = () => import('xlsx');
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { investBounds, defaultUGXFormatter, isInvestAmountValid } from '@/lib/partnershipInvestment';
import { parseContributionDate } from '@/lib/portfolioDates';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Loader2, Upload, FileSpreadsheet, Download, CheckCircle2, AlertTriangle,
  XCircle, ArrowLeft, ArrowRight, Users, Briefcase, ShieldCheck
} from 'lucide-react';
import { cn } from '@/lib/utils';

/* ─── Types ─── */
interface ParsedRow {
  rowNum: number;
  partnerName: string;
  phone: string;
  email: string;
  investmentAmount: number;
  roiPercentage: number;
  durationMonths: number;
  roiMode: string;
  contributionDate: string | null;
  errors: string[];
}

interface ImportGroup {
  partnerName: string;
  phone: string;
  email: string;
  portfolios: {
    amount: number;
    roiPercentage: number;
    durationMonths: number;
    roiMode: string;
    contributionDate: string | null;
  }[];
  isDuplicate: boolean;
  errors: string[];
}

interface ImportResult {
  partnersCreated: number;
  partnersMatched: number;
  portfoliosCreated: number;
  skippedDuplicates: number;
  errors: { partner: string; error: unknown }[];
}

type Step = 'upload' | 'preview' | 'confirm' | 'processing' | 'results';

/* ─── Header Aliases ─── */
const HEADER_ALIASES: Record<string, string[]> = {
  'Partner Name': ['Partner Name', 'Supporter Name', 'Name', 'Full Name', 'SUPPORTER NAME'],
  'Phone': ['Phone', 'PHONE', 'Phone Number', 'Mobile', 'Tel'],
  'Email': ['Email', 'EMAIL', 'Email Address', 'E-mail'],
  'Investment Amount': ['Investment Amount', 'Principal (UGX)', 'Principal', 'Amount', 'Amount (UGX)', 'PRINCIPAL (UGX)'],
  'ROI %': ['ROI %', 'Rate', 'RATE', 'ROI', 'Interest Rate', 'ROI Percentage', 'Interest'],
  'Duration (Months)': ['Duration (Months)', 'Duration', 'Months', 'Term', 'Period'],
  'ROI Mode': ['ROI Mode', 'Mode', 'Payout Mode', 'ROI Type'],
  'Contribution Date': ['Contribution Date', 'Date', 'Investment Date', 'Start Date', 'CONTRIBUTION DATE'],
};

function normalizeHeaders(row: any): any {
  const normalized: any = {};
  const rowKeys = Object.keys(row);

  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      const match = rowKeys.find(k => k.trim().toLowerCase() === alias.toLowerCase());
      if (match) {
        normalized[canonical] = row[match];
        break;
      }
    }
  }
  return normalized;
}

/* ─── Constants ─── */
const VALID_ROI_MODES = ['monthly_payout', 'monthly_compounding'];

async function downloadTemplate() {
  const XLSX = await loadXLSX();
  const headers = ['Partner Name', 'Phone', 'Email', 'Investment Amount', 'Contribution Date', 'ROI %', 'Duration (Months)', 'ROI Mode'];
  const samples = [
    ['Ssenkaali Pius', '0700123456', 'pius@example.com', 500000, '2025-03-09', 15, 12, 'monthly_compounding'],
    ['Ssenkaali Pius', '0700123456', 'pius@example.com', 300000, '2025-01-15', 15, 12, 'monthly_payout'],
    ['Namukisha Esther', '0754155112', 'esther@example.com', 1000000, '2024-11-20', 15, 12, 'monthly_compounding'],
    ['John Doe', '', '', 200000, '', 15, 6, 'monthly_payout'],
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, ...samples]);
  ws['!cols'] = [{ wch: 20 }, { wch: 15 }, { wch: 25 }, { wch: 18 }, { wch: 16 }, { wch: 8 }, { wch: 18 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Partners');
  XLSX.writeFile(wb, 'partner-import-template.xlsx');
}

/* ─── Helpers ─── */
function normalizePhone(raw: string): string {
  const cleaned = String(raw || '').replace(/[\s\-\+]/g, '');
  if (cleaned.startsWith('256') && cleaned.length === 12) return '0' + cleaned.slice(3);
  if (cleaned.startsWith('+256')) return '0' + cleaned.slice(4);
  return cleaned;
}

function parseAmount(raw: any): number {
  if (typeof raw === 'number') return raw;
  // Strip "UGX", commas, spaces
  const cleaned = String(raw || '').replace(/[UGX,\s]/gi, '');
  return Number(cleaned);
}

function validateRow(row: any, rowNum: number): ParsedRow {
  const mapped = normalizeHeaders(row);
  const errors: string[] = [];
  const name = String(mapped['Partner Name'] || '').trim();
  const phone = normalizePhone(mapped['Phone'] || '');
  const email = String(mapped['Email'] || '').trim();
  const amount = parseAmount(mapped['Investment Amount']);
  const roi = Number(mapped['ROI %']);
  const rawDuration = mapped['Duration (Months)'];
  const duration = rawDuration != null && String(rawDuration).trim() !== '' ? Number(rawDuration) : 12;
  const rawRoiMode = mapped['ROI Mode'];
  const roiMode = rawRoiMode && String(rawRoiMode).trim() !== ''
    ? String(rawRoiMode).trim().toLowerCase().replace(/\s+/g, '_')
    : 'monthly_payout';
  const contributionDate = parseContributionDate(mapped['Contribution Date']);

  if (!name) errors.push('Missing partner name');
  if (phone && phone.length < 10) errors.push('Invalid phone (must be 10+ digits or blank)');
  if (!isInvestAmountValid(amount)) {
    const { min, max } = investBounds();
    if (isNaN(amount) || amount < min) errors.push(`Amount must be ≥ ${min.toLocaleString('en-US')}`);
    else errors.push(`Amount must be ≤ ${max.toLocaleString('en-US')}`);
  }
  if (isNaN(roi) || roi < 1 || roi > 30) errors.push('ROI must be 1-30%');
  if (isNaN(duration) || duration < 1 || duration > 36) errors.push('Duration must be 1-36 months');
  if (!VALID_ROI_MODES.includes(roiMode)) errors.push(`ROI mode must be: ${VALID_ROI_MODES.join(' or ')}`);

  return { rowNum, partnerName: name, phone, email, investmentAmount: amount, roiPercentage: roi, durationMonths: duration, roiMode, contributionDate, errors };
}

function groupByPartner(rows: ParsedRow[]): ImportGroup[] {
  const map = new Map<string, ImportGroup>();
  let noIdentifierCounter = 0;
  for (const row of rows) {
    // Group by phone first, then by email, otherwise each row is its own group
    const key = row.phone
      ? `phone:${row.phone}`
      : row.email
        ? `email:${row.email.toLowerCase().trim()}`
        : `__no_id_${noIdentifierCounter++}_${row.partnerName}`;
    if (!map.has(key)) {
      map.set(key, {
        partnerName: row.partnerName,
        phone: row.phone,
        email: row.email,
        portfolios: [],
        isDuplicate: false,
        errors: [...row.errors.filter(e => e.includes('name') || e.includes('phone'))],
      });
    }
    const group = map.get(key)!;
    // If this row has an email and the group doesn't yet, adopt it
    if (row.email && !group.email) {
      group.email = row.email;
    }
    if (row.errors.length === 0 || row.errors.every(e => !e.includes('name') && !e.includes('phone'))) {
      group.portfolios.push({
        amount: row.investmentAmount,
        roiPercentage: row.roiPercentage,
        durationMonths: row.durationMonths,
        roiMode: row.roiMode,
        contributionDate: row.contributionDate,
      });
    }
    const portfolioErrors = row.errors.filter(e => !e.includes('name') && !e.includes('phone'));
    if (portfolioErrors.length > 0) {
      group.errors.push(`Row ${row.rowNum}: ${portfolioErrors.join(', ')}`);
    }
  }
  return Array.from(map.values());
}

function formatImportError(error: unknown, partnerName?: string): string {
  const partnerLabel = partnerName?.trim() || 'this partner';
  const genericMessage = `The backend did not return a readable reason for ${partnerLabel}. Please check for a duplicate phone/email, invalid amount, invalid return mode, missing contribution date, or missing required payout details, then try again.`;

  if (!error) return genericMessage;
  if (typeof error === 'string') {
    const trimmed = error.trim();
    if (!trimmed || trimmed === '{}' || trimmed === '[object Object]') {
      return genericMessage;
    }
    return trimmed;
  }
  if (error instanceof Error) return formatImportError(error.message, partnerName);
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message = record.message ?? record.error ?? record.details ?? record.hint ?? record.reason ?? record.description;
    if (message) return formatImportError(message, partnerName);

    const readableFields = Object.entries(record)
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim() && String(value).trim() !== '{}')
      .map(([key, value]) => `${key}: ${formatImportError(value, partnerName)}`);
    if (readableFields.length > 0) return readableFields.join('; ');

    return genericMessage;
  }
  return String(error);
}

function normalizeImportResult(data: any): ImportResult {
  return {
    partnersCreated: Number(data?.partnersCreated || 0),
    partnersMatched: Number(data?.partnersMatched || 0),
    portfoliosCreated: Number(data?.portfoliosCreated || 0),
    skippedDuplicates: Number(data?.skippedDuplicates || 0),
    errors: Array.isArray(data?.errors)
      ? data.errors.map((item: any) => {
        const partner = String(item?.partner || 'Unknown partner');
        return { partner, error: formatImportError(item?.error, partner) };
      })
      : [],
  };
}

/* ─── Component ─── */
interface PartnerImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export default function PartnerImportDialog({ open, onOpenChange, onSuccess }: PartnerImportDialogProps) {
  const [step, setStep] = useState<Step>('upload');
  const [fileName, setFileName] = useState('');
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [groups, setGroups] = useState<ImportGroup[]>([]);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClose = () => {
    setStep('upload');
    setFileName('');
    setParsedRows([]);
    setGroups([]);
    setImportResult(null);
    onOpenChange(false);
  };

  /* ── File Parse ── */
  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    try {
      const buffer = await file.arrayBuffer();
      const XLSX = await loadXLSX();
      const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const jsonRows = XLSX.utils.sheet_to_json(ws);

      if (jsonRows.length === 0) {
        toast.error('The file has no data rows');
        return;
      }
      if (jsonRows.length > 500) {
        toast.error('Maximum 500 rows per import');
        return;
      }

      const validated = jsonRows.map((row, i) => validateRow(row, i + 2)); // +2 for header offset
      setParsedRows(validated);
      setFileName(file.name);

      // Check duplicates against existing profiles (phones and emails)
      const phones = [...new Set(validated.map(r => r.phone).filter(Boolean))];
      const emails = [...new Set(validated.map(r => r.email?.toLowerCase().trim()).filter(Boolean))];
      let existingPhones = new Set<string>();
      let existingEmails = new Set<string>();

      if (phones.length > 0) {
        const { data: existingProfiles } = await supabase
          .from('profiles')
          .select('phone')
          .in('phone', phones);
        existingPhones = new Set((existingProfiles || []).map(p => p.phone));
      }
      // Note: emails live in auth.users, not profiles — we can't query auth directly from client.
      // The edge function handles email dedup server-side. Here we just detect in-file email grouping.

      const grouped = groupByPartner(validated);
      grouped.forEach(g => {
        if (g.phone && existingPhones.has(g.phone)) g.isDuplicate = true;
      });

      setGroups(grouped);
      setStep('preview');
    } catch (e: any) {
      toast.error('Failed to parse file: ' + (e.message || 'Unknown error'));
    } finally {
      setLoading(false);
    }
  }, []);

  /* ── Stats ── */
  const validGroups = groups.filter(g => g.errors.length === 0 && g.portfolios.length > 0);
  const existingCount = groups.filter(g => g.isDuplicate).length;
  const errorGroups = groups.filter(g => g.errors.length > 0 || g.portfolios.length === 0);
  const totalPortfolios = validGroups.reduce((s, g) => s + g.portfolios.length, 0);
  const totalAmount = validGroups.reduce((s, g) => s + g.portfolios.reduce((ps, p) => ps + p.amount, 0), 0);

  /* ── Import ── */
  const handleImport = async () => {
    setStep('processing');
    setLoading(true);

    try {
      const payload = validGroups.map(g => ({
        partner_name: g.partnerName,
        phone: g.phone,
        email: g.email || null,
        portfolios: g.portfolios.map(p => ({
          amount: p.amount,
          roiPercentage: p.roiPercentage,
          durationMonths: p.durationMonths,
          roiMode: p.roiMode,
          contributionDate: p.contributionDate,
        })),
      }));

      const { data, error } = await supabase.functions.invoke('import-partners', {
        body: { partners: payload },
      });

      if (error) {
        let errMsg = error.message || 'Import failed';
        try {
          if (error?.context) {
            const body = await error.context.json();
            errMsg = body?.error || errMsg;
          }
        } catch { /* use default */ }
        throw new Error(errMsg);
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      const normalizedResult = normalizeImportResult(data);
      setImportResult(normalizedResult);
      setStep('results');
      const totalPartners = normalizedResult.partnersCreated + normalizedResult.partnersMatched;
      toast.success(`Import complete! ${totalPartners} partners (${normalizedResult.partnersCreated} new, ${normalizedResult.partnersMatched} existing), ${normalizedResult.portfoliosCreated} portfolios.`);
      onSuccess?.();
    } catch (e: any) {
      toast.error(e.message || 'Import failed');
      setStep('confirm');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto" onOpenAutoFocus={e => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-primary" />
            Import Partners & Portfolios
          </DialogTitle>
          <DialogDescription>
            {step === 'upload' && 'Upload an Excel file with partner and portfolio data'}
            {step === 'preview' && `Reviewing ${fileName}`}
            {step === 'confirm' && 'Confirm import details before processing'}
            {step === 'processing' && 'Creating accounts and portfolios…'}
            {step === 'results' && 'Import completed'}
          </DialogDescription>
        </DialogHeader>

        {/* ── Step: Upload ── */}
        {step === 'upload' && (
          <div className="space-y-4 py-2">
            <label
              htmlFor="partner-import-file-input"
              className="border-2 border-dashed border-border rounded-xl p-8 text-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-all block"
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            >
              {loading ? (
                <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
              ) : (
                <>
                  <Upload className="h-10 w-10 text-muted-foreground/50 mx-auto mb-3" />
                  <p className="font-semibold text-sm">Drop Excel file here or click to browse</p>
                  <p className="text-xs text-muted-foreground mt-1">Supports .xlsx files, max 500 rows</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Accepts flexible headers: "Supporter Name", "Principal (UGX)", "Rate", "Contribution Date", etc.</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Allowed range per portfolio: {defaultUGXFormatter(investBounds().min)} – {defaultUGXFormatter(investBounds().max)}. Rows with amounts outside this range will be rejected.</p>
                  <p className="text-[10px] text-muted-foreground/70 mt-2 px-4">💡 Phone is optional. Multiple portfolios per partner? Use the <strong>same phone number</strong> on each row — they'll be grouped automatically.</p>
                </>
              )}
              <input
                id="partner-import-file-input"
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) { handleFile(f); e.target.value = ''; } }}
              />
            </label>

            <div className="flex items-center justify-center">
              <button onClick={downloadTemplate} className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline font-medium">
                <Download className="h-3.5 w-3.5" /> Download Template
              </button>
            </div>
          </div>
        )}

        {/* ── Step: Preview ── */}
        {step === 'preview' && (
          <div className="space-y-4">
            {/* Summary Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StatCard icon={<Users className="h-4 w-4" />} label="New Partners" value={validGroups.length} color="text-primary" />
              <StatCard icon={<Briefcase className="h-4 w-4" />} label="Portfolios" value={totalPortfolios} color="text-emerald-600" />
              <StatCard icon={<AlertTriangle className="h-4 w-4" />} label="Existing" value={existingCount} color="text-amber-600" />
              <StatCard icon={<XCircle className="h-4 w-4" />} label="Errors" value={errorGroups.length} color="text-destructive" />
            </div>

            {/* Partner Groups */}
            <div className="max-h-[300px] overflow-y-auto space-y-2 rounded-lg border border-border p-2">
              {groups.map((g, i) => (
                <div key={i} className={cn(
                  'rounded-lg p-3 text-xs border',
                  g.isDuplicate ? 'bg-amber-500/5 border-amber-500/20' :
                  g.errors.length > 0 ? 'bg-destructive/5 border-destructive/20' :
                  'bg-card border-border'
                )}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {g.isDuplicate ? <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" /> :
                       g.errors.length > 0 ? <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" /> :
                       <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />}
                      <span className="font-semibold truncate">{g.partnerName}</span>
                      <span className="text-muted-foreground">{g.phone || 'No phone'}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-[9px]">{g.portfolios.length} portfolio{g.portfolios.length !== 1 ? 's' : ''}</Badge>
                      {g.isDuplicate && <Badge variant="secondary" className="text-[9px] bg-amber-500/15 text-amber-700">Existing</Badge>}
                    </div>
                  </div>
                  {g.portfolios.length > 0 && (
                    <div className="mt-1.5 pl-5 space-y-0.5 text-muted-foreground">
                      {g.portfolios.map((p, j) => (
                        <div key={j} className="flex gap-3">
                          <span>{formatUGX(p.amount)}</span>
                          <span>{p.roiPercentage}% ROI</span>
                          <span>{p.durationMonths}mo</span>
                          <span className="capitalize">{p.roiMode.replace('_', ' ')}</span>
                          {p.contributionDate && <span className="text-xs text-muted-foreground/70">📅 {p.contributionDate}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  {g.errors.length > 0 && (
                    <div className="mt-1.5 pl-5 text-destructive">
                      {g.errors.map((e, j) => <p key={j}>{e}</p>)}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep('upload')} className="gap-1.5">
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </Button>
              <Button onClick={() => setStep('confirm')} disabled={validGroups.length === 0} className="flex-1 gap-1.5">
                Review & Confirm <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        {/* ── Step: Confirm ── */}
        {step === 'confirm' && (
          <div className="space-y-4 py-2">
            <div className="rounded-xl bg-primary/5 border border-primary/20 p-5 space-y-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-primary" />
                <h3 className="font-bold text-sm">COO Confirmation Required</h3>
              </div>
              <p className="text-xs text-muted-foreground">
                You are about to create <strong>{validGroups.length} partner accounts</strong> with{' '}
                <strong>{totalPortfolios} investment portfolios</strong> totaling{' '}
                <strong>{formatUGX(totalAmount)}</strong>.
              </p>
              {existingCount > 0 && (
                <p className="text-xs text-amber-700">ℹ {existingCount} existing partner(s) — portfolios will be added to their accounts.</p>
              )}
              {errorGroups.length > 0 && (
                <p className="text-xs text-destructive">⚠ {errorGroups.length} partner(s) with errors will be skipped.</p>
              )}
              <Separator />
              <div className="text-xs text-muted-foreground space-y-1">
                <p>• Full user accounts will be created (can log in)</p>
                <p>• Portfolios start with <strong>pending_approval</strong> status</p>
                <p>• No wallet deductions — portfolios are record-only until activated</p>
                <p>• Each partner gets a unique activation token</p>
                <p>• If a contribution date is provided, it will be used as the portfolio start date</p>
              </div>
            </div>

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep('preview')} className="gap-1.5">
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </Button>
              <Button onClick={handleImport} disabled={loading} className="flex-1 gap-1.5">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <><ShieldCheck className="h-4 w-4" /> Confirm & Import</>}
              </Button>
            </div>
          </div>
        )}

        {/* ── Step: Processing ── */}
        {step === 'processing' && (
          <div className="text-center py-12 space-y-4">
            <Loader2 className="h-10 w-10 animate-spin text-primary mx-auto" />
            <p className="text-sm font-semibold">Creating accounts and portfolios…</p>
            <p className="text-xs text-muted-foreground">This may take a moment for large imports.</p>
          </div>
        )}

        {/* ── Step: Results ── */}
        {step === 'results' && importResult && (
          <div className="space-y-4 py-2">
            <div className="text-center py-4">
              <div className="w-16 h-16 mx-auto bg-emerald-500/15 rounded-full flex items-center justify-center mb-3">
                <CheckCircle2 className="h-8 w-8 text-emerald-600" />
              </div>
              <h3 className="text-lg font-bold">Import Complete!</h3>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <StatCard icon={<Users className="h-4 w-4" />} label="Partners" value={importResult.partnersCreated + importResult.partnersMatched} color="text-primary" />
              <StatCard icon={<Briefcase className="h-4 w-4" />} label="Portfolios Created" value={importResult.portfoliosCreated} color="text-emerald-600" />
              <StatCard icon={<AlertTriangle className="h-4 w-4" />} label="Skipped" value={importResult.skippedDuplicates} color="text-amber-600" />
            </div>

            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs space-y-1">
              <p className="font-semibold text-foreground">🔐 Login Credentials</p>
              <p className="text-muted-foreground">{importResult.partnersCreated} new · {importResult.partnersMatched} existing. Partners log in using their <strong>phone number</strong> and the default password:</p>
              <p className="font-mono font-bold text-primary text-sm">Welile[last 6 digits of phone]!</p>
              <p className="text-muted-foreground">Example: Phone 0700405936 → Password: <strong className="font-mono">Welile405936!</strong></p>
              <p className="text-[10px] text-muted-foreground mt-1">Partners should change their password after first login.</p>
            </div>

            {importResult.errors.length > 0 && (
              <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 max-h-[150px] overflow-y-auto">
                <p className="text-xs font-semibold text-destructive mb-1.5">Import issues that need attention:</p>
                <ul className="space-y-1.5">
                  {importResult.errors.map((e, i) => (
                    <li key={i} className="text-xs text-destructive/80">
                      <span className="font-semibold text-destructive">{e.partner || 'Unknown partner'}:</span>{' '}
                      {formatImportError(e.error, e.partner)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Button onClick={handleClose} className="w-full">Done</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ── Stat Card ── */
function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number | string; color: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-center">
      <div className={cn('mx-auto mb-1', color)}>{icon}</div>
      <p className="text-lg font-black tabular-nums">{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}
