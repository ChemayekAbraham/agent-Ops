/**
 * balancedLedgerPost — posting-time double-entry assertion.
 *
 * Phase 2 of WELILE-LEDGER-TRACE-2. Every transaction group posted through this
 * helper is priced against `ledger_account_map` (the same resolution the CFO
 * reports use, including the blanket fallback) BEFORE it is written. If the
 * group's debits do not equal its credits the write is rejected outright and the
 * attempt is logged with the computed totals, the per-leg sides and the calling
 * function, so an unbalanced group can never reach `general_ledger` again.
 *
 * Scope (deliberate, per Phase 2): admin-float-to-withdrawable,
 * admin-withdrawable-to-float and finops-wallet-move. Other posting paths keep
 * their current behaviour until they are migrated onto this helper on purpose.
 */

// deno-lint-ignore no-explicit-any
type Admin = any;

export type LedgerLeg = Record<string, unknown>;

type MapRow = {
  ledger_scope: string;
  category: string;
  wallet_bucket: string | null;
  account_code: string;
  debit_when: string;
};

export type LegSide = {
  index: number;
  category: string;
  ledger_scope: string;
  wallet_bucket: string | null;
  direction: string;
  amount: number;
  account_code: string;
  debit_when: string;
  side: "DR" | "CR";
  mapped: boolean;
};

export type BalanceReport = {
  balanced: boolean;
  debit_total: number;
  credit_total: number;
  difference: number;
  legs: LegSide[];
};

/** cash_in / credit are the same side of the fence; so are cash_out / debit. */
const normalizeDirection = (raw: unknown): "cash_in" | "cash_out" => {
  const d = String(raw ?? "").toLowerCase();
  if (d === "cash_in" || d === "credit") return "cash_in";
  return "cash_out";
};

/** Mirrors the report fallback in get_cfo_weekly_report / balance sheet legs. */
const fallbackFor = (scope: string, bucket: string | null) => {
  if (scope === "wallet" && bucket === "float") return { account_code: "A2", debit_when: "cash_in" };
  if (scope === "wallet" && bucket === "advance") return { account_code: "A4", debit_when: "cash_in" };
  if (scope === "wallet") return { account_code: "L1", debit_when: "cash_out" };
  return { account_code: "A9", debit_when: "cash_in" };
};

/**
 * Prices every leg against the account map and reports whether the group nets
 * to zero. Exported so callers (and tests) can assert without posting.
 */
export async function assertLedgerGroupBalanced(
  admin: Admin,
  entries: LedgerLeg[],
): Promise<BalanceReport> {
  const categories = Array.from(
    new Set(entries.map((e) => String(e.category ?? ""))),
  ).filter(Boolean);

  let rows: MapRow[] = [];
  if (categories.length) {
    const { data } = await admin
      .from("ledger_account_map")
      .select("ledger_scope, category, wallet_bucket, account_code, debit_when")
      .in("category", categories);
    rows = (data || []) as MapRow[];
  }

  const legs: LegSide[] = entries.map((e, index) => {
    const scope = String(e.ledger_scope ?? "wallet");
    const category = String(e.category ?? "");
    const bucket = (e.wallet_bucket ?? null) as string | null;
    const direction = normalizeDirection(e.direction);
    const amount = Number(e.amount ?? 0);

    const bucketRow = bucket
      ? rows.find((r) =>
        r.ledger_scope === scope && r.category === category && r.wallet_bucket === bucket
      )
      : undefined;
    const wildcardRow = rows.find((r) =>
      r.ledger_scope === scope && r.category === category && r.wallet_bucket === null
    );
    const resolved = bucketRow ?? wildcardRow ?? fallbackFor(scope, bucket);

    return {
      index,
      category,
      ledger_scope: scope,
      wallet_bucket: bucket,
      direction,
      amount,
      account_code: resolved.account_code,
      debit_when: resolved.debit_when,
      side: direction === normalizeDirection(resolved.debit_when) ? "DR" : "CR",
      mapped: Boolean(bucketRow ?? wildcardRow),
    };
  });

  const debit_total = legs.filter((l) => l.side === "DR").reduce((s, l) => s + l.amount, 0);
  const credit_total = legs.filter((l) => l.side === "CR").reduce((s, l) => s + l.amount, 0);
  const difference = debit_total - credit_total;

  return {
    balanced: Math.abs(difference) < 0.005,
    debit_total,
    credit_total,
    difference,
    legs,
  };
}

export type PostResult =
  | { ok: true; groupId: string | null; report: BalanceReport }
  | { ok: false; error: string; report: BalanceReport | null };

/**
 * Assert-then-post. Nothing is written when the assertion fails.
 */
export async function postBalancedLedgerGroup(
  admin: Admin,
  opts: {
    entries: LedgerLeg[];
    source: string;
    referenceId?: string | null;
    skipBalanceCheck?: boolean;
    idempotencyKey?: string | null;
    /**
     * When set, posts through create_ledger_transaction_locked instead of
     * create_ledger_transaction: an advisory lock salted to
     * "bucket_reclass:<lockUserId>" is held for the duration of the post,
     * and (when minAvailable is also set) get_user_available_balance() is
     * re-checked under that lock immediately before writing. This closes
     * the TOCTOU race that skipBalanceCheck otherwise leaves open — two
     * concurrent cross-bucket moves for the same user can no longer both
     * read the same stale balance and both post. Use for any reclass that
     * debits a user's own withdrawable/float balance (agent self-service,
     * admin withdrawable<->float, finops wallet moves); omit for legs with
     * no per-user race exposure (e.g. platform-side legs).
     */
    lockUserId?: string | null;
    minAvailable?: number | null;
  },
): Promise<PostResult> {
  const {
    entries,
    source,
    referenceId = null,
    skipBalanceCheck = true,
    idempotencyKey = null,
    lockUserId = null,
    minAvailable = null,
  } = opts;

  if (!Array.isArray(entries) || entries.length < 2) {
    return {
      ok: false,
      error: "LEDGER_ASSERTION_FAILED: a transaction group needs at least two legs.",
      report: null,
    };
  }

  const report = await assertLedgerGroupBalanced(admin, entries);

  if (!report.balanced) {
    const detail = {
      source_function: source,
      reference_id: referenceId,
      debit_total: report.debit_total,
      credit_total: report.credit_total,
      difference: report.difference,
      legs: report.legs,
    };
    console.error(
      `[${source}] LEDGER_ASSERTION_FAILED — group rejected before write:`,
      JSON.stringify(detail),
    );
    try {
      await admin.from("system_events").insert({
        event_type: "ledger.unbalanced_group_rejected",
        description:
          `Rejected an unbalanced ledger group from ${source}: debits UGX ${
            Math.round(report.debit_total).toLocaleString()
          } vs credits UGX ${Math.round(report.credit_total).toLocaleString()} ` +
          `(difference UGX ${Math.round(report.difference).toLocaleString()}).`,
        metadata: detail,
      });
    } catch (_) {
      // Diagnostics are best-effort; the rejection itself is what matters.
    }
    return {
      ok: false,
      error:
        `LEDGER_ASSERTION_FAILED: the transaction legs do not net to zero ` +
        `(debits UGX ${Math.round(report.debit_total).toLocaleString()}, credits UGX ${
          Math.round(report.credit_total).toLocaleString()
        }, difference UGX ${Math.round(report.difference).toLocaleString()}). ` +
        `Nothing was written to the ledger.`,
      report,
    };
  }

  const payload: Record<string, unknown> = { entries, skip_balance_check: skipBalanceCheck };
  if (idempotencyKey) payload.idempotency_key = idempotencyKey;

  let groupId: string | null = null;
  let error: { message: string } | null = null;
  if (lockUserId) {
    payload.lock_user_id = lockUserId;
    if (minAvailable != null) payload.min_available = minAvailable;
    ({ data: groupId, error } = await admin.rpc("create_ledger_transaction_locked", payload));
  } else {
    ({ data: groupId, error } = await admin.rpc("create_ledger_transaction", payload));
  }
  if (error) return { ok: false, error: `Ledger error: ${error.message}`, report };

  // Post-write confirmation: read the group back and re-price it. A mismatch
  // here means a trigger rewrote a leg — surface it loudly for diagnosis.
  try {
    if (groupId) {
      const { data: written } = await admin
        .from("general_ledger")
        .select("category, ledger_scope, wallet_bucket, direction, amount")
        .eq("transaction_group_id", groupId);
      if (written?.length) {
        const after = await assertLedgerGroupBalanced(admin, written as LedgerLeg[]);
        if (!after.balanced) {
          console.error(
            `[${source}] LEDGER_POST_DRIFT — written group ${groupId} does not net to zero:`,
            JSON.stringify({
              transaction_group_id: groupId,
              debit_total: after.debit_total,
              credit_total: after.credit_total,
              difference: after.difference,
              legs: after.legs,
            }),
          );
        }
      }
    }
  } catch (_) {
    // Read-back is diagnostic only.
  }

  return { ok: true, groupId: (groupId as string) ?? null, report };
}
