import { useState } from 'react';
import { Boxes, FileSpreadsheet, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AssetOverview } from './AssetOverview';
import { AssetTable } from './AssetTable';
import { AssetDetailSheet } from './AssetDetailSheet';
import { AssetFormDialog } from './AssetFormDialog';
import { AssetImportDialog } from './AssetImportDialog';

/**
 * CFO Asset Register (Stage 1): overview, searchable register, asset detail, manual entry and Excel import.
 * Register information only — nothing here posts to the ledger or moves money.
 */
export function AssetRegisterPanel() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Boxes className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-foreground">Asset Register</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Tangible assets owned by Welile</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button id="asset-register-import" variant="outline" size="sm" onClick={() => setImporting(true)}>
            <FileSpreadsheet className="mr-1.5 h-4 w-4" /> Import from Excel
          </Button>
          <Button id="asset-register-add" size="sm" onClick={() => setAdding(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Add asset
          </Button>
        </div>
      </header>

      <AssetOverview />
      <AssetTable onOpen={setOpenId} />

      <AssetDetailSheet assetId={openId} onOpenChange={(o) => { if (!o) setOpenId(null); }} />
      <AssetFormDialog open={adding} onOpenChange={setAdding} onSaved={(a) => setOpenId(a.id)} />
      <AssetImportDialog open={importing} onOpenChange={setImporting} />
    </div>
  );
}

export default AssetRegisterPanel;
