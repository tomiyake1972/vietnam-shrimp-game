# ShrimpX V2 — 長期シナリオ・イベントモジュール アーキテクチャ v0.1（Phase 2）

対象コード: `app/lib/v2/scenario/`
関連ドキュメント: `docs/v2/CORE_ARCHITECTURE_v0.1.md`、`docs/v2/MARKET_PRICING_ARCHITECTURE_v0.1.md`

## 1. 本モジュールの責務・非責務

### 責務

- 疾病・拡張投資・景気変動・貿易規制・物流混乱といった外生イベントと、能力・コスト・需要の緩やかな長期トレンドをシナリオ定義として表現する。
- ターンごとに、これらのイベント・トレンドから「基礎変数」（`ScenarioBaseVariable`）の値を導出する。
- 基礎変数のうち、市場モジュール（Phase1）の既存入力型が受け取れるものだけを `MarketQuarterInput` へ変換する（`marketAdapter.ts`）。
- シナリオ内部の真実と、プレイヤー・AI会社が知る情報を分離する（`informationEngine.ts`）。
- Canonical（外生イベント固定）／Variation（許容範囲内でジッター）の2モードを提供する。
- 5つの代表シナリオ（`definitions/`）を提供する。

### 非責務（本モジュールが絶対にしないこと）

- **価格を直接決定しない。** `ScenarioBaseVariable` の一覧に価格そのもの（HOSO価格・国内原料価格・PD/VAPプレミアム）は一切含まれていない。価格を計算できるのは市場モジュール（`app/lib/v2/market`）だけであり、本モジュールのイベント・トレンドは必ず基礎変数（能力・生残率・コスト・需要指数等）にのみ作用する。この制約は型レベルで強制されている：`ScenarioEffect.variable` の型が `ScenarioBaseVariable` である限り、「疾病→HOSO価格+10%」のような効果を書こうとしてもコンパイルが通らない。
- 画面・API・Redis保存には依存しない（Phase1市場モジュールと同じ独立性の原則）。
- Vietnam5社の意思決定・生成AI呼び出し・実際のゲーム進行への接続は行わない。

## 2. 型の全体像

```
ScenarioDefinition
├── prehistory: ScenarioPrehistory              前史（2〜4年）
├── initialStateOverrides: ScenarioInitialStateOverrides
├── longTermTrends: LongTermTrend[]              緩やかな背景トレンド
├── scheduledEvents: ScenarioEvent[]              突発イベント
├── informationReleases: InformationRelease[]     情報公開
└── variationSettings: ScenarioVariationSettings  Canonical/Variation設定

ScenarioState (initializeScenarioの戻り値)
├── definition
├── mode: "canonical" | "variation"
├── resolvedEvents: ResolvedScenarioEvent[]       イベントをmodeに応じて解決した結果
└── turnHistory: ScenarioTurnRecord[]             advanceScenarioTurnで蓄積される実現フィードバック

getScenarioTurnInput(state, turn) → ScenarioTurnInput
├── countries: Record<CountryId, ScenarioTurnCountryVariables>
├── demandMarkets: Record<DemandMarketId, ScenarioTurnMarketVariables>
└── ...

toMarketQuarterInput(turnInput, previousMarketContext) → MarketQuarterInput（Phase1市場モジュールの入力）
```

## 3. 基礎変数と価格を切り離す設計

`ScenarioBaseVariable`（`types.ts`）は次の20種類のみを含む。国別養殖能力・放養量・能力稼働率・養殖生産性・生残率・疾病圧力・輸出適格率・養殖コスト・飼料エネルギー人件費コスト・国別輸出可能供給量(直接上書き用)・PD加工能力・VAP加工能力・地域別潜在需要・景気指数・消費成長率・冷凍在庫・物流能力・貿易規制・供給信頼性・品質評価。

イベント・トレンドはこの変数一覧にのみ作用できる。価格系の変数は意図的に存在しないため、「疾病→HOSO価格+10%」のような効果は型エラーになる。基礎変数から実際に価格を計算するのは市場モジュールのみである。

各変数には `VARIABLE_SCOPE`（country / market / global）と `VARIABLE_DOMAIN`（値域。例: `SURVIVAL_RATE` は[0,1]、`QUALITY_SCORE` は[0,100]）が定義されており、イベント効果を適用した後は必ずこの値域へclampされる（`eventEngine.ts` の `applyComposedEffect`）。

## 4. ターン処理の流れ

```
1. initializeScenario(definition, mode, randomSeed)
   → assertValidScenarioDefinition() で検証
   → RandomStream作成
   → resolveScenarioEvents() でイベントをmodeに応じて解決（ScenarioState.resolvedEvents）

2. getScenarioTurnInput(state, turn)
   国別変数ごとに:
     a. LongTermTrendが明示的に定義されていればinterpolateTrendValue()で値を得る
        （無ければscenario/parameters.tsの既定値、または前史からの逆算値）
     b. composeEventEffects()で、そのturnに強度>0で有効な全イベントの効果を
        (変数, 対象) ごとに合成する
     c. applyComposedEffect()で a の値に b を適用し、VARIABLE_DOMAINへclamp
   production = capacity × utilization × survivalRate × productivity
   （EXPORTABLE_SUPPLYに明示トレンドがあればそちらを優先）

3. toMarketQuarterInput(turnInput, previousMarketContext)
   → 接続可能なサブセットだけをMarketQuarterInputへ変換

4. calculateMarketQuarter(marketInput, MARKET_PARAMETERS_V1, randomStream)
   → Phase1市場モジュールが価格を計算（本モジュールの責務外）

5. advanceScenarioTurn(state, { realizedMarketResult, externalProducerResponses })
   → turnHistoryへ記録し、currentTurnを1進める
```

## 5. イベントの発現曲線（ramp-up / duration / recovery）

`eventEngine.ts` の `calculateEventIntensity(rampUpTurns, durationTurns, recoveryTurns, relativeTurn)` が強度を [0,1] で返す。

- `relativeTurn < 0`: 0（開始前は無効）
- `0 <= relativeTurn < rampUpTurns`: `relativeTurn / rampUpTurns` で線形に立ち上がる（`rampUpTurns=0` なら即100%）
- `rampUpTurns <= relativeTurn < rampUpTurns + durationTurns`: 1（継続期間中は満額）
- 継続期間後、`recoveryTurns` の間に線形に0へ回復する（`recoveryTurns=0` なら即0%）
- それ以降: 0（完全終了）

## 6. 複数イベント重複時の合成規則

実装指示 §7「重複時の合成規則を定義し、文書化」に対応する、本モジュールの核となる設計判断。

- **multiplicative効果**: `magnitude` を倍率として扱う（例: `1.08` = +8%）。複数イベントが同じ (変数, 対象) に重複した場合、**倍率を掛け合わせる**（単純な差分の合算にはしない）。例えば -10% の効果を持つイベントが2件重複すると `0.9 × 0.9 = 0.81`（-19%相当）になり、単純合算の -20% にはならない。実際の適用値は「1からの乖離」に強度・`resolvedMagnitudeScale` を掛けたものを使う（`(magnitude - 1) × intensity × magnitudeScale`）ため、強度が低いイベントは1に近い倍率にしかならない。
- **additivePoint効果**: `magnitude` をポイント差分として扱う（例: `-0.18`、`-6`）。複数イベントが重複した場合、**差分を単純に合算する**（例: 生残率 `-18pt` と `-5pt` が重なれば `-23pt`）。
- **最終値**: multiplicative適用 → additivePoint適用の順で基準値に反映し、必ず `VARIABLE_DOMAIN` の範囲へclampする（`applyComposedEffect`）。

この規則は `eventEngine.test.ts` の「multiplicative効果: 複数イベントが重複すると倍率を掛け合わせる」「additivePoint効果: 複数イベントが重複するとポイント差分を合算する」で検証している。

## 7. 市場モジュールとの境界（実装指示 §3）

現行の市場モジュール（Phase1）の入力型 `MarketQuarterInput` に無理に変数を追加していない。`ScenarioTurnCountryVariables` は「市場モジュールへ接続可能」なフィールドと「シナリオ内部にのみ保持」するフィールドを明示的に分離している。

### 接続可能（`marketAdapter.ts` が変換する）

`production`, `exportCapacityRatio`（=輸出適格率）, `aquacultureCostIndex`, `priorAquacultureCostIndex`, `qualityScore`, `reliabilityScore`, `pdProcessingCapacity`, `vapProcessingCapacity`、および需要側の `priorPeriodConsumption`（=地域別潜在需要）, `economicIndex`, `populationGrowthRate`（=消費成長率）。

### 現時点では未接続（シナリオ内部状態にとどまる）

`survivalRate`（生残率）, `diseasePressure`（疾病圧力）, `stockingVolume`（放養量）, `growingInventory`（成育中在庫）, `frozenInventory`（冷凍在庫）, `farmerExpectedPriceUsdPerKg`（農家期待価格）, `logisticsCapacityRatio`（物流能力）, `tradeRestrictionSeverity`（貿易規制）。

これらは `ScenarioTurnCountryVariables` の型としては存在し、イベント・トレンドの効果も正しく適用されるが、`toMarketQuarterInput()` では意図的に使用していない。将来、放養・在庫・物流を扱う供給モジュールが実装された時点で接続する（実装指示 §3の3段階プロセスのうち、本Phaseは (1)(2)(3) を実施し、(4)＝既存市場モジュールの公開インターフェースを一切破壊しない、を満たしている）。

### 簡略化した接続（要将来見直し）

- `vietnamDomesticRawSupply` は、ベトナムの国内未凍結原料供給量を、VN国の輸出向け `production` と同一の値として扱っている（同じ収穫量を、国際HOSO清算と国内原料市場という異なる入力チャネルから参照している簡略化）。
- 世界のPD/VAP需要（`pdVapDemand`）は、専用の基礎変数が実装指示の18項目一覧に含まれていないため、`REGIONAL_DEMAND` の合計値に `scenario/parameters.ts` の固定シェア（`pdDemandShareOfTotalConsumption` / `vapDemandShareOfTotalConsumption`）を掛けて導出している。
- `FEED_ENERGY_LABOR_COST` は独立変数として存在するが、市場モジュールには専用の入力欄が無いため、`aquacultureCostIndex` に乗数として合成している。
- `FROZEN_INVENTORY`（グローバルスコープ）は、国別prehistory基準値に同一の合成効果を適用する簡略化にとどめている（国別の在庫積み上げロジックは未実装）。

## 8. 情報公開レベルの分離（実装指示 §8）

`InformationRelease.informationLevel` は `public` ⊂ `standard` ⊂ `advanced` ⊂ `gm` の累積アクセスで、`postGame` は別チャンネルとして扱う。

`informationEngine.ts` の `getAvailableInformation(releases, turn, informationLevel, isGameComplete)`:

- `public`/`standard`/`advanced`/`gm`: `availableFromTurn <= turn` のリリースのみ、かつ指定レベル以下（累積）のみを返す。**将来のイベント・未公開の事実がこの経路から漏れることはない**（`availableFromTurn` によるフィルタが常にかかる）。
- `postGame`: `isGameComplete=false` の間は常に空配列。`isGameComplete=true` になって初めて、`availableFromTurn` を無視して全リリース（`postGameTruth` を含む）を返す。
- 上記4レベル（`public`〜`gm`）では、`postGameTruth` フィールドを常に取り除いて返す（多重防御。シナリオ定義側の設定ミスでも漏れない）。
- 生成AI（Claude API等）は一切使わない。返すのは構造化事実（`StructuredFact`）・見出しテンプレート・見積り範囲（`EstimateRange`）・確信度（`confidence`）のみ。

同じ事実を複数の精度で表現するパターン（`definitions/informationTemplates.ts`）: 噂（`standard`, `isRumor:true`, 低確信度）→ 確定情報（`advanced`, `revisionOf`で噂を参照, 高確信度）→ GM向け内部情報（`gm`, 正確な数値）→ ゲーム終了後の真実（`postGame`, `postGameTruth`）。5つの代表シナリオはすべてこのパターンで情報リリースを構築している。

## 9. Canonical / Variation の再現性（実装指示 §9・§10）

`resolveScenarioEvents(events, mode, randomStream)`:

- **Canonical**: `variationRange` の有無に関わらず、イベントは定義どおりに解決される。`randomStream` は一切消費しない。同じ初期状態・同じ会社行動・同じ条件からは常に同じ結果になる（外生イベントのスケジュールが固定されるだけで、市場結果・供給の実現値は会社行動に応じて変わりうる点に注意）。
- **Variation**: `variationRange` が定義されたフィールド（`startTurnJitter`, `magnitudeJitterRatio`, `durationJitterTurns`, `recoveryJitterTurns`）ごとに `randomStream` から1つずつ乱数を消費してジッターを適用する。消費順序はシナリオ定義のイベント配列順に固定されており、同じシードからは常に同じ解決結果になる（`eventEngine.test.ts` で検証）。`resolvedMagnitudeScale` は `[0.1, 3.0]` にclampされる。

乱数生成は既存の `app/lib/v2/core/random.ts` の `RandomStream`／`createRandomStream()` のみを使用しており、シナリオ専用の新しい乱数実装は追加していない（実装指示 §10）。

## 10. フィードバック接続点（実装指示 §11）

```typescript
interface ScenarioTurnFeedback {
  readonly realizedMarketResult?: MarketQuarterResult;
  readonly externalProducerResponses?: readonly ExternalProducerResponse[];
}
```

`advanceScenarioTurn(state, feedback)` は `feedback` を `turnHistory` に記録するのみで、次ターンの供給計算へ自動反映するロジックは本Phaseでは実装していない。現時点で実際にフィードバックを利用しているのは `vietnamTrailingAverageDomesticPurchase` の算出（`turnHistory` に記録された過去の `realizedMarketResult.vietnamDomestic.effectiveDemand` の直近4ターン平均、データが無ければ初期値にフォールバック）だけである。

将来、「価格上昇→海外農家が放養を増やす→数ターン後に供給が増える」という因果を実装する際は、`externalProducerResponses`（`stockingAdjustmentRatio` を記録済み）を `getScenarioTurnInput` の `STOCKING_VOLUME`/`COUNTRY_CAPACITY` 計算に反映する形で接続できるよう、型・記録経路だけを用意している。

区別: 疾病の発生時期などの外生イベントは**シナリオが決める**。海外生産者の価格反応は**将来、フィードバックとして計算する**。ベトナム5社の意思決定は**本モジュールの範囲外**。

## 11. 5つの代表シナリオ（実装指示 §12）

いずれも8年・32ターン、`docs/v2/`および`app/lib/v2/scenario/parameters.ts`に定義した共通の前史・初期状態（`SCENARIO_PREHISTORY_BASELINE_V1`）を共有する。すべての数値パラメータは「校正前の仮置き」であり、`app/lib/v2/scenario/parameters.ts`・`app/lib/v2/scenario/definitions/*.ts` に集約されている。

| シナリオ | scenarioId | 概要 |
|---|---|---|
| A. ベースライン | `baseline-v0.1` | 需要は年率2〜3%で緩やかに拡大、供給がおおむね追随。中規模の疾病(ID, turn10)・景気減速(全市場, turn20)イベントを各1件だけ配置し、長期危機は発生しない。他4シナリオの比較基準。 |
| B. エクアドル早期拡張 | `ecuador-early-expansion-v0.1` | Year2(turn5)からエクアドルの能力・稼働率が3段階（turn5/12/20）で拡大し、8年で能力+45%に達する。他国の背景トレンドはベースラインと同一。 |
| C. エクアドル遅延拡張 | `ecuador-delayed-expansion-v0.1` | Bと同じ前史・最終到達能力(+45%)を共有しつつ、資金制約(turn6)・疾病(turn14)・物流制約(turn18)によりturn24頃まで能力がほぼ横ばい、turn28以降に急速に立ち上がる。 |
| D. 世界的疾病危機 | `global-disease-crisis-v0.1` | EC(turn6)→IN(turn10)→VN(turn14)→ID(turn18)の順に疾病が発生。各イベントは実装指示§7の例と同じ効果量（生残率-18pt・コスト+8%・放養量-10%・輸出適格率-4pt・供給信頼性-6pt）を持ち、recoveryTurnsを8ターン(2年)と長めに取ることで一時的な価格スパイクにとどまらない長期的影響を表現する。 |
| E. 世界的需要ブーム | `global-demand-boom-v0.1` | CN/US/EU/JPの需要成長率をベースラインより引き上げ（8年でCN+45%等）、turn4〜24の需要拡大イベントを重ねる。供給側はturn20まではベースライン並み、turn20以降に加速するトレンドへ切り替え、「需要先行・供給が後半で追いつく」を表現する。 |

## 12. 未接続・簡略化された変数（実装指示 §3・§17に基づき明記）

- 生残率・成育中在庫・放養意欲・農家の期待価格・冷凍在庫・物流能力・農家の資金状態は、`ScenarioTurnCountryVariables` の型としては存在し効果も正しく適用されるが、市場モジュールへは接続していない（§7参照）。
- ベトナム国内原料供給量は、国際HOSO向け `production` と同一値を流用する簡略化。
- PD/VAP需要は専用の基礎変数を持たず、`REGIONAL_DEMAND` 合計からの固定シェア按分。
- `FEED_ENERGY_LABOR_COST` は `AQUACULTURE_COST` への乗数として合成。
- `FROZEN_INVENTORY`（グローバルスコープ）は国別基準値への一律倍率適用にとどめている。
- 前史の `carriedOverEvents`（ゲーム開始時点で進行中／回復中のイベント）は型として用意したが、5つの代表シナリオでは未使用（空配列）。

## 13. パラメータ集約（実装指示 §17）

- `app/lib/v2/scenario/parameters.ts`: エンジンのフォールバック既定値（`SCENARIO_ENGINE_PARAMETERS_V1`）、5シナリオ共通の前史・初期状態・Variation設定。
- `app/lib/v2/scenario/definitions/commonTrends.ts`: 背景トレンド（需要成長率・景気指数・能力成長率・コストインフレ）の既定値と組み立てロジック。
- `app/lib/v2/scenario/definitions/*.ts`: シナリオ固有の数値（イベントの発生turn・効果量・トレンドの到達値）。

ロジック本体（`scenarioEngine.ts` 等）にマジックナンバーを直接埋め込んでいない。

## 14. 今後の実データ照合・再校正が必要な項目

- 前史の各国供給量・養殖コスト指数・冷凍/成育中在庫・農家期待価格（`SCENARIO_PREHISTORY_BASELINE_V1`）。
- エンジンのフォールバック既定値（稼働率0.85・生残率0.85・生産性1.0・輸出適格率0.9・品質/信頼性スコア60等）。
- PD/VAP需要シェア（0.28 / 0.12）。
- 5シナリオそれぞれのイベント効果量・発生タイミング・トレンド到達値。

## 15. 本Phaseで実装していない項目

- V1コード・API・Redis接続・GM画面・シナリオ選択UI・プレイヤー向けニュース画面。
- 生成AI（Claude API等）呼び出し。
- 実際のゲーム進行（ターン処理エンジン本体）への接続。
- ベトナム5社の意思決定ロジック。
- `ScenarioTurnFeedback.externalProducerResponses` を実際の供給計算へ反映する海外生産者反応モデル（記録経路のみ用意）。
- 既存の価格計算式（市場モジュール）への変更。
