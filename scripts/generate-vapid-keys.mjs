#!/usr/bin/env node
// Generates a Web Push (VAPID) key pair in the exact formats Welile's code expects.
//   VAPID_PUBLIC_KEY   65-byte uncompressed P-256 point, base64url   -> goes in code (src/lib/webPush.ts, supabase/functions/_shared/webPushSend.ts). Public, safe to share.
//   VAPID_PRIVATE_KEY  PKCS#8 DER, base64url                          -> goes ONLY in Supabase edge-function secrets. Never commit it, never paste it in chat.
// (`npx web-push generate-vapid-keys` prints a raw 32-byte private key, which webPushSend.ts cannot import: "expected valid PKCS#8 data".)
// Usage: node scripts/generate-vapid-keys.mjs
import { generateKeyPairSync } from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pub = b64url(publicKey.export({ format: "jwk" }).x ? Buffer.concat([
  Buffer.from([4]),
  Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"),
  Buffer.from(publicKey.export({ format: "jwk" }).y, "base64url"),
]) : Buffer.alloc(0));
const priv = b64url(privateKey.export({ format: "der", type: "pkcs8" }));

if (process.argv.includes("--selftest")) {
  console.log("public bytes:", Buffer.from(pub, "base64url").length, "(expect 65)");
  console.log("private bytes:", Buffer.from(priv, "base64url").length, "(PKCS#8 P-256 is 138)");
  const { webcrypto } = await import("node:crypto");
  await webcrypto.subtle.importKey("pkcs8", Buffer.from(priv, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  console.log("private key imports as pkcs8: ok");
} else {
  console.log("\nVAPID_PUBLIC_KEY  (public, goes in code):\n" + pub);
  console.log("\nVAPID_PRIVATE_KEY (secret, goes only in Supabase edge-function secrets):\n" + priv + "\n");
}
