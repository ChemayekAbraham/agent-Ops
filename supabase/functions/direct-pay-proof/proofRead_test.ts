/*
 * Author: SSENKAALI PIUS
 * Email: ssenkaali.pius@welileapp.com
 * Date: 2026-11-13
 * Website: welileapp.com
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { kampalaTimestamp, mimeFromPath, parseProofRequest, sha256Hex, toProofRead } from "./proofRead.ts";

const UID = "11111111-1111-4111-8111-111111111111";
const PAY = "aaaaaaaa-0000-4000-8000-000000000003";

Deno.test("a photo outside the caller's folder is refused", () => {
  assertEquals(parseProofRequest({ payment_id: PAY, photo_path: "22222222-2222-4222-8222-222222222222/a.jpg" }, UID),
    { error: "invalid_photo" });
  assertEquals(parseProofRequest({ payment_id: PAY, photo_path: `${UID}/../x.jpg` }, UID), { error: "invalid_photo" });
});

Deno.test("a bad payment id is refused", () => {
  assertEquals(parseProofRequest({ payment_id: "x", photo_path: `${UID}/a.jpg` }, UID), { error: "invalid" });
});

Deno.test("typed values are cleaned; unknown providers dropped", () => {
  assertEquals(parseProofRequest({ payment_id: PAY, photo_path: `${UID}/a.jpg`, tid_typed: "  MP1234 ", amount_typed: "450000.4", provider: "other" }, UID), {
    request: { payment_id: PAY, photo_path: `${UID}/a.jpg`, tid_typed: "MP1234", amount_typed: 450000, provider: null },
  });
});

Deno.test("SMS time is read as Kampala time; a date without a time stays unknown", () => {
  assertEquals(kampalaTimestamp("2026-11-17", "9:05"), "2026-11-17T09:05:00+03:00");
  assertEquals(kampalaTimestamp("2026-11-17", null), null);
  assertEquals(kampalaTimestamp("17/11/2026", "09:05"), null);
});

Deno.test("reader output becomes p_read; no amount means unreadable, no result means error", () => {
  assertEquals(toProofRead({ fields: { transactionId: " 123 ", amount: 450000, date: "2026-11-17", time: "10:00", phone: "0772123456", confidence: "high" } }), {
    status: "read", tid: "123", amount: 450000, phone: "0772123456", paid_at: "2026-11-17T10:00:00+03:00", confidence: "high",
  });
  assertEquals(toProofRead({ fields: { transactionId: "123", amount: null } }).status, "unreadable");
  assertEquals(toProofRead({ fields: null, unverifiableReason: "gateway_rate_limited" }), {
    status: "error", tid: null, amount: null, phone: null, paid_at: null, confidence: null, reason: "gateway_rate_limited",
  });
  assertEquals(toProofRead(null, "reader_not_configured").reason, "reader_not_configured");
});

Deno.test("mime type from the file name", () => {
  assertEquals(mimeFromPath("a/b.PNG"), "image/png");
  assertEquals(mimeFromPath("a/b"), "image/jpeg");
});

Deno.test("sha256 is stable hex", async () => {
  assertEquals(await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
