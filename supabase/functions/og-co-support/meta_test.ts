import { assertEquals, assertMatch, assertNotMatch } from "jsr:@std/assert@1";
import { coSupportPreviewMeta, formatUgx } from "./meta.ts";

const open = {
  status: "open",
  lead_first_name: "Sarah",
  tenant_first_name: "Tom",
  city: "Kampala",
  house_image_url: "https://cdn.example/h.jpg",
  your_share: 153000,
};

Deno.test("open invitation names the sender, the home and the half", () => {
  const m = coSupportPreviewMeta(open);
  assertEquals(m.title, "Sarah wants to support a Rent Plan with you");
  assertMatch(m.description, /^Tom's home in Kampala, Uganda\. /);
  assertMatch(m.description, /your half is UGX 153,000/);
  assertMatch(m.description, /Rent Profit Share/);
  assertEquals(m.image, "https://cdn.example/h.jpg");
});

Deno.test("never uses banned words or shows a rate", () => {
  for (const status of ["open", "completed", "expired", "cancelled"]) {
    const m = coSupportPreviewMeta({ ...open, status });
    const text = `${m.title} ${m.description}`;
    assertNotMatch(text, /\b(loan|lender|interest|ROI|returns?)\b/i);
    assertNotMatch(text, /%/);
  }
});

Deno.test("closed invitations say so and keep the photo", () => {
  assertMatch(coSupportPreviewMeta({ ...open, status: "completed" }).description, /fully supported/);
  assertMatch(coSupportPreviewMeta({ ...open, status: "expired" }).description, /no longer open/);
  assertEquals(coSupportPreviewMeta({ ...open, status: "expired" }).image, "https://cdn.example/h.jpg");
});

Deno.test("missing names and city fall back politely", () => {
  const m = coSupportPreviewMeta({ status: "open", your_share: "51050" });
  assertEquals(m.title, "A Welile partner wants to support a Rent Plan with you");
  assertMatch(m.description, /^A tenant's home\. /);
  assertMatch(m.description, /UGX 51,050/);
});

Deno.test("only https photos are used", () => {
  assertEquals(coSupportPreviewMeta({ ...open, house_image_url: "javascript:alert(1)" }).image, null);
  assertEquals(coSupportPreviewMeta({ ...open, house_image_url: "http://x/h.jpg" }).image, null);
});

Deno.test("formatUgx rounds and groups", () => {
  assertEquals(formatUgx(127550.4), "UGX 127,550");
  assertEquals(formatUgx(null), "UGX 0");
});
