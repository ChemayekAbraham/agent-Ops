import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { KeyRound, Download, Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';

export default function ExportUsersWithHashesCard() {
  const [loading, setLoading] = useState(false);

  const handleExport = async () => {
    const ok = window.confirm(
      'This will download every user profile together with their bcrypt password hash. ' +
      'Treat the file as highly sensitive — only use it to migrate to another auth system. Continue?'
    );
    if (!ok) return;
    setLoading(true);
    try {
      const { data, error } = await invokeEdgeFunction<{ sql?: string; error?: string }>(
        'export-users-with-hashes',
        {}
      );
      if (error) throw new Error(error.message || 'Export failed');
      if (!data?.sql) throw new Error(data?.error || 'No data returned');

      const blob = new Blob([data.sql], { type: 'application/sql' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url;
      a.download = `welile_users_with_hashes_${stamp}.sql`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('User export downloaded');
    } catch (err: any) {
      console.error('User export failed:', err);
      toast.error(err?.message || 'Failed to export users');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-3 sm:p-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="h-10 w-10 rounded-xl bg-destructive/10 text-destructive flex items-center justify-center shrink-0">
          <KeyRound className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            Export Users + Password Hashes
            <ShieldAlert className="h-3.5 w-3.5 text-destructive" />
          </h3>
          <p className="text-xs text-muted-foreground">
            SQL dump of <code>public.profiles</code> + <code>auth.users</code> bcrypt hashes for migration to a new system. CTO / Manager / Super Admin only.
          </p>
        </div>
      </div>
      <Button
        size="sm"
        variant="destructive"
        onClick={handleExport}
        disabled={loading}
        className="shrink-0"
      >
        {loading ? (
          <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Exporting…</>
        ) : (
          <><Download className="h-4 w-4 mr-1.5" />Download .sql</>
        )}
      </Button>
    </div>
  );
}