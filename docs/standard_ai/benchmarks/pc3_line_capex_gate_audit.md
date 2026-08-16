# Standard AI Investment Portfolio Calibration — Phase PC-3 Line CAPEX Gate Audit

5 scenarios x 5 seeds x 32Q x 3 companies (JPQ/CONSV/VAP) x 3 products, PROFILE ON. 7200 turn-product observations. parameter変更なし（監査のみ）。

## Focus lines: JPQ=VAP line, CONSV=PD line, VAP company=PD line（指示§7）

## First blocker distribution（重点ライン、規約上の優先順位で分類。コードは各gateを独立AND条件で評価しており、下記は報告用の便宜的順序であることに注意）

| Company | Line | Blocker | Count | Share |
|---|---|---|---|---|
| JPQ | VAP | ONGOING_PROJECT | 500 | 62.5% |
| JPQ | VAP | PROPOSED | 112 | 14.0% |
| JPQ | VAP | FINANCE_CASH | 103 | 12.9% |
| JPQ | VAP | SUSTAINED_UTILIZATION | 85 | 10.6% |
| CONSV | PD | ONGOING_PROJECT | 523 | 65.4% |
| CONSV | PD | PROPOSED | 198 | 24.8% |
| CONSV | PD | SUSTAINED_UTILIZATION | 52 | 6.5% |
| CONSV | PD | FINANCE_CASH | 27 | 3.4% |
| VAP | PD | ONGOING_PROJECT | 448 | 56.0% |
| VAP | PD | PROPOSED | 173 | 21.6% |
| VAP | PD | FINANCE_CASH | 129 | 16.1% |
| VAP | PD | SUSTAINED_UTILIZATION | 50 | 6.3% |

## Utilization vs shortfall detail（重点ライン、CAPEX_DEFERRED/CAPEX_PROPOSED時点の平均）

| Company | Line | avg shortfallRatio | avg effectiveShortfallThreshold | avg relevantUtilization | sustainedThreshold | avg overdue (t) | avg healthy forward (t) |
|---|---|---|---|---|---|---|---|
| JPQ | VAP | 3.44 | 1.05 | 93.5% | 92% | 5120 | 4275 |
| CONSV | PD | 2.39 | 1.10 | 94.1% | 92% | 1211 | 6187 |
| VAP | PD | 3.22 | 1.00 | 95.0% | 92% | 5926 | 8019 |

## Space gate occurrence (CAPEX_DEFERRED_INSUFFICIENT_SPACE count, focus lines)

| Company | Line | count |
|---|---|---|
| JPQ | VAP | 0 |
| CONSV | PD | 0 |
| VAP | PD | 0 |

