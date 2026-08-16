# Standard AI Investment Portfolio Calibration — Phase PC-2B MASS PD Mechanization Sensitivity Audit

5 scenarios x 5 seeds x 32Q x 5 companies, PROFILE ON. 7395 candidate-quarter observations. parameter変更なし（監査のみ）。

## Company comparison (PD_MECH_CONSIDERED以降の候補観測のみ、rows with keyValues)

| Company | n candidates | avg PD utilization | avg PD tons est. | avg labor savings HC | avg quarterly saving ($) | avg raw payback (Q) | avg strategyFitMultiplier | avg financialConservatismRatio | avg effectiveMaxPayback (Q) | eligible (raw<=effective) rate |
|---|---|---|---|---|---|---|---|---|---|---|
| MASS | 859 | 64.2% | 4603 | 153.4 | $153424 | 16.9 | 0.792 | 1.000 | 9.5 | 0.0% |
| BAL | 299 | 67.5% | 5446 | 181.5 | $181537 | 14.4 | 1.000 | 1.000 | 12.0 | 1.8% |
| JPQ | 25 | 54.2% | 5945 | 198.2 | $198178 | 12.6 | 1.118 | 1.000 | 13.4 | 2.7% |
| CONSV | 67 | 61.0% | 5503 | 183.4 | $183436 | 13.7 | 1.211 | 1.050 | 13.8 | 4.5% |
| VAP | 32 | 76.8% | 5130 | 171.0 | $171000 | 14.6 | 1.412 | 1.000 | 16.9 | 3.2% |

## MASS neutral-profile shadow calculation (strategyFitMultiplier=1.0と仮定、audit-only、production behaviorは変更しない)

- 実際のeligible件数（raw payback <= 実際のeffectiveMaxPaybackQuarters）: 0 / 859
- PD_MECH_PAYBACK_UNATTRACTIVEだった859件のうち、strategyFitMultiplier=1.0（neutral）と仮定した場合にeligibleになる件数: 7 / 859

## MASS sensitivity sweep (strategyFitMultiplier 0.8/0.9/1.0/1.1, audit-only shadow calc)

| strategyFitMultiplier | eligible rate (among PD_MECH_PAYBACK_UNATTRACTIVE observations) |
|---|---|
| 0.8 | 0.0% (0/859) |
| 0.9 | 0.0% (0/859) |
| 1.0 | 0.8% (7/859) |
| 1.1 | 4.9% (42/859) |

