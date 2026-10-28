import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
    },
    from: vi.fn(() => ({
      insert: vi.fn().mockResolvedValue({ error: null }),
    })),
  },
}));

import * as xlsxExport from '@/lib/xlsxExport';
import {
  buildZoeDisplayRows,
  buildZoeReportHtml,
  buildZoeReportPdfDoc,
  buildZoeReportXlsxBytes,
  buildZoeReportXlsxSheets,
  ensureXlsxFilename,
  evaluateZoeFileRequest,
  exportZoeReportXlsx,
  extractZoeEmailDraft,
  extractZoeExportableReport,
  normalizePdfText,
  sanitizeWelileTerms,
  selectImportantColumnsForPdf,
  sendZoeReportEmail,
  verifySummaryNumbersAgainstReport,
} from '../index';

describe('Zoe Prompt 1: Files only when asked, real Excel (.xlsx), clean PDFs, and email drafts', () => {
  const fixedGeneratedAt = new Date('2026-10-26T06:30:00.000Z');
  const staffGenerator = 'Janehephzibar Gimono (jane@welile.com)';

  const sampleTableChatRows = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      tenant_id: '22222222-2222-4222-8222-222222222222',
      tenant_name: 'Namukasa Grace',
      phone: '256700***111',
      rent_amount: 450000,
      collected_total: 300000,
      outstanding: 150000,
      due_date: '2026-10-15',
      stage: 'repaying',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      tenant_id: '44444444-4444-4444-8444-444444444444',
      tenant_name: 'Okello Ronald',
      phone: '256772***222',
      rent_amount: 600000,
      collected_total: 600000,
      outstanding: 0,
      due_date: '2026-10-18',
      stage: 'completed',
    },
    {
      id: '55555555-5555-4555-8555-555555555555',
      tenant_id: '66666666-6666-4666-8666-666666666666',
      tenant_name: 'Achieng Sarah',
      phone: '256752***333',
      rent_amount: 350000,
      collected_total: 125000,
      outstanding: 225000,
      due_date: '2026-10-22',
      stage: 'repaying',
    },
  ];

  const sampleAssistantTableMessage = {
    id: 'msg-table-1',
    role: 'assistant' as const,
    status: 'answered',
    content: [
      'Tenant Ops recorded 3 Rent Plan repayment rows for October 2026.',
      'Total rent amount across the 3 rows is UGX 1,400,000, with UGX 1,025,000 collected and UGX 375,000 outstanding.',
      'Okello Ronald has completed repayment of UGX 600,000, while 2 plans remain in repaying stage.',
    ].join('\n'),
    source: 'get_tenant_ops_repayments',
    period: '2026-10-01 to 2026-10-26',
    reportPayload: {
      tool: 'tenant_ops_repayments',
      rpc: 'assistant_staff_tenant_ops_repayments',
      source: 'get_tenant_ops_repayments',
      period: { from: '2026-10-01', to: '2026-10-26' },
      row_count: 3,
      rows: sampleTableChatRows,
    },
  };

  it('deterministic rule: 30 questions with no file request produce no file, and 10 questions with a file request produce a file', () => {
    const thirtyQuestionsWithoutFileRequest = [
      'What is my wallet balance today?',
      'Show my pending tasks in My Space.',
      'How many open support tickets do I have?',
      'Show my latest payslip for October 2026.',
      'What are my attendance records this month?',
      'Show the Tenant Ops overview for today.',
      'What is the Tenant Ops arrears ageing summary as of today?',
      'How many Rent Plans are sitting at each stage right now?',
      'How did First 7 Days repayments perform this week?',
      'Show the Landlord Ops home summary for this month.',
      'How many landlords were paid and how many are now repaying this month?',
      'What are the open Landlord Ops field verification tasks?',
      'Give me the Calling Hub summary for October 2026.',
      'Show the weekly calling report for the team this month.',
      'What is the Agent Ops overview for this week?',
      'Who are the top performing agents by Rent Plans this month?',
      'How many agent float requests are pending right now?',
      'What is the Supporter Pool health and coverage ratio today?',
      'Show upcoming Supporter payout obligations this week.',
      'What is the Treasury cash position as of today?',
      'Give me the Receivables and Payables forecast as of today.',
      'What is the daily cash reconciliation status for yesterday?',
      'How many pending wallet operations are waiting for CFO approval?',
      'What is the COO executive overview for this week?',
      'Show the CEO platform health summary for this month.',
      'How many active staff are in each department?',
      'Show the current payroll runs status for October.',
      'Are there any contracts expiring in the next 30 days?',
      'Whose birthday is coming up this month?',
      'What is the shopping advance count and total for this month?',
    ];

    expect(thirtyQuestionsWithoutFileRequest).toHaveLength(30);

    for (const question of thirtyQuestionsWithoutFileRequest) {
      const decision = evaluateZoeFileRequest({
        userPrompt: question,
        assistantMessage: sampleAssistantTableMessage,
        options: { generatedBy: staffGenerator, generatedAt: fixedGeneratedAt },
      });
      expect(decision.fileCreated, `Expected no file for question: "${question}"`).toBe(false);
      expect(decision.requestedFormat).toBeNull();
      // Because sampleAssistantTableMessage has a structured table, offerChipsShown is true
      expect(decision.offerChipsShown).toBe(true);
    }

    const tenQuestionsWithFileRequest: Array<{
      prompt: string;
      expectedFormat: 'xlsx' | 'pdf' | 'both';
    }> = [
      { prompt: 'Give me an Excel of the Tenant Ops repayments for October.', expectedFormat: 'xlsx' },
      { prompt: 'PDF please for the Tenant Ops arrears ageing report.', expectedFormat: 'pdf' },
      { prompt: 'Can you export this table to xlsx?', expectedFormat: 'xlsx' },
      { prompt: 'Download this report as a PDF.', expectedFormat: 'pdf' },
      { prompt: 'Please make an Excel spreadsheet of theOctober calling report.', expectedFormat: 'xlsx' },
      { prompt: 'Generate a PDF file for the First 7 Days performance.', expectedFormat: 'pdf' },
      { prompt: 'Send me an Excel workbook for the Landlord Ops paid and repaying report.', expectedFormat: 'xlsx' },
      { prompt: 'Prepare a PDF and Excel for the Receivables and Payables forecast.', expectedFormat: 'both' },
      { prompt: 'Download the report table for me.', expectedFormat: 'both' },
      { prompt: 'Create a spreadsheet of the top agents this month.', expectedFormat: 'xlsx' },
    ];

    expect(tenQuestionsWithFileRequest).toHaveLength(10);

    for (const { prompt, expectedFormat } of tenQuestionsWithFileRequest) {
      const decision = evaluateZoeFileRequest({
        userPrompt: prompt,
        assistantMessage: sampleAssistantTableMessage,
        options: { generatedBy: staffGenerator, generatedAt: fixedGeneratedAt },
      });
      expect(decision.fileCreated, `Expected fileCreated=true for prompt: "${prompt}"`).toBe(true);
      expect(decision.requestedFormat).toBe(expectedFormat);
      expect(decision.offerChipsShown).toBe(false);
    }

    // Tapping an offer chip on an unrequested table question also creates the file
    const chipDecision = evaluateZoeFileRequest({
      userPrompt: 'What is the Tenant Ops arrears ageing summary as of today?',
      assistantMessage: sampleAssistantTableMessage,
      chipTappedFormat: 'xlsx',
      options: { generatedBy: staffGenerator, generatedAt: fixedGeneratedAt },
    });
    expect(chipDecision.fileCreated).toBe(true);
    expect(chipDecision.requestedFormat).toBe('xlsx');
  });

  it('stops extractZoeExportableReport from building period_summary reports out of loose scalar fields or markdown tables', () => {
    // 1. Loose scalar fields (e.g. cash_position object with no rows array) -> returns null
    const scalarOnlyReport = extractZoeExportableReport(
      {
        id: 'msg-scalar-1',
        role: 'assistant',
        status: 'answered',
        content: 'Treasury cash position as of 2026-10-26 is UGX 128,450,000.',
        source: 'get_treasury_cash_position',
        period: 'as of 2026-10-26',
        reportPayload: {
          tool: 'cfo_cash_position',
          rpc: 'assistant_staff_cfo_cash_position',
          source: 'get_treasury_cash_position',
          period: { as_of: '2026-10-26' },
          cash_position: {
            total_cash_ugx: 128450000,
            operational_float_ugx: 42300000,
            supporter_pool_ugx: 86150000,
          },
        },
      },
      { generatedBy: 'Vandamme Abaho (cfo@welile.com)', generatedAt: fixedGeneratedAt },
    );
    expect(scalarOnlyReport).toBeNull();

    // 2. Markdown table in content with no structured rows in reportPayload -> returns null
    const markdownOnlyReport = extractZoeExportableReport(
      {
        id: 'msg-md-1',
        role: 'assistant',
        status: 'answered',
        content: [
          '| Metric | Amount |',
          '| --- | --- |',
          '| Cash | UGX 100,000 |',
        ].join('\n'),
        source: 'manual_help',
        period: 'as of 2026-10-26',
        reportPayload: {
          tool: 'manual_help',
        },
      },
      { generatedBy: staffGenerator, generatedAt: fixedGeneratedAt },
    );
    expect(markdownOnlyReport).toBeNull();
  });

  it('extracts a structured table report, hides internal ID columns (id, *_id, UUIDs), and computes totals', () => {
    const report = extractZoeExportableReport(sampleAssistantTableMessage, {
      generatedBy: staffGenerator,
      generatedAt: fixedGeneratedAt,
      userQuestion: 'Show Tenant Ops repayments for October 2026',
    });

    expect(report).not.toBeNull();
    expect(report!.kind).toBe('table');
    expect(report!.title).toBe('Tenant Ops Repayments & Collection Rate Report');
    expect(report!.question).toBe('Show Tenant Ops repayments for October 2026');
    expect(report!.periodLabel).toBe('2026-10-01 to 2026-10-26');
    expect(report!.generatedBy).toBe(staffGenerator);
    expect(report!.generatedAt).toContain('26 Oct 2026');
    expect(report!.howCountedNote).toContain('get_tenant_ops_repayments');
    expect(report!.rowCount).toBe(3);

    // Internal ID columns (`id`, `tenant_id`) must be hidden from visible columns
    expect(report!.hiddenColumns).toEqual(['id', 'tenant_id']);
    expect(report!.columns).toEqual([
      'tenant_name',
      'phone',
      'rent_amount',
      'collected_total',
      'outstanding',
      'due_date',
      'stage',
    ]);
    expect(report!.headers).toEqual([
      'Tenant Name',
      'Phone',
      'Rent Amount',
      'Collected Total',
      'Outstanding',
      'Due Date',
      'Stage',
    ]);

    // Visible cell matrix matches the exact non-ID columns
    const expectedMatrix = sampleTableChatRows.map((r) => [
      r.tenant_name,
      r.phone,
      r.rent_amount,
      r.collected_total,
      r.outstanding,
      r.due_date,
      r.stage,
    ]);
    expect(report!.rows).toEqual(expectedMatrix);

    // Totals row sums money columns and leaves text/phone/date columns blank
    expect(report!.totalsRow).toEqual([
      'Total',
      null,
      1400000,
      1025000,
      375000,
      null,
      null,
    ]);

    // Summary lines are 3 to 5 lines and pass the number verification check
    expect(report!.summaryLines.length).toBeGreaterThanOrEqual(3);
    expect(report!.summaryLines.length).toBeLessThanOrEqual(5);
  });

  it('generates a real .xlsx OpenXML archive with .xlsx extension, numeric cells (UGX & date formats), hidden IDs, frozen/auto-filtered header, column widths, wrapped text, totals row, and About this report sheet', async () => {
    const spy = vi.spyOn(xlsxExport, 'downloadXlsxWorkbook').mockResolvedValue('report.xlsx');

    expect(ensureXlsxFilename('welile-zoe-report')).toBe('welile-zoe-report.xlsx');
    expect(ensureXlsxFilename('welile-zoe-report.xls')).toBe('welile-zoe-report.xlsx');
    expect(ensureXlsxFilename('welile-zoe-report.xlsx')).toBe('welile-zoe-report.xlsx');

    const report = extractZoeExportableReport(sampleAssistantTableMessage, {
      generatedBy: staffGenerator,
      generatedAt: fixedGeneratedAt,
      userQuestion: 'Give me an Excel of Tenant Ops repayments for October 2026',
    })!;

    const { filename, bytes, sheets } = await buildZoeReportXlsxBytes(report);
    expect(filename.endsWith('.xlsx')).toBe(true);
    expect(sheets).toHaveLength(2);
    expect(sheets[1].name).toBe('About this report');

    // Inspect the actual ZIP/OpenXML contents of the generated .xlsx file
    const unzipped = unzipSync(bytes);
    const decodeUtf8 = (u8: Uint8Array) => new TextDecoder('utf-8').decode(u8);
    const workbookXml = decodeUtf8(unzipped['xl/workbook.xml']);
    const stylesXml = decodeUtf8(unzipped['xl/styles.xml']);
    const sheet1Xml = decodeUtf8(unzipped['xl/worksheets/sheet1.xml']);
    const sheet2Xml = decodeUtf8(unzipped['xl/worksheets/sheet2.xml']);

    // 1. Workbook contains "Report Data" and "About this report"
    expect(workbookXml).toContain('name="Report Data"');
    expect(workbookXml).toContain('name="About this report"');

    // 2. Styles define UGX currency format ("UGX "#,##0) and date format (yyyy-mm-dd) and wrapText="1"
    expect(stylesXml).toContain('numFmtId="164" formatCode="&quot;UGX &quot;#,##0"');
    expect(stylesXml).toContain('numFmtId="167" formatCode="yyyy-mm-dd"');
    expect(stylesXml).toContain('wrapText="1"');

    // 3. Sheet 1 has frozen header row (ySplit="1" state="frozen"), autoFilter, and custom column widths (<cols>)
    expect(sheet1Xml).toContain('ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"');
    expect(sheet1Xml).toContain('<autoFilter ref="A1:G4"/>');
    expect(sheet1Xml).toContain('<cols><col min="1" max="1"');

    // 4. Sheet 1 excludes internal IDs (`id`, `tenant_id`, UUID strings)
    expect(sheet1Xml).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(sheet1Xml).not.toContain('>Tenant ID<');

    // 5. Sheet 1 writes money figures as numeric cells (`t="n"` with style `s="2"` for UGX) and dates as `s="5"`
    expect(sheet1Xml).toContain('<c r="C2" s="2" t="n"><v>450000</v></c>');
    expect(sheet1Xml).toContain('<c r="D2" s="2" t="n"><v>300000</v></c>');
    expect(sheet1Xml).toContain('<c r="E2" s="2" t="n"><v>150000</v></c>');
    expect(sheet1Xml).toContain('<c r="F2" s="5" t="n"><v>');

    // 6. Sheet 1 includes the bold Totals row at row 5 (`s="7"` for bold UGX totals)
    expect(sheet1Xml).toContain('<c r="A5" s="6" t="inlineStr"><is><t xml:space="preserve">Total</t></is></c>');
    expect(sheet1Xml).toContain('<c r="C5" s="7" t="n"><v>1400000</v></c>');
    expect(sheet1Xml).toContain('<c r="D5" s="7" t="n"><v>1025000</v></c>');
    expect(sheet1Xml).toContain('<c r="E5" s="7" t="n"><v>375000</v></c>');

    // 7. Sheet 2 ("About this report") records question, period, source, who asked, generated time, and how counted
    expect(sheet2Xml).toContain('Give me an Excel of Tenant Ops repayments for October 2026');
    expect(sheet2Xml).toContain('2026-10-01 to 2026-10-26');
    expect(sheet2Xml).toContain('get_tenant_ops_repayments');
    expect(sheet2Xml).toContain(staffGenerator);

    const exportedSheets = await exportZoeReportXlsx(report);
    expect(spy).toHaveBeenCalledWith(`${report.filenameBase}.xlsx`, exportedSheets);
    spy.mockRestore();
  });

  it('builds redesigned PDF and HTML with Welile purple header, 3-5 line verified summary, <=8 importance-ranked columns, landscape when >=6 columns, accented character support, totals row, and Page X of Y footer', async () => {
    // Create a wide 10-column dataset with accented staff/tenant names and UGX amounts
    const wideRows = [
      {
        tenant_id: 'aaaa1111-1111-4111-8111-111111111111',
        tenant_name: 'René Élodie Niyonkuru',
        phone: '256701***111',
        district: 'Kampala',
        region: 'Central',
        agent_name: 'François Mugisha',
        rent_amount: 1250000,
        collected_total: 950000,
        outstanding: 300000,
        collection_rate_pct: 76,
        due_date: '2026-10-25',
        stage: 'repaying',
        note: 'Paid via MTN MoMo',
      },
      {
        tenant_id: 'bbbb2222-2222-4222-8222-222222222222',
        tenant_name: 'Zoë Chloé Nabwire',
        phone: '256772***222',
        district: 'Wakiso',
        region: 'Central',
        agent_name: 'André Byaruhanga',
        rent_amount: 800000,
        collected_total: 800000,
        outstanding: 0,
        collection_rate_pct: 100,
        due_date: '2026-10-20',
        stage: 'completed',
        note: 'Settled on time',
      },
    ];

    const report = extractZoeExportableReport(
      {
        id: 'msg-pdf-wide',
        role: 'assistant',
        status: 'answered',
        content: [
          'Here is the Tenant Ops repayment breakdown for 2 Rent Plans in October 2026.',
          'Total rent amount is UGX 2,050,000, with UGX 1,750,000 collected and UGX 300,000 outstanding.',
          'René Élodie Niyonkuru has UGX 300,000 outstanding while Zoë Chloé Nabwire is completed.',
        ].join('\n'),
        source: 'get_tenant_ops_repayments',
        period: '2026-10-01 to 2026-10-26',
        reportPayload: {
          tool: 'tenant_ops_repayments',
          rpc: 'assistant_staff_tenant_ops_repayments',
          source: 'get_tenant_ops_repayments',
          period: { from: '2026-10-01', to: '2026-10-26' },
          rows: wideRows,
        },
      },
      {
        generatedBy: staffGenerator,
        generatedAt: fixedGeneratedAt,
        userQuestion: 'PDF please for the Tenant Ops repayment breakdown',
      },
    )!;

    // 1. Internal ID (`tenant_id`) hidden -> 12 visible columns in Excel, capped at 8 most important columns in PDF
    expect(report.columns).toHaveLength(12);
    expect(report.pdfColumns).toHaveLength(8);
    expect(report.omittedPdfColumns).toBe(4);
    expect(selectImportantColumnsForPdf(report.columns).selectedColumns).toHaveLength(8);

    // 2. Accented characters preserved by normalizePdfText (never stripped to ASCII)
    expect(normalizePdfText('René Élodie Niyonkuru — UGX 1,250,000')).toBe(
      'René Élodie Niyonkuru - UGX 1,250,000',
    );

    // 3. Summary lines are 3 to 5 lines and verified against the report's numbers
    expect(report.summaryLines.length).toBeGreaterThanOrEqual(3);
    expect(report.summaryLines.length).toBeLessThanOrEqual(5);
    expect(
      verifySummaryNumbersAgainstReport(
        'Total rent amount is UGX 2,050,000 with UGX 999,999,999 invented.',
        new Set([2050000, 1750000, 300000]),
        report.periodLabel,
      ),
    ).toBe(false);

    // 4. HTML report includes purple header (#6C21C4), logo, Executive Summary, accented names, UGX formatting, and Totals row
    const html = buildZoeReportHtml(report);
    expect(html).toContain('#6C21C4');
    expect(html).toContain('class="brand-logo-img"');
    expect(html).toContain('Executive Summary');
    expect(html).toContain('René Élodie Niyonkuru');
    expect(html).toContain('Zoë Chloé Nabwire');
    expect(html).toContain('UGX 1,250,000');
    expect(html).toContain('UGX 2,050,000');
    expect(html).toContain('data-testid="zoe-pdf-totals-row"');
    expect(html).toContain('Page 1 of 1');

    // 5. PDF doc builder selects landscape (since 8 columns >= 6), embeds summary lines, and produces valid PDF bytes
    const builtPdf = await buildZoeReportPdfDoc(report);
    expect(builtPdf.orientation).toBe('landscape');
    expect(builtPdf.pdfHeaders).toHaveLength(8);
    expect(builtPdf.summaryLines.length).toBeGreaterThanOrEqual(3);
    expect(builtPdf.summaryLines.length).toBeLessThanOrEqual(5);
    expect(builtPdf.totalPages).toBeGreaterThanOrEqual(1);
    expect(builtPdf.displayRows).toEqual(buildZoeDisplayRows(report));
    expect(builtPdf.pdfBytes).toBeInstanceOf(Uint8Array);
    expect(builtPdf.pdfBytes!.byteLength).toBeGreaterThan(1000);
  });

  it('paginates multi-page HTML and PDF reports with accurate Page X of Y footers and sanitizes Welile terms', async () => {
    const manyRows = Array.from({ length: 35 }, (_, idx) => ({
      plan_ref: `RP-${idx + 1}`,
      amount_ugx: (idx + 1) * 10000,
    }));

    const report = extractZoeExportableReport(
      {
        id: 'msg-multi-1',
        role: 'assistant',
        status: 'answered',
        content: '35 active Rent Plans.',
        source: 'get_tenant_ops_overview',
        period: '2026-10-26',
        reportPayload: {
          tool: 'tenant_ops_overview',
          source: 'get_tenant_ops_overview',
          rows: manyRows,
        },
      },
      {
        generatedBy: staffGenerator,
        generatedAt: fixedGeneratedAt,
      },
    )!;

    const html = buildZoeReportHtml(report);
    expect(html).toContain('Page 1 of 2');
    expect(html).toContain('Page 2 of 2');
    expect(report.rows).toHaveLength(35);

    const builtPdf = await buildZoeReportPdfDoc(report);
    expect(builtPdf.orientation).toBe('portrait');
    expect(builtPdf.totalPages).toBeGreaterThanOrEqual(1);

    expect(sanitizeWelileTerms('Active loan from lender with 15% ROI and interest')).toBe(
      'Active Rent Plan from Supporter with 15% Returns and Returns',
    );
  });

  it('extracts email drafts from draft_report_email and routes Send through staff-assistant-send-email, refusing non-staff addresses', async () => {
    const { supabase } = await import('@/integrations/supabase/client');
    const invokeMock = vi.fn();
    (supabase as unknown as { functions: { invoke: typeof invokeMock } }).functions = {
      invoke: invokeMock,
    };

    const draft = extractZoeEmailDraft({
      id: 'msg-draft-1',
      role: 'assistant',
      outcome: 'answered',
      content: 'Prepared report email draft.',
      reportPayload: {
        tool: 'get_tops_arrears_ageing',
        rpc: 'assistant_staff_tops_arrears_ageing',
        source: 'tops_arrears_ageing_amclock',
        period: { as_of: '2026-10-26' },
        rows: [{ bucket: '1-7 days', overdue_ugx: 850000 }],
        email_draft: {
          draft_id: 'd-1',
          status: 'ready',
          recipient_user_id: 'staff-uuid-1',
          recipient_name: 'Janehephzibar Gimono',
          recipient_email: 'jane@welile.com',
          recipient_roles: ['tenant_ops'],
          subject: 'Loan report for lender with ROI',
          message: 'Sharing active loan summary.',
          report_reference: {
            tool: 'get_tops_arrears_ageing',
            rpc: 'assistant_staff_tops_arrears_ageing',
            args: {},
            source: 'tops_arrears_ageing_amclock',
            period: 'as of 2026-10-26',
            title: 'Tenant Ops Arrears Ageing Report',
            row_count: 1,
            filename: 'welile-zoe-arrears-2026-10-26.pdf',
          },
          candidates: [
            {
              staff_user_id: 'staff-uuid-1',
              full_name: 'Janehephzibar Gimono',
              email: 'jane@welile.com',
              roles: ['tenant_ops'],
            },
          ],
        },
      },
    });

    expect(draft).not.toBeNull();
    expect(draft!.status).toBe('ready');
    expect(draft!.recipient_email).toBe('jane@welile.com');
    expect(draft!.subject).toBe('Rent Plan report for Supporter with Returns');
    expect(draft!.message).toBe('Sharing active Rent Plan summary.');
    expect(invokeMock).not.toHaveBeenCalled();

    invokeMock.mockResolvedValueOnce({
      data: {
        ok: false,
        code: 'RECIPIENT_NOT_STAFF',
        error: 'Refused: Zoe can only send report emails to active Welile staff members.',
      },
      error: null,
    });
    const refusedRes = await sendZoeReportEmail({
      recipient_email: 'nonstaff@gmail.com',
      subject: draft!.subject,
      message: draft!.message,
      report_reference: draft!.report_reference,
    });
    expect(refusedRes.ok).toBe(false);
    expect(refusedRes.code).toBe('RECIPIENT_NOT_STAFF');

    invokeMock.mockResolvedValueOnce({
      data: {
        ok: true,
        sent: true,
        recipient_email: 'jane@welile.com',
        recipient_name: 'Janehephzibar Gimono',
        attachment_filename: 'welile-zoe-arrears-2026-10-26.pdf',
        remaining_emails_today: 29,
      },
      error: null,
    });
    const sentRes = await sendZoeReportEmail({
      recipient_email: draft!.recipient_email!,
      recipient_name: draft!.recipient_name,
      subject: draft!.subject,
      message: draft!.message,
      report_reference: draft!.report_reference,
    });
    expect(sentRes.ok).toBe(true);
    expect(sentRes.recipient_email).toBe('jane@welile.com');
  });
});
