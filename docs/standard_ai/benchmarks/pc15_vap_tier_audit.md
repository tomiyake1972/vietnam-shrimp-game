# PC-1.5 — VAP Product Development Tier Audit

5 scenarios x 5 seeds x 5 companies x 32Q, PROFILE ON. 4000 quarter-observations (VAP_DEV_CONSIDERED発火時のみ)。

## Tier pass/fail distribution by company (affordability gate only, finance gate separate)

| Company | n | pass500k% | pass250k-only% | pass100k-only% | pass none % |
|---|---|---|---|---|---|
| MASS | 800 | 92.5% | 0.4% | 0.1% | 7.0% |
| BAL | 800 | 96.9% | 0.0% | 0.0% | 3.1% |
| JPQ | 800 | 96.9% | 0.0% | 0.0% | 3.1% |
| CONSV | 800 | 96.9% | 0.0% | 0.0% | 3.1% |
| VAP | 800 | 93.8% | 0.0% | 0.0% | 6.3% |

## Reproduction fidelity (audit formula vs actual selected tier)

3079 / 4000 (77.0%) 一致（affordability再現式のみで再構成、financeSafeForSpendのborrowingPressure項は近似のため完全一致ではない）。

