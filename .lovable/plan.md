# CRM call screen redesign

## What will change
- Remove the entire Call summary area; Record a complaint remains the only note-entry area.
- Rebuild the top of the drawer as the selected integrated command header: compact caller identity and live state on the left, microphone/ring controls and End Call on the right.
- Place profile and financial highlights directly beneath that header, before the role tabs and Portfolio content.
- Restyle wallet balances, collections, transactions, Rent Plans, portfolios, and complaint history with meaningful icons and clearer semantic theme colours.
- Preserve the safe Test view badge and its guarantee that no call or call record is created.

## Data accuracy
- Verify the live wallet view and dossier function before changing anything.
- Update the dossier's read-only balance lookup to use the authoritative physical wallet values when a projection row is missing, while retaining the existing projected bucket values when present.
- Keep collection figures tied to the existing operational `agent_collections` records; show an explicit empty state when no recorded collection exists instead of making an unexplained zero look like a failed load.

## Safety and verification
- Do not write wallet, ledger, approval, call, or transaction records during testing.
- Run the full backend/logic guard suite because the read-only dossier function changes.
- Run the TypeScript check and verify the signed-in Test call screen at desktop and mobile widths.
- Confirm through browser network activity that Test view sends no voice or call-session requests.
