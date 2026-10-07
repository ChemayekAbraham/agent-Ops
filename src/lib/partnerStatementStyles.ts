/**
 * Stylesheet for the partner portfolio statement. Taken verbatim from the
 * approved statement template (partner-portfolio-report-*.html) so the PDF a
 * partner downloads matches it exactly. Self-contained: it does not depend on
 * the shared report stylesheet in welileReportDocument.ts.
 */
export const PARTNER_STATEMENT_CSS = `
    :root {
      --primary: #4A154B;          /* Deep Corporate Purple */
      --primary-deep: #3B0764;     /* Welile Institutional Deep Purple */
      --primary-accent: #7B19D4;   /* Welile Purple Accent */
      --primary-light: #FAF5FF;    /* Ultra light purple tint */
      --primary-border: #DDD6FE;
      
      --text-main: #000000;        /* Pure Bank Black */
      --text-dark: #111827;        /* Very dark charcoal */
      --text-body: #1F2937;        /* Body text */
      --text-muted: #4B5563;       /* Medium Slate / Gray */
      --text-light: #9CA3AF;       /* Light Slate */
      
      --bg-document: #FFFFFF;
      --bg-header: #F9FAFB;
      --bg-subtle: #F3F4F6;
      --bg-row-alt: #F9FAFB;
      
      --rule-strong: #000000;      /* Strong horizontal bank rule */
      --rule-medium: #374151;      /* Medium section rule */
      --rule-table: #D1D5DB;       /* Table border rule */
      --rule-light: #E5E7EB;       /* Hairline divider */
      
      --status-active-color: #166534;
      --status-active-bg: #F0FDF4;
      --status-active-border: #BBF7D0;
      
      --status-awaiting-color: #9A3412;
      --status-awaiting-bg: #FFFBEB;
      --status-awaiting-border: #FDE68A;
      
      --status-closed-color: #4B5563;
      --status-closed-bg: #F3F4F6;
      --status-closed-border: #D1D5DB;

      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      --font-mono: 'JetBrains Mono', 'Courier New', monospace;
    }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html, body {
      background-color: #E5E7EB;
      font-family: var(--font-sans);
      color: var(--text-dark);
      font-size: 8.5px;
      line-height: 1.35;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .num, .currency, .pct, .date {
      font-feature-settings: "tnum" 1, "zero" 1;
      font-variant-numeric: tabular-nums;
    }
    
    .font-mono { font-family: var(--font-mono); }
    .font-bold { font-weight: 700; }
    .font-semibold { font-weight: 600; }
    .text-primary { color: var(--primary-deep); }
    .text-accent { color: var(--primary-accent); }
    .text-muted { color: var(--text-muted); }
    .text-body { color: var(--text-body); }
    .text-main { color: var(--text-main); }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .text-left { text-align: left; }

    /* ==========================================================================
       A4 DOCUMENT WRAPPER & PAGE GEOMETRY
       ========================================================================== */
    .document-wrapper {
      width: 100%;
      max-width: 210mm;
      margin: 15px auto 30px auto;
      padding: 0 8px;
    }

    .report-page {
      width: 100%;
      max-width: 210mm;
      min-height: 297mm;
      background-color: var(--bg-document);
      padding: 8mm 12mm 8mm 12mm;
      margin-bottom: 20px;
      margin-left: auto;
      margin-right: auto;
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.08);
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      overflow: hidden;
      page-break-after: always;
      break-after: page;
    }

    .page-content {
      flex: 1;
      display: flex;
      flex-direction: column;
    }

    /* Running Statement Footer */
    .report-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 4px;
      border-top: 1px solid var(--rule-table);
      font-size: 6.8px;
      color: var(--text-muted);
      font-weight: 500;
      margin-top: 6px;
      letter-spacing: 0.2px;
    }

    .footer-left { text-align: left; }
    .footer-center { text-align: center; font-weight: 600; }
    .footer-right { text-align: right; }

    /* ==========================================================================
       PAGE 1: BANK STATEMENT HEADER (EXACT FIRST CITIZENS BANK LAYOUT)
       ========================================================================== */
    .bank-statement-header {
      width: 100%;
      margin-bottom: 6px;
      border-bottom: 1.5px solid var(--rule-strong);
      padding-bottom: 6px;
    }

    /* Top Section: Bank Identity & Account Details positioned on the Right */
    .header-top-container {
      display: flex;
      justify-content: flex-end;
      align-items: flex-start;
      margin-bottom: 8px;
    }

    .header-right-block {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 5px;
    }

    .header-bank-identity {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }

    .bank-logo {
      height: 38px;
      width: auto;
      display: block;
    }

    .bank-address-block {
      display: flex;
      flex-direction: column;
      font-size: 7.5px;
      line-height: 1.35;
      color: var(--text-body);
    }

    .bank-company-name {
      font-size: 9.5px;
      font-weight: 800;
      color: var(--text-main);
      margin-bottom: 1px;
    }

    /* Account Metadata */
    .account-meta-block {
      display: flex;
      flex-direction: column;
      gap: 1px;
      font-size: 8px;
      line-height: 1.45;
    }

    .meta-line {
      display: flex;
      gap: 6px;
    }

    .meta-lbl {
      width: 105px;
      color: var(--text-muted);
      font-weight: 600;
    }

    .meta-val {
      color: var(--text-main);
      font-weight: 700;
    }

    /* Bottom Row: Customer Address on Left, Account Balance Summary Table on Right */
    .header-summary-row {
      display: grid;
      grid-template-columns: 1.15fr 1fr;
      gap: 20px;
      align-items: flex-start;
      margin-top: 2px;
    }

    .customer-info-col {
      display: flex;
      flex-direction: column;
      gap: 1.5px;
      font-size: 8px;
      color: var(--text-body);
    }

    .customer-name {
      font-size: 13px;
      font-weight: 900;
      color: var(--text-main);
      margin-bottom: 2px;
      letter-spacing: 0.2px;
    }

    .customer-detail {
      font-size: 8px;
      color: var(--text-body);
    }

    .customer-branch {
      margin-top: 4px;
      font-size: 7.2px;
      color: var(--text-muted);
      font-style: italic;
    }

    .balance-summary-col {
      width: 100%;
    }

    .balance-summary-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 7.8px;
    }

    .balance-summary-table td {
      padding: 1.6px 0;
      vertical-align: middle;
    }

    .balance-summary-table .bal-lbl {
      color: var(--text-muted);
      font-weight: 600;
      text-align: left;
      padding-right: 8px;
    }

    .balance-summary-table .bal-val {
      text-align: right;
      color: var(--text-main);
      font-weight: 700;
    }

    .closing-balance-row td {
      border-top: 1px solid var(--rule-table);
      border-bottom: 1.5px solid var(--rule-strong);
      padding: 2.5px 0;
    }

    /* Statement Note / Payout Disclosure */
    .statement-disclosure-block {
      border-top: 1px solid var(--rule-table);
      border-bottom: 1px solid var(--rule-table);
      background-color: var(--bg-subtle);
      padding: 3.5px 8px;
      margin-bottom: 5px;
      font-size: 6.8px;
      line-height: 1.3;
    }

    .disclosure-title {
      font-size: 6.8px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--text-main);
      margin-bottom: 1px;
    }

    .disclosure-body {
      color: var(--text-body);
    }

    /* Master Portfolio Schedule Table (All 27 Portfolios) */
    .section-header-bar {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      padding-bottom: 2px;
      border-bottom: 1px solid var(--rule-strong);
      margin-bottom: 3px;
      margin-top: 2px;
    }

    .section-title {
      font-size: 7.8px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-main);
    }

    .section-subtitle {
      font-size: 6.8px;
      color: var(--text-muted);
      font-weight: 500;
    }

    .master-table-wrapper {
      width: 100%;
    }

    .master-schedule-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 7px;
      line-height: 1.2;
    }

    .master-schedule-table thead th {
      background-color: var(--bg-header);
      color: var(--text-main);
      font-weight: 700;
      text-transform: uppercase;
      font-size: 6.5px;
      letter-spacing: 0.3px;
      padding: 2px 4px;
      border-top: 1px solid var(--rule-strong);
      border-bottom: 1.5px solid var(--rule-strong);
      text-align: left;
    }

    .master-schedule-table td {
      padding: 1.9px 4px;
      border-bottom: 1px solid var(--rule-light);
      color: var(--text-main);
    }

    .master-schedule-table tbody tr:nth-child(even) td {
      background-color: var(--bg-row-alt);
    }

    .master-schedule-table tfoot td {
      background-color: var(--bg-header);
      font-weight: 800;
      padding: 3px 4px;
      border-top: 1.5px solid var(--rule-strong);
      border-bottom: 3px double var(--rule-strong);
    }

    /* Subtle Financial Status Badges */
    .status-tag {
      display: inline-block;
      padding: 1px 3.5px;
      border-radius: 2px;
      font-size: 6.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.2px;
      line-height: 1.15;
    }

    .tag-active { background-color: var(--status-active-bg); color: var(--status-active-color); border: 1px solid var(--status-active-border); }
    .tag-awaiting { background-color: var(--status-awaiting-bg); color: var(--status-awaiting-color); border: 1px solid var(--status-awaiting-border); }
    .tag-closed { background-color: var(--status-closed-bg); color: var(--status-closed-color); border: 1px solid var(--status-closed-border); }
    
    .type-tag {
      display: inline-block;
      padding: 1px 3.5px;
      font-size: 6.5px;
      font-weight: 600;
      color: var(--text-body);
      background-color: var(--bg-subtle);
      border: 1px solid var(--rule-light);
      border-radius: 2px;
      line-height: 1.15;
    }

    /* ==========================================================================
       PAGES 2+: RUNNING HEADER & INDIVIDUAL PORTFOLIO SCHEDULES
       ========================================================================== */
    .detail-running-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1.5px solid var(--rule-strong);
      padding-bottom: 4px;
      margin-bottom: 7px;
    }

    .running-header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .running-logo {
      height: 22px;
      width: auto;
    }

    .running-company-info {
      display: flex;
      flex-direction: column;
    }

    .running-company-name {
      font-size: 7.5px;
      font-weight: 800;
      color: var(--text-main);
    }

    .running-contact {
      font-size: 6.5px;
      color: var(--text-muted);
    }

    .running-header-right {
      text-align: right;
      font-size: 7px;
      color: var(--text-body);
      white-space: nowrap;
    }

    .running-doc-title {
      font-size: 9px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      color: var(--text-main);
      margin-bottom: 1px;
    }

    .running-meta-line {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
      align-items: center;
      font-size: 6.8px;
      color: var(--text-muted);
    }

    .running-meta-line strong {
      color: var(--text-main);
    }

    /* Full-Width Bank Statement Portfolio Schedules List */
    .portfolio-schedule-list {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .portfolio-statement-entry {
      width: 100%;
      border-top: 1.5px solid var(--rule-medium);
      border-bottom: 1px solid var(--rule-table);
      background-color: #FFFFFF;
      break-inside: avoid;
      page-break-inside: avoid;
      padding-bottom: 3px;
    }

    /* Portfolio Top Banner */
    .portfolio-banner {
      background-color: var(--bg-header);
      padding: 2.5px 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--rule-light);
    }

    .portfolio-banner-left {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .entry-code {
      font-family: var(--font-mono);
      font-size: 9.5px;
      font-weight: 800;
      color: var(--text-main);
      letter-spacing: -0.2px;
    }

    .portfolio-banner-right {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 7.2px;
    }

    .banner-metric-label {
      color: var(--text-muted);
      font-size: 6.5px;
      text-transform: uppercase;
      font-weight: 600;
    }

    .banner-sep {
      color: var(--text-light);
    }

    /* Full-Width Key Terms / Parameters Table (Spanning 100% width) */
    .portfolio-terms-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 7px;
      margin-bottom: 2.5px;
      background-color: #FFFFFF;
    }

    .portfolio-terms-table th {
      background-color: #F9FAFB;
      color: var(--text-muted);
      font-weight: 700;
      text-transform: uppercase;
      font-size: 6.4px;
      letter-spacing: 0.3px;
      padding: 2px 5px;
      border-bottom: 1px solid var(--rule-light);
      text-align: left;
    }

    .portfolio-terms-table td {
      padding: 2.2px 5px;
      border-bottom: 1px solid var(--rule-light);
      color: var(--text-main);
      font-weight: 600;
    }

    /* Full-Width Activity & Transaction Ledger Table */
    .entry-ledger-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 7px;
    }

    .entry-ledger-table th {
      background-color: var(--bg-subtle);
      color: var(--text-main);
      font-weight: 700;
      text-transform: uppercase;
      font-size: 6.4px;
      letter-spacing: 0.3px;
      padding: 1.8px 5px;
      border-top: 1px solid var(--rule-light);
      border-bottom: 1px solid var(--rule-table);
      text-align: left;
    }

    .entry-ledger-table td {
      padding: 1.9px 5px;
      border-bottom: 1px solid var(--rule-light);
      color: var(--text-main);
    }

    .entry-ledger-table tbody tr:nth-child(even) td {
      background-color: var(--bg-row-alt);
    }

    .entry-ledger-table tfoot td {
      font-weight: 800;
      background-color: var(--bg-header);
      border-top: 1px solid var(--rule-table);
      border-bottom: 1.5px solid var(--rule-table);
      padding: 2px 5px;
    }

    .entry-empty-ledger {
      padding: 2px 5px;
      font-size: 6.8px;
      color: var(--text-muted);
      font-style: italic;
      background-color: var(--bg-row-alt);
      border-top: 1px solid var(--rule-light);
      border-bottom: 1px solid var(--rule-light);
    }

    .entry-footnote-row {
      font-size: 6.5px;
      color: var(--text-muted);
      padding: 1.5px 5px 0 5px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    /* Page 7 Statement Completion Verification Block */
    .statement-completion-panel {
      width: 100%;
      background-color: var(--bg-header);
      border-top: 1.5px solid var(--rule-strong);
      border-bottom: 2.5px solid var(--rule-strong);
      padding: 6px 10px;
      margin-top: 8px;
      font-size: 7px;
      line-height: 1.4;
    }

    .completion-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 3px;
      padding-bottom: 2px;
      border-bottom: 1px solid var(--rule-table);
    }

    .completion-title {
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-main);
      font-size: 7.6px;
    }

    .completion-body p {
      color: var(--text-body);
      margin-bottom: 3px;
    }

    .completion-contact-row {
      display: flex;
      gap: 12px;
      font-size: 6.8px;
      color: var(--text-muted);
    }

    .completion-contact-row strong {
      color: var(--text-main);
    }

    /* ==========================================================================
       RESPONSIVE & PRINT MEDIA
       ========================================================================== */
    @media screen and (max-width: 680px) {
      html, body { font-size: 10px; }
      .document-wrapper { margin: 10px auto; padding: 0 4px; }
      .report-page { min-height: auto; padding: 12px; margin-bottom: 12px; }
      .header-top-container { justify-content: flex-start; }
      .header-right-block { align-items: flex-start; }
      .header-summary-row { grid-template-columns: 1fr; gap: 10px; }
      .master-schedule-table { display: block; overflow-x: auto; }
      .portfolio-terms-table { display: block; overflow-x: auto; }
      .entry-ledger-table { display: block; overflow-x: auto; }
      .detail-running-header { flex-direction: column; align-items: flex-start; gap: 4px; }
      .running-header-right { text-align: left; }
      .running-meta-line { flex-wrap: wrap; justify-content: flex-start; }
      .report-footer { flex-direction: column; gap: 2px; align-items: flex-start; }
      .completion-contact-row { flex-direction: column; gap: 2px; }
    }

    @media print {
      @page {
        size: A4 portrait;
        margin: 6mm 10mm 6mm 10mm;
      }

      *, *::before, *::after {
        box-shadow: none !important;
        text-shadow: none !important;
      }

      html, body {
        background-color: #FFFFFF !important;
        background: #FFFFFF !important;
        color: #000000 !important;
        font-size: 7pt !important;
        width: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }

      .no-print {
        display: none !important;
      }

      .document-wrapper {
        margin: 0 !important;
        max-width: 100% !important;
        width: 100% !important;
        padding: 0 !important;
      }

      .report-page {
        width: 100% !important;
        max-width: 100% !important;
        min-height: auto !important;
        height: auto !important;
        box-shadow: none !important;
        padding: 0 !important;
        margin: 0 !important;
        page-break-after: always !important;
        break-after: page !important;
        page-break-inside: avoid !important;
        break-inside: avoid !important;
      }

      .report-page:last-child {
        page-break-after: auto !important;
        break-after: auto !important;
      }

      /* Enforce strict horizontal bank header in print */
      .bank-statement-header {
        width: 100% !important;
        margin-bottom: 4px !important;
        padding-bottom: 4px !important;
      }

      .header-top-container {
        display: flex !important;
        flex-direction: row !important;
        justify-content: flex-end !important;
        align-items: flex-start !important;
        margin-bottom: 5px !important;
      }

      .header-summary-row {
        display: grid !important;
        grid-template-columns: 1.15fr 1fr !important;
        gap: 16px !important;
        align-items: flex-start !important;
      }

      .balance-summary-col {
        width: 100% !important;
      }

      .detail-running-header {
        display: flex !important;
        flex-direction: row !important;
        justify-content: space-between !important;
        align-items: center !important;
        margin-bottom: 5px !important;
        padding-bottom: 3px !important;
      }

      .running-header-right {
        text-align: right !important;
        white-space: nowrap !important;
      }

      .running-meta-line {
        display: flex !important;
        flex-direction: row !important;
        justify-content: flex-end !important;
        flex-wrap: nowrap !important;
      }

      .report-footer {
        display: flex !important;
        flex-direction: row !important;
        justify-content: space-between !important;
        align-items: center !important;
        padding-top: 3px !important;
        margin-top: 4px !important;
      }

      .portfolio-banner {
        display: flex !important;
        flex-direction: row !important;
        justify-content: space-between !important;
      }

      .statement-disclosure-block,
      .master-schedule-table thead th,
      .portfolio-banner,
      .portfolio-terms-table th,
      .entry-ledger-table th,
      .statement-completion-panel {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }

      .portfolio-statement-entry {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
        margin-bottom: 4px !important;
      }
    }

  
`;
