# Dynamic Scenario 1 — Phase 1: 既存 Scenario / Market / Raw / News アーキテクチャ監査

- 監査日: 2026-08-16
- 監査ブランチ: `claude/v2-dynamic-scenario-1-v4bx8v`（base = `feature/v2-32q-management-console` @ `8006fb6`）
- ゲームロジックの変更: **なし**（本 Phase は読み取り専用監査 + 実測スクリプト追加のみ）
- テスト: `npm test` = 3088 pass / 0 fail（base 時点で green を確認済み）

---

## 0. 結論サマリ（先に読む部分）

Dynamic Scenario 1 が要求する世界変化のうち、

- **供給側（原料ショック・産地競争力・Ecuador 拡張）は、既存 Scenario 定義だけで実現可能**
- **需要側（市場別 demand path・市場×商品構成の時間変化）は、既存 Scenario 定義からは一切動かせない**

という非対称がある。後者には shared engine 変更が必要であり、実装前に #04 の判断を要する。

決定的な事実は2つ。

**(1) 市場×商品構成比は Scenario から動かせない。**
`PRODUCT_LIFECYCLE_PARAMETERS_V1`（`app/lib/v2/market/productLifecycle.ts`）というグローバル定数表が
唯一の情報源で、`ScenarioDefinition` からの上書き経路が存在しない。
Japan VAP path・China premiumization(T25)・EU の HOSO→PD 転換・Others の隠れ成長は
**すべてこの表の管轄**であり、Scenario 側からは書けない。

**(2) 市場需要には減衰ラチェットがあり、Scenario が書いた需要 path は約10ターンで上書きされる。**
baseline 32Q 実測で、Japan の対象需要は 13,072t → 98t（**−99.3%**）、EU は −97.6%、OTHER は −85% に崩壊し、
CN だけが 67,553t → 212,138t に膨張する。これは Scenario 設定ではなく
`consumerInventory` の正のフィードバックによる構造的な現象である（§4 に因果分解）。
**この状態では Turn17〜20 の "Others hidden opportunity" も Turn25 の "China premiumization" も成立しない**
（T17 時点で OTHER のシェアは既に 3.7%、JP は 0.49% まで縮小しているため）。

したがって **Phase 3 実装へ進む前に、§7 の shared engine 変更3件について #04 の可否判断が必要**。

---

## 1. branch / base SHA

| 対象 | SHA | 日付 | 備考 |
|---|---|---|---|
| `origin/main` | `3ae9485` | 2026-07-13 | 変更しない |
| `origin/develop/v2` | `90d67bc` | 2026-08-02 | **stale**。現在のゲーム環境を含まない |
| `origin/feature/v2-32q-management-console` | `8006fb6` | 2026-08-16 | **最新ゲーム環境**。develop/v2 +172 commits |
| `origin/feature/v2-test16-balance-foundation` | `06705b3` | 2026-08-09 | 32q console の祖先（含まれている） |
| `origin/feature/v2-scenario-engine` | `0cf4b84` | 2026-07-19 | **孤立**。develop/v2 にも 32q にも未マージ |
| 作業ブランチ | `claude/v2-dynamic-scenario-1-v4bx8v` | — | base = `8006fb6`、working tree clean |

### base 選定の根拠（推測ではなく ancestry 実測）

```
develop/v2                     is ancestor of 32q-management-console : YES
test16-balance-foundation      is ancestor of 32q-management-console : YES
feature/v2-scenario-engine     is ancestor of develop/v2             : NO
feature/v2-scenario-engine     is ancestor of 32q-management-console : NO
develop/v2 .. 32q-management-console = 172 commits
```

`feature/v2-32q-management-console` が Test16 / 32Q 環境を含む唯一の最新ブランチであり、
**Dynamic Scenario 1 の base はこれ以外にない**。

`feature/v2-scenario-engine`(Jul 19) は Phase 2 scenario engine の元ブランチだが、
その中身は既に 32q console 側へ（別経路で）取り込まれている
（`app/lib/v2/scenario/**` の全26ファイルが 32q console 上に存在）。**このブランチは参照不要**。

### branch 名についての確認事項

- 指示の希望名 `feature/v2-dynamic-scenario-1` は **remote に存在しない**（新規作成可能）
- ただし本セッションは harness から `claude/v2-dynamic-scenario-1-v4bx8v` を指定されており、
  他ブランチへの push は禁止されている
- **`feature/v2-dynamic-scenario-1` への rename が必要なら明示指示を要する**
- upstream tracking は解除済み（`git branch --unset-upstream`）。
  base ブランチへ誤 push する事故を構造的に防いでいる

---

## 2. 既存 Scenario architecture

### 2.1 モジュール構成（`app/lib/v2/scenario/`, 2,734行）

| ファイル | 行 | 役割 |
|---|---|---|
| `types.ts` | 431 | 基礎変数・イベント・トレンド・情報公開・前史の型 |
| `scenarioEngine.ts` | 464 | `initializeScenario` / `getScenarioTurnInput` / `advanceScenarioTurn` |
| `eventEngine.ts` | 228 | 発現曲線（ramp/duration/recovery）と重複効果の合成 |
| `interpolation.ts` | 63 | キーフレーム補間（linear / step） |
| `marketAdapter.ts` | 71 | `ScenarioTurnInput` → `MarketQuarterInput` |
| `informationEngine.ts` | 55 | 情報レベル別の News 取得 |
| `validation.ts` | 229 | 定義の事前検証 |
| `parameters.ts` | 192 | 前史・初期状態・エンジン既定値 |
| `definitions/*.ts` | 842 | 既存5シナリオ（baseline / EC早期 / EC遅延 / 疾病危機 / 需要ブーム） |

### 2.2 設計思想（そのまま活かせる）

「**base environment × scenario modifier**」という指示の理想形が、既に厳密に実装されている。

- Scenario は**価格を一切計算しない**。型レベルで強制されている
  （`ScenarioEffect.variable: ScenarioBaseVariable` に価格変数が存在しない）
- 導出は `trend（無ければ既定値）→ event合成効果 → 変数域へclamp` の一貫パイプライン
- `LongTermTrend`（キーフレーム補間）と `ScenarioEvent`（ramp/duration/recovery 曲線）の2層
- `canonical` mode は乱数を一切消費しない = **完全決定論**（benchmark に必須）
- **production engine / market engine に turn 番号の if 文は1つも無い**

→ **指示 §26「Turn番号if文を大量追加しない」は、既存設計を守るだけで自動的に満たされる。**

### 2.3 実際のゲームへの接続（配線済み）

```
companyLab/runner.ts:917  getScenarioTurnInput(state.scenarioState, turn)
                     920  toMarketQuarterInput(scenarioTurnInput, previousMarketContext)
                          → applyLifecycleDemandToMarketInput   ← productLifecycle（Scenario外）
                          → applyProductionSupplySignalsToMarketInput
                          → planConsumerMarketQuarterTable      ← consumerInventory（Scenario外）
                     ...  turn/runner.ts → calculateMarketQuarter
```

Scenario は company-lab（本番プレイ）・management console（32Q）・industry-lab の
**3経路すべての世界生成源**になっている。industryLab 専用の実験装置ではない。

### 2.4 5シナリオの既存構造

| シナリオ | trends | events | 情報公開 |
|---|---|---|---|
| baseline | 需要5 + 景気5 + 能力4 + コスト4 = 18 | 2（T10疾病 / T20景気減速） | 8 |
| ecuadorEarly / Delayed | 同上 + EC能力差し替え | 各1〜2 | 4〜8 |
| globalDiseaseCrisis | 同上 | 疾病系 | 4 |
| globalDemandBoom | 需要成長率引き上げ + 景気強化 + 後半供給追随 | 1（T4〜T24需要拡大） | 4 |

**Dynamic Scenario 1 は既存5本の6本目として追加でき、既存シナリオを一切変更しない。**

---

## 3. 既存 News architecture

### 3.1 実装済みの部分

`InformationRelease` 型（`scenario/types.ts:212`）は要求仕様をほぼ満たしている。

| フィールド | 内容 | Dynamic Scenario 1 での用途 |
|---|---|---|
| `availableFromTurn` | 公開開始ターン | effect 開始ターンとの同期点 |
| `informationLevel` | `public`/`standard`/`advanced`/`gm`/`postGame` | 情報の非対称性 |
| `headlineTemplate` | 見出し | News headline |
| `structuredFacts` | 構造化事実 | 数値を書かない定性事実 |
| `estimateRange` | 見積り範囲 | 「−5〜−15%程度」等のぼかし |
| `confidence` | 0〜1 | Leading Indicator の確度 |
| `isRumor` | 噂フラグ | 予兆 News |
| `revisionOf` | 続報の親ID | 噂→確定の連鎖 |
| `postGameTruth` | 終了後のみ開示 | 振り返り用の真実 |

`informationEngine.ts` は多重防御で安全:
- 全レベルで `availableFromTurn <= turn` のみ返す（未来の News が漏れない）
- `postGame` 以外では `postGameTruth` を常に除去
- `postGame` は `isGameComplete=true` のときのみ

`buildEventInformationReleases`（`definitions/informationTemplates.ts`）が
「噂(standard) → 確定(advanced) → GM(gm) → 終了後(postGame)」の4点セットを自動生成する。
生成AIは一切使わない。

### 3.2 News type の対応関係

指示の3分類は既存フィールドの組み合わせで表現でき、**新しい型は不要**。

| 指示の News type | 既存フィールドでの表現 |
|---|---|
| Current Event | `isRumor: false`, `confidence >= 0.8`, `availableFromTurn = effect開始ターン` |
| Leading Indicator | `isRumor: true`, `confidence ≈ 0.35`, `availableFromTurn = effect開始 − 1〜2` |
| Structural Trend | `isRumor: false`, `relatedEventId` なし（trend に紐づく）, `estimateRange` で幅を示す |

`InformationRelease.relatedEventId` は optional なので、**trend 由来の News（Structural Trend）も
イベント無しで定義できる**（`validation.ts:128` は `relatedEventId` が存在する場合のみ検証）。

### 3.3 【欠落】News は companyLab UI に載っていない

`getAvailableInformation` の呼び出し元は **`industryLab/simulationRunner.ts` の1箇所のみ**。

```
app/lib/v2/industryLab/simulationRunner.ts:197-200
  publicInformation:   getAvailableInformation(releases, turn, "public")
  standardInformation: getAvailableInformation(releases, turn, "standard")
  advancedInformation: getAvailableInformation(releases, turn, "advanced")
  gmInformation:       getAvailableInformation(releases, turn, "gm")
```

**プレイヤーが実際に遊ぶ company-lab の画面（`PlayerScreenClient.tsx`）には News 表示が存在しない。**
Standard AI にも News は渡っていない。

→ Dynamic Scenario 1 の News を「プレイヤーが先読みするための情報」として機能させるには、
**UI 配線が必須**（§7-C）。

---

## 4. 【最重要】市場需要の減衰ラチェット（baseline 実測）

### 4.1 実測結果

`scripts/dynamicScenario1WorldAudit.ts` — baseline / 32Q / seed固定。市場別 true demand（HOSO換算トン）:

| turn | CN | US | EU | JP | OTHER | WORLD |
|---|---|---|---|---|---|---|
| 1 | 67,553 | 41,463 | 32,750 | **13,072** | 20,050 | 174,888 |
| 8 | 100,423 | 77,689 | 25,969 | 7,722 | 22,302 | 234,105 |
| 16 | 145,294 | 69,807 | 6,846 | 1,440 | 10,462 | 233,849 |
| 17 | 163,064 | 60,377 | 5,274 | 1,173 | **8,802** | 238,690 |
| 24 | 173,143 | 60,576 | 2,116 | 336 | 5,140 | 241,311 |
| 25 | 189,411 | 52,250 | 1,678 | 284 | 4,355 | 247,978 |
| 32 | 212,138 | 59,114 | **781** | **98** | 2,927 | 275,058 |

世界合計はほぼ横ばい（175k → 275k）だが、**内訳が CN へ完全に集中する**。

`deriveTargetDemand` の按分ウェイト（= `desiredPurchase` 構成比）の推移:

| turn | CN | US | EU | JP | OTHER |
|---|---|---|---|---|---|
| 1 | 38.63% | 23.71% | 18.73% | 7.47% | 11.46% |
| 8 | 42.90% | 33.19% | 11.09% | 3.30% | 9.53% |
| 16 | 62.13% | 29.85% | 2.93% | 0.62% | 4.47% |
| 18 | 67.21% | 26.58% | 2.10% | 0.44% | 3.67% |

### 4.2 因果分解（`scripts/dynamicScenario1DemandDecay.ts`、JP の例）

| turn | planCons | realCons | desiredBuy | actualBuy | openInv | endInv | phase | consGrowth |
|---|---|---|---|---|---|---|---|---|
| 1 | 94,500 | 94,500 | 94,376 | 82,772 | 96,000 | 84,272 | balanced | +5.0% |
| 3 | 88,351 | 88,351 | 111,065 | 70,786 | 66,015 | 48,450 | tight | −3.7% |
| 5 | 106,635 | **72,091** | 150,347 | 59,719 | 12,371 | **0** | tight | +12.0% |
| 9 | 41,962 | 34,097 | 63,923 | 34,097 | 0 | 0 | tight | +12.6% |
| 17 | 8,491 | 6,048 | 12,765 | 6,048 | 0 | 0 | tight | +13.0% |
| 32 | 593 | 468 | 831 | 468 | 0 | 0 | tight | +10.2% |

**注目すべき点: `consGrowth`（計画消費の成長率）は毎ターン +3〜+13% で正である。**
つまり「需要が縮小している」のではなく、**供給が届かないので実現消費が縮み、それが翌期の基準になっている**。

因果の連鎖（`market/consumerInventory.ts`）:

1. `actualPurchase < plannedConsumption`（turn1 から。5社が VN 配分需要を成約しきれないため世界全体で約 −14%）
2. 在庫が turn5 で 0 に枯渇
3. 以降 `realizedConsumption = min(planned, opening + actual) = actualPurchase`（`settleConsumerMarketQuarter:626`）
4. `rollCarryStateForward` が `priorConsumptionTons ← realizedConsumptionTons`（`consumerInventory.ts:688`）
5. 翌期 `plannedConsumption = priorConsumption × ...`（`planConsumerMarketQuarter:427`）
6. `desiredPurchase ∝ plannedConsumption` → `deriveMarketWeightsFromDesiredPurchase` の**市場ウェイトが低下**
7. 翌期の `actualPurchase = nonVnAllocated × weight + VN成約` がさらに減る → **1へ戻る**

**復元力が一切無い正のフィードバックループ。**

### 4.3 増幅要因

5社（Standard AI）の営業配置が CN に集中するため、**CN だけ「重み按分の非VN分 + 5社のVN成約」の二重取り**になる。
他市場は非VN分しか受け取れず、相対的に capture ratio が下がる。
結果として **市場需要が5社の営業配置に対して内生的**になり、勝者総取りが加速する。

### 4.4 Dynamic Scenario 1 への影響（致命的）

| 要求 | 現状での成否 |
|---|---|
| §11 Japan を T8〜16 の VAP 先行市場にする | **不可**（T16 で JP シェア 0.62%） |
| §13 EU を T10 から PD 成長 | **不可**（T16 で EU シェア 2.93%） |
| §19 Others を T17〜20 に隠れ成長 | **不可**（T17 で OTHER シェア 3.69%、以降単調減少） |
| §14 China を T24 まで巨大 HOSO 市場 | 成立するが「**そうならざるを得ない**」だけで Scenario の功績ではない |
| §23 China premiumization を T25 から | 市場は残るが、比較対象の JP/EU が消滅済み |

→ **Scenario 側の需要 modifier（`REGIONAL_DEMAND` / `ECONOMIC_INDEX` / `CONSUMPTION_GROWTH`）を
どう設定しても、この減衰は打ち消せない。** シェア争いはゼロサムであり、
ある市場を守れば別の市場が同じ速度で崩れるだけだからである。

---

## 5. Scenario から動かせる parameter の全数調査

### 5.1 動かせる（trend / event で毎ターン制御可能）

| # | 基礎変数 | scope | 到達先 | 効く先 |
|---|---|---|---|---|
| 1 | `REGIONAL_DEMAND` | market | `priorPeriodConsumption` | 世界需要 → 産地別配分需要・PD/VAP世界需要。**consumerInventory は t=1 の初期化のみ** |
| 2 | `ECONOMIC_INDEX` | market | `economicIndex` | ①世界需要式（**水準**として作用）②consumerInventory 消費（**毎期の乗数＝複利**として作用） |
| 3 | `CONSUMPTION_GROWTH` | market | `populationGrowthRate` | 同上（複利） |
| 4 | `COUNTRY_CAPACITY` | country | `production` | 輸出可能供給 → HOSO FOB |
| 5 | `UTILIZATION_RATE` | country | 同上 | 同上 |
| 6 | `SURVIVAL_RATE` | country | 同上 | 同上（疾病表現の中核） |
| 7 | `PRODUCTIVITY` | country | 同上 | 同上 |
| 8 | `EXPORTABLE_SUPPLY` | country | `production` を直接指定 | 上記4〜7を上書き |
| 9 | `EXPORT_ELIGIBILITY_RATE` | country | `exportCapacityRatio` | 輸出可能供給 |
| 10 | `AQUACULTURE_COST` | country | `aquacultureCostIndex` | **価格アンカー（= 初期価格 × コスト指数）** + コスト圧力 |
| 11 | `FEED_ENERGY_LABOR_COST` | country | 同上（乗算） | 同上 |
| 12 | `QUALITY_SCORE` | country | `qualityScore` | PD/VAP 品質プレミアム |
| 13 | `SUPPLY_RELIABILITY` | country | `reliabilityScore` | 同上 |
| 14 | `PD_PROCESSING_CAPACITY` | country | `pdProcessingCapacity` | PD プレミアムの稼働率倍率 |
| 15 | `VAP_PROCESSING_CAPACITY` | country | `vapProcessingCapacity` | VAP プレミアムの稼働率倍率 |

### 5.2 Scenario 内部に留まり market へ届いていない（死んでいる変数）

`marketAdapter.ts:6-7` が明示的に落としている。

`DISEASE_PRESSURE` / `STOCKING_VOLUME` / `FROZEN_INVENTORY` / `LOGISTICS_CAPACITY` /
`TRADE_RESTRICTION` / `growingInventory` / `farmerExpectedPriceUsdPerKg`

→ Dynamic Scenario 1 でこれらを効果として書いても**何も起きない**。
News の裏づけ（GM 情報）としては使えるが、**effect として使ってはいけない**。

### 5.3 Scenario にあるが「ゲーム開始時固定」（毎ターン変えられない）

| 項目 | 位置 | 現在値 | 影響 |
|---|---|---|---|
| `vietnamFarmerEconomics` | `initialStateOverrides` | 1.90+0.15+0.20 = 2.25 | 国内原料の価格下限・数量配給 |
| `vietnamProcessingEconomics` | `initialStateOverrides` | recovery 1.00 / cost 0.85 / margin 0.25 | 買付上限 = VN_FOB − 1.10 |

### 5.4 Scenario から到達できない（グローバル定数）

| 項目 | 位置 | Dynamic Scenario 1 での必要性 |
|---|---|---|
| **市場×商品構成比** | `PRODUCT_LIFECYCLE_PARAMETERS_V1` | §11/§12/§13/§14/§19/§23 の**全部** |
| 消費国在庫パラメータ | `CONSUMER_MARKET_INVENTORY_PARAMETERS_V1` | 季節性・価格弾力性の市場別性格 |
| 仕向市場価格係数 | `DESTINATION_MARKET_PRICE_COEFFICIENTS_*` | 市場別 selling price の構造差 |
| 輸入諸掛 | `RAW_MATERIALS_PARAMETERS_V1.imports` | freight 0.15 / duty 5% / 保険 0.05 |
| `demandShockFactor` | `planConsumerMarketQuarter` の**未使用引数** | 市場別 demand shock（T17 COVID）の理想的な受け口 |

---

## 6. 原料シナリオの到達可能域（実測）

### 6.1 baseline の原料経済（32Q 実測）

| 項目 | 値域（T1〜T32） |
|---|---|
| VN 国内原料価格 | 2.348 〜 2.924 USD/HOSO換算kg |
| VN 買付上限 | 2.745 〜 3.353 |
| 農家留保価格 | 2.250（固定） |
| VN HOSO FOB | 3.845 〜 4.453 |
| IN HOSO FOB | 3.723 〜 4.329 |
| EC HOSO FOB | 4.218 〜 4.972 |
| **IN 輸入着地** = FOB×1.05 + 0.20 | **4.11 〜 4.75** |
| **EC 輸入着地** | **4.63 〜 5.42** |

**baseline では輸入は国内原料より恒常的に 60〜90% 高く、経済的に成立しない。**
指示 §7「Turn1〜4 は import ほぼ不要」は**現状のままで自動的に満たされる**。

### 6.2 「VN国内 > 輸入着地」の到達可能域（`scripts/dynamicScenario1RawShockProbe.ts`）

既存市場モジュールをそのまま3四半期回した収束値。エンジン無改変。

| lever | VN_FOB | 買付上限 | VN国内 | IN着地 | VN>IN | VN取引量 | spread制約 |
|---|---|---|---|---|---|---|---|
| BEFORE（baseline平衡） | 3.746 | 2.646 | 2.296 | 3.964 | no | 389,300 | — |
| A: 供給 −20% | 4.025 | 2.925 | 2.691 | 4.036 | no | 366,400 | — |
| B: 供給 −35% | 4.313 | 3.213 | 3.069 | 4.105 | no | 297,700 | — |
| C: 供給 −35% + コスト×1.25 | 4.880 | 3.780 | 3.610 | 4.150 | no | 297,700 | — |
| **D: 供給 −45% + コスト×1.40** | 5.431 | 4.331 | **4.287** | 4.205 | **YES (+2%)** | 251,900 | — |
| **J: 供給 −50% + コスト×1.60** | 5.969 | 4.869 | **4.869** | 4.233 | **YES (+15%)** | 229,000 | — |
| K: 供給 −50% + コスト×1.90 | 6.177 | 5.077 | 5.077 | 4.233 | YES (+20%) | 229,000 | **BOUND** |
| G: 供給 −30% + コスト×1.25 + IN/EC **+10%** | 4.598 | 3.498 | 3.340 | **3.902** | no | 320,600 | — |
| I: 供給 −40% + コスト×1.35 + IN/EC **+15%** | 4.915 | 3.815 | 3.710 | 3.844 | no | 274,800 | — |

### 6.3 この実測から確定した設計上の事実

1. **T7〜9 の「国内 > 輸入」は Scenario 単独で達成可能。** ただし相当強いショックが要る。
2. **支配的レバーは `AQUACULTURE_COST`（価格アンカー）であって供給量ではない。**
   供給 −35% 単独では国内 3.07 に留まり、輸入 4.11 に全く届かない。
   `anchorPrice = initialHosoFobPrice[VN] × costIndex`（`hosoPricing.ts:193`）が効くため。
3. **`maxCountryDeviationRatioFromReference = 0.35` の壁はコスト指数 ×1.9 付近まで当たらない。** 余裕がある。
4. **⚠ VN ショックと同時に IN/EC を増産させてはいけない。**
   lever G/I が示すとおり、IN/EC 増産は世界基準価格を下げ、平均回帰と spread 制約経由で
   **VN_FOB も一緒に引き下げてしまう**。狙いと逆に働く。
   → **Ecuador 拡張は指示どおり T13〜16 に置き、T7〜9 の VN ショックとは重ねない。** 物語と機構が一致する。
5. 農家留保価格（lever E/F）は買付上限 > 留保価格の領域では**価格に一切影響しない**。
   数量配給（`quantityRationed`）を起こす目的でのみ意味があり、価格を上げる主レバーにはならない。
6. ショックは価格上昇と同時に **VN 取引量を 389k → 229k（−41%）へ縮小**させる。
   指示 §9「売り先行で固定売価 backlog を持つ会社の margin collapse」は
   **価格高騰 + 調達未達の二重で発生する**。設計意図どおり。

---

## 7. 必要となる shared engine 変更（実装前に #04 判断を要する）

優先度順。**A が無いと Dynamic Scenario 1 の需要側は原理的に成立しない。**

### A. 市場×商品構成比を Scenario から上書き可能にする 【必須・中規模】

- 対象: `app/lib/v2/market/productLifecycle.ts` + `ScenarioDefinition`
- 変更内容: `ScenarioDefinition` に optional な `productLifecycleOverrides?: Partial<ProductLifecycleParameters>` を追加し、
  `companyLab/runner.ts:958` の `computeMarketProductMix(turn, PRODUCT_LIFECYCLE_PARAMETERS_V1, shift)` が
  シナリオ指定値を優先する
- 影響範囲: **未指定時は完全に現行動作（既存5シナリオ・既存テストにビット単位で影響なし）**
- 規模: production code 3ファイル程度（productLifecycle / runner / scenario types）
- 代替案: `PRODUCT_LIFECYCLE_PARAMETERS_V1` を直接書き換える
  → **却下推奨。** 既存5シナリオ・Standard AI benchmark を全部巻き込み、並行開発と衝突する

**なぜ必須か（数値）**: 指示 §14「China PD/VAP は T25 まで Japan より小さい」を満たすには、
CN 市場規模 380k / JP 90k（4.2倍）の下で CN の PD シェアが `0.34/4.2 = 0.081` 未満である必要がある。
現行 `CN.pd.initialShare = 0.12`・`accelStartTurn = 16` は**この条件を最初から破っている**
（T1 で CN PD 45.6k > JP PD 30.6k）。Scenario 側からは1つも触れない。

### B. 市場需要の減衰ラチェットを止める 【必須・小〜中規模】

- 対象: `app/lib/v2/market/consumerInventory.ts`
- 問題: `rollCarryStateForward`（:688）が `priorConsumptionTons ← realizedConsumptionTons` としているため、
  供給が届かなかった分だけ**潜在需要が恒久的に消滅**する
- 候補（#04 の判断事項。§8 に Before/Candidate/Expected を記載）:
  - **B-1（推奨）**: `priorConsumptionTons ← plannedConsumptionTons`（潜在消費は残り、実現だけが減る）
  - B-2: `realized` と `planned` の加重ブレンド（`α` を新パラメータ化）
  - B-3: Scenario の `REGIONAL_DEMAND` を潜在需要のアンカーとし、そこへ平均回帰させる
- 経済的な妥当性: 日本の消費者が「ベトナムの輸出業者が出荷しなかった」という理由で
  エビを永久に食べなくなることはない。**B-1 が最も現実に近い**
- 影響範囲: **既存5シナリオの 32Q 挙動が変わる**（並行開発の Standard AI benchmark に影響）
  → **#04 の統合判断が要る最大の点**

### C. Scenario News を company-lab UI へ載せる 【必須・小規模】

- 対象: `app/v2/company-lab/play/_lib/viewModel.ts`（`buildOpeningInfo`）+ `PlayerScreenClient.tsx`
- 変更内容: 既存 `getAvailableInformation(releases, turn, "standard")` を呼び、
  `openingInfo` に `scenarioNews` を追加。既存 `OpeningMarketInfoPanel` の隣に表示パネルを1つ足す
- 規模: 小（新規ロジックはゼロ。既存の scenario 関数を呼ぶだけ）
- 注意: `viewModel.ts` は**並行ブランチも触っている**（§9）

### D. `vietnamFarmerEconomics` を turn 可変にする 【任意・小規模】

- 対象: `ScenarioTurnInput` / `scenarioEngine.ts` / `marketAdapter.ts`
- 用途: 疾病時の養殖原価上昇 → 農家留保価格上昇 → 数量配給。
  §6.3-5 のとおり価格の主レバーではないため、**無くても T7 ショックは成立する**
- 判断: Phase 3 で余力があれば。**優先度は低い**

### E. `demandShockFactor` を配線する 【任意・小規模】

- 対象: `planConsumerMarketQuarterTable`（引数を素通しするだけ）
- 現状: `planConsumerMarketQuarter(period, carry, demandInput, params, demandShockFactor = 1)` の
  第5引数は**定義されているが誰も渡していない**
- 用途: T17〜20 の COVID 型 demand shock を「市場別・一時的」に表現する理想的な受け口
- 代替: `ECONOMIC_INDEX` のイベント効果でも表現できる（ただし複利で効くため recovery 設計が難しい）
- 判断: B の修正方針次第。B-1 を採る場合は `ECONOMIC_INDEX` で十分な可能性が高い

### 【変更不要と確認できたもの】

- **永続化スキーマの migration は不要。**
  `persistence/schema.ts:671` の `validateScenarioState` は `definition` を
  `requireObject` した上で**フィールド検証せず opaque に通している**。
  `ScenarioDefinition` にフィールドを足しても保存・復元は壊れない
- **Scenario 追加そのものに engine 変更は不要。**
  `ALL_SCENARIO_DEFINITIONS` に1本足すだけで company-lab / management console 双方の選択肢に出る
- **`durationTurns = 32` は検証範囲内**（`validation.ts`: 20〜40）

---

## 8. 数値校正 candidate（Before / Candidate / Expected result）

すべて **candidate であり正式値ではない**。#04 の game-design 判断を仰ぐ。

### 8.1 T7〜9 Vietnam raw shock

| | 手段 | VN国内価格 | IN着地 | 差 | VN取引量 | 評価 |
|---|---|---|---|---|---|---|
| **Before** | — | 2.30〜2.92 | 3.96〜4.75 | −40% | 389k | 輸入は常に非経済 |
| **Cand-1（弱）** | 供給 −35% + コスト×1.25 | 3.61 | 4.15 | −13% | 298k | **輸入転換が起きない**。ショックとして弱い |
| **Cand-2（中）** | 供給 −45% + コスト×1.40 | 4.29 | 4.21 | **+2%** | 252k | 逆転はするが差が小さすぎ、AI/プレイヤーが気づかない懸念 |
| **Cand-3（推奨）** | 供給 −50% + コスト×1.60 | 4.87 | 4.23 | **+15%** | 229k | 明確な逆転。取引量 −41% で調達未達も同時発生 |
| Cand-4（強すぎ） | 供給 −50% + コスト×1.90 | 5.08 | 4.23 | +20% | 229k | spread 制約に接触。全社破綻リスク |

**推奨: Cand-3。** 実装は VN に対する
`SURVIVAL_RATE` additivePoint −0.30 前後 + `AQUACULTURE_COST` multiplicative ×1.60、
`rampUpTurns: 1, durationTurns: 3, recoveryTurns: 3`（T6 予兆 → T7 立ち上がり → T7〜9 満額 → T10〜12 回復）。

**未検証リスク**: 5社の資金繰りへの影響は company を含む 32Q 実行でしか測れない（Phase 5 の benchmark 事項）。
指示 §9「全社を自動破綻させないこと」の確認は benchmark 待ち。

### 8.2 T17〜20 global demand shock

`ECONOMIC_INDEX` は consumerInventory で**毎期複利**として効くため、
「−20%」を multiplicative 0.80 で4ターン当てると **0.80⁴ = −59%** になる。**直感と大きくズれる。**

| | 手段 | 4ターン後の累積消費水準 | 評価 |
|---|---|---|---|
| **Before** | — | — | — |
| Cand-1 | `ECONOMIC_INDEX ×0.80`, duration 4 | ≈ −59% | **強すぎ。** 全社破綻の懸念 |
| **Cand-2（推奨）** | `ECONOMIC_INDEX ×0.94`, ramp 1 / duration 3 / recovery 3 | ≈ −20% | 指示の「demand 急減」に相当 |
| Cand-3 | `demandShockFactor`（§7-E 配線後）で level 指定 0.80 | −20%（複利なし） | **意味が直感どおり。** engine 変更が要る |

**推奨: Cand-2 で開始し、§7-E が承認されれば Cand-3 へ移行。**
**⚠ #04 判断事項: `ECONOMIC_INDEX` の複利セマンティクスを許容するか、level 指定へ寄せるか。**

### 8.3 T22〜24 reopening boom

| | 手段 | 評価 |
|---|---|---|
| Cand-1 | `ECONOMIC_INDEX ×1.08` × 3ターン | ≈ +26%。急回復として妥当 |
| **Cand-2（推奨）** | `ECONOMIC_INDEX ×1.06` × 3ターン + `REGIONAL_DEMAND ×1.10` | 消費と配分需要の両方を戻す。供給追随が遅れて価格が跳ねる |
| Cand-3 | `ECONOMIC_INDEX ×1.12` × 3ターン | +40%。COVID 期に縮小した会社が全く追いつけない |

**推奨: Cand-2。** 同時に供給側（`COUNTRY_CAPACITY`）を**動かさない**ことで
「demand > supply response」を作る（指示 §21）。

### 8.4 China HOSO price spike（T13 以降・年2回）

CN の HOSO 価格を直接は動かせない（Scenario は価格を書かない）ため、
**`REGIONAL_DEMAND[CN]` の短期スパイク**で表現する。

| | 手段 | 評価 |
|---|---|---|
| Cand-1 | `REGIONAL_DEMAND[CN] ×1.15`, ramp 0 / dur 1 / recov 1 | 世界需要 +5.7% → VN_FOB +2〜4%。**弱い** |
| **Cand-2（推奨）** | `REGIONAL_DEMAND[CN] ×1.30`, ramp 0 / dur 1 / recov 1 | 世界需要 +11% → 価格変動上限(±20%)の範囲内で明確なスパイク |
| Cand-3 | `REGIONAL_DEMAND[CN] ×1.50`, dur 2 | 価格変動上限に張り付く。毎回同じ形になり読まれやすい |

**推奨: Cand-2 を Q1（春節）に、やや弱い ×1.20 を Q3（importer buying）に。**
**⚠ #04 判断事項: 「HOSO 戦略への明確な収益機会」（指示 §15）を作るには、価格スパイクだけでなく
CN の HOSO 対象需要そのものが残っている必要がある。これは §7-A/B の可否に依存する。**

### 8.5 Others PD/VAP hidden growth（T17〜20）

**§7-A が承認されない限り実装不可能。** 承認前提の candidate:

| | `OTHER.pd` | `OTHER.vap` | 評価 |
|---|---|---|---|
| **Before** | initial 0.22 / mature 0.30 / accel T12 / dur 10 | initial 0.03 / mature 0.14 / accel T12 / dur 10 | 緩慢。隠れ成長にならない |
| Cand-1 | mature 0.34 / accel T17 / dur 4 | mature 0.20 / accel T17 / dur 4 | PD +55% / VAP +567%。控えめ |
| **Cand-2（推奨）** | mature 0.36 / accel T17 / dur 4 | mature 0.24 / accel T17 / dur 4 | 指示 §19「他社が赤字の中で break-even〜moderate profit」に相当 |
| Cand-3 | mature 0.40 / accel T17 / dur 3 | mature 0.30 / accel T17 / dur 3 | 大儲けになりすぎ。指示の意図と不一致 |

### 8.6 T25 China premiumization

**§7-A が承認されない限り実装不可能。**

| | `CN.pd` | `CN.vap` | JP との比較（T24時点） |
|---|---|---|---|
| **Before** | initial 0.12 / mature 0.30 / accel T16 | initial 0.01 / mature 0.10 / accel T22 | **T1 から CN PD > JP PD。指示違反** |
| **Cand-1（推奨）** | initial **0.06** / mature 0.30 / accel **T25** / dur 8 | initial 0.008 / mature 0.14 / accel **T25** / dur 8 | T24 で CN PD 0.06×CN規模 < JP PD。条件充足 |
| Cand-2 | initial 0.07 / mature 0.34 / accel T25 / dur 6 | initial 0.01 / mature 0.18 / accel T25 / dur 6 | 立ち上がりが急。T32 までに十分な収益機会 |
| Cand-3 | initial 0.05 / mature 0.26 / accel T26 / dur 8 | initial 0.005 / mature 0.12 / accel T26 / dur 8 | 保守的。T32 までに成熟しきらない |

---

## 9. 並行ブランチとの衝突リスク

`origin/develop/v2..origin/feature/v2-32q-management-console`（172 commits）が触ったファイルとの照合。

| Dynamic Scenario 1 が触る予定 | 並行ブランチが触ったか | リスク |
|---|---|---|
| `app/lib/v2/scenario/**`（26ファイル） | **一切触っていない** | **なし** |
| `app/lib/v2/market/**`（13ファイル） | **一切触っていない** | **なし** |
| `app/lib/v2/companyLab/runner.ts` | **触っている（3 commits）** | **中** |
| `app/v2/company-lab/play/_lib/viewModel.ts` | **触っている** | **中** |
| `app/lib/v2/companyLab/types.ts` | 触っている（6 commits） | 中（触らない方針） |
| `app/lib/v2/sales/**` | 触っている（allocation / parameters / runner / types） | — （触らない方針） |
| `app/lib/v2/companyLab/standardAi/**` | 集中的に触っている | — （担当外） |

**方針**:
- Scenario 定義（`scenario/definitions/dynamicScenario1*.ts`）は**完全に新規ファイル**。衝突ゼロ
- `productLifecycle.ts` / `consumerInventory.ts` は並行ブランチが触っていないため、
  §7-A / §7-B の変更は**衝突しない**
- `runner.ts` と `viewModel.ts` への変更は**数行に留め、事前に報告する**（§7-A の1行・§7-C の数行）
- 並行ブランチの merge / cherry-pick / rebase は**行わない**

---

## 10. 実装複雑度の見積り

| Phase | 内容 | production code | 前提 |
|---|---|---|---|
| 3-a | Dynamic Scenario 1 定義本体（trends / events） | 新規1〜3ファイル、約600〜900行 | なし |
| 3-b | `productLifecycleOverrides` 配線（§7-A） | 3ファイル・約40行 | **#04 承認** |
| 3-c | consumerInventory ラチェット修正（§7-B） | 1ファイル・約10行 + テスト | **#04 承認**（既存挙動が変わる） |
| 4 | News 定義（32ターン × 1〜3件 = 40〜80 releases） | 新規1ファイル、約700〜1000行 | なし |
| 4-b | News の company-lab UI 配線（§7-C） | 2ファイル・約60行 | 小 |
| 5 | 5社×32Q deterministic benchmark | 新規スクリプト1本 | 3・4 完了後 |

**Phase 3-a と Phase 4 は #04 判断を待たずに着手可能**（供給側・原料側・News 定義は engine 変更不要）。
**Phase 3-b / 3-c は承認待ち。**

---

## 11. #04 の game-design 判断を要する論点

1. **§7-A（productLifecycle の Scenario 上書き）を承認するか。**
   否なら Japan / EU / Others / China premiumization の商品構成 path は**全部落とす**必要がある
2. **§7-B（需要ラチェット修正）を承認するか。承認する場合 B-1 / B-2 / B-3 のどれか。**
   既存5シナリオの 32Q 挙動が変わるため、並行開発中の Standard AI benchmark の再取得が要る
3. **`ECONOMIC_INDEX` の複利セマンティクスを許容するか**（§8.2）。
   許容しないなら §7-E（`demandShockFactor` 配線）を承認する必要がある
4. **T7 raw shock の強度**（§8.1 Cand-2 +2% か Cand-3 +15% か）
5. **T17〜20 の demand shock 深度**と「全社を自動破綻させない」の許容ライン
6. **branch 名**を `feature/v2-dynamic-scenario-1` へ変更するか、
   現行の `claude/v2-dynamic-scenario-1-v4bx8v` のままとするか
7. `scenario/definitions/index.ts` の `ALL_SCENARIO_DEFINITIONS` に
   Dynamic Scenario 1 を**いつ**追加するか（追加した瞬間に company-lab / console の選択肢に出る）

---

## 付録: 本 Phase で追加した監査スクリプト（production code 非改変）

| スクリプト | 用途 |
|---|---|
| `scripts/dynamicScenario1WorldAudit.ts` | 32Q の市場別・市場×商品別 true demand、原料価格、産地供給、lifecycle 構成比、有効イベントの一括出力 |
| `scripts/dynamicScenario1DemandDecay.ts` | `consumerInventory` の3層（消費/在庫/購買）分解と市場ウェイト推移 |
| `scripts/dynamicScenario1RawShockProbe.ts` | VN 原料ショックの到達可能域（市場モジュールを直接叩く。エンジン無改変） |
