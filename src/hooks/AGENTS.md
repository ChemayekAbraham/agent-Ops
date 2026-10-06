# Forecast hooks

- Receivables Forecast uses read-only history averages and scheduled RPC amounts; generate windows independently of the predictive RPC's 60-period cap and split contract reads into non-overlapping windows at its 400-day limit, so long horizons are not truncated or double-counted.