# Faster CRM dossier and cleaner profile

## Build
- Keep a single dossier request per person and prevent repeated refetches while operators reopen the same call screen.
- Rework the server query to aggregate collections and related names in sets instead of repeating lookups per row.
- Render the call identity immediately from the People list while the remaining dossier sections load asynchronously with stable section-level placeholders.
- Replace the desktop profile tile grid with a compact, full-width information band that uses space efficiently; preserve all fields, roles, frozen status, and mobile readability.
- Keep wallet and ledger data read-only and preserve the existing server-side partner visibility gate.

## Technical details
- Optimize `crm_callee_dossier` without splitting it into extra requests.
- Use the existing query cache with a longer freshness window and placeholder data sourced from the selected person.
- Add only targeted supporting indexes confirmed missing in the live schema.
- Validate desktop/mobile rendering, request count, type checks, safety guards, and confirm no financial or workflow writes.
