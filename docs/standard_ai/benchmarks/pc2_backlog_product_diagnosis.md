# Standard AI Investment Portfolio Calibration — Phase PC-2C Product-Level Backlog Diagnosis

5 scenarios x 5 seeds x 32Q x 3 companies (JPQ/CONSV/VAP), PROFILE ON. 2400 turn observations. parameter変更なし（監査のみ）。

## Healthy Forward vs Overdue Backlog（全期間平均、指示補正への対応）

| Company | avg outstanding (t) | avg overdue (t) | avg healthy forward (t) | overdue share | avg on-time delivery |
|---|---|---|---|---|---|
| JPQ | 9395 | 5120 | 4275 | 54.5% | 83.2% |
| CONSV | 7398 | 1211 | 6187 | 16.4% | 87.8% |
| VAP | 13945 | 5926 | 8019 | 42.5% | 74.9% |

## Product-level utilization & requirement/capacity ratio（全期間平均）

| Company | Product | avg utilization | avg requirement/capacity | avg overdue backlog by product (t) |
|---|---|---|---|---|
| JPQ | HOSO | 73.3% | 0.72 | 0 |
| JPQ | PD | 82.3% | 0.82 | 0 |
| JPQ | VAP | 83.4% | 2.65 | 5120 |
| CONSV | HOSO | 75.6% | 0.76 | 0 |
| CONSV | PD | 83.9% | 1.76 | 1211 |
| CONSV | VAP | 81.7% | 0.84 | 0 |
| VAP | HOSO | 66.2% | 0.66 | 0 |
| VAP | PD | 84.7% | 2.46 | 5788 |
| VAP | VAP | 81.9% | 1.33 | 138 |

## Common Processing role（全期間平均）

| Company | avg Common Processing utilization |
|---|---|
| JPQ | 59.9% |
| CONSV | 61.2% |
| VAP | 53.8% |

## Labor role（全期間平均）

| Company | avg regular workers | avg labor shortfall |
|---|---|---|
| JPQ | 6621 | 567.7 |
| CONSV | 5938 | 397.4 |
| VAP | 6611 | 8.6 |

## Forward Capacity Gap at completion horizon（既存newFactoryAssessment.forwardCapacityGap、全期間平均・評価対象四半期のみ）

【重要・監査で確認した既存アーキテクチャ上の制約】decision/newFactory.tsのforwardCapacityGapは、strategicPosture==="AGGRESSIVE_EARLY_CAPACITY"の会社に対してのみ計算される（既存コード仕様、本フェーズでは変更禁止）。JPQ/CONSV/VAPは既定のPostureで稼働しているため、以下の集計は「評価対象四半期0件」になる（バグではなく、既存設計どおりの結果）。したがって本フェーズではcompletion-horizonの真のForward Capacity Gapではなく、上記の「Product-level requirement/capacity比」を代替のproxyシグナルとして用いる（新しい効果値は作らず、既存の観測値の比率として提示するのみ）。

| Company | n turns evaluated | avg forwardCapacityGapTons | avg forwardCapacityGapRatio | newFactoryStatus distribution |
|---|---|---|---|---|
| JPQ | 0 | 0 | 0.00 | NOT_CONSIDERED=285, MONITORING=235, DEFERRED=225, APPROVED=40, READY_TO_BUILD=15 |
| CONSV | 0 | 0 | 0.00 | NOT_CONSIDERED=550, MONITORING=240, DEFERRED=10 |
| VAP | 0 | 0 | 0.00 | NOT_CONSIDERED=800 |

## Line CAPEX role（全期間、code出現数）

| Company | code distribution |
|---|---|
| JPQ | CAPEX_DEFERRED=1603, CAPEX_PROPOSED=245 |
| CONSV | CAPEX_DEFERRED=1502, CAPEX_PROPOSED=269 |
| VAP | CAPEX_DEFERRED=1877, CAPEX_PROPOSED=288 |

## Delivery economics: overdue vs forward backlog unit price（既存SalesContract.unitPriceのみ使用、架空計算なし）

| Company | avg unit price (overdue backlog) | avg unit price (forward backlog) |
|---|---|---|
| JPQ | 7.468 | 7.144 |
| CONSV | 5.689 | 5.502 |
| VAP | 5.671 | 6.176 |

