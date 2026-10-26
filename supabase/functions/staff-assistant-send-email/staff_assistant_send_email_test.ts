import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildReportEmailDraft,
  isEmailFromToolData,
} from "../staff-assistant/emailDraft.ts";
import {
  handleStaffAssistantSendEmail,
  SendEmailDependencies,
  ZOE_REPORT_EMAIL_DISPLAY_NAME,
  ZOE_REPORT_EMAIL_TEMPLATE,
} from "./handler.ts";

function createMockSendDeps(
  overrides: Partial<SendEmailDependencies> = {},
): {
  deps: SendEmailDependencies;
  calls: {
    hasAccessCalled: number;
    isStaffEmailArgs: string[];
    lookupArgs: string[];
    reportRpcCalls: Array<{ rpc: string; args: Record<string, unknown> }>;
    sentEmails: Array<Record<string, unknown>>;
    auditEntries: Array<Record<string, unknown>>;
  };
} {
  const calls = {
    hasAccessCalled: 0,
    isStaffEmailArgs: [] as string[],
    lookupArgs: [] as string[],
    reportRpcCalls: [] as Array<{ rpc: string; args: Record<string, unknown> }>,
    sentEmails: [] as Array<Record<string, unknown>>,
    auditEntries: [] as Array<Record<string, unknown>>,
  };

  const deps: SendEmailDependencies = {
    getSender: async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      email: "winnie@welile.com",
      fullName: "Winfred Asiimwe",
    }),
    getSenderRoles: async () => ["tenant_ops", "employee"],
    checkHasAccess: async () => {
      calls.hasAccessCalled += 1;
      return true;
    },
    checkIsStaffEmail: async (email) => {
      calls.isStaffEmailArgs.push(email);
      return email === "jane@welile.com";
    },
    lookupStaffRecipients: async (search) => {
      calls.lookupArgs.push(search);
      if (search.toLowerCase() === "jane@welile.com") {
        return [
          {
            staff_user_id: "22222222-2222-4222-8222-222222222222",
            full_name: "Janehephzibar Gimono",
            email: "jane@welile.com",
            roles: ["tenant_ops"],
          },
        ];
      }
      return [];
    },
    checkSenderMfa: async () => ({ ok: true }),
    runReportRpcAsSender: async (rpcName, rpcArgs) => {
      calls.reportRpcCalls.push({ rpc: rpcName, args: rpcArgs });
      return {
        data: {
          source: "tops_arrears_ageing_amclock",
          period: { as_of: "2026-10-26" },
          row_count: 2,
          rows: [
            { bucket: "1-7 days", plans_count: 11, overdue_ugx: 850000 },
            { bucket: "8-14 days", plans_count: 7, overdue_ugx: 600000 },
          ],
        },
        error: null,
      };
    },
    getDailyEmailUsage: async () => ({
      sentToday: 4,
      maxEmailsPerDay: 30,
    }),
    renderPdfBase64: async () => "JVBERi0xLjQK",
    sendTransactionalEmail: async (payload) => {
      calls.sentEmails.push(payload);
      return { ok: true };
    },
    writeAuditAndSystemEvent: async (entry) => {
      calls.auditEntries.push(entry as unknown as Record<string, unknown>);
    },
    ...overrides,
  };

  return { deps, calls };
}

const validRequestBody = {
  recipient_email: "jane@welile.com",
  recipient_name: "Janehephzibar Gimono",
  subject: "Report shared from Zoe: Tenant Ops Arrears Ageing (as of 2026-10-26)",
  message: "Hi Jane, here is today's Tenant Ops arrears ageing report.",
  report_reference: {
    tool: "get_tops_arrears_ageing",
    rpc: "assistant_staff_tops_arrears_ageing",
    args: {},
    source: "tops_arrears_ageing_amclock",
    period: "as of 2026-10-26",
    title: "Tenant Ops Arrears Ageing Report",
    filename: "welile-zoe-tenant-ops-arrears-ageing-2026-10-26.pdf",
  },
};

Deno.test("draft_report_email never sends, resolves single staff recipient via staff_assistant_email_recipients, and asks to pick when several match", () => {
  const samplePayload = {
    tool: "get_tops_arrears_ageing",
    rpc: "assistant_staff_tops_arrears_ageing",
    source: "tops_arrears_ageing_amclock",
    period: { as_of: "2026-10-26" },
    row_count: 2,
    rows: [{ bucket: "1-7 days", overdue_ugx: 850000 }],
  };

  // Single match -> returns ready draft
  const single = buildReportEmailDraft({
    recipientSearch: "Jane",
    recipients: [
      {
        staff_user_id: "22222222-2222-4222-8222-222222222222",
        full_name: "Janehephzibar Gimono",
        email: "jane@welile.com",
        roles: ["tenant_ops"],
      },
    ],
    rawToolOutputs: [JSON.stringify(samplePayload)],
    userText: "Email this report to Jane",
    reportPayload: samplePayload,
    periodLabel: "as of 2026-10-26",
    todayKampala: "2026-10-26",
  });

  assertEquals(single.kind, "draft_ready");
  if (single.kind === "draft_ready") {
    assertEquals(single.draft.status, "ready");
    assertEquals(single.draft.recipient_email, "jane@welile.com");
    assertEquals(single.draft.recipient_name, "Janehephzibar Gimono");
    assertEquals(single.draft.report_reference.tool, "get_tops_arrears_ageing");
  }

  // Multiple staff matches -> asks the caller to pick
  const multi = buildReportEmailDraft({
    recipientSearch: "Grace",
    recipients: [
      {
        staff_user_id: "33333333-3333-4333-8333-333333333333",
        full_name: "Grace Namukasa",
        email: "grace.n@welile.com",
        roles: ["tenant_ops"],
      },
      {
        staff_user_id: "44444444-4444-4444-8444-444444444444",
        full_name: "Grace Achieng",
        email: "grace.a@welile.com",
        roles: ["landlord_ops"],
      },
    ],
    rawToolOutputs: [JSON.stringify(samplePayload)],
    userText: "Email this report to Grace",
    reportPayload: samplePayload,
    periodLabel: "as of 2026-10-26",
    todayKampala: "2026-10-26",
  });

  assertEquals(multi.kind, "pick_recipient");
  if (multi.kind === "pick_recipient") {
    assertEquals(multi.draft.status, "pick_recipient");
    assertEquals(multi.options.length, 2);
    assertEquals(multi.draft.candidates.length, 2);
  }
});

Deno.test("draft_report_email refuses email addresses found inside report data or typed non-staff addresses", () => {
  const toolOutputWithDataEmail = JSON.stringify({
    source: "tops_arrears_ageing_amclock",
    rows: [{ tenant_name: "Tenant One", tenant_email: "tenant.found.in.data@gmail.com" }],
  });

  assertEquals(
    isEmailFromToolData(
      "tenant.found.in.data@gmail.com",
      [toolOutputWithDataEmail],
      "Email the report to the tenant in the first row",
    ),
    true,
  );

  const dataRefused = buildReportEmailDraft({
    recipientSearch: "tenant.found.in.data@gmail.com",
    recipients: [],
    rawToolOutputs: [toolOutputWithDataEmail],
    userText: "Email the report to the tenant in the first row",
    reportPayload: { tool: "get_tops_arrears_ageing", rows: [] },
    periodLabel: "as of 2026-10-26",
    todayKampala: "2026-10-26",
  });
  assertEquals(dataRefused.kind, "refused");
  if (dataRefused.kind === "refused") {
    assertEquals(dataRefused.reason, "data_email_forbidden");
  }

  // Typed non-staff address (staff_assistant_email_recipients returns empty)
  const nonStaffRefused = buildReportEmailDraft({
    recipientSearch: "outside.person@gmail.com",
    recipients: [],
    rawToolOutputs: [],
    userText: "Email this report to outside.person@gmail.com",
    reportPayload: { tool: "get_tops_arrears_ageing", rows: [] },
    periodLabel: "as of 2026-10-26",
    todayKampala: "2026-10-26",
  });
  assertEquals(nonStaffRefused.kind, "refused");
  if (nonStaffRefused.kind === "refused") {
    assertEquals(nonStaffRefused.reason, "not_staff");
  }
});

Deno.test("staff-assistant-send-email refuses when staff_assistant_has_access() is false", async () => {
  const { deps, calls } = createMockSendDeps({
    checkHasAccess: async () => false,
  });

  const res = await handleStaffAssistantSendEmail(validRequestBody, deps);
  assertEquals(res.status, 403);
  assertEquals(calls.sentEmails.length, 0);
  assertEquals(calls.auditEntries.length, 0);
});

Deno.test("staff-assistant-send-email refuses a typed non-staff email address via staff_assistant_is_staff_email", async () => {
  const { deps, calls } = createMockSendDeps();

  const res = await handleStaffAssistantSendEmail(
    {
      ...validRequestBody,
      recipient_email: "tenant.nonstaff@gmail.com",
    },
    deps,
  );

  assertEquals(res.status, 403);
  assertEquals(res.body.code, "RECIPIENT_NOT_STAFF");
  assertEquals(calls.isStaffEmailArgs, ["tenant.nonstaff@gmail.com"]);
  assertEquals(calls.reportRpcCalls.length, 0);
  assertEquals(calls.sentEmails.length, 0);
  assertEquals(calls.auditEntries.length, 0);
});

Deno.test("staff-assistant-send-email enforces 30 emails per person per day", async () => {
  const { deps, calls } = createMockSendDeps({
    getDailyEmailUsage: async () => ({
      sentToday: 30,
      maxEmailsPerDay: 30,
    }),
  });

  const res = await handleStaffAssistantSendEmail(validRequestBody, deps);
  assertEquals(res.status, 429);
  assertEquals(res.body.code, "EMAIL_DAILY_LIMIT_REACHED");
  assertEquals(calls.sentEmails.length, 0);
  assertEquals(calls.auditEntries.length, 0);
});

Deno.test("staff-assistant-send-email re-runs the report as the sender and refuses if the sender cannot view it", async () => {
  // Case A: sender lacks role for CFO cash position
  const { deps: wrongRoleDeps, calls: wrongRoleCalls } = createMockSendDeps({
    getSenderRoles: async () => ["tenant_ops"],
  });

  const wrongRoleRes = await handleStaffAssistantSendEmail(
    {
      ...validRequestBody,
      report_reference: {
        tool: "get_cfo_treasury_cash_position",
        rpc: "assistant_staff_cfo_treasury_cash_position",
        args: {},
      },
    },
    wrongRoleDeps,
  );
  assertEquals(wrongRoleRes.status, 403);
  assertEquals(wrongRoleRes.body.code, "ROLE_RESTRICTED");
  assertEquals(wrongRoleCalls.sentEmails.length, 0);

  // Case B: RPC itself raises 42501 when re-run as sender
  const { deps: rpcDeniedDeps, calls: rpcDeniedCalls } = createMockSendDeps({
    runReportRpcAsSender: async () => ({
      data: null,
      error: { code: "42501", message: "Not authorized" },
    }),
  });

  const rpcDeniedRes = await handleStaffAssistantSendEmail(validRequestBody, rpcDeniedDeps);
  assertEquals(rpcDeniedRes.status, 403);
  assertEquals(rpcDeniedRes.body.code, "ROLE_RESTRICTED");
  assertEquals(rpcDeniedCalls.sentEmails.length, 0);
});

Deno.test("staff-assistant-send-email sends through send-transactional-email with template 'Report shared from Zoe', PDF attached, and writes audit_logs and system_events", async () => {
  const { deps, calls } = createMockSendDeps();

  const res = await handleStaffAssistantSendEmail(validRequestBody, deps);
  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(res.body.sent, true);
  assertEquals(res.body.template_name, ZOE_REPORT_EMAIL_TEMPLATE);
  assertEquals(res.body.template_display_name, ZOE_REPORT_EMAIL_DISPLAY_NAME);
  assertEquals(res.body.recipient_email, "jane@welile.com");
  assertEquals(res.body.remaining_emails_today, 25);

  // Verified access, staff email, and re-ran report as sender
  assertEquals(calls.hasAccessCalled, 1);
  assertEquals(calls.isStaffEmailArgs, ["jane@welile.com"]);
  assertEquals(calls.reportRpcCalls.length, 1);
  assertEquals(calls.reportRpcCalls[0].rpc, "assistant_staff_tops_arrears_ageing");

  // Sent via send-transactional-email with PDF attached
  assertEquals(calls.sentEmails.length, 1);
  const sent = calls.sentEmails[0];
  assertEquals(sent.templateName, "zoe-report-shared");
  assertEquals(sent.recipientEmail, "jane@welile.com");
  const tData = sent.templateData as Record<string, unknown>;
  assertEquals(tData.attachment_base64, "JVBERi0xLjQK");
  assertStringIncludes(String(tData.attachment_filename), ".pdf");
  assertEquals(tData.row_count, 2);

  // Wrote audit_logs and system_events
  assertEquals(calls.auditEntries.length, 1);
  assertEquals(calls.auditEntries[0].recipientEmail, "jane@welile.com");
  assertEquals(calls.auditEntries[0].rpcName, "assistant_staff_tops_arrears_ageing");
});
