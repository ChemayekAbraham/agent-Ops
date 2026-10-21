import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hmacSha256, messageFromResource, verifyNeexaSignature } from "./neexa.ts";

const SECRET = "test-signing-secret";
const BODY = JSON.stringify({
  event: "messages:whatsapp",
  data: { message_id: "84210", conversation_id: "2", from: "+256700000000", message: "Hello" },
});

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

Deno.test("signature: hex, sha256= prefix, upper case and base64 all verify", async () => {
  const mac = await hmacSha256(SECRET, BODY);
  assertEquals(await verifyNeexaSignature(SECRET, BODY, hex(mac)), true);
  assertEquals(await verifyNeexaSignature(SECRET, BODY, `sha256=${hex(mac)}`), true);
  assertEquals(await verifyNeexaSignature(SECRET, BODY, hex(mac).toUpperCase()), true);
  assertEquals(await verifyNeexaSignature(SECRET, BODY, btoa(String.fromCharCode(...mac))), true);
});

Deno.test("signature: wrong secret, altered body and empty header are rejected", async () => {
  const mac = hex(await hmacSha256(SECRET, BODY));
  assertEquals(await verifyNeexaSignature("other-secret", BODY, mac), false);
  assertEquals(await verifyNeexaSignature(SECRET, BODY.replace("Hello", "Hellp"), mac), false);
  assertEquals(await verifyNeexaSignature(SECRET, BODY, ""), false);
  assertEquals(await verifyNeexaSignature(SECRET, BODY, "sha256="), false);
});

Deno.test("messageFromResource: client is inbound, business is outbound", () => {
  const client = messageFromResource(
    { id: "84210", attributes: { message: "Hi", message_creator_type: "client", channel: "whatsapp", status: "delivered", created_at: "2026-07-05T12:29:40+00:00" } },
    "2",
    "sync",
  );
  assertEquals(client.direction, "inbound");
  assertEquals(client.conversation_id, "2");
  assertEquals(client.message_id, "84210");

  const sent = messageFromResource(
    { id: 84213, attributes: { message: "Yes", message_creator_type: "business", ai_human_conversation_id: 42 } },
    "2",
    "api",
  );
  assertEquals(sent.direction, "outbound");
  assertEquals(sent.conversation_id, "42");
  assertEquals(sent.message_id, "84213");
});
