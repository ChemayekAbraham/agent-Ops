import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DueScheduleRecord,
  runStaffAssistantSchedules,
  ScheduleRunnerDependencies,
} from "./handler.ts";

function makeBaseSchedule(
  overrides: Partial<DueScheduleRecord> = {},
): DueScheduleRecord {
  return {
    id: "sched-1",
    user_id: "owner-1",
    title: "Daily Tenant Ops Waiting Queue",
    report_tool: "get_tops_pipeline_waiting_on_lops",
    report_rpc: "assistant_staff_tops_pipeline_waiting_on_lops",
    report_args: {},
    frequency: "daily",
    day_of_week: null,
    send_time_kampala: "07:30",
    recipient_emails: ["winnie@welile.com"],
    recipient_names: ["Winfred Asiimwe"],
    custom_message: "Daily 07:30 Kampala pipeline check.",
    run_count: 2,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<ScheduleRunnerDependencies> = {},
): ScheduleRunnerDependencies {
  return {
    dispatchDueReminders: async () => 1,
    loadDueSchedules: async () => [makeBaseSchedule()],
    checkOwnerHasAccess: async () => true,
    getOwnerProfileAndRoles: async () => ({
      fullName: "Janehephzibar Gimono",
      email: "jane@welile.com",
      roles: ["tenant_ops"],
    }),
    checkRecipientIsStaffEmail: async (email) => email.endsWith("@welile.com"),
    getDailyEmailUsage: async () => ({ sentToday: 2, maxEmailsPerDay: 30 }),
    runReportAsOwner: async () => ({
      data: {
        source: "Tenant Ops Pipeline",
        period: { as_of: "2026-10-26" },
        row_count: 2,
        rows: [
          { tenant_name: "Alice", rent_ugx: 450000 },
          { tenant_name: "Bob", rent_ugx: 600000 },
        ],
      },
      error: null,
    }),
    renderPdfBase64: async () => "JVBERi0xLjQK",
    sendTransactionalEmail: async () => ({ ok: true }),
    computeNextRunAt: async () => "2026-10-27T04:30:00.000Z",
    updateScheduleState: async () => {},
    writeScheduleAudit: async () => {},
    ...overrides,
  };
}

Deno.test("schedule runner sends report when owner has access and recipient is active staff", async () => {
  const sentEmails: string[] = [];
  const res = await runStaffAssistantSchedules(
    makeDeps({
      sendTransactionalEmail: async (payload) => {
        sentEmails.push(payload.recipientEmail);
        return { ok: true };
      },
    }),
  );

  assertEquals(res.status, 200);
  assertEquals(res.body.reminders_dispatched, 1);
  assertEquals(res.body.schedules_sent, 1);
  assertEquals(sentEmails, ["winnie@welile.com"]);
  assertEquals(res.body.outcomes[0].status, "sent");
});

Deno.test("schedule runner pauses and refuses when owner loses staff_assistant_has_access()", async () => {
  let sentCount = 0;
  const res = await runStaffAssistantSchedules(
    makeDeps({
      checkOwnerHasAccess: async () => false,
      sendTransactionalEmail: async () => {
        sentCount += 1;
        return { ok: true };
      },
    }),
  );

  assertEquals(sentCount, 0);
  assertEquals(res.body.schedules_sent, 0);
  assertEquals(res.body.outcomes[0].status, "paused_owner_access_revoked");
});

Deno.test("schedule runner pauses and refuses when recipient is no longer an active staff email", async () => {
  let sentCount = 0;
  const res = await runStaffAssistantSchedules(
    makeDeps({
      loadDueSchedules: async () => [
        makeBaseSchedule({
          recipient_emails: ["former.staff@gmail.com"],
          recipient_names: ["Former Staff"],
        }),
      ],
      checkRecipientIsStaffEmail: async () => false,
      sendTransactionalEmail: async () => {
        sentCount += 1;
        return { ok: true };
      },
    }),
  );

  assertEquals(sentCount, 0);
  assertEquals(res.body.schedules_sent, 0);
  assertEquals(res.body.outcomes[0].status, "paused_recipient_not_staff");
  assertEquals(res.body.outcomes[0].refused_recipients, ["former.staff@gmail.com"]);
});

Deno.test("schedule runner pauses and refuses when owner role no longer permits the report tool", async () => {
  let sentCount = 0;
  const res = await runStaffAssistantSchedules(
    makeDeps({
      loadDueSchedules: async () => [
        makeBaseSchedule({
          report_tool: "get_cfo_treasury_cash_position",
          report_rpc: "assistant_staff_cfo_treasury_cash_position",
        }),
      ],
      getOwnerProfileAndRoles: async () => ({
        fullName: "Jane",
        email: "jane@welile.com",
        roles: ["tenant_ops"],
      }),
      sendTransactionalEmail: async () => {
        sentCount += 1;
        return { ok: true };
      },
    }),
  );

  assertEquals(sentCount, 0);
  assertEquals(res.body.schedules_sent, 0);
  assertEquals(res.body.outcomes[0].status, "paused_owner_role_revoked");
});
