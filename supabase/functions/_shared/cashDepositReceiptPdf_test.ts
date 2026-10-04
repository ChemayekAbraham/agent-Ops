import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { cashDepositReceiptFilename, renderCashDepositReceipt } from "./cashDepositReceiptPdf.ts";

Deno.test("cash deposit receipt renders a valid single-page PDF", async () => {
  const bytes = await renderCashDepositReceipt({
    depositorName: "Amina Nakato",
    amount: 5_000_000,
    newBalance: 5_125_000,
    depositedAt: "2026-09-12T09:30:00.000Z",
    referenceNumber: "DEP-5A7C91E2",
    maskedDepositCode: "••21",
    facilitatedRentVolume: 4_500_000,
    platformServiceFees: 350_000,
    transactionExpenses: 150_000,
  });

  assert(bytes.length > 1_000);
  assertEquals(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
});

Deno.test("cash deposit receipt filename is safe and descriptive", () => {
  assertEquals(
    cashDepositReceiptFilename("DEP-5a7c 91e2"),
    "Welile-Cash-Deposit-Receipt-DEP-5A7C-91E2.pdf",
  );
});