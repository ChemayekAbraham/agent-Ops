// Postgres SQLSTATE -> HTTP for cfo-record-advance-payment.
// Anything unrecognised is a 500. P0001 is plpgsql RAISE EXCEPTION: a
// business-rule rejection (insufficient wallet balance, a disallowed ledger
// category, and the same class of checks). It is a 400 so the CFO screen can
// show the Postgres message instead of treating it as a server fault.

export interface PgRpcError {
  code?: string | null;
  message?: string | null;
}

export function statusForPgError(code?: string | null): number {
  switch (code) {
    case '28000': return 401; // not authenticated
    case '42501': return 403; // wrong role
    case '22023': return 400; // bad argument
    case '0A000': return 422; // unsupported payment method
    case 'P0001': return 400; // plpgsql RAISE EXCEPTION
    case 'P0002': return 404; // advance not found
    default:      return 500;
  }
}

/** JSON body returned after the RPC rolls back. `error` is the Postgres message. */
export function advancePaymentErrorBody(error: PgRpcError): {
  error: string | null;
  code: string | null;
  recorded: false;
  rolled_back: true;
} {
  return {
    error: error.message ?? null,
    code: error.code ?? null,
    recorded: false,
    rolled_back: true,
  };
}
