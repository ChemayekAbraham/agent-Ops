import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatPhoneInternational, isUgandanPhone } from "./phone.ts";

Deno.test("formatPhoneInternational - 256-prefixed number is kept and +", () => {
  assertEquals(formatPhoneInternational("256772123456"), "+256772123456");
  assertEquals(formatPhoneInternational("+256772123456"), "+256772123456");
});

Deno.test("formatPhoneInternational - local 0-trunk number is converted", () => {
  assertEquals(formatPhoneInternational("0772123456"), "+256772123456");
  assertEquals(formatPhoneInternational("0700000000"), "+256700000000");
});

Deno.test("formatPhoneInternational - 9 bare digits get +256 prefix", () => {
  assertEquals(formatPhoneInternational("772123456"), "+256772123456");
});

Deno.test("formatPhoneInternational - strips spaces, dashes and parentheses", () => {
  assertEquals(formatPhoneInternational(" 0772 123 456 "), "+256772123456");
  assertEquals(formatPhoneInternational("+256-772-123-456"), "+256772123456");
  assertEquals(formatPhoneInternational("(256) 772 123456"), "+256772123456");
});

Deno.test("formatPhoneInternational - empty / non-digit input returns empty string", () => {
  assertEquals(formatPhoneInternational(""), "");
  assertEquals(formatPhoneInternational("   "), "");
  assertEquals(formatPhoneInternational("abc"), "");
  // @ts-expect-error - guarding against null at runtime
  assertEquals(formatPhoneInternational(null), "");
});

Deno.test("isUgandanPhone - valid Ugandan formats", () => {
  assertEquals(isUgandanPhone("0772123456"), true);
  assertEquals(isUgandanPhone("256772123456"), true);
  assertEquals(isUgandanPhone("+256772123456"), true);
  assertEquals(isUgandanPhone("772123456"), true);
  assertEquals(isUgandanPhone(" 0772 123 456 "), true);
});

Deno.test("isUgandanPhone - rejects too-short numbers", () => {
  assertEquals(isUgandanPhone("0772"), false);
  assertEquals(isUgandanPhone("25677"), false);
  assertEquals(isUgandanPhone("12345"), false);
});

Deno.test("isUgandanPhone - rejects empty / invalid input", () => {
  assertEquals(isUgandanPhone(""), false);
  assertEquals(isUgandanPhone("abc"), false);
});

Deno.test("isUgandanPhone - rejects non-Ugandan country codes", () => {
  // Kenyan number normalizes to +254… which is not +256.
  assertEquals(isUgandanPhone("+254712345678"), false);
});
