# Standard AI Factory Activation Strategy FA-1 — Benchmark

Part 1 baseline: 5 scenarios x 5 seeds x 5 companies x 32Q x (EXISTING_AI, FACTORY_ACTIVATION_ON), PROFILE ON固定. 250 company-runs.
Part 2 high-Vision: MASS 80k / others 50k (benchmark override only), baseline scenario, 3 seeds x 2 variants. 30 company-runs.
Part 3 Strategic Posture: AGGRESSIVE_EARLY_CAPACITY / VALUE_FIRST, baseline scenario, 3 seeds x 2 variants. 60 company-runs.

## EXISTING_AI vs FACTORY_ACTIVATION_ON per company (avg across 25 runs/variant, baseline benchmark)

| Company | Variant | On-time ratio | Ending Trust | HOSO+PD+VAP production (t) | Regular workers | Avg overtime | OP ($) | Cash ($) |
|---|---|---|---|---|---|---|---|---|
| MASS | EXISTING_AI | 36.4% | 42.3 | 583554 | 7140 | 0.9% | $378.2M | $34.9M |
| MASS | FACTORY_ACTIVATION_ON | 55.9% | 58.4 | 714014 | 14900 | 1.8% | $517.3M | $132.1M |
| BAL | EXISTING_AI | 97.9% | 77.0 | 718374 | 7270 | 0.4% | $699.0M | $342.1M |
| BAL | FACTORY_ACTIVATION_ON | 100.0% | 79.9 | 761641 | 11519 | 1.4% | $745.0M | $379.1M |
| JPQ | EXISTING_AI | 81.9% | 73.3 | 576025 | 7316 | 1.0% | $626.2M | $374.8M |
| JPQ | FACTORY_ACTIVATION_ON | 81.9% | 73.3 | 577026 | 8006 | 1.3% | $626.7M | $370.2M |
| CONSV | EXISTING_AI | 86.2% | 70.0 | 586142 | 6638 | 1.2% | $605.7M | $386.5M |
| CONSV | FACTORY_ACTIVATION_ON | 86.2% | 70.0 | 586139 | 6638 | 1.2% | $603.9M | $384.6M |
| VAP | EXISTING_AI | 73.3% | 64.4 | 516284 | 6956 | 0.2% | $574.8M | $372.4M |
| VAP | FACTORY_ACTIVATION_ON | 73.3% | 64.4 | 516293 | 6956 | 0.2% | $573.7M | $371.0M |

## Factory Activation Lag (turns from factory completion to first meaningful production, all scenarios/seeds pooled)

| Variant | n (factory-completion events) | Avg activation lag (turns) | Median lag | Never produced (n) |
|---|---|---|---|---|
| EXISTING_AI | 70 | n/a | n/a | 70 |
| FACTORY_ACTIVATION_ON | 86 | 2.0 | 2 | 10 |

## High-Vision case (MASS 80k / others 50k)

| Company | Variant | On-time ratio | Ending Trust | OP ($) |
|---|---|---|---|---|
| MASS | EXISTING_AI | 36.9% | 43.8 | $311.0M |
| MASS | FACTORY_ACTIVATION_ON | 47.8% | 54.1 | $387.6M |
| BAL | EXISTING_AI | 52.7% | 41.9 | $468.7M |
| BAL | FACTORY_ACTIVATION_ON | 100.0% | 79.9 | $720.9M |
| JPQ | EXISTING_AI | 57.2% | 48.9 | $480.2M |
| JPQ | FACTORY_ACTIVATION_ON | 96.8% | 80.6 | $600.0M |
| CONSV | EXISTING_AI | 55.2% | 44.5 | $464.6M |
| CONSV | FACTORY_ACTIVATION_ON | 97.2% | 80.3 | $683.1M |
| VAP | EXISTING_AI | 64.7% | 53.9 | $467.7M |
| VAP | FACTORY_ACTIVATION_ON | 82.6% | 72.7 | $549.7M |

## Strategic Posture cases

| Posture | Company | Variant | On-time ratio | Ending Trust | OP ($) |
|---|---|---|---|---|---|
| AGGRESSIVE_EARLY_CAPACITY | MASS | EXISTING_AI | 38.8% | 45.9 | $334.1M |
| AGGRESSIVE_EARLY_CAPACITY | MASS | FACTORY_ACTIVATION_ON | 50.4% | 56.6 | $393.1M |
| AGGRESSIVE_EARLY_CAPACITY | BAL | EXISTING_AI | 55.4% | 45.5 | $469.3M |
| AGGRESSIVE_EARLY_CAPACITY | BAL | FACTORY_ACTIVATION_ON | 100.0% | 79.9 | $734.2M |
| AGGRESSIVE_EARLY_CAPACITY | JPQ | EXISTING_AI | 57.1% | 48.7 | $480.2M |
| AGGRESSIVE_EARLY_CAPACITY | JPQ | FACTORY_ACTIVATION_ON | 96.9% | 80.6 | $601.3M |
| AGGRESSIVE_EARLY_CAPACITY | CONSV | EXISTING_AI | 53.8% | 44.1 | $464.2M |
| AGGRESSIVE_EARLY_CAPACITY | CONSV | FACTORY_ACTIVATION_ON | 97.2% | 80.3 | $683.0M |
| AGGRESSIVE_EARLY_CAPACITY | VAP | EXISTING_AI | 64.7% | 53.9 | $468.1M |
| AGGRESSIVE_EARLY_CAPACITY | VAP | FACTORY_ACTIVATION_ON | 82.7% | 72.7 | $550.3M |
| VALUE_FIRST | MASS | EXISTING_AI | 39.2% | 46.0 | $332.7M |
| VALUE_FIRST | MASS | FACTORY_ACTIVATION_ON | 47.5% | 54.9 | $385.4M |
| VALUE_FIRST | BAL | EXISTING_AI | 72.7% | 50.6 | $551.0M |
| VALUE_FIRST | BAL | FACTORY_ACTIVATION_ON | 100.0% | 79.6 | $720.0M |
| VALUE_FIRST | JPQ | EXISTING_AI | 57.5% | 49.1 | $481.4M |
| VALUE_FIRST | JPQ | FACTORY_ACTIVATION_ON | 96.8% | 80.6 | $619.6M |
| VALUE_FIRST | CONSV | EXISTING_AI | 55.9% | 45.2 | $464.7M |
| VALUE_FIRST | CONSV | FACTORY_ACTIVATION_ON | 97.2% | 80.3 | $688.1M |
| VALUE_FIRST | VAP | EXISTING_AI | 63.0% | 52.4 | $467.4M |
| VALUE_FIRST | VAP | FACTORY_ACTIVATION_ON | 81.8% | 72.1 | $559.9M |

