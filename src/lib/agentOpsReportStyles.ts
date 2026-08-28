/**
 * Print stylesheet for the Agent Operations Comprehensive Report.
 * Copied verbatim from the approved report template so the exported PDF
 * matches the design pixel for pixel. Do not restyle here — change the
 * template and re-copy.
 */
export const AGENT_OPS_REPORT_CSS = `
    /* ==========================================================================
       1. PRINT & PDF DOCUMENT DESIGN SYSTEM
       ========================================================================== */
    :root {
      /* Institutional Financial Palette */
      --primary: #7B19D4;
      --primary-dark: #581C87;
      --primary-light: #F3E8FF;
      
      --text-main: #111827;
      --text-body: #374151;
      --text-muted: #6B7280;
      
      --bg-document: #FFFFFF;
      --bg-header: #F9FAFB;
      --bg-subtle: #F3F4F6;
      --border-color: #E5E7EB;
      --border-dark: #D1D5DB;
      
      --status-success: #15803D;
      --status-success-bg: #F0FDF4;
      --status-warning: #B45309;
      --status-warning-bg: #FFFBEB;
      --status-danger: #B91C1C;
      --status-danger-bg: #FEF2F2;
      
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html, body {
      background-color: #E2E8F0;
      font-family: var(--font-sans);
      color: var(--text-main);
      font-size: 11px;
      line-height: 1.4;
      -webkit-font-smoothing: antialiased;
    }

    /* Financial Tabular Numbers */
    .num, .currency, .pct {
      font-feature-settings: "tnum" 1, "zero" 1;
      font-variant-numeric: tabular-nums;
    }
    
    .font-mono {
      font-family: var(--font-mono);
    }

    /* ==========================================================================
       2. A4 PAGE LAYOUT & PAGE BREAKS
       ========================================================================== */
    .document-wrapper {
      max-width: 210mm; /* Standard A4 Width */
      margin: 20px auto 40px auto;
      background-color: transparent;
    }

    .report-page {
      width: 210mm;
      min-height: 297mm; /* Standard A4 Height */
      background-color: var(--bg-document);
      padding: 16mm 16mm 18mm 16mm;
      margin-bottom: 24px;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      overflow: hidden;
    }

    .page-content {
      flex: 1;
    }

    .report-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 8px;
      border-top: 1px solid var(--border-color);
      font-size: 9px;
      color: var(--text-muted);
      font-weight: 500;
    }

    /* Page Break Utility */
    .report-page {
      break-after: page;
      page-break-after: always;
    }

    .avoid-break {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    /* ==========================================================================
       4. FORMAL REPORT HEADER & META
       ========================================================================== */
    .pdf-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid var(--text-main);
      padding-bottom: 12px;
      margin-bottom: 18px;
    }

    .pdf-header-left {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .company-name {
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--primary);
    }

    .report-title-main {
      font-size: 20px;
      font-weight: 800;
      color: var(--text-main);
      letter-spacing: -0.4px;
      margin-top: 2px;
    }

    .pdf-header-meta-table {
      font-size: 9.5px;
      border-collapse: collapse;
    }

    .pdf-header-meta-table td {
      padding: 2px 6px;
      text-align: right;
    }

    .pdf-header-meta-table td.meta-lbl {
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    .pdf-header-meta-table td.meta-val {
      font-weight: 700;
      color: var(--text-main);
    }

    /* ==========================================================================
       5. DOCUMENT SECTION STYLING
       ========================================================================== */
    .section-title {
      font-size: 15px;
      font-weight: 800;
      color: var(--text-main);
      border-bottom: 1px solid var(--border-dark);
      padding-bottom: 4px;
      margin-bottom: 4px;
      letter-spacing: -0.2px;
    }

    .section-subtitle {
      font-size: 10px;
      color: var(--text-muted);
      margin-bottom: 14px;
    }

    /* Executive Narrative Block */
    .executive-summary-text {
      background-color: var(--bg-header);
      border-left: 3px solid var(--primary);
      padding: 10px 14px;
      font-size: 10.5px;
      line-height: 1.55;
      color: var(--text-body);
      margin-bottom: 16px;
    }

    .executive-summary-text strong {
      color: var(--text-main);
      font-weight: 700;
    }

    /* Report Summary Matrix / Table */
    .summary-matrix {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
      font-size: 10px;
    }

    .summary-matrix th {
      background-color: var(--bg-header);
      color: var(--text-muted);
      font-weight: 700;
      text-transform: uppercase;
      font-size: 8.5px;
      letter-spacing: 0.5px;
      padding: 6px 10px;
      border: 1px solid var(--border-color);
      text-align: left;
    }

    .summary-matrix td {
      padding: 6px 10px;
      border: 1px solid var(--border-color);
      color: var(--text-main);
    }

    .summary-matrix tr.group-row td {
      background-color: #FAF5FF;
      font-weight: 700;
      color: var(--primary-dark);
    }

    /* Methodology / Definitions Box */
    .methodology-box {
      border: 1px solid var(--border-color);
      background-color: #F8FAFC;
      border-radius: 4px;
      padding: 10px 12px;
      margin-bottom: 16px;
      font-size: 9.5px;
    }

    .methodology-title {
      font-weight: 800;
      text-transform: uppercase;
      font-size: 9px;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 4px;
    }

    /* ==========================================================================
       6. FINANCIAL TABLES FOR PRINT
       ========================================================================== */
    .report-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 9.5px;
      margin-bottom: 16px;
    }

    .report-table thead {
      display: table-header-group;
    }

    .report-table tr {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .report-table th {
      background-color: var(--bg-header);
      color: var(--text-muted);
      font-weight: 700;
      text-transform: uppercase;
      font-size: 8.5px;
      letter-spacing: 0.4px;
      padding: 6px 8px;
      border-top: 1px solid var(--border-dark);
      border-bottom: 1.5px solid var(--border-dark);
      text-align: left;
    }

    .report-table th.right, .report-table td.right {
      text-align: right;
    }

    .report-table td {
      padding: 5px 8px;
      border-bottom: 1px solid var(--border-color);
      color: var(--text-main);
    }

    .report-table tr:nth-child(even) td {
      background-color: #FAFAFA;
    }

    .report-table tr.highlight-row td {
      background-color: #FEF2F2;
    }

    /* Expandable Row Styling */
    .parent-row td {
      font-weight: 700;
      background-color: #F9FAFB !important;
    }
    .child-row td {
      font-size: 9px;
      color: #4B5563;
    }
    .child-row td:first-child {
      padding-left: 20px;
    }

    /* Multi-Agent Stacked Cell */
    .agent-stack {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .agent-stack-item {
      font-weight: 600;
    }
    .agent-stack-sub {
      font-size: 8.5px;
      color: var(--text-muted);
    }

    /* Status Badges */
    .doc-badge {
      display: inline-block;
      padding: 1px 5px;
      border-radius: 2px;
      font-size: 8.5px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .badge-pass { background-color: var(--status-success-bg); color: var(--status-success); border: 1px solid #BBF7D0; }
    .badge-warn { background-color: var(--status-warning-bg); color: var(--status-warning); border: 1px solid #FDE68A; }
    .badge-fail { background-color: var(--status-danger-bg); color: var(--status-danger); border: 1px solid #FECACA; }

    /* ==========================================================================
       7. GRAPH & CHARTS CONTAINERS
       ========================================================================== */
    .chart-container-block {
      border: 1px solid var(--border-color);
      background-color: #FFFFFF;
      padding: 10px 12px;
      margin-bottom: 16px;
      break-inside: avoid;
    }

    .chart-header-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-main);
    }

    .chart-header-sub {
      font-size: 9px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }

    .chart-canvas-area {
      position: relative;
      width: 100%;
      height: 180px;
    }

    .chart-grid-2col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 16px;
    }

    /* Management Observation Callout */
    .observation-callout {
      background-color: #F8FAFC;
      border: 1px solid var(--border-dark);
      border-left: 4px solid var(--text-main);
      padding: 8px 12px;
      font-size: 9.5px;
      margin-top: 10px;
      margin-bottom: 12px;
    }

    .observation-callout strong {
      color: var(--text-main);
      font-weight: 700;
    }

    /* Final Summary Grid */
    .final-summary-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 12px;
    }

    .summary-card {
      border: 1px solid var(--border-color);
      padding: 10px;
      background-color: #FAFAFA;
    }

    .summary-card-title {
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--primary);
      margin-bottom: 4px;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 3px;
    }

    /* ==========================================================================
       8. PRINT STYLESHEET (@media print)
       ========================================================================== */
    @media print {
      @page {
        size: A4 portrait;
        margin: 12mm 12mm 15mm 12mm;
      }

      html, body {
        background-color: #FFFFFF !important;
        color: #000000 !important;
        font-size: 10pt !important;
      }

      .no-print, .report-preview-toolbar {
        display: none !important;
      }

      .document-wrapper {
        margin: 0 !important;
        max-width: 100% !important;
      }

      .report-page {
        width: 100% !important;
        min-height: auto !important;
        box-shadow: none !important;
        padding: 0 !important;
        margin-bottom: 0 !important;
        break-after: page !important;
        page-break-after: always !important;
      }

      .report-page:last-child {
        break-after: auto !important;
        page-break-after: auto !important;
      }

      .report-table th, .report-table td {
        border-bottom: 1px solid #CBD5E1 !important;
      }

      .chart-container-block {
        border: 1px solid #CBD5E1 !important;
      }

      .report-footer {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
      }
    }
  `;
