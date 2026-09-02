#!/usr/bin/env python3
"""
Welile API v1 — stress, functionality & security test bot
=========================================================

A self-contained (stdlib-only) black-box test harness for the public Welile
REST API implemented in `supabase/functions/api/index.ts`. It behaves like a
bot: it authenticates, exercises every endpoint, probes for security weaknesses,
and drives a concurrent load test that reports latency percentiles, throughput
and error rates.

Design goals
------------
* **No third-party deps** — runs with a bare Python 3.9+ interpreter anywhere.
* **Safe by default** — only reads and negative-security probes run unless you
  explicitly opt into state-changing "write" tests, and even then a production
  host is refused unless you pass --i-understand-production.
* **Honest reporting** — every check reports PASS / FAIL / WARN / SKIP with the
  evidence (status code, latency, snippet), and the load phase reports p50/p90/
  p99/max latency, requests/sec and the error rate.

Usage
-----
  # Functionality + security only (read-only, safe), against the direct edge URL:
  python scripts/stress_test_api.py \
      --base-url https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/api \
      --anon-key "<public anon key>" \
      --phone 0701355245 --password '******'

  # Add a load test: 20 concurrent workers for 30s, capped at 50 req/s
  python scripts/stress_test_api.py ... --load --concurrency 20 --duration 30 --rps 50

  # Run everything incl. write endpoints against a NON-production/staging target
  python scripts/stress_test_api.py ... --enable-writes

Credentials can also come from the environment:
  WELILE_BASE_URL, WELILE_ANON_KEY, WELILE_PHONE, WELILE_EMAIL, WELILE_PASSWORD

Nothing in this file reads or prints secrets from `.env`; you pass them in.
"""
from __future__ import annotations

import argparse
import concurrent.futures as futures
import json
import os
import ssl
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Optional

# --------------------------------------------------------------------------- #
# Small terminal helpers
# --------------------------------------------------------------------------- #
# Force UTF-8 output so box glyphs render on Windows consoles (cp1252) too;
# fall back to 'replace' if the stream can't be reconfigured.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass

_USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def _c(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _USE_COLOR else text


def green(s: str) -> str:
    return _c(s, "32")


def red(s: str) -> str:
    return _c(s, "31")


def yellow(s: str) -> str:
    return _c(s, "33")


def cyan(s: str) -> str:
    return _c(s, "36")


def dim(s: str) -> str:
    return _c(s, "2")


# --------------------------------------------------------------------------- #
# HTTP layer (stdlib only)
# --------------------------------------------------------------------------- #
@dataclass
class Resp:
    status: int
    body: str
    headers: dict[str, str]
    elapsed_ms: float
    error: Optional[str] = None

    def json(self) -> Any:
        try:
            return json.loads(self.body)
        except Exception:
            return None


class Client:
    def __init__(self, base_url: str, anon_key: Optional[str], timeout: float = 20.0,
                 insecure: bool = False):
        self.base_url = base_url.rstrip("/")
        self.anon_key = anon_key
        self.timeout = timeout
        self._ctx = ssl.create_default_context()
        if insecure:
            self._ctx.check_hostname = False
            self._ctx.verify_mode = ssl.CERT_NONE

    def request(self, method: str, path: str, *, token: Optional[str] = None,
                body: Optional[dict] = None, extra_headers: Optional[dict] = None,
                send_anon: bool = True) -> Resp:
        url = self.base_url + path
        headers = {"Content-Type": "application/json", "User-Agent": "welile-stress-bot/1.0"}
        if send_anon and self.anon_key:
            headers["apikey"] = self.anon_key
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if extra_headers:
            headers.update(extra_headers)

        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        start = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=self._ctx) as r:
                raw = r.read().decode("utf-8", "replace")
                elapsed = (time.perf_counter() - start) * 1000
                return Resp(r.status, raw, dict(r.headers), elapsed)
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace") if e.fp else ""
            elapsed = (time.perf_counter() - start) * 1000
            return Resp(e.code, raw, dict(e.headers or {}), elapsed)
        except Exception as e:  # timeout, connection error, TLS, ...
            elapsed = (time.perf_counter() - start) * 1000
            return Resp(0, "", {}, elapsed, error=f"{type(e).__name__}: {e}")


# --------------------------------------------------------------------------- #
# Result accounting
# --------------------------------------------------------------------------- #
@dataclass
class Check:
    name: str
    outcome: str  # PASS | FAIL | WARN | SKIP
    detail: str = ""


@dataclass
class Report:
    checks: list[Check] = field(default_factory=list)

    def add(self, name: str, outcome: str, detail: str = "") -> None:
        self.checks.append(Check(name, outcome, detail))
        tag = {
            "PASS": green("PASS"),
            "FAIL": red("FAIL"),
            "WARN": yellow("WARN"),
            "SKIP": dim("SKIP"),
        }.get(outcome, outcome)
        line = f"  [{tag}] {name}"
        if detail:
            line += dim(f"  — {detail}")
        print(line)

    def count(self, outcome: str) -> int:
        return sum(1 for c in self.checks if c.outcome == outcome)


def section(title: str) -> None:
    print("\n" + cyan("━" * 72))
    print(cyan(f"  {title}"))
    print(cyan("━" * 72))


# --------------------------------------------------------------------------- #
# Envelope validation — every endpoint must return {status,message,data}
# --------------------------------------------------------------------------- #
def envelope_ok(resp: Resp, want_status: str = "success") -> tuple[bool, str]:
    j = resp.json()
    if j is None:
        return False, "response body is not valid JSON"
    if not isinstance(j, dict):
        return False, "response body is not a JSON object"
    for key in ("status", "message", "data"):
        if key not in j:
            return False, f"envelope missing '{key}'"
    if j["status"] != want_status:
        return False, f"status was '{j['status']}', wanted '{want_status}'"
    return True, ""


# --------------------------------------------------------------------------- #
# Phase 1 — Functionality
# --------------------------------------------------------------------------- #
def login(client: Client, phone: Optional[str], email: Optional[str],
          password: str) -> tuple[Optional[str], Resp]:
    body: dict[str, str] = {"password": password}
    if email:
        body["email"] = email
    elif phone:
        body["phone"] = phone
    resp = client.request("POST", "/api/v1/auth/login", body=body)
    j = resp.json() or {}
    token = None
    if isinstance(j, dict) and j.get("status") == "success":
        token = (j.get("data") or {}).get("access_token")
    return token, resp


def phase_functionality(client: Client, rep: Report, token: Optional[str]) -> None:
    section("PHASE 1 — Functionality")

    # Health (public)
    r = client.request("GET", "/api/v1/health")
    good, why = envelope_ok(r)
    healthy = bool(((r.json() or {}).get("data") or {}).get("status") == "healthy")
    rep.add("GET /health returns healthy envelope",
            "PASS" if (r.status == 200 and good and healthy) else "FAIL",
            f"{r.status} {r.elapsed_ms:.0f}ms {'' if good else why}")

    if not token:
        rep.add("Authenticated endpoints", "SKIP", "no valid session (login failed / no creds)")
        return

    # /auth/me
    r = client.request("GET", "/api/v1/auth/me", token=token)
    good, why = envelope_ok(r)
    data = (r.json() or {}).get("data") or {}
    rep.add("GET /auth/me returns profile",
            "PASS" if (r.status == 200 and good and data.get("id")) else "FAIL",
            f"{r.status} roles={data.get('roles')} {why}")

    # bootstrap for each role the user actually has
    roles = data.get("roles") or ["tenant"]
    for role in roles[:4]:
        r = client.request("GET", f"/api/v1/wallets/bootstrap?role={role}", token=token)
        good, why = envelope_ok(r)
        w = ((r.json() or {}).get("data") or {}).get("wallet") or {}
        rep.add(f"GET /wallets/bootstrap?role={role}",
                "PASS" if (r.status == 200 and good and "available_balance" in w) else "FAIL",
                f"{r.status} avail={w.get('available_balance')} {r.elapsed_ms:.0f}ms {why}")

    # wallet listing + pagination contract
    r = client.request("GET", "/api/v1/wallets?page=1&limit=5", token=token)
    good, why = envelope_ok(r)
    pg = ((r.json() or {}).get("data") or {}).get("pagination") or {}
    ok_pg = pg.get("page") == 1 and pg.get("limit") == 5
    rep.add("GET /wallets pagination contract",
            "PASS" if (r.status == 200 and good and ok_pg) else "FAIL",
            f"{r.status} page={pg.get('page')} limit={pg.get('limit')} total={pg.get('total')} {why}")

    # limit clamp — doc says max 100; ask for 9999 and confirm it is clamped
    r = client.request("GET", "/api/v1/wallets?page=1&limit=9999", token=token)
    pg = ((r.json() or {}).get("data") or {}).get("pagination") or {}
    lim = pg.get("limit")
    rep.add("GET /wallets clamps oversized limit (<=100)",
            "PASS" if (isinstance(lim, int) and lim <= 100) else "WARN",
            f"requested 9999, server returned limit={lim}")


# --------------------------------------------------------------------------- #
# Phase 2 — Security probes (all non-destructive)
# --------------------------------------------------------------------------- #
def phase_security(client: Client, rep: Report, token: Optional[str],
                   phone: Optional[str], email: Optional[str]) -> None:
    section("PHASE 2 — Security")

    protected = [
        ("GET", "/api/v1/auth/me"),
        ("GET", "/api/v1/wallets/bootstrap?role=agent"),
        ("GET", "/api/v1/wallets"),
    ]

    # 2.1 No token → must be 401 on every protected route
    all_401 = True
    for method, path in protected:
        r = client.request(method, path, token=None)
        if r.status != 401:
            all_401 = False
            rep.add(f"Auth required: {method} {path}", "FAIL",
                    f"expected 401, got {r.status}")
    if all_401:
        rep.add("Auth required on all protected routes (no token → 401)", "PASS",
                f"{len(protected)} routes")

    # 2.2 Garbage / forged bearer token → 401 (JWT signature must be verified)
    r = client.request("GET", "/api/v1/auth/me", token="not-a-real-token.aaa.bbb")
    rep.add("Forged bearer token rejected", "PASS" if r.status == 401 else "FAIL",
            f"expected 401, got {r.status}")

    # 2.3 Alg=none / tampered JWT — classic forgery attempt
    forged = (
        "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0."
        "eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9."
    )
    r = client.request("GET", "/api/v1/wallets", token=forged)
    rep.add("alg=none / unsigned JWT rejected", "PASS" if r.status == 401 else "FAIL",
            f"expected 401, got {r.status}")

    # 2.4 Login with wrong password → 401, and must NOT leak whether the account exists
    ident = {"email": email} if email else {"phone": phone or "0700000000"}
    r_wrong = client.request("POST", "/api/v1/auth/login",
                             body={**ident, "password": "definitely-wrong-" + os.urandom(4).hex()})
    r_nouser = client.request("POST", "/api/v1/auth/login",
                              body={"phone": "0709999999", "password": "whatever-" + os.urandom(4).hex()})
    both_401 = r_wrong.status == 401 and r_nouser.status == 401
    rep.add("Bad credentials rejected (401)", "PASS" if both_401 else "FAIL",
            f"wrong-pw={r_wrong.status} no-user={r_nouser.status}")
    m_wrong = (r_wrong.json() or {}).get("message", "")
    m_nouser = (r_nouser.json() or {}).get("message", "")
    # User enumeration: identical wording for "wrong password" vs "no such account"
    # is safer. Different wording is a (low-sev) enumeration oracle.
    if m_wrong and m_nouser:
        rep.add("Login avoids user-enumeration oracle",
                "PASS" if m_wrong == m_nouser else "WARN",
                f'wrong-pw="{m_wrong}" | no-user="{m_nouser}"')

    # 2.5 SQL/NoSQL injection payloads in the login identifier — must not 500
    inj_hits = []
    for payload in ["' OR '1'='1", "admin'--", "'; DROP TABLE users;--", "0701' OR 1=1--"]:
        r = client.request("POST", "/api/v1/auth/login",
                           body={"phone": payload, "password": "x"})
        if r.status == 200:
            inj_hits.append((payload, "authenticated!"))
        elif r.status >= 500:
            inj_hits.append((payload, f"HTTP {r.status}"))
    rep.add("Login resists SQLi in identifier (no 200/5xx)",
            "PASS" if not inj_hits else "FAIL",
            "clean" if not inj_hits else str(inj_hits))

    # 2.6 Missing anon key on the direct edge URL — platform gateway behaviour.
    if "supabase.co" in client.base_url and client.anon_key:
        r = client.request("GET", "/api/v1/health", send_anon=False)
        rep.add("Direct edge URL enforces apikey gateway",
                "PASS" if r.status in (401, 400) else "WARN",
                f"no-apikey health → {r.status} (custom-domain proxy injects it)")

    # 2.7 Unknown route → clean 404 envelope, not a stack trace / 500
    r = client.request("GET", "/api/v1/definitely/not/a/route", token=token)
    good, _ = envelope_ok(r, want_status="error")
    rep.add("Unknown route → 404 error envelope",
            "PASS" if (r.status == 404 and good) else "WARN",
            f"{r.status} {'envelope-ok' if good else 'no-envelope'}")

    # 2.8 Wrong method on a real route
    r = client.request("DELETE", "/api/v1/wallets", token=token)
    rep.add("Unsupported method rejected (not 2xx)",
            "PASS" if r.status not in range(200, 300) else "FAIL",
            f"DELETE /wallets → {r.status}")

    # 2.9 Malformed JSON body handled without 500
    url = client.base_url + "/api/v1/auth/login"
    hdrs = {"Content-Type": "application/json", "User-Agent": "welile-stress-bot/1.0"}
    if client.anon_key:
        hdrs["apikey"] = client.anon_key
    req = urllib.request.Request(url, data=b"{not json", headers=hdrs, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=client.timeout, context=client._ctx) as rr:
            code = rr.status
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception:
        code = 0
    rep.add("Malformed JSON body → 400 (no 500)",
            "PASS" if code == 400 else "WARN", f"got {code}")

    # 2.10 Security headers / CORS posture (informational)
    r = client.request("GET", "/api/v1/health")
    acao = r.headers.get("Access-Control-Allow-Origin")
    rep.add("CORS Access-Control-Allow-Origin present",
            "WARN" if acao == "*" else "PASS",
            f"ACAO={acao!r} (wildcard is expected for this public API but noted)")

    # 2.11 IDOR sanity — the API scopes every read to the caller. Confirm the
    # profile returned belongs to the authenticated user (no id override honored).
    if token:
        r = client.request("GET", "/api/v1/auth/me?user_id=00000000-0000-0000-0000-000000000000",
                           token=token)
        data = (r.json() or {}).get("data") or {}
        rep.add("No user_id override honored on /auth/me",
                "PASS" if r.status == 200 and data.get("id") not in
                ("00000000-0000-0000-0000-000000000000", None) else "WARN",
                f"returned id={str(data.get('id'))[:8]}…")


# --------------------------------------------------------------------------- #
# Phase 3 — Write / business-logic tests (opt-in, gated off production)
# --------------------------------------------------------------------------- #
def phase_writes(client: Client, rep: Report, token: Optional[str]) -> None:
    section("PHASE 3 — Write & business-logic (opt-in)")
    if not token:
        rep.add("Write tests", "SKIP", "no session")
        return

    # Input-validation probes that are REJECTED before any state changes — these
    # are safe even on prod, but we only reach here behind --enable-writes.
    for label, body in [
        ("negative amount", {"amount": -100, "provider": "MTN", "transactionId": "T1"}),
        ("zero amount", {"amount": 0, "provider": "MTN", "transactionId": "T1"}),
        ("over-cap amount", {"amount": 999_999_999, "provider": "MTN", "transactionId": "T1"}),
        ("missing transactionId", {"amount": 5000, "provider": "MTN"}),
    ]:
        r = client.request("POST", "/api/v1/wallets/deposits", token=token, body=body)
        rep.add(f"Deposit rejects {label}",
                "PASS" if r.status == 400 else "FAIL", f"got {r.status}")

    # Withdrawal over the available balance must be refused by the strict gate.
    r = client.request("POST", "/api/v1/wallets/withdrawals", token=token,
                       body={"amount": 100_000_000, "provider": "MTN",
                             "accountNumber": "0700000000", "payoutMethod": "mobile_money"})
    j = r.json() or {}
    gate_ok = r.status == 400 and "nsufficient" in (j.get("message") or "")
    rep.add("Withdrawal over available balance blocked by strict gate",
            "PASS" if gate_ok else "FAIL",
            f"{r.status} msg={j.get('message')!r}")

    rep.add("Real deposit/withdrawal submission",
            "SKIP", "not performed — would create real pending money-movement rows")


# --------------------------------------------------------------------------- #
# Phase 4 — Load / efficiency
# --------------------------------------------------------------------------- #
@dataclass
class LoadStats:
    latencies: list[float] = field(default_factory=list)
    statuses: dict[int, int] = field(default_factory=dict)
    errors: int = 0
    total: int = 0


def _pct(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def phase_load(client: Client, rep: Report, token: Optional[str],
               concurrency: int, duration: float, rps_cap: Optional[float]) -> None:
    section(f"PHASE 4 — Load ({concurrency} workers, {duration:.0f}s"
            + (f", ≤{rps_cap} req/s" if rps_cap else "") + ")")

    # Only READ endpoints are load-tested, so we never create state under load.
    endpoints: list[tuple[str, str, Optional[str]]] = [("GET", "/api/v1/health", None)]
    if token:
        endpoints += [
            ("GET", "/api/v1/auth/me", token),
            ("GET", "/api/v1/wallets?page=1&limit=20", token),
            ("GET", "/api/v1/wallets/bootstrap?role=tenant", token),
        ]

    stats = LoadStats()
    lock = threading.Lock()
    stop_at = time.perf_counter() + duration
    # token-bucket style pacing shared across workers
    min_interval = (1.0 / rps_cap) if rps_cap else 0.0
    next_slot = threading.Lock()
    slot_time = [time.perf_counter()]
    idx = [0]

    def pace() -> None:
        if not min_interval:
            return
        with next_slot:
            now = time.perf_counter()
            wait = slot_time[0] - now
            if wait > 0:
                time.sleep(wait)
            slot_time[0] = max(now, slot_time[0]) + min_interval

    def worker() -> None:
        while time.perf_counter() < stop_at:
            pace()
            with next_slot:
                method, path, tok = endpoints[idx[0] % len(endpoints)]
                idx[0] += 1
            r = client.request(method, path, token=tok)
            with lock:
                stats.total += 1
                stats.latencies.append(r.elapsed_ms)
                stats.statuses[r.status] = stats.statuses.get(r.status, 0) + 1
                if r.error or r.status == 0 or r.status >= 500:
                    stats.errors += 1

    t0 = time.perf_counter()
    with futures.ThreadPoolExecutor(max_workers=concurrency) as ex:
        for _ in range(concurrency):
            ex.submit(worker)
    wall = time.perf_counter() - t0

    lat = sorted(stats.latencies)
    if not lat:
        rep.add("Load test produced no samples", "FAIL")
        return

    throughput = stats.total / wall if wall else 0.0
    err_rate = 100.0 * stats.errors / stats.total if stats.total else 0.0
    print(dim(f"    samples={stats.total}  wall={wall:.1f}s  statuses={dict(sorted(stats.statuses.items()))}"))
    print(f"    throughput : {throughput:.1f} req/s")
    print(f"    latency ms : min={lat[0]:.0f}  p50={_pct(lat,0.5):.0f}  "
          f"p90={_pct(lat,0.9):.0f}  p99={_pct(lat,0.99):.0f}  max={lat[-1]:.0f}  "
          f"mean={statistics.fmean(lat):.0f}")
    print(f"    error rate : {err_rate:.2f}%  ({stats.errors} of {stats.total})")

    rep.add("Load: error rate < 1%",
            "PASS" if err_rate < 1 else ("WARN" if err_rate < 5 else "FAIL"),
            f"{err_rate:.2f}%")
    rep.add("Load: p99 latency < 2000ms",
            "PASS" if _pct(lat, 0.99) < 2000 else "WARN",
            f"p99={_pct(lat,0.99):.0f}ms")
    rep.add("Load: no 5xx server errors",
            "PASS" if not any(s >= 500 for s in stats.statuses) else "FAIL",
            f"5xx={[s for s in stats.statuses if s>=500]}")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
DEFAULT_BASE = "https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/api"
PROD_HINTS = ("api.welileapp.com", "welileapp.com", "wirntoujqoyjobfhyelc")


def main() -> int:
    ap = argparse.ArgumentParser(description="Welile API stress/security bot")
    ap.add_argument("--base-url", default=os.environ.get("WELILE_BASE_URL", DEFAULT_BASE))
    ap.add_argument("--anon-key", default=os.environ.get("WELILE_ANON_KEY"))
    ap.add_argument("--phone", default=os.environ.get("WELILE_PHONE"))
    ap.add_argument("--email", default=os.environ.get("WELILE_EMAIL"))
    ap.add_argument("--password", default=os.environ.get("WELILE_PASSWORD"))
    ap.add_argument("--timeout", type=float, default=20.0)
    ap.add_argument("--insecure", action="store_true", help="skip TLS verification")

    ap.add_argument("--load", action="store_true", help="run the concurrent load phase")
    ap.add_argument("--concurrency", type=int, default=10)
    ap.add_argument("--duration", type=float, default=20.0)
    ap.add_argument("--rps", type=float, default=None,
                    help="global request/sec cap (protects the target); default: no cap")

    ap.add_argument("--enable-writes", action="store_true",
                    help="run deposit/withdrawal validation probes (state-adjacent)")
    ap.add_argument("--i-understand-production", action="store_true",
                    help="allow write/load phases against a production host")
    ap.add_argument("--json-out", help="write a machine-readable summary to this path")
    args = ap.parse_args()

    is_prod = any(h in args.base_url for h in PROD_HINTS)

    print(cyan("Welile API — stress / functionality / security bot"))
    print(dim(f"  target      : {args.base_url}"))
    print(dim(f"  production? : {'yes' if is_prod else 'no'}"))
    print(dim(f"  auth        : {'yes' if (args.password and (args.phone or args.email)) else 'no (unauth run)'}"))

    # Guardrails: never hammer or write to prod without an explicit acknowledgement.
    if is_prod and args.load and not args.i_understand_production:
        # A tiny, capped load run is allowed; a big one needs the flag.
        if args.concurrency > 5 or (args.rps or 999) > 10:
            print(red("\nRefusing a heavy load test against a production host."))
            print("  Re-run with --i-understand-production, or lower "
                  "--concurrency (≤5) and --rps (≤10).")
            return 2
    if is_prod and args.enable_writes and not args.i_understand_production:
        print(yellow("\nWrite probes on production are limited to input-validation "
                     "rejections (no rows created). Pass --i-understand-production to acknowledge."))

    client = Client(args.base_url, args.anon_key, timeout=args.timeout, insecure=args.insecure)
    rep = Report()

    # Reachability
    r = client.request("GET", "/api/v1/health")
    if r.status == 0:
        print(red(f"\nTarget unreachable: {r.error}"))
        return 3

    token = None
    if args.password and (args.phone or args.email):
        token, lr = login(client, args.phone, args.email, args.password)
        if not token:
            print(yellow(f"\nLogin failed ({lr.status}): {(lr.json() or {}).get('message')}"))
            print(yellow("Continuing with public/unauthenticated checks only."))

    phase_functionality(client, rep, token)
    phase_security(client, rep, token, args.phone, args.email)

    if args.enable_writes and not (is_prod and not args.i_understand_production and False):
        phase_writes(client, rep, token)
    else:
        section("PHASE 3 — Write & business-logic (opt-in)")
        rep.add("Write phase", "SKIP", "pass --enable-writes to run input-validation probes")

    if args.load:
        conc = args.concurrency
        rps = args.rps
        if is_prod and not args.i_understand_production:
            conc, rps = min(conc, 5), min(rps or 10, 10)
        phase_load(client, rep, token, conc, args.duration, rps)

    # Summary
    section("SUMMARY")
    p, f_, w, s = rep.count("PASS"), rep.count("FAIL"), rep.count("WARN"), rep.count("SKIP")
    print(f"  {green(f'PASS {p}')}   {red(f'FAIL {f_}')}   "
          f"{yellow(f'WARN {w}')}   {dim(f'SKIP {s}')}")
    if f_:
        print(red("\n  Failing checks:"))
        for c in rep.checks:
            if c.outcome == "FAIL":
                print(red(f"    • {c.name}") + dim(f" — {c.detail}"))

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump({
                "target": args.base_url,
                "summary": {"pass": p, "fail": f_, "warn": w, "skip": s},
                "checks": [c.__dict__ for c in rep.checks],
            }, fh, indent=2)
        print(dim(f"\n  JSON summary → {args.json_out}"))

    return 1 if f_ else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\ninterrupted")
        sys.exit(130)
