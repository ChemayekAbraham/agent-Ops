/**
 * Builds and delivers the Tenant Location Report PDF.
 *
 * Order matters: the FULL tenant list is fetched (never the visible page), the
 * 5,000 cap is checked, the export is written to the audit log, and only then is
 * the PDF built. The audit write is fail-closed: a PDF full of phone numbers is
 * not handed over if it could not be recorded.
 *
 * On touch devices the PDF is generated first and handed over on the NEXT tap
 * (iOS only opens the share sheet inside a fresh user gesture); elsewhere it
 * downloads straight away.
 */
import { useCallback, useState } from 'react';
import {
  fetchTlbTenantsMulti, logTlbLocationPdfExport, type TlbSelectedPlace, type TlbStatus,
} from '@/hooks/useTenantLocationsBrowser';
import { buildTenantLocationPdf, deliverPdf, isTouchDevice } from '@/lib/tenantLocationReportPdf';
import { assertWithinExportCap, TlbTooManyTenantsError } from '@/lib/tenantLocationSelection';

export type TlbPdfState =
  | { phase: 'idle' }
  | { phase: 'generating' }
  | { phase: 'ready'; blob: Blob; filename: string; tenants: number }
  | { phase: 'done'; message: string }
  | { phase: 'error'; message: string };

export function useTlbPdfExport() {
  const [state, setState] = useState<TlbPdfState>({ phase: 'idle' });

  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  const generate = useCallback(async (places: readonly TlbSelectedPlace[], status: TlbStatus, generatedBy: string) => {
    if (places.length === 0) return;
    setState({ phase: 'generating' });
    try {
      const full = await fetchTlbTenantsMulti(places, status);
      assertWithinExportCap(full.total);
      await logTlbLocationPdfExport({ places, tenants: full.total, status }).catch(() => {
        throw new Error('The export could not be recorded in the audit log, so the PDF was not created. Please try again.');
      });
      const built = buildTenantLocationPdf({ places, rows: full.rows, total: full.total, status, generatedBy });
      if (isTouchDevice()) {
        setState({ phase: 'ready', blob: built.blob, filename: built.filename, tenants: full.total });
        return;
      }
      await deliverPdf(built.blob, built.filename);
      setState({ phase: 'done', message: `${built.filename} is ready.` });
    } catch (err) {
      const message = err instanceof TlbTooManyTenantsError
        ? err.message
        : err instanceof Error && err.message ? err.message : 'The PDF could not be created. Please try again.';
      setState({ phase: 'error', message });
    }
  }, []);

  /** Call from the tap on "Share or save". */
  const deliver = useCallback(async () => {
    if (state.phase !== 'ready') return;
    const outcome = await deliverPdf(state.blob, state.filename);
    setState(outcome === 'cancelled' ? state : { phase: 'done', message: `${state.filename} is ready.` });
  }, [state]);

  return { state, generate, deliver, reset };
}
