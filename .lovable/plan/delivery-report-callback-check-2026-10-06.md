# Delivery-report callback check

No changes needed.

1. Live: yes. A POST returned HTTP 200 (not 404).
2. JWT off: yes. config.toml has verify_jwt = false, and the unauthenticated POST was accepted (no 401).

Caveat: I cannot read the deployed code version. Say so if you want a redeploy to guarantee it matches the repo.
