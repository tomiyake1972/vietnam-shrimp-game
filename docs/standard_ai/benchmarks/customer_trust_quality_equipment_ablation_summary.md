# CE-3A — Quality Equipment Controlled Ablation Benchmark

5 scenarios x 5 seeds x 5 companies x 32Q x (QUALITY_EQUIP_ON, QUALITY_EQUIP_DISABLED). PROFILE ON固定。250 company-runs total.

## Δ attribution per company (ON - DISABLED, avg across 25 runs/variant)

| Company | ΔQuality Score | ΔTrust | Δdowngrade(t) | Δrework(t) | Δdisposal(t) | Δincident | ΔonTimeRatio | Δbacklog(newlyOverdue+continuing) |
|---|---|---|---|---|---|---|---|---|
| MASS | 0.32 | 0.55 | -72 | -40 | -73 | -0.04 | 0.15pp | -24585 |
| BAL | 2.46 | 2.49 | -1559 | -866 | -1499 | -0.40 | 0.60pp | -2014 |
| JPQ | 4.51 | 2.52 | -2457 | -1365 | -1904 | -0.80 | 0.21pp | -7483 |
| CONSV | 4.53 | 2.63 | -2557 | -1421 | -1931 | -0.80 | 0.77pp | -5829 |
| VAP | 4.60 | 3.56 | -1955 | -1086 | -1608 | -0.60 | 0.29pp | -7233 |

## Full KPI comparison per company (avg across 25 runs/variant)

| Company | Variant | Proposed | Completed | Quality Score | Trust | On-time ratio | Backlog(t) | Revenue($) | OP($) | Cash($) |
|---|---|---|---|---|---|---|---|---|---|---|
| MASS | QUALITY_EQUIP_ON | 0.36 | 0.16 | 68.7 | 42.3 | 36.4% | 815695 | $3044.6M | $378.2M | $34.9M |
| MASS | QUALITY_EQUIP_DISABLED | 0.00 | 0.00 | 68.4 | 41.7 | 36.3% | 840280 | $3047.0M | $378.6M | $35.0M |
| BAL | QUALITY_EQUIP_ON | 0.80 | 0.64 | 72.3 | 77.0 | 97.9% | 8166 | $3816.3M | $699.0M | $342.1M |
| BAL | QUALITY_EQUIP_DISABLED | 0.00 | 0.00 | 69.8 | 74.6 | 97.3% | 10180 | $3829.5M | $691.2M | $336.4M |
| JPQ | QUALITY_EQUIP_ON | 1.00 | 1.00 | 74.7 | 73.3 | 81.9% | 183045 | $3205.8M | $626.2M | $374.8M |
| JPQ | QUALITY_EQUIP_DISABLED | 0.00 | 0.00 | 70.2 | 70.8 | 81.7% | 190528 | $3194.6M | $613.3M | $368.2M |
| CONSV | QUALITY_EQUIP_ON | 1.00 | 1.00 | 74.8 | 70.0 | 86.2% | 46061 | $3157.6M | $605.7M | $386.5M |
| CONSV | QUALITY_EQUIP_DISABLED | 0.00 | 0.00 | 70.3 | 67.4 | 85.4% | 51890 | $3151.6M | $594.8M | $379.3M |
| VAP | QUALITY_EQUIP_ON | 1.00 | 1.00 | 74.6 | 64.4 | 73.3% | 209967 | $2957.0M | $574.8M | $372.4M |
| VAP | QUALITY_EQUIP_DISABLED | 0.00 | 0.00 | 70.0 | 60.9 | 73.0% | 217199 | $2948.7M | $564.6M | $365.6M |

