# Standard AI Capability Expansion CE-3 — Quality Control Equipment Benchmark

5 scenarios x 5 seeds x 5 companies x 32Q x (OFF, ON). 250 company-runs total (125 per mode). QI-I1のQuality effect（30%/2Qランプ）は不変。

## OFF vs ON — proposal behavior per company (avg across 25 runs/mode)

| Company | Mode | Proposal rate | Avg proposed Turn | Avg Quality Need at proposal | Avg operationalRisk | Quality Equip paid ($) |
|---|---|---|---|---|---|---|
| MASS | OFF | 40% | 16.0 | 0.162 | 0.482 | $0.38M |
| MASS | ON | 36% | 14.8 | 0.146 | 0.491 | $0.34M |
| BAL | OFF | 80% | 12.8 | 0.337 | 0.473 | $0.77M |
| BAL | ON | 80% | 12.8 | 0.338 | 0.473 | $0.77M |
| JPQ | OFF | 84% | 9.7 | 0.310 | 0.483 | $1.01M |
| JPQ | ON | 100% | 3.0 | 0.331 | 0.483 | $1.20M |
| CONSV | OFF | 80% | 7.5 | 0.286 | 0.487 | $0.96M |
| CONSV | ON | 100% | 3.0 | 0.289 | 0.485 | $1.20M |
| VAP | OFF | 80% | 18.3 | 0.349 | 0.478 | $0.96M |
| VAP | ON | 100% | 5.9 | 0.287 | 0.472 | $1.20M |

## Quality outcomes — OFF vs ON (avg across 25 runs/mode)

| Company | Mode | Downgrade (t) | Rework (t) | Disposal (t) | Major incidents | Ending Quality Score | Ending Trust |
|---|---|---|---|---|---|---|---|
| MASS | OFF | 6991 | 3884 | 5615 | 1.8 | 69.6 | 65.6 |
| MASS | ON | 7318 | 4065 | 5901 | 1.9 | 68.7 | 42.3 |
| BAL | OFF | 6943 | 3857 | 5368 | 1.2 | 72.3 | 76.7 |
| BAL | ON | 6982 | 3879 | 5413 | 1.2 | 72.3 | 77.0 |
| JPQ | OFF | 6340 | 3522 | 4525 | 0.6 | 73.3 | 81.0 |
| JPQ | ON | 4539 | 2522 | 3341 | 0.6 | 74.7 | 73.3 |
| CONSV | OFF | 5889 | 3272 | 4140 | 0.8 | 73.8 | 81.4 |
| CONSV | ON | 4615 | 2564 | 3182 | 0.4 | 74.8 | 70.0 |
| VAP | OFF | 5776 | 3209 | 4669 | 1.6 | 71.9 | 79.5 |
| VAP | ON | 4134 | 2297 | 3174 | 1.0 | 74.6 | 64.4 |

## Investment portfolio — $ allocated per company, ON mode (avg across 25 runs)

| Company | PD Mechanization | VAP Product Dev | Quality Equipment | Line CAPEX | New Factory | Total CAPEX | Quality Equip share |
|---|---|---|---|---|---|---|---|
| MASS | $0.0M | $5.1M | $0.3M | $19.1M | $26.4M | $45.8M | 0.7% |
| BAL | $2.4M | $12.1M | $0.8M | $48.1M | $22.0M | $73.3M | 1.0% |
| JPQ | $2.5M | $12.0M | $1.2M | $46.0M | $13.2M | $62.9M | 1.9% |
| CONSV | $2.5M | $13.0M | $1.2M | $49.1M | $0.0M | $52.8M | 2.3% |
| VAP | $2.5M | $12.4M | $1.2M | $49.9M | $0.0M | $53.6M | 2.2% |

## Factory-level before/after (4Q window around equipment completion, all modes/companies pooled)

Note: pools all scenarios/seeds/companies with an observed completion event. Scenario/seed confounding is present — treat as a directional reference, not a causal per-unit effect estimate (指示§35).

| Relative Q | n | Avg operationalRisk | Avg downgrade (t) | Avg rework (t) | Avg disposal (t) | Major incident rate |
|---|---|---|---|---|---|---|
| -4 | 112 | 0.477 | 212.46 | 118.03 | 141.53 | 0.0% |
| -3 | 177 | 0.480 | 197.60 | 109.77 | 131.65 | 0.0% |
| -2 | 177 | 0.496 | 215.60 | 119.78 | 387.44 | 48.6% |
| -1 | 177 | 0.491 | 214.46 | 119.14 | 144.35 | 2.8% |
| +0 | 177 | 0.491 | 216.65 | 120.36 | 207.06 | 14.1% |
| +1 | 177 | 0.489 | 219.65 | 122.03 | 204.49 | 11.3% |
| +2 | 177 | 0.488 | 172.89 | 96.05 | 115.16 | 0.0% |
| +3 | 177 | 0.489 | 128.61 | 71.45 | 99.69 | 2.8% |
| +4 | 172 | 0.491 | 133.54 | 74.19 | 112.49 | 5.8% |

Total factory-completion events captured for before/after analysis: 177.

