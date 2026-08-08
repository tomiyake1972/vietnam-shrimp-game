# Findings Batch 001 — Standard AI

baseline: `environmentFingerprint=aabcadf67e6f4444` / `standardAiFingerprint=bf652be765da8e3c` / standard profile（1,600 company-quarter）

機械可読版: `analysis_output/standard_ai_training/baseline_standard_findings.json` / `_findings.csv`

---

## F-001【P0相当・AI_LOGIC_DEFECT】生産計画が原料調達可能性を一切見ていない

**該当ルール**: A06（280件）に現れるが、実際の重大性はルールの severity より高い。MASS の破綻の直接原因。

**観測**: MASS は turn 13 以降、原料在庫 0・現金 0 の状態で **29,070トンの生産計画**を立て続けた。20四半期にわたり計画は1トンも変わらず、実生産量は0だった。

**AI の判断**: `decision/production.ts` の `buildStandardAiProductionPlans` は、生産計画を「当期納品需要 ＋ 在庫目標 − 期首在庫」を設備実効能力でキャップして決める。**原料が手に入るかどうかを参照する行が一行も存在しなかった**（`rawMaterialAvailable` 等の観測値への参照がゼロ）。

**結果の連鎖**:

1. 実行不能な生産計画（29,070t）を立てる
2. `decision/labor.ts` がその計画から必要人員を逆算 → 2,100人では足りないと判定 → `primaryConstraint = worker_shortage`
3. 常用2,100人・臨時735人を保持し続ける → 毎四半期 210万USD の遊休労務費
4. 現金がさらに枯渇 → 原料が買えない → 生産0
5. 1 に戻る（正のフィードバック）

さらに `decision/labor.ts` の縮小判定は `hadPriorQuarterProduction`（前期に生産実績があるか）を条件に持つため、**生産が完全に止まると増員も減員も発火しなくなる**。「最も人員を減らすべき状態」で人員調整が無効化される。

**counterfactual**: 当期に確実に入手・購入できる原料量で生産計画を上限すれば、計画は現実的な水準に落ち、必要人員も落ち、遊休労務費が止まる。

**関連ファイル**: `app/lib/v2/companyLab/standardAi/decision/production.ts`, `.../decision/labor.ts`

**対応**: Cycle 1 で修正（C03）。→ `IMPROVEMENT_CYCLES_BATCH_001.md`

---

## F-002【P1・AI_LOGIC_DEFECT】国内買付の提示価格が常に0（前期参照価格ちょうど）で固定

**観測**: baseline 1,600 company-quarter の**すべて**で `domesticPurchasePriceAdjustment = 0`。値の集合が `[0]` のみ。

**AI の判断**: `decision/procurement.ts` に `priceAdjustmentUsdPerHosoEqKg: ratioAdjustmentToUsd(0, referencePrice)` とリテラル 0 が埋め込まれている。`ratioAdjustmentToUsd` は ±0.3 のクランプを持つ「使われる前提の」ヘルパーとして実装されているにもかかわらず、実際には一度も 0 以外が渡されていない。原料不足が何四半期続いても入札を強める経路が存在しない。

**検証結果（重要）**: Cycle 1 で実際に修正を試みた（C02）が、**Before/After で原料不足が全く改善せず（BAL 3,077→3,077t、MASS 671,616→675,380t）、原料単価だけが上がって全社の営業利益が悪化した**（合計 -180.9M → -507.6M）。したがって「提示価格0が原料不足の原因である」という仮説は**実測により棄却**された。

コードとしては依然として不自然（決定レバーが未接続）だが、**現行シナリオでは国内買付の配分は提示価格で決まっていない**。優先度を下げ、Cycle 1 では revert した。

**関連ファイル**: `app/lib/v2/companyLab/standardAi/decision/procurement.ts:110`

**対応**: 実装せず（実測で棄却）。→ `IMPROVEMENT_CYCLES_BATCH_001.md` C02

---

## F-003【P1・AI_LOGIC_DEFECT + 観測構造の限界】営業人員が市場規模を見ずに配分されている（JP19）

**該当ルール**: A01（1,550件 = 全 company-quarter の97%）

**観測（baseline, BAL, turn 2）**: 営業人員18人の配分が `{JP:9, EU:2, US:2, CN:3, OTHER:2}`。**総員の50%が最小市場のJPに投入されている**。同四半期の市場需要は CN 49,535t / US 36,049t / EU 26,608t / **JP 9,395t** / OTHER 16,637t。

**AI の判断**: `decision/sales.ts:285-291`

```ts
markets.forEach((market, idx) => {
  const weight = idx === 0 ? 0.5 : 0.5 / (markets.length - 1 || 1);
  ...
});
```

`markets = pressures.marketPriceRanking` は**前期参照価格の合計だけ**で並べ替えたもの。市場規模は一切考慮されない。首位市場に固定で 50%、残り4市場に 12.5% ずつを配る。

**根の深さ**: これは単なる係数の誤りではない。`types.ts` の `MarketObservationEntry` は

```ts
export interface MarketObservationEntry {
  readonly market: DemandMarketId;
  readonly referencePriceByProduct?: ProductAmount;  // 価格のみ
}
```

であり、市場別の絶対需要量を持たない。`MarketQuarterResult` にも市場別の需要数量は存在しない（`worldDemand` のみ）。**Standard AI は市場の大きさを構造的に観測できない。** 詳細は `TEST15_JP19_ROOT_CAUSE.md`。

**対応**: Cycle 1 では未修正。修正には観測構造の扱いについての判断が要るため、`TEST15_JP19_ROOT_CAUSE.md` に選択肢を整理して判断を仰ぐ。

---

## F-004【P1・AI_LOGIC_DEFECT】納品能力を超える成約（A07: 250件）

**観測**: 生産量＋完成品在庫を大きく超える量を新規成約している四半期が 250 件。延滞四半期数 250 と一致する。MASS では生産0の状態でも毎四半期 4,000〜5,000t を成約し続けていた。

**AI の判断**: 販売計画は営業能力と市場魅力度から決まり、「その量を実際に納品できるか」の事前チェックが弱い。

**対応**: Cycle 1 の C03（生産計画の実行可能性ガード）で間接的に改善（A07 は 250 件で横ばいだが、MASS の延滞の絶対量は減少）。直接の対処は Batch 002 以降。

---

## F-005【P2・AI_LOGIC_DEFECT】労働不足に対する無手当（A08: 274件）

**観測**: 労働不足が出ているのに残業・臨時・採用のいずれも動いていない四半期が 274 件。F-001 で述べた `hadPriorQuarterProduction` ガードが主因の一部。

**対応**: Batch 002 以降。C03 適用後は 343 件へ増加している（生産計画が現実化した結果、労働制約が「見える」ようになったための増加であり、悪化ではない可能性が高い。要検証）。

---

## F-006【P3・MANAGEMENT_JUDGMENT_REVIEW】特定市場への継続的な営業集中

全 company-quarter で発火（1,600件）。F-003 と同じ現象を経営判断の側から見たもの。集中戦略そのものは誤りとは限らないため、Claude Code の判断では変更しない。**この点は経営哲学として判断を仰ぐ。**

---

## ENVIRONMENT_ISSUE_CANDIDATE

今回の baseline では、ゲーム環境側の不具合と断定できる事象は**検出されなかった**。以下は観察されたが、環境の不具合ではないと判断した。

- MASS が現金 -99,826,000 USD まで到達しても `paymentDefault = false` のまま継続する。ただし `insolvent = true` は turn 16 から正しく立っている。シミュレーションを止めずに走らせる仕様と整合的であり、不具合ではないと判断した。
- MASS の借入要求が全四半期で承認額 0。他社は 1,600行中 530行で承認されているため、審査ロジックが動かないのではなく MASS の信用状態が理由と判断した。
