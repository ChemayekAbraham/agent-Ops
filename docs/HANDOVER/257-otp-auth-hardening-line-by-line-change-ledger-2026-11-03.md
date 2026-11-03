# 257. Line-by-line change ledger: OTP and password-reset hardening (2026-11-03)

**Status:** WRITTEN FOR REVIEW BEFORE ANY PUSH TO LOVABLE. Everything below is on branch `dev/otp-attempt-limits`; nothing is pushed or deployed.

**What this is:** every line removed or added by this work, copied from git (not retyped), each hunk followed by a plain-language explanation. The explanations are the reviewer's words; the diff blocks are exact. Read this next to docs 251, 255 and 256, which explain the problems and the tests.

## How to read a diff block

- A line starting with `-` was **removed**. A line starting with `+` was **added**. A line starting with a space is **unchanged context**, shown only so you can see where the change sits.
- `@@ -91,11 +91,12 @@` means: in the old file the block starts at line 91 and covers 11 lines; in the new file it starts at line 91 and covers 12.
- Base for the comparison: commit `17861bca87` (the upstream state that was merged into this branch), compared with this branch's head. Diff algorithm: `patience`, 3 lines of context.

## Summary: lines added and removed, per file (from `git diff --numstat`)

| File | Added | Removed | What it does |
|---|---:|---:|---|
| `supabase/functions/otp-login/index.ts` | 27 | 29 | otp-login: count every guess |
| `supabase/functions/sms-otp/index.ts` | 20 | 6 | sms-otp: secure codes + lock send_custom |
| `supabase/functions/password-reset-sms/index.ts` | 169 | 85 | password-reset-sms: guess limits, single use, audit, no enumeration |
| `supabase/migrations/20261102090000_register_otp_attempt.sql` | 18 | 0 | the atomic counter function (new) |
| `supabase/migrations/20261102090000_register_otp_attempt.rollback.sql` | 1 | 0 | its rollback (new) |
| `src/pages/Auth.tsx` | 2 | 2 | reset screen wording |
| `src/hooks/useAuthForm.ts` | 1 | 1 | reset toast wording |
| `docs/HANDOVER/251-otp-login-wrong-guesses-were-never-counted-2026-11-02.md` | 19 | 0 | documentation only |
| `docs/HANDOVER/255-sms-otp-send-custom-open-relay-gated-2026-11-02.md` | 26 | 0 | documentation only |
| `docs/HANDOVER/256-password-reset-sms-code-guessing-and-reuse-2026-11-03.md` | 46 | 0 | documentation only |
| `docs/HANDOVER/README.md` | 3 | 0 | documentation only |
| `docs/HANDOVER/architecture-map.html` | 3 | 0 | documentation only |
| **Total** | **335** | **123** | code: 238 added, 123 removed; documentation: 97 added, 0 removed |

Every code hunk below is counted by the generator and checked against these numbers; the build stops if they differ.

## Code changes, hunk by hunk

### `supabase/functions/otp-login/index.ts`

#### Hunk 1 of 3: 3 added, 2 removed

````diff
@@ -91,11 +91,12 @@ Deno.serve(async (req) => {
     // Step 1: Verify OTP from otp_verifications table
     const phoneVariants = [`0${last9}`, `256${last9}`, last9, `+256${last9}`];
     
+    // The guess is deliberately NOT part of this search: a wrong guess must still
+    // find the row so it can be counted below (see register_otp_attempt).
     const { data: otpRecord, error: otpError } = await adminClient
       .from("otp_verifications")
-      .select("*")
+      .select("id, otp_code")
       .in("phone", phoneVariants)
-      .eq("otp_code", otp)
       .eq("verified", false)
       .gt("expires_at", new Date().toISOString())
       .order("created_at", { ascending: false })
````

**Removed:** `.select("*")` (read every column) and `.eq("otp_code", otp)` (the guess was part of the database search).
**Added:** `.select("id, otp_code")` (only the two columns needed) and a 2-line comment.
**Why:** with the guess inside the search, a wrong guess found no row, so the code that counts attempts never ran for it. Now the row is found by phone alone (the newest unverified, unexpired code), so every guess, right or wrong, reaches the counter.
**Behavior change:** only the NEWEST live code for a phone is checked. Before, any live code that matched the guess was accepted.

#### Hunk 2 of 3: 17 added, 23 removed

````diff
@@ -103,34 +104,28 @@ Deno.serve(async (req) => {
       .maybeSingle();
 
     if (otpError || !otpRecord) {
-      // Check if expired
-      const { data: expiredRecord } = await adminClient
-        .from("otp_verifications")
-        .select("id")
-        .in("phone", phoneVariants)
-        .eq("otp_code", otp)
-        .eq("verified", false)
-        .lte("expires_at", new Date().toISOString())
-        .limit(1)
-        .maybeSingle();
-
-      if (expiredRecord) {
-        await writeAudit({ phone, outcome: "failed", stage: "otp_verify", reason: "Code expired. Please request a new one." });
-        return new Response(JSON.stringify({ error: "Code expired. Please request a new one." }), {
-          status: 400,
-          headers: { ...corsHeaders, "Content-Type": "application/json" },
-        });
-      }
-
-      await writeAudit({ phone, outcome: "failed", stage: "otp_verify", reason: "Invalid code." });
-      return new Response(JSON.stringify({ error: "Invalid code. Please check and try again." }), {
+      await writeAudit({ phone, outcome: "failed", stage: "otp_verify", reason: "No active code." });
+      return new Response(JSON.stringify({ error: "Code expired or not found. Please request a new one." }), {
         status: 400,
         headers: { ...corsHeaders, "Content-Type": "application/json" },
       });
     }
 
-    // Check attempts
-    if (otpRecord.attempts >= 5) {
+    // Use up one attempt BEFORE comparing, atomically in the database, so a
+    // burst of parallel guesses cannot all read the same old count.
+    const { data: attemptsUsed, error: attemptError } = await adminClient
+      .rpc("register_otp_attempt", { p_otp_id: otpRecord.id });
+
+    // Fail closed: if we cannot count the guess, we do not check it.
+    if (attemptError || attemptsUsed === null) {
+      console.error("[otp-login] register_otp_attempt failed:", attemptError?.message);
+      return new Response(JSON.stringify({ error: "Could not verify code. Please try again." }), {
+        status: 500,
+        headers: { ...corsHeaders, "Content-Type": "application/json" },
+      });
+    }
+
+    if (attemptsUsed > 5) {
       await writeAudit({ phone, outcome: "rejected", stage: "rate_limit", reason: "Too many attempts." });
       return new Response(JSON.stringify({ error: "Too many attempts. Please request a new code." }), {
         status: 429,
````

**Removed:**
- the second database lookup for an expired matching code, and its reply 'Code expired. Please request a new one.';
- the old 'Invalid code' reply that sat inside the not-found branch;
- the check `otpRecord.attempts >= 5`, which read a number that could already be out of date.

**Added:**
- if no live code exists at all: an audit row 'No active code.' and a 400 reply 'Code expired or not found. Please request a new one.' The two old replies merge because we no longer know whether the guess would have matched;
- the atomic counter: `adminClient.rpc("register_otp_attempt", { p_otp_id: otpRecord.id })` asks the database to add 1 to this code's attempts and return the new total in one uninterruptible step (`attemptsUsed`);
- fail closed: if the counter call errors or returns nothing, log it and answer 500 'Could not verify code' WITHOUT checking the guess;
- `if (attemptsUsed > 5)` returns 429. It is `>` not `>=` because the total already includes this guess: guesses 1 to 5 are allowed and the 6th is refused. A correct code sent after the limit is refused too.

**Why:** parallel guesses can no longer all read the same old count. Tested locally: 30 simultaneous wrong guesses gave exactly 5 x 400 and 25 x 429.
**Behavior change:** the expired and invalid messages merge for a missing code; one fewer database read on the failure path.

#### Hunk 3 of 3: 8 added, 5 removed

````diff
@@ -138,11 +133,14 @@ Deno.serve(async (req) => {
       });
     }
 
-    // Increment attempts
-    await adminClient
-      .from("otp_verifications")
-      .update({ attempts: otpRecord.attempts + 1 })
-      .eq("id", otpRecord.id);
+    // Only now compare the guess to the stored code.
+    if (String(otpRecord.otp_code) !== String(otp)) {
+      await writeAudit({ phone, outcome: "failed", stage: "otp_verify", reason: "Invalid code." });
+      return new Response(JSON.stringify({ error: "Invalid code. Please check and try again." }), {
+        status: 400,
+        headers: { ...corsHeaders, "Content-Type": "application/json" },
+      });
+    }
 
     // Mark OTP as verified
     await adminClient
````

**Removed:** the read-then-write increment `update({ attempts: otpRecord.attempts + 1 })`. JavaScript read the old number, added 1 and wrote it back, so parallel requests overwrote each other (measured in a local experiment: 50 guesses recorded as 4).
**Added:** the comparison that used to happen inside the search is now explicit: `String(otpRecord.otp_code) !== String(otp)`. A wrong guess writes an audit row 'Invalid code.' and returns 400 'Invalid code. Please check and try again.' (same wording as before). `String()` on both sides makes the number 123456 and the text '123456' compare equal, which JavaScript's `!==` would not.
**Why it sits here:** it runs AFTER the attempt was counted, so a wrong guess has already used up its try.
**Unchanged below:** marking the code verified, the profile lookup and the magic link.

### `supabase/functions/sms-otp/index.ts`

#### Hunk 1 of 2: 9 added, 6 removed

````diff
@@ -47,13 +47,16 @@ async function userIdFromAuth(
   }
 }
 
+// 6-digit code from the platform's cryptographically secure generator
+// (Math.random is predictable). A draw at or above LIMIT is thrown away and
+// redrawn, so every code from 000000 to 999999 is equally likely.
 function generateOTP(): string {
-  const digits = "0123456789";
-  let otp = "";
-  for (let i = 0; i < 6; i++) {
-    otp += digits[Math.floor(Math.random() * 10)];
-  }
-  return otp;
+  const LIMIT = Math.floor(0x100000000 / 1000000) * 1000000;
+  const buf = new Uint32Array(1);
+  do {
+    crypto.getRandomValues(buf);
+  } while (buf[0] >= LIMIT);
+  return String(buf[0] % 1000000).padStart(6, "0");
 }
 
 // Known country code prefixes (longest first for greedy matching)
````

**Removed:** the loop that picked each digit with `Math.random()`. Math.random is built for games and animations, not secrets; its outputs can be predicted from a few samples.
**Added:** a generator that asks the platform's secure random source, `crypto.getRandomValues`, for a 32-bit number.
- `0x100000000` is 4,294,967,296 (2 to the power 32), how many values a 32-bit number can take.
- `LIMIT = floor(4,294,967,296 / 1,000,000) * 1,000,000 = 4,294,000,000`, the largest multiple of a million that fits.
- the `do ... while (buf[0] >= LIMIT)` loop throws away the rare draw at or above LIMIT and draws again. Without it, small codes would be very slightly more likely than large ones ('modulo bias').
- `buf[0] % 1000000` keeps the last 6 digits, and `String(...).padStart(6, "0")` pads with leading zeros, so 42 becomes 000042.
**Tested:** 300,000 codes from this exact function: all 6 digits, about 10% start with 0, evenly spread.
**Behavior change:** none visible to users; codes just cannot be predicted from earlier codes.

#### Hunk 2 of 2: 11 added, 0 removed

````diff
@@ -845,6 +848,17 @@ Deno.serve(async (req) => {
     }
 
     if (action === "send_custom" || action === "custom") {
+      // Free-text SMS from the WELILE sender. verify_jwt is off for this
+      // function, so anyone could call it; only server-side callers holding the
+      // service-role key (e.g. fraud-cutoff-account) may send arbitrary text.
+      const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
+      if (!bearer || bearer !== supabaseServiceKey) {
+        return new Response(JSON.stringify({ error: "Forbidden" }), {
+          status: 403,
+          headers: { ...corsHeaders, "Content-Type": "application/json" },
+        });
+      }
+
       const message = (body.message as string || "").trim();
       if (!message) {
         return new Response(JSON.stringify({ error: "Message required" }), {
````

**Added (11 lines, nothing removed):** a door check at the start of the `send_custom` / `custom` action.
- `req.headers.get("authorization") || ""` reads the credential sent with the request, or empty text if none;
- `.replace(...)` removes the word 'Bearer' at the start and `.trim()` removes stray spaces, leaving only the key;
- `if (!bearer || bearer !== supabaseServiceKey)` refuses when there is no credential or it is not exactly our server secret (`supabaseServiceKey` is read near the top of the function from the secret environment; browsers never have it);
- the refusal is HTTP 403 'Forbidden'.

**Why:** this function runs with `verify_jwt = false`, so before this anyone holding the public anon key could text anything, from the WELILE sender, to any number.
**Who still works:** server-side callers using the service-role key, such as `fraud-cutoff-account` (via `admin.functions.invoke`), the only caller found in the repo.
**Risk to watch:** production's runtime key differs from the dashboard key (doc 253). An internal call should pass; a caller holding the DASHBOARD key gets 403. After deploy, confirm one fraud notice still sends.

### `supabase/functions/password-reset-sms/index.ts`

#### Hunk 1 of 9: 25 added, 17 removed

````diff
@@ -9,36 +9,44 @@ const corsHeaders = {
   "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
 };
 
-// In-memory rate limiting
-const resetAttempts = new Map<string, { count: number; firstAt: number }>();
+// Durable, database-backed send limits (otp_reserve_send, shared with sms-otp).
+// An in-memory counter resets on every cold start and is not shared between
+// function instances, so it cannot stop someone requesting codes in a loop.
 const MAX_RESETS_PER_HOUR = 3;
+const RESEND_COOLDOWN_SECONDS = 60;
+const MAX_SENDS_PER_IP_HOUR = 10;
+const MAX_SENDS_PER_IP_DAY = 30;
 
-function checkRateLimit(key: string): boolean {
-  const now = Date.now();
-  const record = resetAttempts.get(key);
-  if (!record || now - record.firstAt > 3600000) {
-    resetAttempts.set(key, { count: 1, firstAt: now });
-    return true;
-  }
-  if (record.count >= MAX_RESETS_PER_HOUR) return false;
-  record.count++;
-  return true;
+function clientIpFrom(req: Request): string | null {
+  const raw = req.headers.get("x-forwarded-for") ||
+    req.headers.get("cf-connecting-ip") ||
+    req.headers.get("x-real-ip") ||
+    "";
+  const first = raw.split(",")[0]?.trim();
+  return first || null;
 }
 
 const ADMIN_ACTION_ROLES = ["manager", "super_admin", "cto"];
 
+// Result of requireAdminCaller: either a Response to send straight back
+// (denied), or the signed-in admin's user id (callerId).
+type AdminCheck =
+  | { denied: Response; callerId: null }
+  | { denied: null; callerId: string };
+
 // Admin actions need a real signed-in caller holding an enabled privileged
 // role. verify_jwt is off for this function, so we validate the token here.
-// Returns an error Response, or null when the caller is authorised.
 async function requireAdminCaller(
   // deno-lint-ignore no-explicit-any
   adminClient: any,
   req: Request,
-): Promise<Response | null> {
-  const deny = (status: number, error: string) =>
-    new Response(JSON.stringify({ error }), {
+): Promise<AdminCheck> {
+  const deny = (status: number, error: string): AdminCheck => ({
+    denied: new Response(JSON.stringify({ error }), {
       status, headers: { ...corsHeaders, "Content-Type": "application/json" },
-    });
+    }),
+    callerId: null,
+  });
   const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
   if (!token) return deny(401, "Unauthorized");
   const { data: authData, error: authError } = await adminClient.auth.getUser(token);
````

**Removed:** the in-memory send limiter: the `resetAttempts` Map and the `checkRateLimit` function. A Map lives in one function instance's memory and disappears on every restart, so it could not stop someone requesting codes in a loop.
**Added:**
- constants `RESEND_COOLDOWN_SECONDS = 60`, `MAX_SENDS_PER_IP_HOUR = 10`, `MAX_SENDS_PER_IP_DAY = 30` (the existing `MAX_RESETS_PER_HOUR = 3` is kept, now enforced in the database);
- `clientIpFrom(req)`: reads the caller's IP from the first present header of `x-forwarded-for`, `cf-connecting-ip`, `x-real-ip` and takes the first comma-separated value. Known weakness: that first value can be set by the client;
- `AdminCheck`: a type saying `requireAdminCaller` returns EITHER `{ denied: <Response>, callerId: null }` (refused, send this reply) OR `{ denied: null, callerId: <admin id> }` (allowed, and here is who);
- `requireAdminCaller` now returns that object instead of 'a Response or null'. Its `deny(...)` helper wraps the Response in the same object. The old comment line 'Returns an error Response, or null' is removed.

**Why the callerId:** the audit rows (later hunks) must record WHICH admin acted.
**Behavior change:** none by itself. The checks (token, role lookup, 401 / 403 / 500) are unchanged.

#### Hunk 2 of 9: 46 added, 5 removed

````diff
@@ -52,15 +60,56 @@ async function requireAdminCaller(
     .in("role", ADMIN_ACTION_ROLES);
   if (roleError) return deny(500, "Authorisation check failed");
   if (!roleRows || roleRows.length === 0) return deny(403, "Forbidden");
+  return { denied: null, callerId: caller.id };
+}
+
+const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
+
+// Durable record of a privileged action. audit_logs is append-only in
+// production (triggers block UPDATE, DELETE and TRUNCATE). It is written BEFORE
+// the action and fails closed: if the record cannot be saved, the action is
+// refused. Returns an error Response, or null when the record was saved.
+// NEVER put the new password (or anything secret) in the metadata.
+async function writeAdminAudit(
+  // deno-lint-ignore no-explicit-any
+  adminClient: any,
+  req: Request,
+  callerId: string,
+  actionType: "admin_password_reset" | "admin_delete_user",
+  targetUserId: string,
+  via: string,
+): Promise<Response | null> {
+  const { error } = await adminClient.from("audit_logs").insert({
+    user_id: callerId,
+    actor_id: callerId,
+    target_user_id: targetUserId,
+    action_type: actionType,
+    action: actionType,
+    table_name: "auth.users",
+    record_id: targetUserId,
+    ip_address: clientIpFrom(req),
+    user_agent: req.headers.get("user-agent"),
+    metadata: { function: "password-reset-sms", via },
+  });
+  if (error) {
+    console.error("[password-reset-sms] audit write failed, refusing the action:", error.message);
+    return new Response(JSON.stringify({ error: "Could not record this action. Please try again." }), {
+      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
+    });
+  }
   return null;
 }
 
+// 6-digit code from the platform's cryptographically secure generator
+// (Math.random is predictable). A draw at or above LIMIT is thrown away and
+// redrawn, so every code from 000000 to 999999 is equally likely.
 function generateOTP(): string {
-  let otp = "";
-  for (let i = 0; i < 6; i++) {
-    otp += Math.floor(Math.random() * 10).toString();
-  }
-  return otp;
+  const LIMIT = Math.floor(0x100000000 / 1000000) * 1000000;
+  const buf = new Uint32Array(1);
+  do {
+    crypto.getRandomValues(buf);
+  } while (buf[0] >= LIMIT);
+  return String(buf[0] % 1000000).padStart(6, "0");
 }
 
 // Known country code prefixes (longest first for greedy matching)
````

**Added at the end of `requireAdminCaller`:** `return { denied: null, callerId: caller.id }`. Success now says who the caller is; before it returned `null`.
**Added:** `UUID_RE`, a pattern that matches only a well-formed user id (8-4-4-4-12 hex characters), used to reject garbage ids before they reach the database.
**Added:** `writeAdminAudit(...)`, which saves one row in `audit_logs`:
- `user_id` and `actor_id` = the admin; `target_user_id` and `record_id` = the person acted on; `action_type` and `action` = 'admin_password_reset' or 'admin_delete_user'; `table_name` = 'auth.users'; `ip_address` and `user_agent` from the request; `metadata` = which function and which action name (`via`);
- if the insert fails it logs and returns a 500 'Could not record this action', which makes the caller REFUSE the action (fail closed); on success it returns `null`;
- rule in its comment: never put the new password or any secret in the metadata. Tested: the password appears in no field;
- in production `audit_logs` is append-only (triggers block UPDATE, DELETE and TRUNCATE).

**Replaced:** `generateOTP`, the same change as in `sms-otp` (see that file's first hunk): the `Math.random` loop is replaced by the secure generator with rejection sampling.

#### Hunk 3 of 9: 6 added, 3 removed

````diff
@@ -373,15 +422,18 @@ Deno.serve(async (req) => {
       const userId = (body.user_id as string || "").trim();
       const newPassword = (body.new_password as string || "").trim();
 
-      const denied = await requireAdminCaller(adminClient, req);
-      if (denied) return denied;
+      const check = await requireAdminCaller(adminClient, req);
+      if (check.denied) return check.denied;
 
-      if (!userId || !newPassword || newPassword.length < 6) {
+      if (!UUID_RE.test(userId) || !newPassword || newPassword.length < 6) {
         return new Response(JSON.stringify({ error: "user_id and new_password (min 6 chars) required" }), {
           status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
         });
       }
 
+      const auditFailed = await writeAdminAudit(adminClient, req, check.callerId, "admin_password_reset", userId, "admin_reset");
+      if (auditFailed) return auditFailed;
+
       const { error: updateError } = await adminClient.auth.admin.updateUserById(userId, {
         password: newPassword,
         email_confirm: true,
````

**Action `admin_reset`.**
**Removed:** `const denied = await requireAdminCaller(...)` / `if (denied) return denied;` and the check `!userId`.
**Added:**
- `const check = await requireAdminCaller(...)` / `if (check.denied) return check.denied;` (the same refusal in the new shape);
- `!UUID_RE.test(userId)` replaces `!userId`: the id must be a real UUID, otherwise 400 with the same message as before;
- `writeAdminAudit(..., "admin_password_reset", userId, "admin_reset")` BEFORE the password is changed. If saving the row fails, the reset does not happen.

**Unchanged below:** the actual password update (`auth.admin.updateUserById`).
**Behavior change:** an id that is not a UUID now gets 400 (it would previously have failed later inside the auth service).

#### Hunk 4 of 9: 6 added, 3 removed

````diff
@@ -404,15 +456,18 @@ Deno.serve(async (req) => {
       const userId = (body.user_id as string || "").trim();
       const newPassword = (body.new_password as string || "").trim();
 
-      const denied = await requireAdminCaller(adminClient, req);
-      if (denied) return denied;
+      const check = await requireAdminCaller(adminClient, req);
+      if (check.denied) return check.denied;
 
-      if (!userId || !newPassword || newPassword.length < 6) {
+      if (!UUID_RE.test(userId) || !newPassword || newPassword.length < 6) {
         return new Response(JSON.stringify({ error: "user_id and new_password required" }), {
           status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
         });
       }
 
+      const auditFailed = await writeAdminAudit(adminClient, req, check.callerId, "admin_password_reset", userId, "admin_reset_password");
+      if (auditFailed) return auditFailed;
+
       const { error: resetError } = await adminClient.auth.admin.updateUserById(userId, {
         password: newPassword,
         email_confirm: true,
````

**Action `admin_reset_password`** (a second, older-named route to the same capability).
**Removed / Added:** the same three changes as the previous hunk: `denied` becomes `check`, `!userId` becomes `!UUID_RE.test(userId)`, and an audit row (`via` = 'admin_reset_password') is written before the password changes.
**Why both:** both routes set another person's password, so both must leave a record.

#### Hunk 5 of 9: 6 added, 3 removed

````diff
@@ -433,15 +488,18 @@ Deno.serve(async (req) => {
     if (action === "admin_delete_user") {
       const userId = (body.user_id as string || "").trim();
 
-      const denied = await requireAdminCaller(adminClient, req);
-      if (denied) return denied;
+      const check = await requireAdminCaller(adminClient, req);
+      if (check.denied) return check.denied;
 
-      if (!userId) {
+      if (!UUID_RE.test(userId)) {
         return new Response(JSON.stringify({ error: "user_id required" }), {
           status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
         });
       }
 
+      const auditFailed = await writeAdminAudit(adminClient, req, check.callerId, "admin_delete_user", userId, "admin_delete_user");
+      if (auditFailed) return auditFailed;
+
       const { error: deleteError } = await adminClient.auth.admin.deleteUser(userId);
       if (deleteError) {
         console.error("[password-reset-sms] Admin delete error:", deleteError);
````

**Action `admin_delete_user`.**
**Removed:** `denied` handling and the check `!userId`.
**Added:** `check` handling, `!UUID_RE.test(userId)` (400 'user_id required' if not a UUID), and an audit row with `action_type` 'admin_delete_user' written BEFORE the user is deleted.
**Why before:** a deletion cannot be undone, so the record must exist even if the function dies right after. If the row cannot be saved, the user is NOT deleted.

#### Hunk 6 of 9: 0 added, 6 removed

````diff
@@ -457,12 +515,6 @@ Deno.serve(async (req) => {
     }
 
     if (action === "send") {
-      if (!checkRateLimit(phoneKey)) {
-        return new Response(JSON.stringify({ error: "Too many reset requests. Please try again later." }), {
-          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
-        });
-      }
-
       // Verify user exists
       const { data: profile } = await adminClient
         .from("profiles")
````

**Removed (6 lines):** at the start of `send`, the call `checkRateLimit(phoneKey)` and its 429 reply 'Too many reset requests. Please try again later.'
**Why:** the in-memory limiter is gone. The same limits now come from the database in the next hunk (3 per phone per hour, a 60-second cooldown, per-IP caps), with the same 429 status but the database's own wording.

#### Hunk 7 of 9: 35 added, 35 removed

````diff
@@ -471,57 +523,57 @@ Deno.serve(async (req) => {
         .limit(1)
         .maybeSingle();
 
+      // Do not reveal whether this phone has an account: answer exactly as if a
+      // code had been sent, but send nothing and store nothing.
       if (!profile) {
-        return new Response(JSON.stringify({ error: "No account found with this phone number." }), {
-          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
+        console.log(`[password-reset-sms] reset requested for an unregistered number ***${phoneKey.slice(-4)}`);
+        return new Response(JSON.stringify({ success: true, message: "Reset code sent" }), {
+          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
         });
       }
 
+      // Reset codes live in otp_verifications under a reset-specific phone key.
       const resetKey = `reset_${phoneKey}`;
-      const now = Date.now();
+      // Previous send's provider, read only to choose the SMS route (not a limit check).
       const { data: existingReset } = await adminClient
         .from("otp_verifications")
-        .select("otp_code, expires_at, verified, send_status, send_status_reason")
+        .select("send_status, send_status_reason")
         .eq("phone", resetKey)
         .maybeSingle();
 
-      // Password reset SMS can also arrive late/out of order. Reuse a still-valid
-      // reset code so every SMS currently on the user's phone contains a working
-      // code, then rotate provider if the previous accepted route didn't reach
-      // the handset.
-      const existingCodeUsable =
-        !!existingReset?.otp_code &&
-        existingReset?.verified === false &&
-        !!existingReset?.expires_at &&
-        new Date(existingReset.expires_at).getTime() > now;
-      const otp = existingCodeUsable ? existingReset!.otp_code as string : generateOTP();
-      const expiresAt = existingCodeUsable
-        ? existingReset!.expires_at as string
-        : new Date(now + 60 * 60 * 1000).toISOString();
-
-      // Store OTP using otp_verifications table with a reset-specific phone key
-      const { error: upsertError } = await adminClient
-        .from("otp_verifications")
-        .upsert({
-          phone: resetKey,
-          otp_code: otp,
-          expires_at: expiresAt,
-          attempts: 0,
-          verified: false,
-          send_status: "pending",
-          send_status_reason: null,
-          send_status_at: new Date(now).toISOString(),
-        }, { onConflict: "phone" });
-
-      if (upsertError) {
-        console.error("[password-reset-sms] Upsert error:", upsertError);
+      // Every send limit is checked and counted in ONE locked database step, so
+      // simultaneous requests cannot all slip under a cap. Password reset SMS can
+      // arrive late/out of order, so a still-valid code is reused (every SMS on
+      // the handset keeps working) WITHOUT resetting its wrong-try count; only a
+      // brand-new code starts at zero tries.
+      const { data: reserve, error: reserveError } = await adminClient.rpc("otp_reserve_send", {
+        p_phone: resetKey,
+        p_user_id: null,
+        p_ip: clientIpFrom(req),
+        p_new_code: generateOTP(),
+        p_ttl_seconds: 3600,
+        p_cooldown_seconds: RESEND_COOLDOWN_SECONDS,
+        p_max_phone_hour: MAX_RESETS_PER_HOUR,
+        p_max_user_hour: MAX_RESETS_PER_HOUR,
+        p_max_user_day: MAX_RESETS_PER_HOUR * 3,
+        p_max_ip_hour: MAX_SENDS_PER_IP_HOUR,
+        p_max_ip_day: MAX_SENDS_PER_IP_DAY,
+      });
+      if (reserveError || !reserve) {
+        console.error("[password-reset-sms] reserve error:", reserveError);
         return new Response(JSON.stringify({ error: "Failed to generate reset code" }), {
           status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
         });
       }
+      if (!reserve.ok) {
+        return new Response(JSON.stringify({ error: reserve.error, retry_after: reserve.retry_after }), {
+          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
+        });
+      }
+      const otp = String(reserve.otp);
 
       const message = `Welile reset code: ${otp}. Expires in 1 hour. Never share this code.`;
-      const preferBackupRoute = existingCodeUsable && existingReset?.send_status === "accepted";
+      const preferBackupRoute = reserve.reused === true && existingReset?.send_status === "accepted";
       if (preferBackupRoute) {
         console.log(`[password-reset-sms] resend for ***${phoneKey.slice(-4)} rotating to backup SMS route first`);
       }
````

**The core of the `send` action.**

**1. Unknown number (added, replaces the 404):** `if (!profile)` now logs the last 4 digits and returns `200 { success: true, message: "Reset code sent" }`, the same reply a registered number gets. Nothing is sent and nothing is stored (tested: 0 rows and 0 send events). **Removed:** the 404 'No account found with this phone number.', which let anyone test which phones have accounts.

**2. Removed:** the code that built the reset code itself: `const now = Date.now()`; the `existingCodeUsable` check (is there a valid unverified code?); choosing between the old code and `generateOTP()`; computing `expiresAt`; and the `upsert` that wrote the row with `attempts: 0`, plus its error reply. That upsert is what reset the wrong-guess counter on every resend. The select of the previous row is narrowed to the two columns still needed (`send_status`, `send_status_reason`, only to choose the SMS route).

**3. Added:** one database call, `otp_reserve_send`, which does ALL of it in one locked step (so simultaneous requests cannot all slip under a cap):
| parameter | value | meaning |
|---|---|---|
| `p_phone` | `reset_<last 9 digits>` | the reset code's own row key |
| `p_user_id` | `null` | caller is not signed in |
| `p_ip` | `clientIpFrom(req)` | for the per-IP caps |
| `p_new_code` | `generateOTP()` | used only if no valid code exists |
| `p_ttl_seconds` | `3600` | code lifetime, 1 hour (unchanged) |
| `p_cooldown_seconds` | `60` | minimum gap between sends |
| `p_max_phone_hour` | `3` | per phone per hour (unchanged policy) |
| `p_max_user_hour` / `p_max_user_day` | `3` / `9` | unused here (no user id) |
| `p_max_ip_hour` / `p_max_ip_day` | `10` / `30` | per-IP caps |

The database reuses a still-valid code WITHOUT resetting its wrong-try count; only a brand-new code starts at zero.
- `reserveError || !reserve` returns 500 'Failed to generate reset code' (the old wording);
- `!reserve.ok` returns 429 with the database's message and `retry_after`;
- `const otp = String(reserve.otp)` is the code to text.

**4. Changed:** `preferBackupRoute` now uses `reserve.reused === true` instead of the removed `existingCodeUsable` (the value is currently ignored by `sendSMS`, as before).

**Behavior changes:** a person locked out by 5 wrong tries stays locked on that code until it expires (up to 1 hour); sends are capped per IP and shared with `sms-otp`; an unknown number sees 'Reset code sent'.

#### Hunk 8 of 9: 21 added, 6 removed

````diff
@@ -585,22 +637,37 @@ Deno.serve(async (req) => {
           status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
         });
       }
+      // A code that has already reset a password is single-use.
+      if (otpRecord.verified) {
+        return new Response(JSON.stringify({ error: "Reset code has expired or was already used. Please request a new one." }), {
+          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
+        });
+      }
       if (new Date(otpRecord.expires_at) < new Date()) {
         return new Response(JSON.stringify({ error: "Reset code has expired. Please request a new one." }), {
           status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
         });
       }
-      if (otpRecord.attempts >= 5) {
+
+      // Use up one attempt BEFORE comparing, atomically in the database, so a
+      // burst of parallel guesses cannot all read the same old count
+      // (register_otp_attempt, doc 251). Every guess is counted, right or wrong.
+      const { data: attemptsUsed, error: attemptError } = await adminClient
+        .rpc("register_otp_attempt", { p_otp_id: otpRecord.id });
+      // Fail closed: if we cannot count the guess, we do not check it.
+      if (attemptError || attemptsUsed === null) {
+        console.error("[password-reset-sms] register_otp_attempt failed:", attemptError?.message);
+        return new Response(JSON.stringify({ error: "Could not verify code. Please try again." }), {
+          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
+        });
+      }
+      if (attemptsUsed > 5) {
         return new Response(JSON.stringify({ error: "Too many failed attempts. Please request a new code." }), {
           status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
         });
       }
       if (otpCode !== otpRecord.otp_code) {
-        await adminClient
-          .from("otp_verifications")
-          .update({ attempts: otpRecord.attempts + 1 })
-          .eq("phone", resetKey);
-        const remaining = Math.max(0, 4 - otpRecord.attempts);
+        const remaining = Math.max(0, 5 - attemptsUsed);
         return new Response(JSON.stringify({ error: `Invalid code. ${remaining} attempts remaining.` }), {
           status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
         });
````

**The `verify` action (the pre-check the screen calls before asking for a new password).**
**Added:** a refusal for a code whose row is already `verified` ('Reset code has expired or was already used'). The word 'expired' is kept on purpose: `useAuthForm.ts` sends the person back to the code step when the error contains it.
**Added:** the atomic attempt counter (`register_otp_attempt`), a fail-closed 500 if it errors, and `attemptsUsed > 5` returning 429.
**Removed:** `if (otpRecord.attempts >= 5)` (stale read) and the read-then-write `update({ attempts: otpRecord.attempts + 1 })`.
**Changed:** `remaining` is now `Math.max(0, 5 - attemptsUsed)`. It was `Math.max(0, 4 - otpRecord.attempts)`, computed from the stale number; both give 4 after the first wrong guess.
**Behavior change:** this pre-check now uses an attempt too, so the happy path costs 2 tries (this check, then `verify-and-reset`).

#### Hunk 9 of 9: 23 added, 6 removed

````diff
@@ -638,25 +705,42 @@ Deno.serve(async (req) => {
         });
       }
 
+      // A code that has already reset a password is single-use.
+      if (otpRecord.verified) {
+        return new Response(JSON.stringify({ error: "Reset code has expired or was already used. Please request a new one." }), {
+          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
+        });
+      }
+
       if (new Date(otpRecord.expires_at) < new Date()) {
         return new Response(JSON.stringify({ error: "Reset code has expired. Please request a new one." }), {
           status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
         });
       }
 
-      if (otpRecord.attempts >= 5) {
+      // Use up one attempt BEFORE comparing, atomically in the database, so a
+      // burst of parallel guesses cannot all read the same old count. This is
+      // the gate in front of "set a new password on every account for this
+      // phone", so it must hold under load (register_otp_attempt, doc 251).
+      const { data: attemptsUsed, error: attemptError } = await adminClient
+        .rpc("register_otp_attempt", { p_otp_id: otpRecord.id });
+      // Fail closed: if we cannot count the guess, we do not check it.
+      if (attemptError || attemptsUsed === null) {
+        console.error("[password-reset-sms] register_otp_attempt failed:", attemptError?.message);
+        return new Response(JSON.stringify({ error: "Could not verify code. Please try again." }), {
+          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
+        });
+      }
+
+      if (attemptsUsed > 5) {
         return new Response(JSON.stringify({ error: "Too many failed attempts. Please request a new code." }), {
           status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
         });
       }
 
       if (otpCode !== otpRecord.otp_code) {
-        await adminClient
-          .from("otp_verifications")
-          .update({ attempts: otpRecord.attempts + 1 })
-          .eq("phone", resetKey);
         await logOtpUsage(adminClient, "password_reset", "verify_failed", phoneKey, "password-reset-sms");
-        const remaining = 4 - otpRecord.attempts;
+        const remaining = Math.max(0, 5 - attemptsUsed);
         return new Response(JSON.stringify({ error: `Invalid code. ${remaining} attempts remaining.` }), {
           status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
         });
````

**The `verify-and-reset` action: the one that sets a new password on EVERY account tied to the phone.** This is the highest-risk hunk in the change.
**Added:** the same three protections as the previous hunk: refuse a code already `verified` (single use: a code that has reset a password cannot reset it again), count the attempt atomically BEFORE comparing (`register_otp_attempt`, fail closed with a 500), `attemptsUsed > 5` returns 429.
**Removed:** the stale `attempts >= 5` check and the read-then-write increment. The usage log line `logOtpUsage(..., "verify_failed", ...)` is kept.
**Changed:** `remaining` = `Math.max(0, 5 - attemptsUsed)`. It was `4 - otpRecord.attempts` (from the stale number, with no floor at 0).
**Tested locally:** 30 simultaneous wrong guesses = 5 x 400 + 25 x 429, and the correct code afterwards is refused; a used code is refused and the password does not change; with the counter function removed the right code gets 500 and the password does not change.

### `supabase/migrations/20261102090000_register_otp_attempt.sql`

#### Hunk 1 of 1: 18 added, 0 removed

````diff
@@ -0,0 +1,18 @@
+-- Atomic OTP guess counter for the otp-login edge function.
+-- Already run by hand in the production SQL editor on 2026-11-02; this file
+-- records it. CREATE OR REPLACE and re-granting make it safe to run again.
+
+create or replace function public.register_otp_attempt(p_otp_id uuid)
+returns integer
+language sql
+security definer
+set search_path = public
+as $$
+  update otp_verifications
+  set attempts = attempts + 1
+  where id = p_otp_id
+  returning attempts;
+$$;
+
+revoke all on function public.register_otp_attempt(uuid) from public, anon, authenticated;
+grant execute on function public.register_otp_attempt(uuid) to service_role;
````

**New file (18 lines).** Already run by hand in the production SQL editor on 2026-11-02; this file records it, and `create or replace` plus re-granting make running it again safe.
- `create or replace function public.register_otp_attempt(p_otp_id uuid)` makes the function; it takes one input, the id of the code row (`p_` just means parameter);
- `returns integer` hands back one whole number: the new attempt total;
- `language sql` means it is plain SQL;
- `security definer` runs it with its owner's powers, which is why who may call it is locked down below;
- `set search_path = public` pins which schema names resolve, so an attacker cannot swap in a fake table;
- `update otp_verifications set attempts = attempts + 1 where id = p_otp_id returning attempts` is the atomic add: the database reads, adds and saves in one uninterruptible step, and `returning` gives back the new total;
- `revoke all ... from public, anon, authenticated` removes everyone's right to call it;
- `grant execute ... to service_role` lets only our server code (the edge functions' admin key) call it.
**Verified in production (read-only queries):** `service_role` true, `anon` false, `authenticated` false; `otp_verifications.id` is uuid; `attempts` is NOT NULL DEFAULT 0.

### `supabase/migrations/20261102090000_register_otp_attempt.rollback.sql`

#### Hunk 1 of 1: 1 added, 0 removed

````diff
@@ -0,0 +1 @@
+drop function if exists public.register_otp_attempt(uuid);
````

**New file (1 line):** `drop function if exists public.register_otp_attempt(uuid);` undoes the migration. Do not run it while `otp-login` or `password-reset-sms` are deployed, because they would then fail closed (500) for every code check.

### `src/pages/Auth.tsx`

#### Hunk 1 of 2: 1 added, 1 removed

````diff
@@ -995,7 +995,7 @@ export default function Auth() {
                     {resetStep === 'phone' ? (<><Key className="h-4 w-4 text-primary" /> Reset Your Password</>) : resetStep === 'otp' ? (<><Smartphone className="h-4 w-4 text-primary" /> Enter SMS Code</>) : (<><Lock className="h-4 w-4 text-primary" /> Create New Password</>)}
                   </p>
                   <p className="text-sm text-muted-foreground mt-1">
-                    {resetStep === 'phone' ? (resetMethod === 'email' ? 'Enter your email and we\'ll send you a reset link' : 'Enter your phone number and we\'ll send you a code via SMS') : resetStep === 'otp' ? `We sent a 6-digit code to ${resetPhone || 'your phone'}` : 'Choose a strong password you\'ll remember'}
+                    {resetStep === 'phone' ? (resetMethod === 'email' ? 'Enter your email and we\'ll send you a reset link' : 'Enter your phone number and we\'ll send you a code via SMS') : resetStep === 'otp' ? `If an account exists for ${resetPhone || 'that number'}, a 6-digit code is on its way.` : 'Choose a strong password you\'ll remember'}
                   </p>
                 </div>
 
````

**One line changed (a text string, no markup):** the subtitle on the 'Enter SMS Code' step of the password-reset screen.
**Removed:** 'We sent a 6-digit code to {number}'.
**Added:** 'If an account exists for {number}, a 6-digit code is on its way.' (and 'that number' if no number is set, instead of 'your phone').
**Why:** the server now gives the same reply for numbers that have no account, so the screen must not promise that a text was sent.

#### Hunk 2 of 2: 1 added, 1 removed

````diff
@@ -1085,7 +1085,7 @@ export default function Auth() {
                   className="w-full text-sm text-muted-foreground hover:text-primary text-center flex items-center justify-center gap-1 py-2"
                 >
                   <ArrowLeft className="h-4 w-4" />
-                  {resetStep !== 'phone' ? 'Go Back' : 'Back to Sign In'}
+                  {resetStep === 'otp' ? 'Wrong number? Go back' : resetStep !== 'phone' ? 'Go Back' : 'Back to Sign In'}
                 </button>
               </div>
             )}
````

**One line changed (a text string):** the back button label under the reset form.
**Removed:** `resetStep !== 'phone' ? 'Go Back' : 'Back to Sign In'`.
**Added:** a new first case, `resetStep === 'otp' ? 'Wrong number? Go back'`, then the same two labels as before. Only the code step changes; the button's behavior (return to the phone step with the number kept) is the existing code and was not touched.

### `src/hooks/useAuthForm.ts`

#### Hunk 1 of 1: 1 added, 1 removed

````diff
@@ -352,7 +352,7 @@ export function useAuthForm() {
         if (!response.ok) {
           toast({ title: 'Error', description: data.error || 'Failed to send reset code', variant: 'destructive' });
         } else {
-          toast({ title: 'Code Sent', description: 'Check your phone for the reset code' });
+          toast({ title: 'Check your phone', description: 'If that number has an account, a reset code is on its way.' });
           setResetStep('otp');
         }
       } catch {
````

**One line changed (a text string):** the toast shown after asking for a reset code.
**Removed:** title 'Code Sent', description 'Check your phone for the reset code'.
**Added:** title 'Check your phone', description 'If that number has an account, a reset code is on its way.'
**Why:** same reason as `Auth.tsx`. The separate 'Code Sent!' toast in `Auth.tsx` for phone login is a different flow and is untouched.

## Documentation lines (added; nothing removed)

- `docs/HANDOVER/251-...md`, `255-...md`, `256-...md` are whole new files; their content is the explanation of each problem, change and test. Read the files themselves.
- `docs/HANDOVER/README.md` and `architecture-map.html` each gain rows describing docs 251, 255 and 256 and map traps 43, 44 and 45. The exact added lines:

`docs/HANDOVER/README.md` (3 lines added):

````diff
+| [`251-otp-login-wrong-guesses-were-never-counted-2026-11-02.md`](./251-otp-login-wrong-guesses-were-never-counted-2026-11-02.md) | **COMMITTED ON `dev/otp-attempt-limits`, NOT PUSHED; `register_otp_attempt` ALREADY LIVE IN PRODUCTION (inert until `otp-login` is deployed).** `otp-login` only counted attempts for an already-correct code, so wrong guesses were unlimited. New atomic `register_otp_attempt` RPC (service_role only, migration `20261102090000`) is burned before the comparison; more than 5 returns 429. Tested locally. Per-phone/IP lockout across codes not done. |
+| [`255-sms-otp-send-custom-open-relay-gated-2026-11-02.md`](./255-sms-otp-send-custom-open-relay-gated-2026-11-02.md) | **COMMITTED ON `dev/otp-attempt-limits`, NOT PUSHED, NOT DEPLOYED.** `sms-otp` (verify_jwt off) let anyone send arbitrary SMS as WELILE through `send_custom`; it now requires the service-role key. Tested locally. Risk: production runtime key differs from the dashboard key (doc 253), so confirm one fraud notice still sends after deploy. `verify` and send-limit races were already fixed upstream (`otp_check_code`, `otp_reserve_send`); `already_verified`, plaintext codes, `Math.random`, spoofable IP cap still open. |
+| [`256-password-reset-sms-code-guessing-and-reuse-2026-11-03.md`](./256-password-reset-sms-code-guessing-and-reuse-2026-11-03.md) | **COMMITTED ON `dev/otp-attempt-limits`, NOT PUSHED, NOT DEPLOYED.** `password-reset-sms` `verify-and-reset` sets a new password on every account for a phone once the 6-digit code matches, but guesses were effectively unlimited (racy read-then-write counter, in-memory send limit, `send` reset the counter on a reused code) and a used code worked again. Now counts atomically before comparing (`register_otp_attempt`), refuses a used code, and sends through the durable `otp_reserve_send`. Tested locally (30-guess burst = 5 x 400 + 25 x 429). **Deploy only after confirming `otp_reserve_send` and `register_otp_attempt` exist in production.** Follow-up same day (tested locally, not deployed): codes now come from `crypto.getRandomValues` (also in `sms-otp`), an unknown number on `send` no longer reveals that it has no account (the code-step wording in Auth.tsx and the toast in useAuthForm.ts were updated to match; no markup touched, not visually checked), and admin reset/delete write fail-closed audit rows. Open: 6-character passwords, one reset covers every account on a phone. |
````

`docs/HANDOVER/architecture-map.html` (3 lines added):

````diff
+              <li><strong>Trap 45: password reset code could be guessed and reused (doc 256):</strong> <code>password-reset-sms</code> <code>verify-and-reset</code> sets a new password on every account tied to a phone once the 6-digit code matches. Guesses were effectively unlimited (read-then-write counter, in-memory send limit that resets on cold start, <code>send</code> reset <code>attempts</code> on a reused code) and a used code was never marked unusable. It now counts through <code>register_otp_attempt</code> before comparing, refuses a used code, and sends through <code>otp_reserve_send</code>. Tested locally, not deployed. Both database functions it needs (<code>register_otp_attempt</code>, <code>otp_reserve_send</code>) were confirmed present and service_role-only in production on 2026-11-03. Same day follow-up (tested locally, not deployed): codes use <code>crypto.getRandomValues</code> (also in sms-otp); an unknown number on <code>send</code> gets the same reply as a registered one (a mistyped number now sees "Code sent" and never gets a text; the code-step subtitle, back button (now "Wrong number? Go back") and toast were reworded to match, in Auth.tsx and useAuthForm.ts); admin reset and delete write fail-closed <code>audit_logs</code> rows before acting. Still open: 6-character passwords, one reset covers every account on a phone.</li>
+              <li><strong>Trap 44: sms-otp <code>send_custom</code> was an open SMS relay (doc 255):</strong> <code>sms-otp</code> runs with <code>verify_jwt = false</code> and its <code>send_custom</code> action had no caller check, so anyone with the public anon key could text any number as WELILE. It now requires the service-role key (the only legitimate caller, <code>fraud-cutoff-account</code>, uses it). Tested locally, not deployed; production's runtime key differs from the dashboard key (doc 253), so confirm one fraud notice still sends after deploy. The <code>verify</code> and send-limit races were already fixed upstream (<code>otp_check_code</code>, <code>otp_reserve_send</code>). Still open: <code>already_verified</code> success without a code, plaintext codes (also in <code>sms_delivery_log</code>), spoofable per-IP cap (<code>Math.random</code> codes fixed 11-03).</li>
+              <li><strong>Trap 43: otp-login only counted guesses for a correct code (doc 251):</strong> the code was looked up with <code>otp_code = guess</code>, so a wrong guess found no row and never touched <code>attempts</code>; the 5-attempt limit never stopped guessing. <code>register_otp_attempt</code> (service_role only) now burns an attempt atomically before the comparison. Function live in production 11-02; edge change not yet deployed.</li>
````

(This ledger, doc 257, and its own README and map mention were added after the totals above were taken and are not counted in them.)

## Behavior changes, in one list (what a user or support person can notice)

1. **Login by SMS code (`otp-login`):** 5 wrong guesses lock that code; the 6th guess and anything after, even the correct code, gets 429 until a new code is requested. Only the newest live code for a phone is checked. A missing or expired code now says 'Code expired or not found'.
2. **Password reset by SMS (`password-reset-sms`):** the code is single-use; 5 wrong tries lock it until it expires (up to 1 hour); the pre-check and the final reset each use one try; sending is limited to 3 per phone per hour with a 60-second gap and per-IP caps.
3. **Unknown number on 'send reset code':** the reply is now identical to a successful send. Nothing is sent. A person who mistypes their number sees 'If an account exists...' and the back button reads 'Wrong number? Go back'.
4. **Admin password reset and user delete:** each writes an audit row first and is refused if the row cannot be saved; the user id must be a valid UUID.
5. **Free-text SMS (`send_custom`):** works only for server code holding the service-role key; everyone else gets 403.
6. **All SMS codes** (login and reset) now come from a cryptographically secure generator.

## What is NOT changed

`sms-otp` send and verify logic (already fixed upstream by `otp_check_code` and `otp_reserve_send`), the frontend's reset flow and layout, who may be an admin, password length rules (6 characters are still accepted), the 'reset every account on a phone' behavior, SMS provider selection, and every other edge function.

## Evidence (what was actually run) and its limits

- Throwaway local Supabase, the real unmodified function files, fake data: 30 simultaneous wrong guesses = exactly 5 x 400 + 25 x 429 for `otp-login`, `sms-otp` (earlier draft, since dropped) and `password-reset-sms`; used reset code refused with the password unchanged; 8 simultaneous sends = 1 sent + 7 refused; counter function removed = 500 and no password change; admin routes: no token 401, non-admin 403, manager 200 with a correct audit row, audit table down = 500 and password unchanged; unknown number = 200 with 0 rows and 0 events; 300,000 generated codes per file valid and evenly spread; `guard:all` passes; TypeScript syntax check 0 errors on all five code files.
- Read-only queries on production confirmed `register_otp_attempt`, `otp_reserve_send` and `otp_check_code` exist and are executable by `service_role` only, and that `otp_verifications` and `otp_send_events` have the columns they write.
- **Test caveat:** the `send_custom` gate was tested against the copy of `sms-otp` from before Lovable's refactor; the 11 added lines are identical in the current file, but the gate has not been run against the current file.
- **Not proven:** nothing has run in production; the migrations' behavior there is assumed identical to the files tested; the production append-only and IP triggers on `audit_logs` were imitated, not run; no browser or visual test of the reset screen; the merged tree (160+ upstream commits) has not been type-checked or built; callers outside this repo are unknown; the `send_custom` gate has a key-mismatch risk (doc 253) to check after deploy.

## Rollback, per change

| Change | How to undo |
|---|---|
| `otp-login`, `sms-otp`, `password-reset-sms` | redeploy the previous version of the function (the database function can stay); or `git revert` the commit and redeploy |
| Migration | run the rollback file only AFTER the functions above are rolled back, otherwise they fail closed (500) |
| Wording in `Auth.tsx` / `useAuthForm.ts` | `git revert` the commit `copy(auth): reset-code screen...` |

## Open items (found, not fixed here)

`already_verified` success without a code in `sms-otp` (upstream `otp_check_code`); codes stored in plaintext in `otp_verifications.otp_code` and `sms_delivery_log.message` (`sms-otp`); per-IP caps trust a client-settable header; 6-character passwords accepted; one reset covers every account on a phone and sets `email_confirm`; timing still reveals registered numbers on reset send; `otp-login` and sign-up may reveal registration.

_Generated from git by a script; 19 code hunks, +238 / -123 code lines, all matching `git diff --numstat`._
