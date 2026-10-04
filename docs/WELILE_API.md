# Welile API — v1

The Welile API is a versioned REST interface consumed by the Welile Flutter
application. It is implemented as a single Supabase Edge Function that routes on
the request path and returns a stable JSON envelope on every call.

---

## Base URL

| Environment | Base URL |
|-------------|----------|
| Production (custom domain) | `https://api.welileapp.com` |
| Direct edge URL | `https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/api` |

All routes are prefixed with `/api/v1`. The router anchors on the `/v1`
segment, so both base URLs resolve the same routes:

```
POST https://api.welileapp.com/api/v1/auth/login
POST https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/api/api/v1/auth/login
```

### Connecting the `api.welileapp.com` custom domain

The function is live at the direct edge URL today. To serve it at
`api.welileapp.com`, point that subdomain at the edge function with a reverse
proxy / CDN rule (e.g. a Cloudflare Worker or a CNAME + rewrite) that forwards
`https://api.welileapp.com/api/v1/*` to
`https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/api/api/v1/*` and
injects the Supabase `apikey` header. Until that DNS/proxy is in place, point
the Flutter client's base URL at the direct edge URL.

---

## Authentication

1. `POST /api/v1/auth/login` with a **phone or email** + password.
2. Store the returned `access_token` (a Supabase JWT) and `refresh_token`.
3. Send `Authorization: Bearer <access_token>` on every other request.

When calling the **direct edge URL**, also send the Supabase anon key as an
`apikey` header (the custom-domain proxy injects this for you):

```
apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...  (public anon key)
```

Tokens expire (see `expires_in`). Refresh them against Supabase Auth:
`POST https://wirntoujqoyjobfhyelc.supabase.co/auth/v1/token?grant_type=refresh_token`
with body `{ "refresh_token": "<refresh_token>" }` and the `apikey` header.

---

## Response envelope

Every endpoint returns:

```json
{
  "status": "success" | "error",
  "message": "human-readable summary",
  "data": { ... } | null
}
```

HTTP status codes: `200` OK, `201` Created, `400` bad input,
`401` unauthenticated, `404` unknown route, `500` server error.
All amounts are integers in **UGX** (Ugandan Shillings).

---

## Endpoints

### 1. Health — `GET /api/v1/health` (public)

```json
{ "status": "success", "message": "Welile API is running",
  "data": { "name": "Welile API", "version": "v1", "status": "healthy" } }
```

### 2. Login — `POST /api/v1/auth/login` (public)

Request body (provide **either** `phone` or `email`):

```json
{ "phone": "0701355245", "password": "********" }
```

Response `200`:

```json
{
  "status": "success",
  "message": "Login successful",
  "data": {
    "access_token": "eyJhbGci...",
    "refresh_token": "v1.Mr8...",
    "token_type": "bearer",
    "expires_at": 1783728357,
    "expires_in": 3600,
    "user": {
      "id": "0b109aad-...",
      "email": "user@example.com",
      "full_name": "SSENKAALI PIUS",
      "phone": "+256701355245",
      "avatar_url": null,
      "roles": ["agent"]
    }
  }
}
```

Errors: `401 No account found for that phone or email`,
`401 Invalid phone/email or password`.

> Phone numbers are accepted in any local format (`0701355245`,
> `256701355245`, `+256701355245`). A phone that maps to more than one identity
> is resolved automatically — the real email is preferred over any synthetic
> placeholder.

### 3. My profile — `GET /api/v1/auth/me` (auth)

```json
{ "status": "success", "message": "Profile loaded",
  "data": { "id": "...", "full_name": "...", "phone": "...", "email": "...",
            "avatar_url": null, "national_id": "...", "city": "...",
            "country": "...", "territory": "...", "created_at": "...",
            "roles": ["agent"] } }
```

### 4. Dashboard bootstrap — `GET /api/v1/wallets/bootstrap?role=agent` (auth)

Role-aware startup payload for the Flutter dashboard.

```json
{ "status": "success", "message": "Dashboard bootstrap loaded",
  "data": {
    "profile": { "id": "...", "full_name": "...", "phone": "..." },
    "roles": ["agent", "tenant"],
    "active_role": "agent",
    "wallet": {
      "currency": "UGX",
      "available_balance": 116424,
      "withdrawable_balance": 116424,
      "float_balance": 235000,
      "advance_balance": 0,
      "locked_balance": 5000
    },
    "kpis": { "inflow_30d": 250000, "outflow_30d": 40000, "net_30d": 210000 }
  } }
```

`active_role` is the requested `role` if the user holds it, otherwise their
first role. `available_balance` is the strict, ledger-backed amount the user is
allowed to withdraw.

### 5. Wallet & history — `GET /api/v1/wallets?page=1&limit=50` (auth)

`page` defaults to `1`; `limit` defaults to `50` (max `100`).

```json
{ "status": "success", "message": "Wallet loaded",
  "data": {
    "wallet": { "currency": "UGX", "available_balance": 116424,
                "withdrawable_balance": 116424, "float_balance": 235000,
                "advance_balance": 0, "locked_balance": 5000 },
    "transactions": [
      { "id": "3c2c...", "date": "2026-07-10T08:02:30Z", "amount": 3000,
        "direction": "cash_in", "category": "agent_commission",
        "description": "UGX 3,000 recruiter override", "reference_id": null,
        "running_balance": 119424 }
    ],
    "pagination": { "page": 1, "limit": 50, "total": 132,
                    "total_pages": 3, "has_more": true }
  } }
```

### 6. Deposit — `POST /api/v1/wallets/deposits` (auth)

Submit a staged mobile-money deposit for Financial Ops verification.

```json
{ "amount": 25000, "provider": "MTN", "transactionId": "TID1782902900",
  "notes": "optional", "purpose": "personal_deposit" }
```

`purpose` is one of `personal_deposit`, `operational_float`,
`partnership_deposit`, `personal_rent_repayment`, `other` (defaults to `other`).
Response `201`:

```json
{ "status": "success", "message": "Deposit submitted for verification",
  "data": { "deposit_id": "...", "amount": 25000, "status": "pending",
            "provider": "MTN", "transaction_id": "TID1782902900",
            "purpose": "personal_deposit", "created_at": "..." } }
```

### 7. Withdrawal — `POST /api/v1/wallets/withdrawals` (auth)

Request a payout from the strict available balance.

```json
{ "amount": 20000, "provider": "MTN", "accountNumber": "0701355245",
  "accountName": "SSENKAALI PIUS", "payoutMethod": "mobile_money",
  "reason": "optional" }
```

- `payoutMethod`: `mobile_money` (default) or `bank`.
- For `mobile_money`, `accountNumber` is required and `provider` is the telco.
- For `bank`, pass `provider` as the bank name, plus `accountNumber` and
  `accountName`.

Response `201`:

```json
{ "status": "success", "message": "Withdrawal submitted for review",
  "data": { "withdrawal_id": "...", "amount": 20000, "status": "pending",
            "payout_method": "mobile_money", "created_at": "..." } }
```

Rejected with `400` when the amount exceeds the available balance:

```json
{ "status": "error",
  "message": "Insufficient withdrawable balance. Available: UGX 116,424",
  "data": { "available_balance": 116424, "requested": 200000 } }
```

---

## Flutter quick start

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

class WelileApi {
  // Use the custom domain in production, or the direct edge URL for now.
  static const base = 'https://api.welileapp.com';
  // Required only when hitting the direct *.supabase.co edge URL:
  static const apikey = String.fromEnvironment('WELILE_ANON_KEY');
  String? _token;

  Map<String, String> _headers({bool auth = false}) => {
        'Content-Type': 'application/json',
        if (apikey.isNotEmpty) 'apikey': apikey,
        if (auth && _token != null) 'Authorization': 'Bearer ' + _token!,
      };

  Future<Map<String, dynamic>> login(String phone, String password) async {
    final r = await http.post(Uri.parse(base + '/api/v1/auth/login'),
        headers: _headers(),
        body: jsonEncode({'phone': phone, 'password': password}));
    final body = jsonDecode(r.body) as Map<String, dynamic>;
    if (body['status'] == 'success') _token = body['data']['access_token'];
    return body;
  }

  Future<Map<String, dynamic>> bootstrap({String role = 'tenant'}) async {
    final r = await http.get(
        Uri.parse(base + '/api/v1/wallets/bootstrap?role=' + role),
        headers: _headers(auth: true));
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> deposit(
      {required int amount, required String provider,
       required String transactionId, String purpose = 'personal_deposit'}) async {
    final r = await http.post(Uri.parse(base + '/api/v1/wallets/deposits'),
        headers: _headers(auth: true),
        body: jsonEncode({
          'amount': amount, 'provider': provider,
          'transactionId': transactionId, 'purpose': purpose,
        }));
    return jsonDecode(r.body) as Map<String, dynamic>;
  }
}
```

---

## Testing with Postman

Import `docs/welile-api-v1.postman_collection.json`. Set the collection
variable `base_url` (custom domain or direct edge URL). Run **Login** first —
its test script stores `token` automatically for every other request.

## Extending the API

Add a handler in `supabase/functions/api/index.ts` and register the route in
the `Deno.serve` router (`if (path === "/v1/...")`). Keep the `{ status,
message, data }` envelope, validate input, use the strict available-balance RPC
for any money movement, and redeploy the `api` function.
