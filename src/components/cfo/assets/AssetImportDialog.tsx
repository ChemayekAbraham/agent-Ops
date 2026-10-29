import { useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { checkAssetDuplicates, useAssetReferenceData, useCommitAssetImport } from '@/hooks/useAssetRegister';
import {
  applyDuplicateMatches, commitPayload, duplicateCheckPayload, parseAssetSheet, sha256Hex, summariseImport,
  type ImportRow, type ImportRowStatus,
} from '@/lib/assetRegister/importParser';
import { buildErrorReportWorkbook, buildTemplateWorkbook, importStatusText } from '@/lib/assetRegister/template';
import { describeAssetRpcError } from '@/lib/assetRegister/validation';
import { categoryLabel, type ImportCommitResult } from '@/lib/assetRegister/types';

// xlsx is ~430 KB — loaded on demand.
const loadXLSX = () => import('xlsx');

const STATUS_TONE: Record<ImportRowStatus, string> = {
  valid: 'bg-success/10 text-success',
  invalid: 'bg-destructive/10 text-destructive',
  duplicate_file: 'bg-destructive/10 text-destructive',
  duplicate_existing: 'bg-destructive/10 text-destructive',
  possible_duplicate: 'bg-warning/10 text-warning',
};

type Step = 'upload' | 'preview' | 'result';

export function AssetImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const ref = useAssetReferenceData(open);
  const commit = useCommitAssetImport();
  const [step, setStep] = useState<Step>('upload');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<{ name: string; sha: string } | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [headerErrors, setHeaderErrors] = useState<string[]>([]);
  const [unknownHeaders, setUnknownHeaders] = useState<string[]>([]);
  const [filter, setFilter] = useState<'all' | 'problems'>('all');
  const [includePossible, setIncludePossible] = useState(false);
  const [result, setResult] = useState<ImportCommitResult | null>(null);

  const reset = () => {
    setStep('upload'); setFile(null); setRows([]); setHeaderErrors([]); setUnknownHeaders([]);
    setFilter('all'); setIncludePossible(false); setResult(null);
    if (fileRef.current) fileRef.current.value = '';
  };
  const close = (o: boolean) => { if (busy || commit.isPending) return; if (!o) reset(); onOpenChange(o); };

  const counts = useMemo(() => summariseImport(rows), [rows]);
  const toCommit = useMemo(() => commitPayload(rows, includePossible), [rows, includePossible]);
  const shown = filter === 'all' ? rows : rows.filter((r) => r.status !== 'valid');

  const downloadTemplate = async () => {
    const XLSX = await loadXLSX();
    XLSX.writeFile(buildTemplateWorkbook(XLSX, ref.data?.sites ?? []), 'welile_asset_register_template.xlsx');
  };

  const downloadErrors = async () => {
    const XLSX = await loadXLSX();
    XLSX.writeFile(buildErrorReportWorkbook(XLSX, rows), 'asset_import_rows_not_imported.xlsx');
  };

  const handleFile = async (f: File) => {
    if (f.size > 10 * 1024 * 1024) { toast.error('The file is larger than 10 MB.'); return; }
    setBusy(true);
    try {
      const buf = await f.arrayBuffer();
      const [XLSX, sha] = await Promise.all([loadXLSX(), sha256Hex(buf)]);
      const wb = XLSX.read(buf, { type: 'array' });
      const sheetName = wb.SheetNames.includes('Assets') ? 'Assets' : wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', blankrows: false, raw: true });
      const parsed = parseAssetSheet(aoa, { departments: ref.data?.departments ?? [], sites: ref.data?.sites ?? [] });
      setHeaderErrors(parsed.headerErrors);
      setUnknownHeaders(parsed.unknownHeaders);
      let next = parsed.rows;
      if (next.length) {
        const matches = await checkAssetDuplicates(duplicateCheckPayload(next));
        next = applyDuplicateMatches(next, matches);
      }
      setRows(next);
      setFile({ name: f.name, sha });
      setStep('preview');
    } catch (err) {
      toast.error(err instanceof Error && !('code' in err) ? err.message : describeAssetRpcError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const doCommit = async () => {
    if (!file || !toCommit.length) return;
    try {
      const res = await commit.mutateAsync({ fileName: file.name, fileSha256: file.sha, rows: toCommit });
      setResult(res);
      setStep('result');
      if (res.status === 'committed') toast.success(`${res.inserted_count} asset(s) imported`);
      else toast.error('The server rejected the import. Nothing was saved.');
    } catch (err) {
      toast.error(describeAssetRpcError(err).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[90vh] max-w-5xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileSpreadsheet className="h-5 w-5 text-primary" /> Import assets from Excel</DialogTitle>
          <DialogDescription>
            Preview and validate every row before anything is saved. Imports only add new assets; existing records are never changed.
          </DialogDescription>
        </DialogHeader>

        {step === 'upload' && (
          <div className="space-y-4 py-2">
            <button
              type="button"
              id="asset-import-dropzone"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void handleFile(f); }}
              disabled={busy || ref.isLoading}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-muted/20 px-6 py-12 text-center transition hover:border-primary/50 hover:bg-primary/5 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-8 w-8 animate-spin text-primary" /> : <Upload className="h-8 w-8 text-primary" />}
              <span className="text-sm font-medium">{busy ? 'Reading and checking the file…' : 'Choose an .xlsx, .xls or .csv file, or drop it here'}</span>
              <span className="text-xs text-muted-foreground">Up to 1,000 rows · Asset Name and Category are required</span>
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
            <Button id="asset-import-template" variant="outline" size="sm" onClick={() => void downloadTemplate()}>
              <Download className="mr-1.5 h-4 w-4" /> Download template
            </Button>
          </div>
        )}

        {step === 'preview' && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="font-medium text-foreground">{file?.name}</span>
              <Count label="Rows" n={counts.total} />
              <Count label="Ready" n={counts.valid} tone={STATUS_TONE.valid} />
              <Count label="Invalid" n={counts.invalid} tone={STATUS_TONE.invalid} />
              <Count label="Duplicate in file" n={counts.duplicate_file} tone={STATUS_TONE.duplicate_file} />
              <Count label="Already registered" n={counts.duplicate_existing} tone={STATUS_TONE.duplicate_existing} />
              <Count label="Possible duplicate" n={counts.possible_duplicate} tone={STATUS_TONE.possible_duplicate} />
            </div>

            {headerErrors.length > 0 && (
              <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>{headerErrors.map((e) => <p key={e}>{e}</p>)}</div>
              </div>
            )}
            {unknownHeaders.length > 0 && (
              <p className="text-[11px] text-muted-foreground">Ignored column(s): {unknownHeaders.join(', ')}</p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex rounded-lg border border-border p-0.5" role="tablist" aria-label="Rows to show">
                {(['all', 'problems'] as const).map((f) => (
                  <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition ${filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                    {f === 'all' ? 'All rows' : 'Rows with problems'}
                  </button>
                ))}
              </div>
              {counts.total > counts.valid && (
                <Button id="asset-import-error-report" variant="outline" size="sm" className="h-8 text-xs" onClick={() => void downloadErrors()}>
                  <Download className="mr-1.5 h-3.5 w-3.5" /> Download rows not imported
                </Button>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-muted/80 text-[11px] text-muted-foreground backdrop-blur">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Row</th>
                    <th className="px-3 py-2 text-left font-medium">Result</th>
                    <th className="px-3 py-2 text-left font-medium">Name</th>
                    <th className="px-3 py-2 text-left font-medium">Category</th>
                    <th className="px-3 py-2 text-left font-medium">Serial</th>
                    <th className="px-3 py-2 text-left font-medium">Problems</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {shown.length === 0 && (
                    <tr><td colSpan={6} className="py-8 text-center text-muted-foreground">No rows to show.</td></tr>
                  )}
                  {shown.map((r) => (
                    <tr key={r.row_ref} className="align-top">
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.row_ref}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_TONE[r.status]}`}>{importStatusText(r.status)}</span>
                      </td>
                      <td className="max-w-[14rem] truncate px-3 py-2 text-foreground">{r.value.name ?? '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{r.value.category ? categoryLabel(r.value.category) : '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-muted-foreground">{r.value.serial_number ?? '—'}</td>
                      <td className="px-3 py-2 text-[11px]">
                        {r.errors.length === 0 ? <span className="text-muted-foreground">—</span> : (
                          <ul className="space-y-0.5">
                            {r.errors.map((e, i) => (
                              <li key={i} className={r.status === 'possible_duplicate' ? 'text-warning' : 'text-destructive'}>
                                {e.field === '_' ? e.message : `${e.field.replace(/_/g, ' ')}: ${e.message}`}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {counts.possible_duplicate > 0 && (
              <div className="flex items-center gap-2">
                <Checkbox id="asset-import-include-possible" checked={includePossible} onCheckedChange={(v) => setIncludePossible(v === true)} />
                <Label htmlFor="asset-import-include-possible" className="text-xs">
                  Also import the {counts.possible_duplicate} possible duplicate(s) — I have checked they are different assets
                </Label>
              </div>
            )}
          </div>
        )}

        {step === 'result' && result && (
          <div className="space-y-3 py-4">
            {result.status === 'committed' ? (
              <div className="flex items-start gap-3 rounded-xl border border-success/30 bg-success/10 p-4 text-sm">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
                <div>
                  <p className="font-semibold text-foreground">{result.inserted_count} asset(s) imported</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Asset IDs {result.asset_codes[0]}{result.asset_codes.length > 1 ? ` to ${result.asset_codes[result.asset_codes.length - 1]}` : ''}.
                    {counts.total - result.inserted_count > 0 && ` ${counts.total - result.inserted_count} row(s) were not imported.`}
                  </p>
                </div>
              </div>
            ) : (
              <div role="alert" className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-xs text-destructive">
                <p className="flex items-center gap-2 text-sm font-semibold"><AlertCircle className="h-4 w-4" /> Nothing was saved</p>
                <p>The server found problems the preview did not. Fix these rows and import again:</p>
                <ul className="max-h-48 list-disc space-y-0.5 overflow-auto pl-5">
                  {result.errors.map((e, i) => <li key={i}>Row {e.row_ref}: {e.field === '_' ? '' : `${e.field.replace(/_/g, ' ')} — `}{e.message}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {step === 'preview' && (
            <>
              <Button variant="outline" onClick={reset} disabled={commit.isPending}>
                <ArrowLeft className="mr-1.5 h-4 w-4" /> Choose another file
              </Button>
              <Button id="asset-import-commit" onClick={() => void doCommit()} disabled={commit.isPending || toCommit.length === 0 || headerErrors.some((e) => e.startsWith('Missing'))}>
                {commit.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Import {toCommit.length} asset(s)
              </Button>
            </>
          )}
          {step === 'result' && (
            <>
              {result?.status === 'rejected' && <Button variant="outline" onClick={reset}>Start again</Button>}
              <Button onClick={() => close(false)}>Done</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Count({ label, n, tone }: { label: string; n: number; tone?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${tone ?? 'bg-muted text-muted-foreground'}`}>
      {label} <span className="font-semibold tabular-nums">{n.toLocaleString()}</span>
    </span>
  );
}
