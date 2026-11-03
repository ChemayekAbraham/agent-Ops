import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Boxes, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAssetDetail } from '@/hooks/useAssetRegister';
import { isAssetId } from '@/lib/assetRegister/qr';
import { categoryLabel, conditionLabel, statusLabel } from '@/lib/assetRegister/types';
import { AssetCodeHeading, AssetDetailBody } from '@/components/cfo/assets/AssetDetailSheet';

/**
 * Read-only asset record opened by scanning an asset QR code (/cfo/assets/:assetId).
 * The route is gated by SignInReturnGate + RoleGuard (cfo, super_admin); `asset_register_get` re-checks the caller on
 * the server, so a denied or unknown asset shows the same message and reveals nothing. Editing stays in the register.
 */
export default function AssetDetailPage() {
  const { assetId } = useParams<{ assetId: string }>();
  const valid = isAssetId(assetId);
  const q = useAssetDetail(valid ? assetId.toLowerCase() : null);
  const a = q.data?.asset;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2 h-8 text-xs">
        <Link to="/cfo/dashboard"><ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> CFO dashboard</Link>
      </Button>

      <header className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Boxes className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
            {a ? <><AssetCodeHeading asset={a} /><span className="break-words">{a.name}</span></> : 'Asset'}
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {a ? `${categoryLabel(a.category)} · ${statusLabel(a.status)} · ${conditionLabel(a.condition)}` : 'Welile Asset Register'}
          </p>
        </div>
      </header>

      {valid && q.isLoading && (
        <p className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading asset…
        </p>
      )}
      {(!valid || q.isError) && (
        <p role="alert" className="rounded-xl border border-border bg-card p-6 text-center text-xs text-muted-foreground">
          This asset could not be found, or you do not have access to it.
        </p>
      )}
      {a && (
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <AssetDetailBody asset={a} events={q.data?.events ?? []} readOnly />
        </section>
      )}
    </main>
  );
}
