/**
 * Sticky bar for the places picked on the Tenant Locations page.
 * Slides up when the first place is selected (plain CSS, off when the person
 * prefers reduced motion) and keeps clear of the phone's bottom safe area.
 */
import { Download, Loader2, Share2, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { TlbPdfState } from '@/hooks/useTlbPdfExport';

interface Props {
  placeCount: number;
  /** Distinct tenants across the selection; undefined while it is being counted. */
  tenantCount: number | undefined;
  viewing: boolean;
  pdf: TlbPdfState;
  onView: () => void;
  onDownload: () => void;
  onDeliver: () => void;
  onClear: () => void;
}

export function TenantLocationsSelectionBar({
  placeCount, tenantCount, viewing, pdf, onView, onDownload, onDeliver, onClear,
}: Props) {
  const generating = pdf.phase === 'generating';
  return (
    <div
      role="region"
      aria-label="Selected places"
      data-testid="tlb-selection-bar"
      className="tlb-selection-bar sticky bottom-0 z-30 -mx-1 border-t border-border bg-card/95 px-3 pt-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/80 sm:mx-0 sm:rounded-t-xl sm:border"
      style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-1.5 text-sm font-semibold" aria-live="polite">
          <Users className="h-4 w-4 text-primary" aria-hidden="true" />
          <span>
            {placeCount} {placeCount === 1 ? 'place' : 'places'} · {tenantCount === undefined ? '…' : tenantCount.toLocaleString('en-UG')} tenants
          </span>
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={viewing ? 'secondary' : 'default'}
            className="min-h-[44px] flex-1 sm:flex-none"
            onClick={onView}
          >
            {viewing ? 'Back to browsing' : 'View tenants'}
          </Button>

          {pdf.phase === 'ready' ? (
            <Button type="button" className="min-h-[44px] flex-1 sm:flex-none" onClick={onDeliver}>
              <Share2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Share or save PDF
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px] flex-1 sm:flex-none"
              onClick={onDownload}
              disabled={generating}
            >
              {generating
                ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
                : <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />}
              {generating ? 'Preparing PDF…' : 'Download PDF'}
            </Button>
          )}

          <Button type="button" variant="ghost" className="min-h-[44px]" onClick={onClear}>
            <X className="mr-1 h-4 w-4" aria-hidden="true" />
            Clear
          </Button>
        </div>
      </div>

      {pdf.phase === 'error' && (
        <p role="alert" className="mx-auto mt-1 max-w-5xl text-xs text-destructive">{pdf.message}</p>
      )}
      {pdf.phase === 'ready' && (
        <p className="mx-auto mt-1 max-w-5xl text-xs text-muted-foreground">
          Your PDF is ready ({pdf.tenants.toLocaleString('en-UG')} tenants). Tap to share or save it.
        </p>
      )}
      {pdf.phase === 'done' && (
        <p className="mx-auto mt-1 max-w-5xl text-xs text-muted-foreground">{pdf.message}</p>
      )}
    </div>
  );
}

export default TenantLocationsSelectionBar;
