import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { LedgerEntryDetailDrawer } from '@/components/wallet/LedgerEntryDetailDrawer';
import { Button } from '@/components/ui/button';
import { ArrowLeft, FileText } from 'lucide-react';

/**
 * Lightweight fallback deep-link for a single ledger entry.
 *
 * Unlike the heavy `/cfo/ledger/:id` page, this route is reachable by a broad
 * set of staff/finance roles, so an operator who follows a shared link still
 * gets the Ledger Entry Details drawer instead of a role-lock screen. Data
 * access remains gated by RLS, so no extra information is exposed.
 */
export default function LedgerEntryDeepLink() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // Open the drawer immediately on mount.
  const [open, setOpen] = useState(true);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    // When the drawer is dismissed, return the operator to where they came from.
    if (!next) {
      navigate(-1);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-6 text-center gap-4">
      <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
        <FileText className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">Ledger Entry</h1>
        <p className="text-sm text-muted-foreground font-mono break-all max-w-md">{id}</p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => navigate(-1)} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        {!open && (
          <Button onClick={() => setOpen(true)} className="gap-2">
            <FileText className="h-4 w-4" /> Open details
          </Button>
        )}
      </div>

      <LedgerEntryDetailDrawer entryId={id ?? null} open={open} onOpenChange={handleOpenChange} />
    </div>
  );
}