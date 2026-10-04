import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertTriangle, Download, FileText, Loader2 } from 'lucide-react';

interface AgreementRecord {
  version_code: string;
  body_md: string;
  accepted_at: string;
  period_month: string;
  lead_name: string | null;
  checksum: string;
}

function formatDate(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function formatMonth(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export default function ProxyAgreementRecord() {
  const [rows, setRows] = useState<AgreementRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data, error: rpcError } = await supabase.rpc('my_proxy_agreement_record');
      if (cancelled) return;

      if (rpcError) {
        setError(rpcError.message);
      } else {
        const list = (Array.isArray(data) ? data : data ? [data] : []) as unknown as AgreementRecord[];
        list.sort(
          (a, b) => new Date(b.accepted_at).getTime() - new Date(a.accepted_at).getTime(),
        );
        setRows(list);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleDownload = (record: AgreementRecord) => {
    const footer = `Accepted by you on ${record.accepted_at}. Version ${record.version_code}. Reference ${record.checksum}.`;
    const content = `${record.body_md || ''}\n\n${footer}\n`;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `welile-proxy-agreement-${record.version_code}-${record.period_month}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const latest = rows[0];
  const earlier = rows.slice(1);

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto w-full max-w-2xl space-y-4">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading your agreement record…
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              You have not yet accepted a proxy agent agreement.
            </CardContent>
          </Card>
        )}

        {latest && (
          <Card>
            <CardHeader className="space-y-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-4 w-4 text-primary" />
                Proxy agent agreement
              </CardTitle>
              <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                <span>Accepted: {formatDate(latest.accepted_at)}</span>
                <span>Covers: {formatMonth(latest.period_month)}</span>
                <span>Lead assigned: {latest.lead_name || 'Not assigned'}</span>
                <span>Version: {latest.version_code}</span>
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              <ScrollArea className="h-[45vh] rounded-md border p-4">
                <div className="prose prose-sm max-w-none dark:prose-invert text-sm leading-relaxed">
                  <ReactMarkdown>{latest.body_md || ''}</ReactMarkdown>
                </div>
              </ScrollArea>

              <Button variant="outline" onClick={() => handleDownload(latest)} className="gap-2">
                <Download className="h-4 w-4" />
                Download
              </Button>
            </CardContent>
          </Card>
        )}

        {earlier.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Earlier acceptances</CardTitle>
            </CardHeader>
            <CardContent className="divide-y p-0">
              {earlier.map((record) => (
                <div
                  key={`${record.checksum}-${record.accepted_at}`}
                  className="flex items-center justify-between gap-3 px-5 py-3 text-xs"
                >
                  <span className="font-medium">{formatMonth(record.period_month)}</span>
                  <span className="text-muted-foreground">Version {record.version_code}</span>
                  <span className="text-muted-foreground">{formatDate(record.accepted_at)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}