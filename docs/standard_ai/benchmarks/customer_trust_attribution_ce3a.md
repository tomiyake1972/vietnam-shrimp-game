# CE-3A — Customer Trust Attribution Audit

Turn-by-turn Trust decomposition for representative cases (JPQ/VAP/MASS, PROFILE ON, seed-1/seed-2, baseline scenario). avgDeliveredQualityScore/avgObservedDeliveryScore are company-level simple averages across markets observed that turn (the actual Trust update happens per company x market with asymmetric EWMA; this table approximates by averaging, see customer_trust_attribution_ce3a_turns.csv for the full per-turn data).

## Largest single-turn Trust drops per company (baseline/seed-1)

| Company | Turn | Trust before | Trust after | Delta | Avg delivered quality | Avg on-time delivery | Incident penalty | Newly overdue (t) |
|---|---|---|---|---|---|---|---|---|
| JPQ | 32 | 73.5 | 73.5 | 0.00 | 74.8 | 73.2 | 0.0 | 6355.3 |
| VAP | 22 | 67.9 | 67.5 | -0.44 | 75.1 | 55.9 | 0.0 | 7039.5 |
| MASS | 8 | 53.3 | 49.6 | -3.64 | 57.4 | 38.4 | 72.2 | 8867.9 |

## Full-run summary per company (baseline, seed-1/seed-2 averaged)

| Company | Trust Q1 | Trust Q32 | Avg delivered quality | Avg on-time delivery | Total incident penalty | Total newly overdue (t) | Total continuing overdue (t) |
|---|---|---|---|---|---|---|---|
| JPQ | 50.0 | 73.8 | 73.8 | 85.1 | 86.0 | 95539 | 76976 |
| VAP | 50.0 | 66.1 | 74.0 | 74.6 | 0.0 | 123812 | 84017 |
| MASS | 50.0 | 45.2 | 69.6 | 39.9 | 148.1 | 370979 | 445686 |

