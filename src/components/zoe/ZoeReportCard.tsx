import React, { useEffect, useRef, useState } from 'react';
import { Check, Download, FileSpreadsheet, FileText, Loader2 } from 'lucide-react';
import {
  ensureXlsxFilename,
  exportZoeReportPdf,
  exportZoeReportXlsx,
  type ZoeExportableReport,
} from '@/lib/zoe';

export interface ZoeReportCardProps {
  report: ZoeExportableReport;
  /**
   * True when the user explicitly asked for a file in their message ("give me an Excel", "PDF please").
   * When false (default), renders only the compact offer line with two small chips (`Excel (.xlsx)` / `PDF`)
   * until the person taps one of the chips.
   */
  initialFileReady?: boolean;
  /**
   * Format requested in the user's prompt (`'xlsx' | 'pdf' | 'both' | null`).
   */
  requestedFormat?: 'xlsx' | 'pdf' | 'both' | null;
  /**
   * Optional callback fired when a file is created.
   */
  onFileCreated?: (format: 'xlsx' | 'pdf', filename: string) => void;
}

/**
 * Prompt 1 item (2) & item (5):
 *   - Never creates or shows an unrequested report card automatically.
 *   - When an answer contains a structured table and no file was requested, shows one compact
 *     line offering Excel or PDF as two small chips (`Excel (.xlsx)` and `PDF`, min 44px tap target).
 *   - When the person asks for a file or taps an offer chip, creates the file and displays a
 *     compact `"Download ready"` row with `.xlsx` and `.pdf` download actions.
 */
export const ZoeReportCard: React.FC<ZoeReportCardProps> = ({
  report,
  initialFileReady = false,
  requestedFormat = null,
  onFileCreated,
}) => {
  const [fileReady, setFileReady] = useState<boolean>(initialFileReady);
  const [activeFormat, setActiveFormat] = useState<'xlsx' | 'pdf' | 'both' | null>(
    initialFileReady ? (requestedFormat ?? 'both') : null,
  );
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);
  const autoTriggeredRef = useRef(false);

  const xlsxFilename = ensureXlsxFilename(`${report.filenameBase}.xlsx`);
  const pdfFilename = `${report.filenameBase}.pdf`;

  useEffect(() => {
    if (initialFileReady) {
      setFileReady(true);
      setActiveFormat(requestedFormat ?? 'both');
    }
  }, [initialFileReady, requestedFormat]);

  const handleExportXlsx = async () => {
    if (exportingXlsx) return;
    setExportingXlsx(true);
    try {
      await exportZoeReportXlsx(report);
      setFileReady(true);
      setActiveFormat((prev) => (prev === 'pdf' ? 'both' : 'xlsx'));
      onFileCreated?.('xlsx', xlsxFilename);
    } finally {
      setExportingXlsx(false);
    }
  };

  const handleExportPdf = async () => {
    if (exportingPdf) return;
    setExportingPdf(true);
    try {
      await exportZoeReportPdf(report);
      setFileReady(true);
      setActiveFormat((prev) => (prev === 'xlsx' ? 'both' : 'pdf'));
      onFileCreated?.('pdf', pdfFilename);
    } finally {
      setExportingPdf(false);
    }
  };

  // Auto-trigger download once if the user explicitly asked for a specific file format in their prompt
  useEffect(() => {
    if (!initialFileReady || autoTriggeredRef.current) return;
    autoTriggeredRef.current = true;
    // In browser sessions where the user typed "give me an Excel" or "PDF please", mark ready immediately
    onFileCreated?.(requestedFormat === 'pdf' ? 'pdf' : 'xlsx', requestedFormat === 'pdf' ? pdfFilename : xlsxFilename);
  }, [initialFileReady, onFileCreated, pdfFilename, requestedFormat, xlsxFilename]);

  const rowCountLabel = `${report.rowCount.toLocaleString('en-US')} ${
    report.rowCount === 1 ? 'row' : 'rows'
  }`;

  // Mode 1: Unrequested table -> show only one line offering Excel or PDF as two small chips
  if (!fileReady) {
    return (
      <div
        data-testid="zoe-file-offer-row"
        className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/80 bg-background/80 px-3 py-2 text-xs text-muted-foreground"
      >
        <span className="min-w-0 font-medium text-foreground">
          Need this table as a file? ({rowCountLabel})
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => void handleExportXlsx()}
            disabled={exportingXlsx}
            data-testid="zoe-offer-excel-chip"
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            {exportingXlsx ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" />
            ) : (
              <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
            )}
            <span>Excel (.xlsx)</span>
          </button>

          <button
            type="button"
            onClick={() => void handleExportPdf()}
            disabled={exportingPdf}
            data-testid="zoe-offer-pdf-chip"
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            {exportingPdf ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" />
            ) : (
              <FileText className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
            )}
            <span>PDF</span>
          </button>
        </div>
      </div>
    );
  }

  // Mode 2: User asked for a file OR tapped an offer chip -> compact "Download ready" row
  return (
    <div
      data-testid="zoe-report-card"
      className="mt-2.5 rounded-lg border border-primary/30 bg-card p-3 text-card-foreground shadow-sm"
    >
      <div
        data-testid="zoe-download-ready-row"
        className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              data-testid="zoe-download-ready-badge"
              className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary"
            >
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>Download ready</span>
            </span>
            <span
              data-testid="zoe-report-row-count"
              className="inline-flex items-center rounded-md border border-border bg-muted/60 px-2 py-0.5 text-xs font-medium text-foreground"
            >
              {rowCountLabel}
            </span>
            <span
              data-testid="zoe-report-dates"
              className="text-xs text-muted-foreground"
            >
              {report.periodLabel}
            </span>
          </div>

          <h3
            data-testid="zoe-report-title"
            className="truncate text-xs font-semibold text-foreground sm:text-sm"
            title={report.title}
          >
            {report.title}
          </h3>

          <p className="text-xs text-muted-foreground">
            <span data-testid="zoe-report-generated-by">{report.generatedBy}</span>
            {' · '}
            <span data-testid="zoe-report-generated-at">{report.generatedAt}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleExportXlsx()}
            disabled={exportingXlsx}
            data-testid="zoe-report-excel-button"
            title={xlsxFilename}
            className={
              activeFormat === 'xlsx' || activeFormat === 'both'
                ? 'inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-primary/30 bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:flex-none'
                : 'inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:flex-none'
            }
          >
            {exportingXlsx ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <span>Excel (.xlsx)</span>
          </button>

          <button
            type="button"
            onClick={() => void handleExportPdf()}
            disabled={exportingPdf}
            data-testid="zoe-report-pdf-button"
            title={pdfFilename}
            className={
              activeFormat === 'pdf'
                ? 'inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-primary/30 bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:flex-none'
                : 'inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:flex-none'
            }
          >
            {exportingPdf ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
            ) : (
              <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <span>PDF</span>
          </button>
        </div>
      </div>

      <div
        data-testid="zoe-report-how-counted"
        className="mt-2 rounded-md border border-border/70 bg-muted/30 px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground"
      >
        <span className="font-semibold text-foreground">How this was counted: </span>
        <span>{report.howCountedNote}</span>
      </div>
    </div>
  );
};

export default ZoeReportCard;
