# Standard AI バージョン別スコアカード

すべて standard profile（5社 × 32四半期 × 10 seed = 1,600 company-quarter）。
`environmentFingerprint` が全行で同一であることが、これらが**同じ世界での比較**であることの機械的な証明。

## 環境同一性

### Batch 001（単一 environmentFingerprint 時代）

| 版 | environmentFingerprint | standardAiFingerprint |
|---|---|---|
| baseline（Cycle 0） | `aabcadf67e6f4444` | `bf652be765da8e3c` |
| C02（revert 済み） | `aabcadf67e6f4444` | `def9503db1ecfb17` |
| **C03（採用）** | `aabcadf67e6f4444` | `e11f7c6f79c3b5b5` |

environmentFingerprint は3版すべてで一致している。ゲーム環境は変更していない。

### Batch 002（3層分離後）

Batch 002 で情報公開層（プレイヤー・AIが何を観測できるか）を変更したため、fingerprint を
gameMechanics / informationSet / standardAi の3層へ分離した。定義自体が変わったので、
Batch 001 の `aabcadf67e6f4444` とは直接比較できない。

| 版 | gameMechanics | informationSet | standardAi |
|---|---|---|---|
| **Batch 002** | `f34f5465ca1fb52c` | `08c9ca59d35e5c6c` | `f5e17aff9363e7fa` |

**ゲームメカニクスが変わっていないことの直接確認**: 同じ意思決定列を新旧のエンジンへ流した
結果ハッシュが両方とも `6764e40ad66a01b923f71c7159ed380e` で一致した（`git stash` で
Batch 002 以前のコードへ戻して実測）。`advanceCompanyLabQuarter` は `publicInfo` を
引数に取らないため、観測情報がエンジン計算へ入る経路は構造上存在しない。

## 経営指標

| 指標 | baseline | C02（棄却） | C03（採用） | **Batch 002（採用）** |
|---|---|---|---|---|
| 営業利益 | -180,928,719 | -507,601,898 | +460,106,219 | **+8,292,997,450** |
| 当期純利益 | -1,464,985,413 | — | -730,808,453 | **+5,649,409,431** |
| 成約量 (t) | 11,039,964 | 10,909,687 | 11,044,083 | **14,897,200** |
| 原料不足 (t) | 6,792,568 | 改善せず | **351,046** | 355,143 |
| 遊休労務費 | 971,418,195 | — | 534,300,317 | **479,936,530** |
| 完成品在庫（平均, t） | 4,644 | — | 4,643 | **1,668** |
| 平均設備稼働率 | 0.420 | — | 0.420 | **0.548** |
| 平均労働稼働率 | 0.851 | — | 0.879 | **0.893** |
| 債務超過四半期 | 164 | — | 133 | **131** |
| 支払不能 | 0 | 0 | 0 | 0 |
| 最低現金 | -99,951,400 | — | -47,237,027 | -47,256,104 |
| JP営業集中率（平均） | 約50% | — | 約50% | **2.8%** |

## 監査 findings

| rule | baseline | C03 | **Batch 002** |
|---|---|---|---|
| B_STRATEGIC_MARKET_CONCENTRATION (P3・経営判断) | 1,600 | 1,600 | 1,242 |
| **A01_SALES_FORCE_CONCENTRATION_WITHOUT_OPPORTUNITY** | 1,550 | 1,550 | **0** |
| A08_LABOR_SHORTAGE_IGNORED | 274 | 343 | **150** |
| A07_SALES_WITHOUT_DELIVERY_CAPABILITY | 250 | 250 | 257 |
| **A06_PRODUCTION_WITH_RAW_SHORTAGE** | 280 | **98** | 98 |
| A14_MARGINAL_SALESFORCE_VALUE_NEGATIVE | 63 | 63 | 754 |
| A04_REPEATED_FG_ACCUMULATION | 40 | 40 | 34 |
| A13_CONTRACT_FAILURE_REPEATED | 10 | 10 | 10 |
| A15_STALE_MARKET_INFORMATION_OVERREACTION（新規） | — | — | 10 |
| A16_MARKET_SIZE_IGNORED（新規） | — | — | 0 |
| 合計 | 4,067 | 3,954 | 2,555 |
| P0 / P1 / P2 / P3 | 0 / 2,090 / 377 / 1,600 | 0 / 1,908 / 446 / 1,600 | 0 / 365 / 948 / 1,242 |

A14 の 63 → 754、A08 の 274 → 343 は**いずれも悪化ではなく bottleneck migration**である
（`BATCH_002_RESULTS.md` §A・§F・§G）。finding count の増減だけで改善・悪化を判定してはならない。

## 会社別営業利益（1 seed 平均・32四半期累計）

| 会社 | baseline | C03 | **Batch 002** |
|---|---|---|---|
| BAL | +80,304,111 | +81,522,214 | **+297,612,779** |
| MASS | -230,223,143 | -170,258,024 | -170,035,826 |
| JPQ | +59,679,043 | +60,658,966 | **+246,677,565** |
| VAP | +4,264,725 | +5,229,381 | **+257,373,136** |
| CONSV | +67,882,393 | +68,858,085 | **+197,672,092** |

**どの段階でも悪化した会社は無い。** Batch 002 では MASS 以外の4社が大幅に改善した。

## 未解決（正直な記録）

- **MASS は Batch 002 後も -170M の赤字**（唯一改善していない会社）。原因は fixture の設備規模が
  国内原料市場の供給可能量を構造的に超えていることであり、主として environment 側の問題
  （`BATCH_002_RESULTS.md` §C）。
- **capex 提案は依然 0 件**。原因は特定した（`sustained` ゲートが会社全体稼働率0.92を要求するが、
  実測最大は0.877で構造的に到達不可能）。修正は §I により判断待ち（`BATCH_002_RESULTS.md` §D）。
- **A07 は 257件のうち250件が MASS**。MASS の原料制約を扱うのが先。
- **A14 754件**は「営業がボトルネックでなくなった」状態の記述だが、その状態で採用を続けているのは
  実在する非効率（`BATCH_002_RESULTS.md` §F）。
- **観測需要の内生性**: EU・JP市場の需要が32四半期で大きく縮小し、Batch 002 はそれを加速している。
  市場別ウェイトが消費地の希望購買量から決まる既存メカニクスによるもので、AIの撤退が市場縮小を
  自己強化する。`MANAGEMENT_JUDGMENT_REVIEW.md` MJ-005。
