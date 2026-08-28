import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Loader2, RefreshCw, ShieldCheck, AlertTriangle, ChevronDown, ChevronUp,
  Smartphone, Calendar, Hash, FileImage, ImageOff, CheckCircle2,
} from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';

type Report = {
  total_completed: number;
  with_proof: number;
  missing_proof: number;
  legacy_records: number;
  invalid_references: number;
  expired_url_legacy: number;
  storage_objects: number;
  orphaned_storage_files: number;
  missing_storage_objects: number;
  generated_at: string;
};

type Alert = {
  id: string;
  issue_type: string;
  severity: string;
  withdrawal_id: string | null;
  storage_path: string | null;
  details?: {
    fields?: string[];
    extracted_from_image?: {
      amount?: number | null;
      transactionId?: string | null;
      phone?: string | null;
      date?: string | null;
      time?: string | null;
      confidence?: string | null;
    } | null;
    extracted_from_sms?: {
      amount?: number | null;
      transactionId?: string | null;
      phone?: string | null;
      date?: string | null;
    } | null;
  } | null;
  created_at: string;
};

const sevTone = (s: string) =>
  s === 'critical' || s === 'high'
    ? 'bg-destructive/10 text-destructive border-destructive/30'
    : s === 'medium'
    ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30'
    : 'bg-muted text-muted-foreground border-border';

const formatMismatchField = (f: string) => {
  switch (f) {
    case 'phone_sms_vs_image':
      return { label: 'Phone Discrepancy', Icon: Smartphone, color: 'text-amber-700 bg-amber-500/10 border-amber-500/30' };
    case 'tid_sms_vs_image':
      return { label: 'TID Discrepancy', Icon: Hash, color: 'text-rose-700 bg-rose-500/10 border-rose-500/30' };
    case 'date_sms_vs_image':
      return { label: 'Date Discrepancy', Icon: Calendar, color: 'text-blue-700 bg-blue-500/10 border-blue-500/30' };
    default:
      return { label: f.replace(/_/g, ' '), Icon: AlertTriangle, color: 'text-muted-foreground bg-muted border-border' };
  }
};

/**
 * Proof-of-payment integrity dashboard — read-only reconciliation between
 * storage objects, withdrawal records, SMS verification logs and the Receipt Archive.
 * Never mutates financial data.
 */
export function PayoutProofIntegrityPanel() {
  const [report, setReport] = useState<Report | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedAlerts, setExpandedAlerts] = useState<Record<string, boolean>>({});
  const [filterType, setFilterType] = useState<'all' | 'mismatch' | 'storage' | 'reference'>('all');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [{ data, error: rpcErr }, { data: alertRows }] = await Promise.all([
        supabase.rpc('get_payout_proof_integrity_report' as any),
        supabase
          .from('payout_proof_integrity_alerts' as any)
          .select('id,issue_type,severity,withdrawal_id,storage_path,details,created_at')
          .eq('resolved', false)
          .order('created_at', { ascending: false })
          .limit(50),
      ]);
      if (rpcErr) throw rpcErr;
      setReport(data as unknown as Report);
      setAlerts((alertRows ?? []) as unknown as Alert[]);
    } catch (e: any) {
      setError(e?.message || 'Failed to load proof integrity report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleExpand = (id: string) => {
    setExpandedAlerts((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const filteredAlerts = alerts.filter((a) => {
    if (filterType === 'all') return true;
    if (filterType === 'mismatch') return a.issue_type === 'sms_image_field_mismatch' || a.issue_type.includes('mismatch');
    if (filterType === 'storage') return a.issue_type.includes('storage') || a.issue_type.includes('missing_proof');
    if (filterType === 'reference') return a.issue_type.includes('reference');
    return true;
  });

  const tiles: Array<{ label: string; value: number; warn?: boolean }> = report
    ? [
        { label: 'Completed payouts', value: report.total_completed },
        { label: 'With proof', value: report.with_proof },
        { label: 'Missing proof', value: report.missing_proof, warn: report.missing_proof > 0 },
        { label: 'Legacy records', value: report.legacy_records },
        { label: 'Storage objects', value: report.storage_objects },
        { label: 'Orphaned files', value: report.orphaned_storage_files, warn: report.orphaned_storage_files > 0 },
        { label: 'Invalid references', value: report.invalid_references, warn: report.invalid_references > 0 },
        { label: 'Expired URLs (legacy)', value: report.expired_url_legacy },
        { label: 'Missing storage objects', value: report.missing_storage_objects, warn: report.missing_storage_objects > 0 },
      ]
    : [];

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-lg font-bold flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              Proof of Payment &amp; OCR Integrity
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Storage object → withdrawal request → SMS &amp; proof screenshot cross-verification audit.
              Read-only; no financial records are touched.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-1.5">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh audit
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>
        ) : !report ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {tiles.map((t) => (
                <div
                  key={t.label}
                  className={`rounded-lg border p-3 ${t.warn ? 'border-destructive/30 bg-destructive/5' : 'bg-muted/30'}`}
                >
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t.label}</div>
                  <div className={`text-xl font-bold tabular-nums ${t.warn ? 'text-destructive' : ''}`}>
                    {t.value.toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Generated {format(new Date(report.generated_at), 'MMM d, yyyy HH:mm')} · automated check runs daily.
            </p>

            {alerts.length > 0 && (
              <div className="space-y-2.5 pt-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="text-xs font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                    Open integrity alerts ({filteredAlerts.length})
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant={filterType === 'all' ? 'secondary' : 'ghost'}
                      className="h-7 text-xs px-2.5"
                      onClick={() => setFilterType('all')}
                    >
                      All ({alerts.length})
                    </Button>
                    <Button
                      size="sm"
                      variant={filterType === 'mismatch' ? 'secondary' : 'ghost'}
                      className="h-7 text-xs px-2.5"
                      onClick={() => setFilterType('mismatch')}
                    >
                      SMS vs Photo ({alerts.filter((a) => a.issue_type === 'sms_image_field_mismatch').length})
                    </Button>
                    <Button
                      size="sm"
                      variant={filterType === 'storage' ? 'secondary' : 'ghost'}
                      className="h-7 text-xs px-2.5"
                      onClick={() => setFilterType('storage')}
                    >
                      Storage
                    </Button>
                  </div>
                </div>

                <div className="max-h-96 overflow-y-auto space-y-2 rounded-lg border p-2 bg-muted/10">
                  {filteredAlerts.map((a) => {
                    const isMismatch = a.issue_type === 'sms_image_field_mismatch';
                    const mismatchFields = a.details?.fields || [];
                    const img = a.details?.extracted_from_image;
                    const sms = a.details?.extracted_from_sms;
                    const isExpanded = !!expandedAlerts[a.id];

                    return (
                      <div key={a.id} className="rounded-lg border bg-card p-3 space-y-2 text-xs shadow-sm">
                        <div className="flex items-start justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant="outline" className={`text-[10px] ${sevTone(a.severity)}`}>
                              {a.severity}
                            </Badge>
                            <span className="font-semibold text-foreground">
                              {isMismatch ? 'SMS & Proof Photo Field Mismatch' : a.issue_type.replace(/_/g, ' ')}
                            </span>
                            {a.withdrawal_id && (
                              <span className="font-mono text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                                WID: {a.withdrawal_id.slice(0, 8)}…
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                            {format(new Date(a.created_at), 'MMM d, HH:mm')}
                          </span>
                        </div>

                        {/* Mismatch badges for each individual field */}
                        {isMismatch && mismatchFields.length > 0 && (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {mismatchFields.map((f) => {
                              const meta = formatMismatchField(f);
                              const Icon = meta.Icon;
                              return (
                                <span
                                  key={f}
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${meta.color}`}
                                >
                                  <Icon className="h-3 w-3" />
                                  {meta.label}
                                </span>
                              );
                            })}
                          </div>
                        )}

                        {/* Side-by-side comparison when details are present */}
                        {isMismatch && (img || sms) && (
                          <div className="pt-1">
                            <button
                              type="button"
                              onClick={() => toggleExpand(a.id)}
                              className="text-[11px] font-semibold text-primary hover:underline inline-flex items-center gap-1"
                            >
                              {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                              {isExpanded ? 'Hide comparison data' : 'View SMS vs Photo comparison'}
                            </button>

                            {isExpanded && (
                              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 p-2.5 rounded-lg border bg-muted/30">
                                {/* SMS extracted */}
                                <div className="space-y-1.5 p-2 rounded bg-background border">
                                  <p className="font-semibold text-[11px] text-muted-foreground flex items-center gap-1">
                                    <Smartphone className="h-3 w-3" /> Extracted from Pasted SMS
                                  </p>
                                  <div className="space-y-1 text-[11px]">
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">TID:</span>
                                      <span className="font-mono font-medium">{sms?.transactionId || '—'}</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">Amount:</span>
                                      <span className="font-semibold tabular-nums">{sms?.amount != null ? formatUGX(sms.amount) : '—'}</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">Phone:</span>
                                      <span className="font-mono">{sms?.phone || '—'}</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">Date:</span>
                                      <span>{sms?.date || '—'}</span>
                                    </div>
                                  </div>
                                </div>

                                {/* Proof Photo OCR extracted */}
                                <div className="space-y-1.5 p-2 rounded bg-background border">
                                  <p className="font-semibold text-[11px] text-muted-foreground flex items-center gap-1">
                                    <FileImage className="h-3 w-3" /> Extracted from Proof Photo (OCR)
                                  </p>
                                  <div className="space-y-1 text-[11px]">
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">TID:</span>
                                      <span className="font-mono font-medium">{img?.transactionId || '—'}</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">Amount:</span>
                                      <span className="font-semibold tabular-nums">{img?.amount != null ? formatUGX(img.amount) : '—'}</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">Phone:</span>
                                      <span className="font-mono">{img?.phone || '—'}</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">Date / Time:</span>
                                      <span>{[img?.date, img?.time].filter(Boolean).join(' ') || '—'}</span>
                                    </div>
                                    {img?.confidence && (
                                      <div className="flex justify-between pt-1 border-t text-[10px]">
                                        <span className="text-muted-foreground">Confidence:</span>
                                        <span className={img.confidence === 'high' ? 'text-emerald-600 font-semibold' : 'text-amber-600 font-semibold'}>
                                          {img.confidence.toUpperCase()}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default PayoutProofIntegrityPanel;