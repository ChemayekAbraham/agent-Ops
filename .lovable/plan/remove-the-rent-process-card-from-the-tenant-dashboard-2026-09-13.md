# Remove the Rent Process card from the tenant dashboard

## Change
- Remove the conditional **Rent Process** card from the tenant home screen.
- Remove its now-unused import from the tenant dashboard file.
- Keep the shared Rent Process tracker component intact because it is also used in the manager review flow.

## Scope
- Change only `src/components/dashboards/TenantDashboard.tsx`.
- Do not change Rent Plan status logic, request data, navigation, other tenant cards, or manager-facing tracking.

## Verification
- Confirm the tenant dashboard moves directly from the subscription status area to the two action cards.
- Confirm the highlighted Rent Process card no longer appears when a tenant has an active request.
- Run the existing checks and verify the preview remains error-free.
