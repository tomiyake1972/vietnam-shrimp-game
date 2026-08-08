# Baseline Benchmark — Standard AI（Cycle 0）

実行: `npx tsx scripts/standardAiTraining.ts --profile standard --label baseline`

## 実行条件

| 項目 | 値 |
|---|---|
| profile | standard（5社 × 32四半期 × 10 seed = 1,600 company-quarter） |
| environmentFingerprint | `aabcadf67e6f4444` |
| standardAiFingerprint | `bf652be765da8e3c` |
| branch | `feature/v2-standard-ai-training-harness` |
| parametersVersion | market `market-params-2015-baseline-v0.1` / sales `sales-v0.1` / rawMaterials `raw-materials-v0.1` / production `production-v0.2` / finance `finance-v0.1` |

## 経営成績（10 seed 合計）

| 指標 | 値 |
|---|---|
| 成約量 | 11,039,964 t |
| 営業利益 | **-180,928,719 USD** |
| 当期純利益 | -1,464,985,413 USD |
| 原料不足 | **6,792,568 t** |
| 遊休労務費 | 971,418,195 USD |
| 平均設備稼働率 | 0.420 |
| 平均労働稼働率 | 0.851 |
| 債務超過四半期 | 164 / 1,600 |
| 支払不能 | 0 |
| capex提案 | 0 |

## 会社別（1 seed あたり平均・32四半期累計）

| 会社 | 成約量 | 営業利益 | 原料不足 | 遊休労務費 | 設備稼働率 |
|---|---|---|---|---|---|
| BAL | 314,973 t | +80,304,111 | 3,077 t | 7,996,387 | 0.56 |
| **MASS** | 177,178 t | **-230,223,143** | **671,616 t** | **64,740,852** | **0.06** |
| JPQ | 238,557 t | +59,679,043 | 1,917 t | 8,135,333 | 0.58 |
| VAP | 123,833 t | +4,264,725 | 1,460 t | 9,346,511 | 0.27 |
| CONSV | 249,455 t | +67,882,393 | 1,187 t | 6,922,736 | 0.64 |

**全体の赤字はほぼ全て MASS 1社に由来する。** 他4社は黒字であり、業界全体が破綻しているわけではない。

## 監査 findings

| rule | 件数 |
|---|---|
| B_STRATEGIC_MARKET_CONCENTRATION（P3・経営判断） | 1,600 |
| A01_SALES_FORCE_CONCENTRATION_WITHOUT_OPPORTUNITY | 1,550 |
| A06_PRODUCTION_WITH_RAW_SHORTAGE | 280 |
| A08_LABOR_SHORTAGE_IGNORED | 274 |
| A07_SALES_WITHOUT_DELIVERY_CAPABILITY | 250 |
| A14_MARGINAL_SALESFORCE_VALUE_NEGATIVE | 63 |
| A04_REPEATED_FG_ACCUMULATION | 40 |
| A13_CONTRACT_FAILURE_REPEATED | 10 |
| **合計** | **4,067**（P0 0 / P1 2,090 / P2 377 / P3 1,600） |

## MASS の四半期推移（seed `sai-train-standard-001`）

| turn | 成約 | 生産 | 原料在庫 | 原料不足 | 設備稼働 | 労働稼働 | 遊休労務費 | 現金 |
|---|---|---|---|---|---|---|---|---|
| 1 | 6,936 | 12,139 | 0 | 8,311 | 40% | 100% | 6,621,832 | 35,277,249 |
| 5 | 6,650 | 6,556 | 2,586 | 0 | 21% | 100% | 479,850 | 0 |
| 9 | 6,547 | 2,449 | 0 | 11,341 | 8% | 59% | 1,492,545 | -3,183,660 |
| 12 | 5,966 | 2,921 | 0 | 22,800 | 10% | 63% | 1,360,418 | -8,335,302 |
| **13** | 5,684 | **0** | 0 | 29,070 | **0%** | **0%** | 2,100,000 | 0 |
| 20 | 4,962 | 0 | 0 | 29,070 | 0% | 0% | 2,100,000 | -36,778,000 |
| 32 | 4,435 | 0 | 0 | 29,070 | 0% | 0% | 2,100,000 | -99,826,000 |

turn 13 以降、**MASSの意思決定は四半期ごとに完全に同一の値で凍結する**（生産計画 29,070t、国内買付 11,628t、輸入 4,361t、養殖 11,305t、常用2,100人、臨時735人）。生産量は0のまま、遊休労務費だけが毎四半期 210万USD 出続け、現金は一定額ずつ減り続ける。20四半期にわたって同じ誤りを繰り返し、そこから抜け出す挙動が一切ない。

これが Cycle 1 の主対象となった（`FINDINGS_BATCH_001.md` / `IMPROVEMENT_CYCLES_BATCH_001.md`）。
