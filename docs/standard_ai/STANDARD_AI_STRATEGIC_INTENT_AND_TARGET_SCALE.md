# Standard AI Strategic Intent / Target Scale Band 設計文書

作成: Cowork #05（AI設定）／2026-08-05
実装ファイル: `strategicIntent.ts`・`targetScale.ts`・`targetCapability.ts`

## 1. 背景・方針（三宅さんご指示の核心）

8Qシミュレーションで営業人員が複利的に指数増加した根本原因は、単なる安全上限の式の誤りだけではなく、**Standard AIに「この会社はどの程度の規模を目指しているのか」という経営上の目安が無かったこと**だった。限界利益が正である限り、会社規模を超えて増員し続ける方向へ進みやすい構造になっていた。

今回導入するのは「8期先の市場を精密予測するAI」ではなく、「8期程度先にどんな会社になりたいかを決め、そのために主として今後4期程度の能力整合性を確認するAI」である。

## 2. 基本フロー

```
Strategic Intent → Target Scale Band → Target Capability → Current/Future Capacity Gap
→ Bottleneck Diagnosis → Candidate Actions → Economics/Feasibility/Finance Check → Final Decision
```

## 3. Strategic Intent

`strategicIntent.ts`に、三宅さんご提示のtype定義をそのまま採用した構造体を実装した。

```ts
interface StrategicIntent {
  growthPosture: "DEFENSIVE" | "BALANCED_GROWTH" | "AGGRESSIVE_GROWTH";
  productDirection: "HOSO_FOCUSED" | "PD_FOCUSED" | "VAP_FOCUSED" | "BALANCED";
  marketConcentration: "DIVERSIFIED" | "FOCUSED";
  financialPosture: "CASH_PRESERVATION" | "BALANCED" | "LEVERAGE_ACCEPTING";
  targetHorizonQuarters: number;
}
```

今回はStandard AI共通の`BALANCED_GROWTH_STRATEGIC_INTENT_V1`（`STANDARD_AI_STRATEGIC_INTENT_V1`としてpolicy.tsが参照）のみを実装し、全社一律で使う。`productDirection`・`marketConcentration`・`financialPosture`は現時点でTarget Scale算定への直接反映はしておらず、将来拡張（会社別性格・AI難易度）の受け皿として型のみ保持している。動的なMVV文章生成・自由文からの戦略決定は今回のスコープ外（三宅さんご指示§19）。将来、`managementProfile.ts`と同様の差し込み口で会社別Strategic Intentへ拡張できる設計にした（`policy.ts`は定数を1箇所差し替えるだけで済む）。

## 4. Target Scale Band

`targetScale.ts`の`computeTargetScaleBand`が算定する。単一値ではなくmin/preferred/maxの帯。

```ts
interface TargetScaleBand {
  quarterlySalesTons: { min: number; preferred: number; max: number };
}
```

### 4.1 算定方法（8期先市場を精密予測しない）

```
currentSustainableScaleTons = 現在の実効生産能力（totalEffectiveCapacityByProduct合計）
targetScaleBand = currentSustainableScaleTons × targetScaleGrowthBandMultiplierByPosture[growthPosture]
```

`targetScaleGrowthBandMultiplierByPosture`（`parameters.ts`に明示パラメータ化）:

| growthPosture | min | preferred | max |
|---|---|---|---|
| DEFENSIVE | 0.90 | 1.00 | 1.10 |
| BALANCED_GROWTH | 1.00 | 1.15 | 1.35 |
| AGGRESSIVE_GROWTH | 1.10 | 1.35 | 1.60 |

### 4.2 実績と能力のどちらを基準にするか（三宅さんご指示§18への対応）

初版では「直近実績と実効生産能力の加重平均」（`targetScaleCapacityWeightInBaseline=0.5`）としていたが、実測で**Target Scale Bandが四半期ごとに大きく動く**（例: BAL turn1 [20,520-23,598-27,702]t → turn2 [15,528-17,857-20,963]t）ことが判明した。三宅さんご指示§18「Target Scaleは毎期激しく変えない」に抵触する挙動である。原因は、直近実績（`lastQuarterActualProductionByProduct`）が四半期ごとの変動が大きいためだった。

**修正**: `targetScaleCapacityWeightInBaseline`を`1.0`（実効生産能力のみ）へ変更した。実効生産能力はcapex完了時以外変化しないため、この修正によりTarget Scale Bandはターンをまたいでも構造的に安定する（回帰テスト`targetScale.test.ts`で固定化）。将来、実績側の情報も使いたい場合は、単純な当期実績ではなく複数四半期の移動平均等、粘着性のある指標へ置き換えることを推奨する（今回は見送り）。

### 4.3 市場機会の方向性（補助情報のみ、精密予測ではない）

`marketOpportunityDirection: "GROWING" | "STABLE" | "WEAKENING"`を、公開ライフサイクルトレンド（`lifecycleTrendByMarket`）の市場×商品全体の単純平均符号から算出する。**Target Scale Band自体を動かす主要因にはしていない**（診断情報として保持するのみ）。未接続（SAI-5C機能OFF、turn1等）の場合は断定せずundefined。

「日本市場シェア27.4%」のような精密予測、LOW/BASE/HIGHの3シナリオ機構は、今回は実装していない（三宅さんご指示§6「初版では市場予測を本格実装するより、Target Scaleの妥当性を確認するための補助情報として扱う」に従い、スコープを絞った）。

## 5. Capacity Planning Horizon（3層の時間軸分離）

```
0〜2Q: operational decisions（既存の各decision/*.tsがそのまま担当。変更なし）
3〜4Q: capacity planning（targetCapability.tsが診断。本番ロジックは変更しない）
5〜8Q: strategic direction / target scale（strategicIntent.ts・targetScale.tsが担当）
```

詳細は`STANDARD_AI_CAPACITY_PLANNING_4Q.md`を参照。

## 6. Target Capability

`targetCapability.ts`の`computeTargetCapability`が、Target Scaleから必要能力を逆算する。今回実装したのは以下（三宅さんご指示§8「今回最重要なのはTarget Sales CapacityとTarget Production Capacity」に対応）。

- **Target Production Capacity（gap診断）**: `productionCapacityGapTons = max(0, targetScaleBand.preferred − 現在の実効生産能力)`。正の場合、稼働中の設備投資案件の有無（`activeCapexProjectTargets`、数量・タイミングは捏造しない）に応じて`FUTURE_CAPEX_SUPPORTS_TARGET_SCALE`または`PRODUCTION_CAPACITY_BELOW_TARGET_SCALE`を診断する。
- **Target Sales Capacity**: `salesForceHiring.ts`側で、Target Scale Bandを直接の入力として使う（詳細は`STANDARD_AI_TARGET_SALES_FORCE_DESIGN.md`）。
- **Financeable Scale（簡易診断）**: 現金の最低バッファ余力を想定変動費単価でトン数へ逆算した`financeableScaleTons`。Target Scale自体を資金理由で変えることはせず、「目標は維持しつつ、現時点では資金制約がprimary bottleneck」という定性的な診断（`FINANCEABLE_SCALE_BELOW_STRATEGIC_TARGET`）に留める（三宅さんご指示§17）。
- **Worker capability gap signal**: Worker本番ロジックは変更しない（三宅さんご指示§15）。現在の生産能力あたり人員密度から単純比例で見積もる、診断専用の粗い信号（`hasWorkerCapabilityGapSignal`）のみを持つ。
- **Raw Material**: 今回、Target Scaleを設定しただけで将来分のraw materialを即購入する経路は存在しない（既存の`procurementResult`は本モジュールより前に計算済みで、本モジュールから一切参照・変更していない。三宅さんご指示§16）。

## 7. 既知の限界

- `productionCapacityGapTons`は商品別ではなく合計ベースの簡略化（既存の`salesForceHiring.ts`の生産余力判定と同じ簡略化方針を踏襲）。
- Financeable Scaleは単四半期近似（既存のFinancial Capacity診断モジュールとの厳密統合は次のステップ）。
- Worker capability gap signalは粗い比例見積りであり、実際のWorker必要人数計算（既存の`labor.ts`）とは独立した診断専用の信号。
