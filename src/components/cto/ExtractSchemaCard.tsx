import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Database, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';

export default function ExtractSchemaCard() {
  const [loading, setLoading] = useState(false);

  const handleExtract = async () => {
    setLoading(true);
    try {
      const { data, error } = await invokeEdgeFunction<{ sql?: string; error?: string }>(
        'extract-schema',
        {}
      );
      if (error) throw new Error(error.message || 'Extract failed');
      if (!data?.sql) throw new Error(data?.error || 'No schema returned');

      const blob = new Blob([data.sql], { type: 'application/sql' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url;
      a.download = `welile_schema_${stamp}.sql`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('Schema downloaded');
    } catch (err: any) {
      console.error('Schema extract failed:', err);
      toast.error(err?.message || 'Failed to extract schema');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-3 sm:p-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="h-10 w-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Database className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Extract Database Schema</h3>
          <p className="text-xs text-muted-foreground truncate">
            Download a SQL dump of all tables, enums, indexes, RLS policies, triggers and functions in the public schema.
          </p>
        </div>
      </div>
      <Button
        size="sm"
        onClick={handleExtract}
        disabled={loading}
        className="shrink-0"
      >
        {loading ? (
          <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Extracting…</>
        ) : (
          <><Download className="h-4 w-4 mr-1.5" />Download .sql</>
        )}
      </Button>
    </div>
  );
}