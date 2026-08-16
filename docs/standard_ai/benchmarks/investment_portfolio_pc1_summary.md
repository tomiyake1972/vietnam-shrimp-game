# Standard AI Investment Portfolio Calibration — Phase PC-1 Benchmark

Part 1 baseline: 5 scenarios x 5 seeds x 5 companies x 32Q, PROFILE ON固定. 125 company-runs. parameter変更なし（監査のみ）。
Part 2 high-Vision: MASS 80k / others 50k (benchmark override only), baseline scenario, 5 seeds. 25 company-runs.
Part 3 Strategic Posture: AGGRESSIVE_EARLY_CAPACITY / VALUE_FIRST, baseline scenario, 5 seeds. 50 company-runs.

## Company portfolio summary (avg across 25 baseline runs/company)

| Company | Growth CAPEX % | Productivity CAPEX % | Quality CAPEX % | VAP Dev % | Total CAPEX ($) | CAPEX/Revenue | Regular Workers (end) | Sales HC (end) | On-time | Trust | OP ($) | Cash ($) | Debt ($) | Crisis Q |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| MASS | 90.7% | 0.0% | 0.7% | 8.6% | $75.5M | 2.06% | 14900 | 204 | 55.9% | 58.4 | $32.9M | $132.1M | $25.2M | 4.6 |
| BAL | 80.7% | 2.9% | 1.1% | 15.4% | $73.5M | 1.84% | 11519 | 192 | 100.0% | 79.9 | $33.3M | $379.1M | $0.0M | 0.0 |
| JPQ | 78.7% | 3.4% | 1.6% | 16.3% | $62.9M | 1.97% | 8006 | 164 | 81.9% | 73.3 | $23.9M | $370.2M | $0.0M | 0.0 |
| CONSV | 74.6% | 3.8% | 1.8% | 19.8% | $52.8M | 1.68% | 6638 | 145 | 86.2% | 70.0 | $22.0M | $384.6M | $0.0M | 0.0 |
| VAP | 75.6% | 3.8% | 1.8% | 18.7% | $53.6M | 1.82% | 6956 | 182 | 73.3% | 64.4 | $20.5M | $371.0M | $0.0M | 0.0 |

## VAP Product Development tier distribution (share of turns, avg across baseline runs)

| Company | $0 | $100k | $250k | $500k |
|---|---|---|---|---|
| MASS | 55.6% | 0.1% | 0.5% | 43.8% |
| BAL | 16.4% | 0.1% | 0.0% | 83.5% |
| JPQ | 24.8% | 0.3% | 0.0% | 75.0% |
| CONSV | 18.8% | 0.0% | 0.0% | 81.3% |
| VAP | 22.3% | 0.0% | 1.0% | 76.8% |

## Factory utilization milestones (all factories, baseline runs pooled)

| Company | n (factories) | Avg completion→50% util (turns) | Avg completion→70% util (turns) | Never reached 50% | Never reached 70% | Avg idle quarters |
|---|---|---|---|---|---|---|
| MASS | 66 | 2.6 | 3.5 | 12 | 17 | 1.0 |
| BAL | 50 | 3.0 | 4.0 | 1 | 16 | 1.0 |
| JPQ | 35 | n/a | n/a | 10 | 10 | 1.0 |
| CONSV | 25 | n/a | n/a | 0 | 0 | 1.0 |
| VAP | 25 | n/a | n/a | 0 | 0 | 1.0 |

## High-Vision case (MASS 80k / others 50k)

| Company | Total CAPEX ($) | Regular Workers | Sales HC | On-time | Trust | OP ($) |
|---|---|---|---|---|---|---|
| MASS | $74.0M | 12680 | 180 | 50.6% | 56.2 | $31.0M |
| BAL | $67.3M | 9974 | 260 | 100.0% | 79.3 | $29.8M |
| JPQ | $53.9M | 9393 | 261 | 97.8% | 80.9 | $23.1M |
| CONSV | $57.7M | 9954 | 252 | 97.2% | 80.5 | $31.8M |
| VAP | $66.6M | 9902 | 243 | 82.4% | 72.6 | $21.0M |

## Strategic Posture cases

| Posture | Company | Total CAPEX ($) | On-time | Trust | OP ($) |
|---|---|---|---|---|---|
| AGGRESSIVE_EARLY_CAPACITY | MASS | $56.9M | 51.9% | 57.0 | $30.5M |
| AGGRESSIVE_EARLY_CAPACITY | BAL | $68.3M | 100.0% | 78.9 | $29.0M |
| AGGRESSIVE_EARLY_CAPACITY | JPQ | $53.9M | 97.9% | 80.9 | $23.2M |
| AGGRESSIVE_EARLY_CAPACITY | CONSV | $57.7M | 97.2% | 80.5 | $31.3M |
| AGGRESSIVE_EARLY_CAPACITY | VAP | $67.4M | 82.5% | 72.6 | $21.5M |
| VALUE_FIRST | MASS | $61.5M | 50.1% | 56.0 | $30.0M |
| VALUE_FIRST | BAL | $77.6M | 100.0% | 78.8 | $31.0M |
| VALUE_FIRST | JPQ | $54.4M | 97.8% | 80.8 | $23.0M |
| VALUE_FIRST | CONSV | $57.7M | 97.2% | 80.5 | $30.7M |
| VALUE_FIRST | VAP | $68.2M | 82.1% | 72.3 | $22.2M |

## Anomaly counts by type (baseline benchmark, 125 company-runs)

| Anomaly type | Count | Companies affected |
|---|---|---|
| VAP_DEV_BANG_BANG | 125 | MASS, BAL, JPQ, CONSV, VAP |
| UNDERINVESTMENT_SUSTAINED_BACKLOG | 75 | JPQ, CONSV, VAP |

