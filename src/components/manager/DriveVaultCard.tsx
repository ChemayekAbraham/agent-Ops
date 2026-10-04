import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { HardDrive, Loader2, ExternalLink, FolderTree, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Manager-only card for the Google Drive document vault. Documents (tenant IDs,
 * contracts, receipts) are mirrored from Cloud storage to Drive automatically on
 * upload, organized by date: Welile Document Vault / Year / Month / Type.
 * This card lets a manager pre-create the folder skeleton and jump to the vault.
 */
export function DriveVaultCard() {
  const [initializing, setInitializing] = useState(false);
  const [rootLink, setRootLink] = useState<string | null>(null);
  const [backupCount, setBackupCount] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const { count } = await supabase
        .from('drive_archive_log')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'success');
      if (active) setBackupCount(count ?? 0);
    })();
    return () => { active = false; };
  }, []);

  const initVault = async () => {
    setInitializing(true);
    try {
      const { data, error } = await supabase.functions.invoke('drive-archive', {
        body: { operation: 'init' },
      });
      if (error) throw error;
      if (data?.root_link) {
        setRootLink(data.root_link);
        toast.success('Drive vault ready', { description: 'Folder structure created in Google Drive.' });
      } else {
        throw new Error(data?.error || 'Could not initialize vault');
      }
    } catch (e: any) {
      toast.error('Vault setup failed', { description: e?.message ?? 'Try again' });
    } finally {
      setInitializing(false);
    }
  };

  return (
    <Card className="border-border/40 rounded-2xl">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-primary" />
          <div className="min-w-0">
            <CardTitle className="text-sm">Google Drive Document Vault</CardTitle>
            <CardDescription className="text-xs">
              Offsite backup of tenant IDs, contracts &amp; receipts — filed by Year / Month / Type.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <FolderTree className="h-3.5 w-3.5 shrink-0" />
          <span className="font-mono">Welile Document Vault / 2026 / 06 June / {`{Tenant IDs · Contracts · Receipts}`}</span>
        </div>

        {backupCount !== null && (
          <p className="text-xs flex items-center gap-1.5 text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            {backupCount.toLocaleString()} document{backupCount === 1 ? '' : 's'} backed up so far
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={initVault} disabled={initializing}>
            {initializing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FolderTree className="h-3.5 w-3.5 mr-1" />}
            Set up folder structure
          </Button>
          {rootLink && (
            <Button size="sm" variant="secondary" asChild>
              <a href={rootLink} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5 mr-1" /> Open vault
              </a>
            </Button>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground">
          New uploads are mirrored here automatically. Cloud storage remains the primary store;
          Drive is a redundant archive on the company account (weliletenants@gmail.com).
        </p>
      </CardContent>
    </Card>
  );
}
