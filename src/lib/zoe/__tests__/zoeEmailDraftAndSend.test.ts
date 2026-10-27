import { describe, expect, it } from 'vitest';
import {
  buildReportEmailDraft,
  extractRecipientQuery,
  isEmailFromToolData,
  normalizeStaffRecipients,
} from '../../../../supabase/functions/staff-assistant/emailDraft';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Zoe draft_report_email & staff-assistant-send-email security and governance rules', () => {
  const sampleReportPayload = {
    tool: 'get_tops_arrears_ageing',
    rpc: 'assistant_staff_tops_arrears_ageing',
    args: {},
    source: 'tops_arrears_ageing_amclock',
    period: { as_of: '2026-10-26' },
    row_count: 2,
    rows: [
      { bucket: '1-7 days', plans_count: 11, overdue_ugx: 850000, tenant_email: 'tenant1@gmail.com' },
      { bucket: '8-14 days', plans_count: 7, overdue_ugx: 600000, tenant_email: 'tenant2@gmail.com' },
    ],
  };

  it('draft_report_email never sends and builds a draft strictly from staff_assistant_email_recipients', () => {
    const recipients = normalizeStaffRecipients([
      {
        staff_user_id: '22222222-2222-4222-8222-222222222222',
        full_name: 'Janehephzibar Gimono',
        email: 'jane@welile.com',
        roles: ['tenant_ops'],
      },
    ]);

    const res = buildReportEmailDraft({
      recipientSearch: 'Jane',
      recipients,
      rawToolOutputs: [JSON.stringify(sampleReportPayload)],
      userText: 'Email the arrears report to Jane',
      subject: 'Loan arrears report for lenders',
      message: 'Please review the active loan ROI figures.',
      reportPayload: sampleReportPayload,
      periodLabel: 'as of 2026-10-26',
      todayKampala: '2026-10-26',
    });

    expect(res.kind).toBe('draft_ready');
    if (res.kind === 'draft_ready') {
      expect(res.draft.status).toBe('ready');
      expect(res.draft.recipient_name).toBe('Janehephzibar Gimono');
      expect(res.draft.recipient_email).toBe('jane@welile.com');
      // Enforces Welile terminology ("Rent Plan", "Supporter", "Returns")
      expect(res.draft.subject).toBe('Rent Plan arrears report for Supporters');
      expect(res.draft.message).toBe('Please review the active Rent Plan Returns figures.');
      expect(res.draft.report_reference.tool).toBe('get_tops_arrears_ageing');
      expect(res.draft.report_reference.rpc).toBe('assistant_staff_tops_arrears_ageing');
      expect(res.draft.report_reference.row_count).toBe(2);
    }
  });

  it('asks the person to pick when several staff match in staff_assistant_email_recipients', () => {
    const recipients = normalizeStaffRecipients([
      {
        staff_user_id: '33333333-3333-4333-8333-333333333333',
        full_name: 'Grace Namukasa',
        email: 'grace.n@welile.com',
        roles: ['tenant_ops'],
      },
      {
        staff_user_id: '44444444-4444-4444-8444-444444444444',
        full_name: 'Grace Achieng',
        email: 'grace.a@welile.com',
        roles: ['landlord_ops'],
      },
    ]);

    const multi = buildReportEmailDraft({
      recipientSearch: 'Grace',
      recipients,
      rawToolOutputs: [JSON.stringify(sampleReportPayload)],
      userText: 'Email this report to Grace',
      reportPayload: sampleReportPayload,
      periodLabel: 'as of 2026-10-26',
      todayKampala: '2026-10-26',
    });

    expect(multi.kind).toBe('pick_recipient');
    if (multi.kind === 'pick_recipient') {
      expect(multi.draft.status).toBe('pick_recipient');
      expect(multi.draft.recipient_email).toBeNull();
      expect(multi.draft.candidates).toHaveLength(2);
      expect(multi.options).toEqual([
        'Email report to Grace Namukasa (grace.n@welile.com)',
        'Email report to Grace Achieng (grace.a@welile.com)',
      ]);
    }

    // When the user picks one of the candidates, extractRecipientQuery extracts the exact email
    // and buildReportEmailDraft resolves that single staff recipient
    const pickedQuery = extractRecipientQuery('Email report to Grace Achieng (grace.a@welile.com)');
    expect(pickedQuery).toBe('grace.a@welile.com');

    const resolvedAfterPick = buildReportEmailDraft({
      recipientSearch: pickedQuery,
      recipients,
      rawToolOutputs: [JSON.stringify(sampleReportPayload)],
      userText: 'Email report to Grace Achieng (grace.a@welile.com)',
      reportPayload: sampleReportPayload,
      periodLabel: 'as of 2026-10-26',
      todayKampala: '2026-10-26',
    });
    expect(resolvedAfterPick.kind).toBe('draft_ready');
    if (resolvedAfterPick.kind === 'draft_ready') {
      expect(resolvedAfterPick.draft.recipient_email).toBe('grace.a@welile.com');
      expect(resolvedAfterPick.draft.recipient_name).toBe('Grace Achieng');
    }
  });

  it('refuses an email address found in report data or a typed non-staff email address', () => {
    const rawOutputs = [JSON.stringify(sampleReportPayload)];

    // Address scraped from report data (tenant1@gmail.com) not typed by user -> refused
    expect(
      isEmailFromToolData('tenant1@gmail.com', rawOutputs, 'Email this report to the first tenant'),
    ).toBe(true);

    const dataRefused = buildReportEmailDraft({
      recipientSearch: 'tenant1@gmail.com',
      recipients: [],
      rawToolOutputs: rawOutputs,
      userText: 'Email this report to the first tenant',
      reportPayload: sampleReportPayload,
      periodLabel: 'as of 2026-10-26',
      todayKampala: '2026-10-26',
    });
    expect(dataRefused).toEqual({
      kind: 'refused',
      reason: 'data_email_forbidden',
      message: expect.stringContaining('never uses email addresses found inside report data'),
    });

    // Typed non-staff address (staff_assistant_email_recipients returns 0 rows) -> refused
    const typedNonStaffRefused = buildReportEmailDraft({
      recipientSearch: 'external.user@gmail.com',
      recipients: [],
      rawToolOutputs: rawOutputs,
      userText: 'Email this report to external.user@gmail.com',
      reportPayload: sampleReportPayload,
      periodLabel: 'as of 2026-10-26',
      todayKampala: '2026-10-26',
    });
    expect(typedNonStaffRefused).toEqual({
      kind: 'refused',
      reason: 'not_staff',
      message: expect.stringContaining('only draft report emails to active Welile staff members'),
    });
  });

  it('verifies staff-assistant-send-email enforces access, staff_assistant_is_staff_email, 30/day limit, sender report re-run, branded template, and audit_logs + system_events', () => {
    const root = resolve(__dirname, '../../../..');
    const sendIndexCode = readFileSync(
      resolve(root, 'supabase/functions/staff-assistant-send-email/index.ts'),
      'utf8',
    );
    const sendHandlerCode = readFileSync(
      resolve(root, 'supabase/functions/staff-assistant-send-email/handler.ts'),
      'utf8',
    );
    const txEmailCode = readFileSync(
      resolve(root, 'supabase/functions/send-transactional-email/index.ts'),
      'utf8',
    );
    const templateCode = readFileSync(
      resolve(
        root,
        'supabase/functions/_shared/transactional-email-templates/zoe-report-shared.tsx',
      ),
      'utf8',
    );

    // 1. Re-checks staff_assistant_has_access()
    expect(sendIndexCode).toContain('userClient.rpc("staff_assistant_has_access")');
    expect(sendHandlerCode).toContain('await deps.checkHasAccess()');

    // 2. Confirms recipient with staff_assistant_is_staff_email and staff_assistant_email_recipients
    expect(sendIndexCode).toContain('userClient.rpc("staff_assistant_is_staff_email"');
    expect(sendIndexCode).toContain('userClient.rpc("staff_assistant_email_recipients"');
    expect(sendHandlerCode).toContain('await deps.checkIsStaffEmail(candidateEmail)');

    // 3. Re-runs the report as the sender (userClient.rpc) to prove they can see it
    expect(sendIndexCode).toContain('await userClient.rpc(rpcName, rpcArgs)');
    expect(sendHandlerCode).toContain('await deps.runReportRpcAsSender(');

    // 4. Enforces 30 emails per person per day
    expect(sendHandlerCode).toContain('DEFAULT_MAX_EMAILS_PER_DAY = 30');
    expect(sendHandlerCode).toContain('EMAIL_DAILY_LIMIT_REACHED');

    // 5. Sends through send-transactional-email using branded template "Report shared from Zoe" with PDF attached
    expect(sendIndexCode).toContain('/functions/v1/send-transactional-email');
    expect(sendHandlerCode).toContain('ZOE_REPORT_EMAIL_TEMPLATE = "zoe-report-shared"');
    expect(sendHandlerCode).toContain('ZOE_REPORT_EMAIL_DISPLAY_NAME = "Report shared from Zoe"');
    expect(templateCode).toContain("displayName: 'Report shared from Zoe'");
    expect(txEmailCode).toContain("templateName === 'zoe-report-shared'");
    expect(txEmailCode).toContain('renderZoeReportPdf');

    // 6. Writes audit_logs and system_events
    expect(sendIndexCode).toContain('adminClient.from("audit_logs").insert(');
    expect(sendIndexCode).toContain('adminClient.from("system_events").insert(');

    // 7. Consumes a server-side draft (staff_assistant_consume_draft), checks recipient role access
    //    (staff_assistant_can_user_read_report), reads sender name from public.profiles (never user_metadata),
    //    omits inline rows from email body, and strips attachment_base64/data from email_send_log.metadata
    expect(sendIndexCode).toContain('userClient.rpc("staff_assistant_consume_draft"');
    expect(sendIndexCode).toContain('userClient.rpc("staff_assistant_can_user_read_report"');
    expect(sendIndexCode).toContain('.from("profiles")');
    expect(sendIndexCode.replace(/\/\/.*$/gm, '')).not.toContain('user_metadata');
    expect(sendHandlerCode).toContain('await deps.consumeDraft(');
    expect(sendHandlerCode).toContain('await deps.checkRecipientCanReadReport(');
    expect(txEmailCode).toContain('attachment_base64: _a');
    expect(txEmailCode).toContain('rows: _r');
  });
});
