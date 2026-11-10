Acknowledgement only — no code or database changes.

- Re-sync to `578cc98036` happens on the platform side; nothing to edit here.
- The two migrations (`20261110153000`, `20261110153100`) are already live and must not be re-applied or rewritten.
- Rule to keep in all future rent request routing and E58 pipeline guard work: self-onboarded tenants (/tenants-onboarding) and requests from agents with no Service Centre manager skip the Service Centre and stay `pending` in the Agent Ops queue.

Approving this plan makes no changes.
