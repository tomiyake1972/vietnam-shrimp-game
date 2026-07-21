# ShrimpX V2 商品×仕向市場の参照価格差別化 Phase 8P-0A（v0.1）

`feature/v2-market-destination-pricing` ブランチ（`develop/v2` HEAD `31f22fb` から分岐）で実装した、商品（HOSO/PD/VAP）×仕向市場（CN/US/EU/JP/OTHER）ごとに参照価格を差別化する仕組み（`app/lib/v2/market/destinationPricing.ts`・`destinationPricingParameters.ts`）の設計記録。

## 1. このPhaseが解決する問題（現行モデルの課題）

Phase 4（`sales/marketAdapter.ts`）までの実装では、`deriveVietnamBasePrices` がベトナム産地の商品別基準価格（HOSO/PD/VAP、市場非依存の単一値）を算出し、`allocateMarketProduct` が5市場すべてにこの同一の `basePrice` を使っていた。つまり「同じ商品なら、どの仕向市場へ売っても基準価格は同じ」という単純化が明示的な暫定前提（`sales/marketAdapter.ts` のコメント「Phase4固有の暫定前提」）として存在した。

現実の水産物輸出では、同じ商品でも仕向市場によって評価（規格・調理文化・加工度への支払意欲など）が異なるため、この単純化を解消し、商品×仕向市場ごとに異なる参照価格を持てるようにすることが本Phaseの目的である。

## 2. 産地間競争由来の価格と仕向市場評価の区別

**重要な設計原則**: 本Phaseは、既存の産地間競争（エクアドル・インド・インドネシア・ベトナムの供給競争から導かれるベトナム産地の商品別基準価格）を置き換えるものではない。`market/hosoPricing.ts` の産地間競争、`market/productPremium.ts` のPD/VAPプレミアム算出は一切変更していない。

本Phaseが追加するのは、その産地間競争から導かれた商品別基準価格の**上に**、仕向市場ごとの評価差を乗せる層である。

```
産地間競争（既存、変更なし） → ベトナム産地の商品別基準価格（HOSO/PD/VAP、市場非依存）
                                          ↓
                        商品×仕向市場の参照価格差別化（本Phaseで追加）
                                          ↓
                              商品×市場ごとの市場参照価格
```

## 3. HOSO基礎価値・PD加工プレミアム・VAP追加プレミアムへの分解

`decomposeVietnamProductPrices`（`market/destinationPricing.ts`）が、`deriveVietnamBasePrices` の3つの値（HOSO・PD・VAP基準価格）を以下のように分解する。

```
pdProcessingPremium   = 既存PD基準価格 - 既存HOSO基準価格
vapIncrementalPremium = 既存VAP基準価格 - 既存PD基準価格
```

### 価格の逆転（HOSO > PD、PD > VAP）は発生するか

`market/parameters.ts` の `MARKET_PARAMETERS_V1.pdVapPremium` は `pdBasePremiumRatio: 0.18`・`vapBasePremiumRatio: 0.55`（VAPの方がPDより高い比率）であり、かつ両プレミアムには `minPremiumUsdPerKg: 0.05` の下限がある。このため、既存の価格形成ロジックの範囲では HOSO ≤ PD ≤ VAP が常に成り立つ設計になっている。

検証として、市場単体テスト（`market/__tests__/destinationPricing.test.ts`）で8種の合成シードに対する非負性検証、ターン統合テスト・会社ラボ統合テスト（32ターン×5シナリオの実ラン、`companyLab/__tests__/destinationMarketPricing.test.ts` 受入確認DMP-1）の両方で確認しており、**逆転は1件も観測されていない**（`pdPremiumWasClampedToZero`・`vapPremiumWasClampedToZero` はいずれも常にfalse）。実装は、万一逆転が発生した場合に備えて `ProductPriceDecomposition` にクランプ発生フラグを持たせているが、これまでの全検証で発火したことはない。

## 4. 商品×仕向市場の参照価格の算出式

`computeMarketReferencePrice`（`market/destinationPricing.ts`）が、以下の式（実装指示 §7）をそのまま実装する。

```
HOSO市場参照価格 = HOSO基礎価値部分
PD市場参照価格   = HOSO基礎価値部分 + PDプレミアム部分
VAP市場参照価格  = HOSO基礎価値部分 + PDプレミアム部分 + VAPプレミアム部分

HOSO基礎価値部分 = hosoBasePrice          × baseValueCoefficient（HOSO/PD/VAPすべてに共通）
PDプレミアム部分 = pdProcessingPremium    × pdPremiumCoefficient（PD・VAPにのみ含まれる。HOSOには含まれない）
VAPプレミアム部分 = vapIncrementalPremium × vapPremiumCoefficient（VAPにのみ含まれる）
```

**係数の適用範囲は部分ごとに厳密に分離されており、「商品全体の価格に単一の市場係数を掛ける」実装には一切なっていない。** これは市場単体テストの「係数適用範囲テスト」5件（`baseValueCoefficient` を変えるとHOSO/PD/VAPすべての基礎価値部分だけが動く／`pdPremiumCoefficient` を変えるとPD・VAPだけが動きHOSOは不変／`vapPremiumCoefficient` を変えるとVAPだけが動きHOSO・PDは不変、という組合せ）で個別に検証している。

### HOSO換算単位の扱い

数量は常に `HosoEqTons`、価格は常に `UsdPerHosoEqKg` のまま扱い、PD加工の物理歩留り比率（約54%）を価格計算へ再度乗じることは一切行っていない。歩留り換算は既存の生産モジュール（原料所要量計算）の責務のままであり、本Phaseの価格分解・係数適用のどこにも歩留り比率は登場しない。

## 5. 会社提示価格への接続

既存の会社提示価格の仕組み（`sales/types.ts` の `CompanySalesPlanEntry.priceAdjustmentUsdPerHosoEqKg`）は、比率ではなく「基準価格に対する加算USD額」という設計であった。実装指示の基本式は `会社提示価格 = 商品×市場の参照価格 × 会社価格調整` という乗算形だったが、実装指示 §9 に明記された「既存ロジックが比率でなく別の意味を持つ場合は、その意味を保ったまま新しい市場参照価格へ接続してよい」という明示的な許容に従い、既存の加算方式の意味はそのまま維持した。

```
会社提示価格(askPrice) = 商品×市場参照価格 + priceAdjustmentUsdPerHosoEqKg
```

`sales/runner.ts` の `advanceSalesQuarter` で、`allocateMarketProduct` に渡す `basePrice` を、旧来の商品別単一基準価格（`deriveVietnamBasePrices`）から、新しい商品×市場参照価格（`deriveVietnamMarketReferencePrices`）へ差し替えただけであり、`allocateMarketProduct`・`waterFillAllocate` 自体のロジックは一切変更していない。

## 6. 相対価格・需要配分への接続

`sales/allocation.ts` の価格競争力計算（`computeCompetitivenessBreakdown`）が使う相対価格の分母を、旧来の「商品単一の基準価格」から「商品×市場参照価格」に変えただけで、需要配分アルゴリズム（水位法 `waterFillAllocate`）自体は変更していない。このため、以下は従来どおり保持される。

- 市場ごとの総需要量（`targetDemand`）
- 営業人員・処理能力から導かれる会社ごとの処理上限（`processingCapacity`）
- 品質・顧客信頼・納期信頼性のスコア（`competitivenessBreakdown`）
- 価格競争力の上限・下限（値下げ乱発防止の天井・底値保護）
- 承認済み取引上限・最大シェア制約

参照価格が高い市場だからといって、会社が無制限に販売量を増やせるわけではない。実際の成約量は引き続き市場規模・価格感応度・品質・信頼・営業人員によって制約される（`companyLab/__tests__/destinationMarketPricing.test.ts` 受入確認DMP-4で、複数社が競合する市場×商品で1社が需要のほぼ全量を独占するケースがないことを確認）。

## 7. 契約価格ロック

契約（`SalesContract.unitPrice`）は成約時点の会社提示価格（商品×市場参照価格＋当時のpriceAdjustment）でそのまま確定し、以降の市場係数の変更や市場参照価格の再計算の影響を一切受けない。これは `sales/runner.ts` の契約生成ロジックを変更していないため自然に保たれており、`companyLab/__tests__/destinationMarketPricing.test.ts` 受入確認DMP-5で、全契約について「成約時点のaskPriceと契約単価が一致し、契約生成後は契約単価が記録から一切変化しない」ことを確認している。原材料価格の変動、将来の市場係数の校正変更のいずれも、既存契約の単価を遡及的に変えることはない。

## 8. 価格感応度（price sensitivity）について

本Phaseでは、商品×市場ごとの価格感応度パラメータ構造そのものの追加・校正は行っていない（実装指示 §11・§23で明示的に対象外）。既存の価格競争力計算（`sales/allocation.ts` の `priceScore` 系ロジック）が使う感応度は変更しておらず、初期値として既存の挙動をそのまま踏襲している。市場ごとの感応度差の本格校正はPhase 8P-0B/8Cへ持ち越す。

## 9. 二段階のコミット構成

実装指示 §12 に従い、構造実装と係数投入を意図的に別コミットへ分離した。

- **Commit A（構造実装、`5dd72f8`）**: `DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1`（全市場・全部分係数=1.0）を `CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS` として使う状態で、価格分解・市場参照価格算出・会社提示価格接続・需要配分接続・autoPolicy接続のすべての配線を実装した。この状態で、`develop/v2` HEAD `31f22fb`（Phase 8B-2A統合済み）とのバイト単位の後方互換性を、Gitワークツリーによる並行実行比較で検証済み（§10参照）。
- **Commit B（本コミット）**: `CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS` の参照先を `DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1` へ切り替え、実際に市場ごとの価格差別化が機能する状態にした。

## 10. Commit Aの後方互換性検証

`develop/v2` HEAD `31f22fb` を `git worktree add` で別ディレクトリに展開し（`node_modules` はシンボリックリンクで共有。`package.json`・`package-lock.json` の差分が0であることを事前確認済み）、同一の検証スクリプトをCommit A状態と旧モデル状態の両方で実行し、JSON出力を突き合わせた。

対象: baseline 8ターン・baseline 32ターン・全5シナリオ（`baseline-v0.1`・`ecuador-early-expansion-v0.1`・`ecuador-delayed-expansion-v0.1`・`global-disease-crisis-v0.1`・`global-demand-boom-v0.1`）×32ターン。

比較項目: 産業合計販売数量・売上・売上原価・粗利、市場別売上・数量、商品別・市場別平均価格、5社別（累計売上・累計原価・累計純利益・期末現金・期末総資産・期末純資産・貸借差額最大値・CF直接間接差額最大値・期末信用スコア・信用格付け・期末借入残高・緊急融資回数・支払不能回数）。

結果: **全項目で完全一致（差分0）**。これによりCommit Aが「構造だけを変更し、経済的な結果には一切影響しない」ことを確認した。

## 11. 初期市場係数（Commit B）

実装指示 §13の方向性表・許容範囲に基づき、以下の素案値を設定した後、§14の加重平均中立化を適用した最終値。

| 市場 | baseValueCoefficient | pdPremiumCoefficient | vapPremiumCoefficient | 方向性 |
|---|---|---|---|---|
| CN | 0.9917 | 0.9395 | 0.8627 | 基礎価値やや低い〜中立／PDやや低い／VAP低い |
| US | 1.0017 | 1.0104 | 1.0352 | 基礎価値中立／PD中立／VAPやや高い |
| EU | 1.0118 | 1.0710 | 1.1502 | 基礎価値やや高い／PDやや高い／VAP高い |
| JP | 1.0168 | 1.0963 | 1.2173 | 基礎価値やや高い／PD高い／VAP最も高い |
| OTHER | 0.9867 | 0.9498 | 0.8819 | 基礎価値やや低い／PDやや低い／VAPやや低い |

いずれも実装指示 §13の許容範囲内（baseValueCoefficient 0.98〜1.02／pdPremiumCoefficient 0.90〜1.10／vapPremiumCoefficient 0.85〜1.25）。

### 加重平均の正規化方法

`DESTINATION_MARKET_DEMAND_WEIGHTS_V1`（`scenario/parameters.ts` の `SCENARIO_PREHISTORY_BASELINE_V1.priorMarketConsumptionHosoEqTons`、CN 380,000／US 320,000／EU 260,000／JP 90,000／OTHER 150,000 HOSO換算トン。全シナリオ共通の基準期需要で、CN 31.667%／US 26.667%／EU 21.667%／JP 7.5%／OTHER 12.5%）を重みとして、方向性表に沿った素案値の加重平均を各部分係数について算出し、素案値をその加重平均で除することで、加重平均がちょうど1.0000になるよう正規化した。3種の部分係数いずれについても、正規化後の加重平均は1.0000±0.0001（丸め誤差程度）。

`weightedAverageCoefficient`（`market/destinationPricingParameters.ts`）がこの検証を再現可能にする関数として存在し、市場単体テストで加重平均が1.0からの乖離0.001未満であることを確認している。

## 12. 産業全体への経済的影響（旧モデル／中立構造／初期係数の比較）

以下は `runCompanyLabWithAutoPolicyForAllCompanies`（5社自動方針込み）による実ランで、旧モデル（`develop/v2` HEAD `31f22fb`）・Commit A中立構造・Commit B初期係数の3状態を比較した結果。中立構造は旧モデルと完全一致するため、実質的な比較は「旧モデル＝中立構造」対「初期係数」で行う。

### 産業合計（全7ランで一貫した傾向）

| 指標 | 変化幅（全7ラン） |
|---|---|
| 産業合計売上 | +0.72%〜+0.87% |
| 産業合計販売数量 | 概ね0.00%（丸め誤差未満） |
| 産業合計粗利 | -0.06%〜+0.30% |

産業合計売上の変化幅は実装指示 §14の許容目標（±3%）に対して十分小さく、数量の変化幅も許容目標（±5%）に対して十分小さい。**数量がほぼ完全に不変なまま売上だけが変化しているのは意図どおりの挙動である**: autoPolicyの各社は市場係数導入後も商品×市場参照価格に対して同じ相対的価格ポジション（askPrice = 参照価格 ×(1+比率調整)）を取るため、価格競争力ウェイトの相対順位は変わらず、成約数量配分は変化しない。一方、商品×市場参照価格そのものが市場ごとに異なる方向へシフトするため、同じ数量でも売上（数量×単価）は市場構成に応じて再配分される。

### 市場別売上（baseline-v0.1・32ターンの例、他ランもほぼ同一の傾向）

| 市場 | 売上変化 | 平均価格変化 | 方向性との整合 |
|---|---|---|---|
| CN | -2.26% | -2.26% | CNの係数が最も低い方向（基礎価値やや低い〜中立・PD/VAP低い）と整合 |
| US | +0.67% | +0.67% | USの係数がほぼ中立（1.00前後）と整合。基準価格に近い水準を維持し、PDが主要市場として引き続き成立する |
| EU | +3.17% | +3.17% | EUの係数がやや高い〜高い（特にVAP1.15）方向と整合。付加価値評価が機能している |
| JP | +4.00% | +4.00% | JPの係数が最も高い（特にVAP1.2173）方向と整合。VAPプレミアムが相対的に最も高い |
| OTHER | -1.98% | -1.98% | OTHERの係数がCNに次いで低い方向と整合。異常な最有利市場にはなっていない |

各市場の**販売数量はいずれも変化率0.00%**（CN/US/EU/JP/OTHERすべて）であり、市場係数の導入は価格の再配分のみをもたらし、数量配分（水位法アルゴリズム・営業人員・処理能力・品質信頼制約）には影響していない。

### 商品別平均価格（baseline-v0.1・32ターンの例）

| 商品 | 価格変化 |
|---|---|
| HOSO | +0.01%（ほぼ不変。加重平均中立化がbaseValueCoefficientについて機能） |
| PD | +0.51% |
| VAP | +1.69% |

VAPの価格変化がPD・HOSOより大きいのは、VAP係数の許容レンジ（0.85〜1.25）がPD係数（0.90〜1.10）・基礎価値係数（0.98〜1.02）より広く、市場間の差別化がより強くかかるよう設計されているため（実装指示 §13の意図どおり）。

### §21「重点確認」チェックリストとの対応

| 確認項目 | 結果 |
|---|---|
| JP向けVAPのプレミアムが相対的に高い | ○（全期間・全シナリオでJP向けVAP参照価格が5市場中最高。`companyLab/__tests__/destinationMarketPricing.test.ts` DMP-2で恒久回帰テスト化） |
| US向けPDが主要市場として成立する | ○（US係数がほぼ中立のため、PDの主要市場としての地位は変化していない） |
| CN向けHOSOが不自然に消滅しない | ○（CN向けHOSO販売数量は変化率0.00%。DMP-3で「需要があるのに成約数量が0になるクォーターがない」ことを恒久テスト化） |
| EU向けの付加価値評価が機能する | ○（EU向け売上が+3.17%と、VAP高評価の方向性どおりに増加） |
| OTHERが異常な最有利市場にならない | ○（OTHERはCNに次いで売上が下落する側であり、最有利market化していない） |
| 単一市場へ全社販売が集中しない | ○（`anyMarketMonopolized` フラグは旧モデル・初期係数のいずれでも全ランでfalse。DMP-4で恒久テスト化） |
| MASSの既存構造的苦境が市場係数だけで不自然に救済されない | ○（MASSの累計純利益はむしろ全7ランで悪化方向（例: baseline-32で-1,126.3M→-1,131.9M）。信用格付けEのまま、緊急融資・支払不能の回数も不変） |
| BAL等の健全会社が市場係数だけで突然破綻しない | ○（BALの売上変化は-0.08%〜-0.10%と軽微、信用格付けはA、緊急融資・支払不能とも全ラン0のまま。DMP-7で恒久回帰テスト化） |

### 5社別の変化の要因説明

会社アーキタイプの主力商品・主力市場の違いが、各社の変化方向を説明する。

- **BAL（バランス型）**: 複数市場・複数商品に分散しているため、市場別の価格変動がプラス・マイナス相殺し合い、売上・純利益の変化は軽微（-0.1%前後）。
- **CONSV（保守型）**: 純利益がやや改善（例: baseline-32で-10.6M→-8.5M）。保守的な価格設定・市場選択により、相対的にプラス方向の市場係数の恩恵を受けやすい構成になっている。
- **JPQ（JP品質重視型）**: 累計純利益・現金が大きく改善（baseline-32で純利益+30.6%・現金+26.7%）。JP・VAPへの傾斜が大きいアーキタイプであるため、JP係数（最高水準）・VAP係数（最も広いレンジ）の両方の恩恵を最も強く受ける。
- **MASS（低価格・量重視型）**: 売上が一貫して-1.08%程度悪化し、純利益もわずかに悪化。CN・OTHER等の低評価市場への依存度が高い構成であるため、これらの市場の係数低下がそのまま不利に働く。既存の構造的苦境（信用格付けE、恒常的な緊急融資・支払不能）はそのまま変わらず、市場係数だけで救済される様子は一切ない。
- **VAP（VAP特化型）**: 純利益・現金が大きく改善（baseline-8で純利益3.4M→11.9M、信用格付けC→Bへ改善）。VAP係数のレンジが最も広く、かつJP・EU等の高評価市場への構成比が高いアーキタイプであるため、恩恵を最も受けやすい。

いずれの変化も、各社の既存アーキタイプ（主力商品・主力市場の組合せ）と市場係数の方向性から自然に説明でき、特定の会社を狙い撃ちした調整は一切行っていない（会社IDに基づく特別処理は存在しない）。

## 13. autoPolicyへの接続

`companyLab/autoPolicy.ts` の `buildSalesPlans` が、旧来の商品別単一参照価格（`referencePriceByProduct`）を、商品×市場参照価格（`referencePricesByMarketProduct`、前期実績ベースで1四半期分のラグを既存設計どおり踏襲）に差し替えた。各アーキタイプの `priceAdjustment`（基準価格に対する比率調整）は、`ratioAdjustmentToUsd` で当該市場×商品の参照価格に対する比率としてUSD換算されるため、`askPrice = 参照価格 × (1 + 比率調整)` という関係が市場によらず保たれる。これにより、市場係数導入後も各社は「商品×市場参照価格に対して同じ相対的価格ポジション」を取り続け、全社が一律に旧世界価格を提示し続けることも、市場参照価格が高いという理由だけで無制限に販売量を増やすこともない（`companyLab/__tests__/destinationMarketPricing.test.ts` DMP-6で恒久回帰テスト化）。会社の市場選択ロジック自体（`profile.preferredMarkets`）は変更しておらず、高度なAIによる市場選択は本Phaseの対象外。

## 14. 診断出力

`companyLab/cli/output.ts` に `formatDestinationPricingDiagnosticCsv` を追加し、`--format pricing-csv` で商品×市場ごとの診断CSV（HOSO基礎価値部分・PDプレミアム部分・VAPプレミアム部分・各係数・市場参照価格の14列、市場×商品=15行/四半期）を出力できるようにした。既存の `COMPANY_QUARTER_CSV_HEADER`（`--format csv`）は一切変更していない。CLIのサマリ出力にも、市場参照価格の1行サマリを追加している。

## 15. 永続化への影響

商品×市場参照価格は、市場結果（`MarketQuarterResult`）と係数テーブルから毎回再導出可能な値であるため、追加の永続化フィールドは設けていない。従来どおり、会社が実際に提示した価格（`priceAdjustmentUsdPerHosoEqKg` を含む販売計画）・契約単価・契約の市場/商品/数量のみを永続化する。schemaVersionの変更・DB/永続化スキーマの変更は不要と判断し、行っていない。

## 16. 今後の校正課題（本Phaseの対象外）

- 商品×市場ごとの価格感応度パラメータの本格校正（現状は既存の単一感応度をそのまま踏襲）
- 初期係数（`DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1`）自体のより精緻な経済的校正（現状は方向性表＋加重平均中立化による暫定値）
- FX・海上運賃・保険・輸入関税・アンチダンピング税・Incoterms別価格・FOB/CIF切替・市場別決済通貨・為替ヘッジ
- 顧客別個別価格・サイズ規格別価格・認証別価格プレミアム・品質による自動価格上乗せ
- スポット対長期契約の価格差・市場間裁定取引
- AIによる高度な市場選択ロジック
- 需要予測画面・販売UI・V2 API/Redis実配線・Vercelステージング反映
