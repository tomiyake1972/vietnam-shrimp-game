# Strategy Profile Audit — Decision Connection Matrix (Phase SP-A1)

branch `feature/v2-32q-management-console` @ HEAD `ce030f0`

本ドキュメントは、Standard AI の各意思決定ドメインが Mission / Vision / Product Direction /
Strategy Profile / Strategic Posture のどれを実際に読んでいるかを、コード（file:line）に
基づいて分類したものである。分類は DIRECT / INDIRECT / DISPLAY_ONLY / NOT_CONNECTED の4段階。

## 用語の重要な前提

このコードベースには「Vision」という名前の**互いに無関係な2つの概念**が存在する。混同すると
監査結果を誤る。

1. **`CompanyVision`**（`app/lib/v2/companyLab/vision/types.ts`）— `growthAmbition` /
   `targetScaleTonsPerQuarterAtQ32` / `willingnessToBuildFactories` / `financialRiskTolerance` /
   `preferredEndState` / `desiredProductEvolution` / `strategicPosture` を持つ構造化オブジェクト。
   Standard AI の実際の数値判断（`commercialAmbition.ts` / `strategicGrowth.ts` / `newFactory.ts`）
   に接続されているのはこちらである。**本マトリクスの「Vision」「Strategic Posture」列はこれを指す。**
2. **`CompanyStrategyDocument.vision`**（`app/lib/v2/companyLab/strategyProfile/types.ts:83`）—
   `.mission` と対をなす自由文字列。このモジュール自身のヘッダーコメントが明記する：
   *"Strategy Profile を Standard AI の数値判断へ反映する処理は実装しない"*
   *"本モジュールは standardAi/ を一切 import しない"*（`strategyProfile/types.ts:14-19`）。
   `standardAi/` 配下のどこからも `strategyProfile/*` を import していないことをgrepで確認済み
   （`simulation/engine.ts:46` がスキーマバージョン定数だけを永続化用に読むのみ）。この自由文の
   `vision`/`mission` は `CompanyInspector.tsx:446-448` に **「Mission / Vision（自由文。数値判断には
   未使用）」** という見出しでそのまま表示される。

したがって **Mission と Strategy Profile（モジュール）は、全19行にわたって DISPLAY_ONLY**
である。これはコード自身が明言している設計であり、推測ではない。

同様に **「Product Direction」は `CompanyVision.desiredProductEvolution`** に対応する
（`vision/defaults.ts` で会社別に設定され、例: MASS = `HOSO_SCALE`）。`CompanyInspector.tsx:260`
（「商品構成の方向」）や AI Pack（`aiPack/capture.ts:255`）へエクスポートされてはいるが、
`decision/*.ts` / `diagnosis/*.ts` / `vision/*.ts` / `policy.ts` のいずれからも読まれていない
ことをgrepで確認済み — **全19行で DISPLAY_ONLY**。
（`strategicIntent.ts:33,48` にも `StrategicIntent.productDirection` という別の同名フィールドが
存在するが、全社一律 `"BALANCED"` 固定でコメントに「現時点ではTarget Scale算定への直接反映は
せず」と明記されており、これも未使用。結論に影響しない。）

## マトリクス

| # | 意思決定ドメイン（関数） | Mission | Vision (`CompanyVision`) | Product Direction | Strategy Profile（モジュール） | Strategic Posture |
|---|---|---|---|---|---|---|
| 1 | Sales market selection — `buildStandardAiSalesPlans`（`decision/sales.ts:315`） | DISPLAY_ONLY | INDIRECT — Vision由来の`ambitionMultiplier`/`submissionTargetTons`を市場別按分（`policy.ts:452-460`→`sales.ts:379-384,496-523`） | DISPLAY_ONLY | DISPLAY_ONLY | NOT_CONNECTED |
| 2 | Sales product mix（同関数） | DISPLAY_ONLY | NOT_CONNECTED — ambition倍率はHOSO/PD/VAPへ一律適用され構成比は動かさない（`sales.ts:380-384`） | DISPLAY_ONLY — 読まれていない | DISPLAY_ONLY | NOT_CONNECTED |
| 3 | Pricing — `priceAdjustmentRatioByProduct`（`decision/sales.ts:260-274`） | DISPLAY_ONLY | NOT_CONNECTED — シグネチャに`(observation, pressures, params)`のみでambition/Vision引数無し | DISPLAY_ONLY | DISPLAY_ONLY | NOT_CONNECTED |
| 4 | Sales hiring — `buildStandardAiSalesForceHiringDecision`（`decision/salesForceHiring.ts`） | DISPLAY_ONLY | INDIRECT — `commercialAmbitionTons`引数、`strategicTargetTons=max(targetScaleBand.max, commercialAmbitionTons)`（`:357`、`policy.ts:636`で配線） | DISPLAY_ONLY | DISPLAY_ONLY | NOT_CONNECTED |
| 5 | Production requirement/plan — `buildStandardAiProductionPlans`（`decision/production.ts:41`） | DISPLAY_ONLY | INDIRECT — Vision駆動sales（`policy.ts:478-493`）の下流 | DISPLAY_ONLY | DISPLAY_ONLY | NOT_CONNECTED |
| 6 | Procurement — `buildStandardAiProcurementPlan`（`decision/procurement.ts:40`） | DISPLAY_ONLY | INDIRECT — production planの下流（`policy.ts:497`）、関数自体にvision参照無し | DISPLAY_ONLY | DISPLAY_ONLY | NOT_CONNECTED |
| 7 | Worker hiring — `buildStandardAiWorkerAssignments`（`decision/labor.ts:49`） | DISPLAY_ONLY | INDIRECT — productionPlans引数、同じ上流連鎖 | DISPLAY_ONLY | DISPLAY_ONLY | NOT_CONNECTED |
| 8 | New Factory — `evaluateNewFactoryDecision`（`decision/newFactory.ts:985`） | DISPLAY_ONLY | **DIRECT** — `vision.willingnessToBuildFactories`（`:313-314`）、`vision.financialRiskTolerance`（`:595,900`）、`vision.preferredEndState`、`vision.targetScaleTonsPerQuarterAtQ32`（`:641`）、`vision.effectiveFromTurn`（Gate A、`:264-275`） | DISPLAY_ONLY | DISPLAY_ONLY | **DIRECT** — `isAggressive = vision?.strategicPosture === "AGGRESSIVE_EARLY_CAPACITY"`がStrategic Forward-Capacity route全体をゲート（`:991-1002`） |
| 9 | Common Processing line — `buildStandardAiCapexDecision`（`capex.ts:591-647`） | DISPLAY_ONLY | INDIRECT — Vision駆動sales/productionの下流（`policy.ts:506-513`）。関数自体にvision引数無し | DISPLAY_ONLY | DISPLAY_ONLY | NOT_CONNECTED |
| 10 | Freezing/Packaging line | — | — | — | — | — |
| 11 | HOSO Line — `capex.ts:335-486`（`hosoLineExpansion`） | DISPLAY_ONLY | INDIRECT — 同じ連鎖を`.hoso`経由（`:346`） | DISPLAY_ONLY | DISPLAY_ONLY | NOT_CONNECTED |
| 12 | PD Line — 同ループ（`pdLineExpansion`） | DISPLAY_ONLY | INDIRECT — `.pd`経由 | DISPLAY_ONLY | DISPLAY_ONLY | NOT_CONNECTED |
| 13 | VAP Line — 同ループ（`vapLineExpansion`） | DISPLAY_ONLY | INDIRECT — `.vap`経由 | DISPLAY_ONLY | DISPLAY_ONLY | NOT_CONNECTED |
| 14 | PD Mechanization | — | — | — | — | — |
| 15 | VAP Product Development | — | — | — | — | — |
| 16 | Quality investment | — | — | — | — | — |
| 17 | Environmental investment | — | — | — | — | — |
| 18 | Borrowing/Finance — `buildStandardAiFinancingRequest`（`decision/finance.ts:26`）+ `assessWorkingCapitalNeed` | DISPLAY_ONLY | INDIRECT — `procurementCashPlan`引数（`policy.ts:502-505`）は下流連鎖、直接のvision参照無し | DISPLAY_ONLY | DISPLAY_ONLY | NOT_CONNECTED |
| 19 | Crisis Management（CM-1）— `assessStandardAiCrisisState`＋`applyCrisisGateToCommercialCommitment`（`crisisState.ts:94,170`） | DISPLAY_ONLY | NOT_CONNECTED — 入力は財務シグナルのみ。コード自身が明記：「Vision・Commercial Ambition（志そのもの）はこの関数の入力にも出力にも一切現れない」（`crisisState.ts:161-162`） | DISPLAY_ONLY | DISPLAY_ONLY | NOT_CONNECTED |

**10・14・15・16・17行 — フラグ: Standard AI 側に対応関数が一切存在しない。**

`STANDARD_AI_PROPOSABLE_CAPEX_TYPES`（`decision/capex.ts:70-82`）が「Standard AIが提案しうる
全て」の唯一の情報源であり、`hosoLineExpansion | pdLineExpansion | vapLineExpansion |
commonProcessingExpansion | newFactoryConstruction` の5種類に構造的に限定されている。
`capex.ts:14-18` に明示的な理由：「冷凍・包装処理能力／保管能力／品質管理設備／環境設備は
生産のボトルネックへの直接効果が薄い…SAI-1のスコープ判断」— 意図的なスコープ外であり、
配線漏れではない。これら5ドメインには判断関数自体が存在しないため、全セルが定義上
NOT_CONNECTED である。

## 列ごとの総括

- **Mission**: 全ドメインで DISPLAY_ONLY。`.mission`が意思決定コードから読まれた箇所はゼロ。
- **Vision**: 唯一 DIRECT 接続を持つ列。ただしDIRECTは **New Factory のみ**
  （`willingnessToBuildFactories` / `financialRiskTolerance` / `preferredEndState` /
  `targetScaleTonsPerQuarterAtQ32` / `effectiveFromTurn` / `growthAmbition`経由の
  `strategicGrowth`）。それ以外は全て、`policy.ts:407-450`の単一のチョークポイント
  （`commercialAmbition.ambitionMultiplier` / `commercialCommitment.submissionTargetTons`）
  を経由したINDIRECT接続。Crisis Managementは意図的にVisionを見ない設計上の例外。
- **Product Direction**（`desiredProductEvolution`）: 全ドメインでDISPLAY_ONLY —
  設定され・エクスポートされ・UI表示されるが、どの計算にも一切読まれない。意味的には
  Sales product mixを駆動すべきフィールドがそうなっていない、という最も明確なギャップ。
- **Strategy Profile**（新モジュール）: 全ドメインでDISPLAY_ONLY — モジュール自身の
  明示的な非目標宣言どおり、`standardAi/`への import がゼロであることをgrepで確認済み。
- **Strategic Posture**（`vision.strategicPosture`）: New Factoryのみ DIRECT
  （`AGGRESSIVE_EARLY_CAPACITY`がForward-Capacity routeをゲート）。他18ドメインは
  全てNOT_CONNECTED — `capex.ts` / `sales.ts` / `production.ts` / `procurement.ts` /
  `labor.ts` / `finance.ts` / `salesForceHiring.ts` / `crisisState.ts` のいずれにも
  一切出現しないことをgrepで確認済み。
