import { useState, useMemo, useRef } from 'react';
// xlsx is ~430 KB — loaded on demand when a file is actually parsed.
const loadXLSX = () => import('xlsx');
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { Upload, FileSpreadsheet, AlertCircle, CheckCircle2, Loader2, Trash2, ArrowRight, ArrowLeft, Download } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

type RowStatus = 'valid' | 'invalid' | 'duplicate_file' | 'duplicate_db';
interface PreviewRow {
  id: string;
  name: string;
  phone: string;
  property_address: string;
  verified: boolean;
  status: RowStatus;
  errors: string[];
}

const HEADER_ALIASES: Record<string, 'name' | 'phone' | 'property_address' | 'verified'> = {
  name: 'name', 'landlord name': 'name', 'full name': 'name', owner: 'name',
  phone: 'phone', 'phone number': 'phone', mobile: 'phone', tel: 'phone', telephone: 'phone', contact: 'phone',
  location: 'property_address', address: 'property_address', 'property address': 'property_address', property: 'property_address', area: 'property_address',
  status: 'verified', verified: 'verified',
};

function normalizePhone(raw: string): string {
  if (!raw) return '';
  let s = String(raw).replace(/[\s\-()]/g, '').trim();
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('0') && s.length === 10) s = '256' + s.slice(1);
  if (s.startsWith('7') && s.length === 9) s = '256' + s;
  return s;
}

function last9(phone: string): string {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : d;
}

function parseStatus(raw: string): boolean {
  // Default verified = true unless explicitly says pending/unverified/no/false
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return true;
  if (['pending', 'unverified', 'no', 'false', '0', 'not verified', 'inactive'].includes(s)) return false;
  return true;
}

export function BulkImportLandlordsDialog({ open, onClose, onImported }: Props) {
  const { user } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [existingPhones, setExistingPhones] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ inserted: number; skipped: number } | null>(null);

  const reset = () => {
    setStep(1); setRows([]); setExistingPhones(new Set()); setResult(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleClose = () => { reset(); onClose(); };

  const downloadTemplate = () => {
    const csv = 'Name,Phone,Location,Status\nJohn Doe,0772123456,Kampala Central,Verified\nJane Smith,0701234567,Ntinda,Verified';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'landlords_template.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const validateRow = (row: PreviewRow, allRows: PreviewRow[], dbPhones: Set<string>): PreviewRow => {
    const errors: string[] = [];
    const name = row.name.trim();
    const phone = normalizePhone(row.phone);
    const addr = row.property_address.trim();
    if (!name) errors.push('Name required');
    else if (name.length < 2) errors.push('Name too short');
    else if (name.length > 100) errors.push('Name too long');
    if (!phone) errors.push('Phone required');
    if (!addr) errors.push('Location required');

    let status: RowStatus = errors.length ? 'invalid' : 'valid';
    if (status === 'valid' && phone) {
      const k = last9(phone);
      if (dbPhones.has(k)) status = 'duplicate_db';
      else {
        const dupInFile = allRows.some(r => r.id !== row.id && last9(normalizePhone(r.phone)) === k);
        if (dupInFile) status = 'duplicate_file';
      }
    }
    return { ...row, status, errors };
  };

  const revalidate = (next: PreviewRow[], dbPhones: Set<string>) =>
    next.map(r => validateRow(r, next, dbPhones));

  const handleFile = async (file: File) => {
    setParsing(true);
    try {
      const buf = await file.arrayBuffer();
      const XLSX = await loadXLSX();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
      if (raw.length < 2) throw new Error('File is empty or missing data rows');

      const headers = (raw[0] as any[]).map(h => String(h || '').trim().toLowerCase());
      const colMap: Partial<Record<'name' | 'phone' | 'property_address' | 'verified', number>> = {};
      headers.forEach((h, i) => {
        const key = HEADER_ALIASES[h];
        if (key && colMap[key] === undefined) colMap[key] = i;
      });

      if (colMap.name === undefined || colMap.phone === undefined || colMap.property_address === undefined) {
        throw new Error('Required columns missing. Need: Name, Phone, Location');
      }

      const parsed: PreviewRow[] = raw.slice(1)
        .filter(r => r.some(c => String(c).trim()))
        .map((r, idx) => ({
          id: `r-${idx}-${Date.now()}`,
          name: String(r[colMap.name!] || '').trim(),
          phone: String(r[colMap.phone!] || '').trim(),
          property_address: String(r[colMap.property_address!] || '').trim(),
          verified: colMap.verified !== undefined ? parseStatus(String(r[colMap.verified!] || '')) : true,
          status: 'valid' as RowStatus,
          errors: [],
        }));

      if (parsed.length === 0) throw new Error('No data rows found');
      if (parsed.length > 2000) throw new Error('Maximum 2000 rows per import');

      const { data: existing } = await supabase.from('landlords').select('phone');
      const dbPhones = new Set((existing || []).map(e => last9(normalizePhone(e.phone || ''))).filter(Boolean));
      setExistingPhones(dbPhones);
      setRows(revalidate(parsed, dbPhones));
      setStep(2);
    } catch (e: any) {
      toast.error(e.message || 'Failed to parse file');
    } finally {
      setParsing(false);
    }
  };

  const updateRow = (id: string, field: 'name' | 'phone' | 'property_address', value: string) => {
    setRows(prev => {
      const next = prev.map(r => r.id === id ? { ...r, [field]: value } : r);
      return revalidate(next, existingPhones);
    });
  };

  const toggleVerified = (id: string) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, verified: !r.verified } : r));
  };

  const removeRow = (id: string) => {
    setRows(prev => revalidate(prev.filter(r => r.id !== id), existingPhones));
  };

  const stats = useMemo(() => {
    const valid = rows.filter(r => r.status === 'valid').length;
    const invalid = rows.filter(r => r.status === 'invalid').length;
    const dupFile = rows.filter(r => r.status === 'duplicate_file').length;
    const dupDb = rows.filter(r => r.status === 'duplicate_db').length;
    return { total: rows.length, valid, invalid, dupFile, dupDb };
  }, [rows]);

  const handleImport = async () => {
    if (!user) { toast.error('Not authenticated'); return; }
    const valid = rows.filter(r => r.status === 'valid');
    if (valid.length === 0) { toast.error('No valid rows to import'); return; }
    setImporting(true);
    try {
      const nowIso = new Date().toISOString();
      const payload = valid.map(r => ({
        name: r.name.trim(),
        phone: normalizePhone(r.phone),
        property_address: r.property_address.trim(),
        verified: r.verified,
        verified_at: r.verified ? nowIso : null,
        verified_by: r.verified ? user.id : null,
        registered_by: user.id,
      }));
      const { data, error } = await supabase.from('landlords').insert(payload).select('id');
      if (error) throw error;
      const inserted = data?.length || 0;
      const skipped = rows.length - inserted;

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'landlord_bulk_import',
        table_name: 'landlords',
        record_id: data?.[0]?.id || null,
        metadata: {
          total_rows: rows.length,
          inserted,
          skipped_invalid: stats.invalid,
          skipped_duplicates: stats.dupFile + stats.dupDb,
          reason: 'Landlord Ops bulk landlord import',
        },
      });

      setResult({ inserted, skipped });
      setStep(3);
      toast.success(`Imported ${inserted} landlord(s)`);
      onImported();
    } catch (e: any) {
      toast.error(e.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const statusBadge = (s: RowStatus) => {
    if (s === 'valid') return <Badge className="bg-emerald-500/20 text-emerald-700 border-0 text-[10px]">Valid</Badge>;
    if (s === 'invalid') return <Badge className="bg-red-500/20 text-red-700 border-0 text-[10px]">Invalid</Badge>;
    if (s === 'duplicate_db') return <Badge className="bg-amber-500/20 text-amber-700 border-0 text-[10px]">Already in DB</Badge>;
    return <Badge className="bg-amber-500/20 text-amber-700 border-0 text-[10px]">Dup in file</Badge>;
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileSpreadsheet className="h-5 w-5 text-sky-600" />
            Bulk Import Landlords — Step {step} of 3
          </DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-4 py-4">
            <div className="rounded-lg border-2 border-dashed border-border p-8 text-center space-y-3">
              <Upload className="h-10 w-10 mx-auto text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Upload CSV or Excel file</p>
                <p className="text-xs text-muted-foreground mt-1">Required: <strong>Name, Phone, Location</strong>. Optional: <strong>Status</strong> (defaults to Verified).</p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
              <Button onClick={() => fileRef.current?.click()} disabled={parsing}>
                {parsing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
                {parsing ? 'Parsing…' : 'Choose File'}
              </Button>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Max 2000 rows. Phone numbers accepted in any format.</span>
              <Button variant="ghost" size="sm" onClick={downloadTemplate}>
                <Download className="h-3.5 w-3.5 mr-1" /> Template
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex flex-wrap gap-2 py-2 text-xs border-b border-border">
              <Badge variant="outline">Total: {stats.total}</Badge>
              <Badge className="bg-emerald-500/20 text-emerald-700 border-0">Valid: {stats.valid}</Badge>
              {stats.invalid > 0 && <Badge className="bg-red-500/20 text-red-700 border-0">Invalid: {stats.invalid}</Badge>}
              {stats.dupFile > 0 && <Badge className="bg-amber-500/20 text-amber-700 border-0">Dup in file: {stats.dupFile}</Badge>}
              {stats.dupDb > 0 && <Badge className="bg-amber-500/20 text-amber-700 border-0">Already in DB: {stats.dupDb}</Badge>}
            </div>
            <div className="flex-1 overflow-y-auto -mx-6 px-6 py-2">
              <div className="space-y-1.5">
                {rows.map((r, idx) => (
                  <div key={r.id} className={`rounded-lg border p-2 ${r.status === 'valid' ? 'border-border bg-card' : 'border-amber-500/40 bg-amber-500/5'}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] text-muted-foreground w-8">#{idx + 1}</span>
                      {statusBadge(r.status)}
                      <button
                        onClick={() => toggleVerified(r.id)}
                        className={`text-[10px] px-2 py-0.5 rounded-full font-semibold transition-colors ${r.verified ? 'bg-emerald-500/20 text-emerald-700' : 'bg-amber-500/20 text-amber-700'}`}
                        title="Toggle verification"
                      >
                        {r.verified ? 'Verified' : 'Pending'}
                      </button>
                      <button onClick={() => removeRow(r.id)} className="ml-auto text-muted-foreground hover:text-destructive">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <Input value={r.name} onChange={e => updateRow(r.id, 'name', e.target.value)} placeholder="Name" className="h-8 text-xs" />
                      <Input value={r.phone} onChange={e => updateRow(r.id, 'phone', e.target.value)} placeholder="Phone" className="h-8 text-xs" />
                      <Input value={r.property_address} onChange={e => updateRow(r.id, 'property_address', e.target.value)} placeholder="Location" className="h-8 text-xs" />
                    </div>
                    {r.errors.length > 0 && (
                      <div className="flex items-center gap-1 mt-1 text-[10px] text-red-600">
                        <AlertCircle className="h-3 w-3" />
                        {r.errors.join(', ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between pt-3 border-t border-border">
              <Button variant="ghost" onClick={() => { reset(); }}>
                <ArrowLeft className="h-4 w-4 mr-1" /> Back
              </Button>
              <Button onClick={handleImport} disabled={importing || stats.valid === 0}>
                {importing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ArrowRight className="h-4 w-4 mr-2" />}
                Import {stats.valid} valid row{stats.valid === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && result && (
          <div className="py-8 text-center space-y-4">
            <CheckCircle2 className="h-12 w-12 mx-auto text-emerald-600" />
            <div>
              <p className="text-lg font-bold">Import Complete</p>
              <p className="text-sm text-muted-foreground mt-1">
                {result.inserted} landlord(s) added • {result.skipped} skipped
              </p>
            </div>
            <Button onClick={handleClose}>Done</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}