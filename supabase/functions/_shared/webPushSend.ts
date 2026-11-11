// Web Push (VAPID) sender -- MOVED verbatim from send-push-notification's
// former inline implementation, not rewritten. This is the codebase's real
// push transport (no Firebase/FCM anywhere in this project): VAPID JWT
// signing plus RFC 8291/8188 aes128gcm payload encryption, matching the
// browser PushSubscription created by src/lib/webPush.ts.
//
// send-push-notification/index.ts now imports from here so there is exactly
// one implementation of this crypto, used by both the original broadcast
// entrypoint and the Stage 6 channel router -- getting push encryption wrong
// fails silently (no loud error, the push service just drops the message),
// so it is deliberately relocated rather than reimplemented.
//
// The VAPID private key never leaves this server-side module.

// The public key comes from the VAPID_PUBLIC_KEY secret so a key rotation never needs a code change on the server; the literal is only the fallback
// (the key generated 2026-10-29, fingerprint sha256 721b3b1c...56a636). It must be the public half of VAPID_PRIVATE_KEY, and the same key the browser subscribes with (src/lib/webPush.ts).
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ||
  "BKeWfSgeYM9EVU_0CU3EgOEpTlNkqIuO4y9PKvap7p74sh_gEQTdjwNVmo2NAslHKXHIuGkP4JBunz5yun6aCrc";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const VAPID_SUBJECT = "mailto:notifications@welile.com";

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  url?: string;
  type?: string;
  notificationId?: string;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSendResult {
  ok: boolean;
  /** Endpoint is permanently gone (404/410) -- the caller should delete the row. */
  gone: boolean;
  /** Push service says the subscription was made with another VAPID key (e.g. before the 2026-10-29 rotation). */
  keyMismatch: boolean;
  status: number;
}

const KEY_MISMATCH_RE = /do(?:es)? not correspond|VapidPkHashMismatch|mismatch/i;

function base64urlEncode(data: Uint8Array | string): string {
  const str = typeof data === "string" ? data : String.fromCharCode(...data);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(input: string): Uint8Array {
  let s = input.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data as BufferSource);
  return new Uint8Array(sig);
}

/**
 * Encrypt a Web Push payload using the aes128gcm content encoding (RFC 8291 /
 * RFC 8188). Without this, modern push services (FCM's web endpoint, Mozilla
 * autopush, etc.) reject payload-bearing messages and delivery silently fails.
 */
async function encryptPayload(
  p256dh: string,
  auth: string,
  plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = base64urlToBytes(p256dh); // recipient public key (65 bytes)
  const authSecret = base64urlToBytes(auth); // recipient auth secret (16 bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Ephemeral ECDH key pair for this message.
  const asKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const asPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", asKeyPair.publicKey),
  ); // 65 bytes

  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublic as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaPublicKey },
      asKeyPair.privateKey,
      256,
    ),
  );

  const encoder = new TextEncoder();

  // Combine auth_secret + ecdh_secret -> IKM (RFC 8291 §3.4)
  const prkKey = await hmacSha256(authSecret, ecdhSecret);
  const keyInfo = concatBytes(
    encoder.encode("WebPush: info\0"),
    uaPublic,
    asPublic,
  );
  const ikm = await hmacSha256(prkKey, concatBytes(keyInfo, new Uint8Array([1])));

  // HKDF (RFC 8188) to derive content-encryption key and nonce.
  const prk = await hmacSha256(salt, ikm);
  const cek = (
    await hmacSha256(
      prk,
      concatBytes(encoder.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])),
    )
  ).slice(0, 16);
  const nonce = (
    await hmacSha256(
      prk,
      concatBytes(encoder.encode("Content-Encoding: nonce\0"), new Uint8Array([1])),
    )
  ).slice(0, 12);

  // Single record: plaintext followed by the 0x02 "last record" delimiter.
  const record = concatBytes(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      aesKey,
      record as BufferSource,
    ),
  );

  // aes128gcm header: salt(16) | rs(4) | idlen(1) | keyid(as_public)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const header = concatBytes(salt, rs, new Uint8Array([asPublic.length]), asPublic);

  return concatBytes(header, ciphertext);
}

async function createVapidJwt(audience: string): Promise<string> {
  const header = { alg: "ES256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    aud: audience,
    exp: now + 12 * 60 * 60, // 12 hours
    sub: VAPID_SUBJECT,
  };

  const headerB64 = base64urlEncode(JSON.stringify(header));
  const claimsB64 = base64urlEncode(JSON.stringify(claims));
  const unsigned = `${headerB64}.${claimsB64}`;

  // VAPID_PRIVATE_KEY is a PKCS8-encoded (DER) EC private key in base64url.
  const pkcs8 = base64urlToBytes(VAPID_PRIVATE_KEY);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  );

  return `${unsigned}.${base64urlEncode(new Uint8Array(signature))}`;
}

/** Sends one encrypted push message to one browser subscription. */
export async function sendPushToSubscription(
  subscription: PushSubscriptionKeys,
  payload: PushPayload,
): Promise<PushSendResult> {
  try {
    const endpoint = new URL(subscription.endpoint);
    const audience = `${endpoint.protocol}//${endpoint.host}`;

    const jwt = await createVapidJwt(audience);
    const authorization = `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`;

    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = await encryptPayload(subscription.p256dh, subscription.auth, plaintext);

    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        TTL: "86400",
        Urgency: payload.type === "error" ? "high" : "normal",
      },
      body: encrypted,
    });

    if (!response.ok) {
      const status = response.status;
      let body = "";
      try {
        body = (await response.text()).slice(0, 300);
      } catch {
        body = "";
      }
      console.error(`[webPushSend] Push failed (${status}) host=${endpoint.host}`, body);
      // 404/410: endpoint permanently gone. 400/401/403 with a key-mismatch body:
      // subscription made with an old VAPID key, can never succeed. Everything
      // else is transient and the subscription is kept.
      const gone = status === 404 || status === 410;
      const keyMismatch = !gone && (status === 400 || status === 401 || status === 403) && KEY_MISMATCH_RE.test(body);
      return { ok: false, gone, keyMismatch, status };
    }

    return { ok: true, gone: false, keyMismatch: false, status: response.status };
  } catch (error) {
    console.error("[webPushSend] Error sending push:", error);
    return { ok: false, gone: false, keyMismatch: false, status: 0 };
  }
}

/**
 * Deletes a push_subscriptions row after a permanently-gone (404/410)
 * response, so both the broadcast sender and the Stage 6 channel router
 * clean up dead devices the same way instead of each having its own copy of
 * this logic.
 */
export async function cleanupGoneSubscription(admin: any, endpoint: string): Promise<void> {
  try {
    await admin.from("push_subscriptions").delete().eq("endpoint", endpoint);
  } catch (err) {
    console.error("[webPushSend] cleanupGoneSubscription failed:", err);
  }
}

/**
 * Deletes dead subscriptions after one batch of sends. Gone (404/410) rows are
 * always removed; key-mismatch rows only when at least one other send in the
 * same batch succeeded, which proves the current VAPID key works, so a bad
 * VAPID secret can never wipe every device. Deletes in chunks of 50.
 */
export async function removeDeadSubscriptions(
  admin: any,
  results: Array<{ endpoint: string; result: PushSendResult | null }>,
  tag: string,
): Promise<number> {
  const anyOk = results.some((r) => r.result?.ok);
  const dead = results
    .filter((r) => r.result && (r.result.gone || (anyOk && r.result.keyMismatch)))
    .map((r) => r.endpoint);
  let removed = 0;
  for (let i = 0; i < dead.length; i += 50) {
    const chunk = dead.slice(i, i + 50);
    try {
      const { error } = await admin.from("push_subscriptions").delete().in("endpoint", chunk);
      if (error) console.error(`[${tag}] dead subscription delete failed:`, error);
      else removed += chunk.length;
    } catch (err) {
      console.error(`[${tag}] dead subscription delete failed:`, err);
    }
  }
  if (removed > 0) console.log(`[${tag}] removed ${removed} dead subscriptions`);
  return removed;
}

/** Pairs Promise.allSettled push results with their subscription endpoints. */
export function settledPushResults(
  subs: Array<{ endpoint: string }>,
  settled: PromiseSettledResult<PushSendResult>[],
): Array<{ endpoint: string; result: PushSendResult | null }> {
  return subs.map((s, i) => ({
    endpoint: s.endpoint,
    result: settled[i]?.status === "fulfilled" ? (settled[i] as PromiseFulfilledResult<PushSendResult>).value : null,
  }));
}
