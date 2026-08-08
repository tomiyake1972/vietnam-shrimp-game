# Standard AI バージョン別スコアカード

すべて standard profile（5社 × 32四半期 × 10 seed = 1,600 company-quarter）。
`environmentFingerprint` が全行で同一であることが、これらが**同じ世界での比較**であることの機械的な証明。

## 環境同一性

| 版 | environmentFingerprint | standardAiFingerprint |
|---|---|---|
| baseline（Cycle 0） | `aabcadf67e6f4444` | `bf652be765da8e3c` |
| C02（revert 済み） | `aabcadf67e6f4444` | `def9503db1ecfb17` |
| **C03（採用）** | `aabcadf67e6f4444` | `e11f7c6f79c3b5b5` |

environmentFingerprint は3版すべてで一致している。ゲーム環境は変更していない。

## 経営指標

| 指標 | baseline | C02（棄却） | **C03（採用）** |
|---|---|---|---|
| 営業利益 | -180,928,719 | -507,601,898 | **+460,106,219** |
| 当期純利益 | -1,464,985,413 | — | **-730,808,453** |
| 成約量 (t) | 11,039,964 | 10,909,687 | 11,044,083 |
| 原料不足 (t) | 6,792,568 | 改善せず | **351,046** |
| 遊休労務費 | 971,418,195 | — | **534,300,317** |
| 平均設備稼働率 | 0.420 | — | 0.420 |
| 平均労働稼働率 | 0.851 | — | 0.879 |
| 債務超過四半期 | 164 | — | **133** |
| 支払不能 | 0 | 0 | 0 |
| 最低現金 | -99,951,400 | — | -47,237,027 |

## 監査 findings

| rule | baseline | C03 |
|---|---|---|
| B_STRATEGIC_MARKET_CONCENTRATION (P3) | 1,600 | 1,600 |
| A01_SALES_FORCE_CONCENTRATION_WITHOUT_OPPORTUNITY | 1,550 | 1,550 |
| A08_LABOR_SHORTAGE_IGNORED | 274 | 343 |
| A07_SALES_WITHOUT_DELIVERY_CAPABILITY | 250 | 250 |
| **A06_PRODUCTION_WITH_RAW_SHORTAGE** | **280** | **98** |
| A14_MARGINAL_SALESFORCE_VALUE_NEGATIVE | 63 | 63 |
| A04_REPEATED_FG_ACCUMULATION | 40 | 40 |
| A13_CONTRACT_FAILURE_REPEATED | 10 | 10 |
| 合計 | 4,067 | 3,954 |
| P0 / P1 / P2 / P3 | 0 / 2,090 / 377 / 1,600 | 0 / 1,908 / 446 / 1,600 |

## 会社別営業利益（1 seed 平均・32四半期累計）

| 会社 | baseline | C03 | 差分 |
|---|---|---|---|
| BAL | +80,304,111 | +81,522,214 | +1,218,103 |
| MASS | -230,223,143 | -170,258,024 | **+59,965,119** |
| JPQ | +59,679,043 | +60,658,966 | +979,923 |
| VAP | +4,264,725 | +5,229,381 | +964,656 |
| CONSV | +67,882,393 | +68,858,085 | +975,692 |

**悪化した会社は無い。**

## 未解決（正直な記録）

- MASS は C03 適用後も 32四半期累計で -170M の赤字。turn 13 以降の完全凍結は解消したが、収益性そのものは未解決。
- A01（JP19）は 1,550件のまま。修正には判断が必要（`TEST15_JP19_ROOT_CAUSE.md`）。
- A08 は 274 → 343 件へ増加。生産計画の現実化により労働制約が可視化された結果と見ているが、未検証。
- capex提案が全版で 0 件。設備投資判断が一度も発火していないこと自体が要調査（Batch 002）。
