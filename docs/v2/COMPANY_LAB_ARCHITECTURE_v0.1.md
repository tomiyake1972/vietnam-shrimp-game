# ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） アーキテクチャ v0.1

> 【Phase 6.3追記】本文書の経済尺度に関する記述（国内原料価格・調達能力・自動方針の
> 調達構成・成約/履行サマリー集計）はPhase 6.3で是正された。是正内容は
> `docs/v2/ECONOMIC_CALIBRATION_PHASE_6_3_v0.1.md` を正とする。

## 0. 本モジュールの位置づけ

`app/lib/v2/companyLab/` は、Phase 1〜6（市場価格・シナリオ・販売契約・国内原料/輸入/養殖・工場生産）の既存純粋関数を一切書き換えず・重複実装せずに統合し、「5社が契約を取る→原料を確保する→工場で作る→納品する」という会社経営の中核サイクルを1四半期ずつ決定論的に進められるようにする。UI（`/v2/company-lab`）・CLI（`npm run v2:company-simulate`）はどちらもこのモジュールの同じ純粋関数を呼び出すだけの薄い層であり、計算ロジックの複製は一切ない。

対象外（本Phaseでは扱わない）: Redis保存・APIルート、ログイン・ゲームコード、同時プレイ・排他制御（WATCH/MULTI等）、財務三表・会計処理、品質・顧客信頼の動的変化、工場投資・能力増設、Phase7以降のロジック、生成AI、本番AI会社（Phase9）、V1コード、`develop/v2`へのマージ。

## 1. 統合ターン処理順と既存オーケストレーターとの関係

実装指示が示す原則的な四半期処理順（10ステップ）と、既存の`app/lib/v2/turn/runner.ts`（`runTurn`、Phase1・Phase4・Phase5を統合済み）の実行順は完全には一致しない。差異と理由は次のとおり。

| 実装指示のステップ | 既存`runTurn`での対応 | 差異・理由 |
|---|---|---|
| 1. 前期からの輸入到着・養殖収穫・期限切れ | `advanceRawMaterialsQuarter`内で、当期の新規発注・当期の到着処理・期限切れ判定が同一関数呼び出しの中で不可分に行われる | 独立した最初のステップとして切り出さなかった。理由: 新規輸入発注の着地価格計算が当期のHOSO FOB価格（Phase1市場計算の結果）を必要とするため、「前期分の到着処理」と「当期の新規発注」を別ステップに分離すると、輸入モジュールの公開契約（`advanceRawMaterialsQuarter`の1回呼び出しで両方を扱う設計）を書き換えることになる。既存モジュールを変更しない開発ルールに従い、この結合を維持した。 |
| 2. 各社の販売・調達・生産計画を確定 | `companyLab/runner.ts`の`advanceCompanyLabQuarter`が、呼び出し側（画面・CLI）から渡された`CompanyDecisionInput`一式（プレイヤー編集済み、または自動方針生成）をそのまま束ねる | 一致。決定自体の生成はモジュール外（UI/CLI/自動方針）の責務とし、ランナーは「すでに確定した意思決定の集合」を受け取るだけ。 |
| 3. 国内買付意向とPD/VAP供給計画を集計 | `runTurn`内部で`aggregateDomesticPurchaseIntent`（Phase5）を実行。PD/VAP供給シグナルの集計は**Phase6.2で新規配線**（後述） | Phase6実装時点で`production/supplySignal.ts`のロジック自体は用意されていたが、`turn/`へは未接続だった。company-labの`buildSupplySignalInputs`→`applyProductionSupplySignalsToMarketInput`が、この既存ロジックを`calculateMarketQuarter`呼び出し前に接続する、Phase6.2の真の新規実装部分。 |
| 4. Phase2・3のシナリオ、市場価格を計算 | `runTurn`内で`calculateMarketQuarter`を実行 | 一致。 |
| 5. Phase4の販売競争・新規契約生成 | `runTurn`内で`advanceSalesQuarter` | 一致。 |
| 6. Phase5の国内買付配分、輸入発注、養殖池入れ | `runTurn`内で`advanceRawMaterialsQuarter`（ステップ1の輸入到着処理と同一呼び出し） | 一致（順序上はステップ1と統合済み）。 |
| 7. Phase6の原料消費・製品生産 | `advanceProductionQuarter`（`runTurn`の外、company-lab側から呼び出し） | 一致。Phase6は元々`turn/`へ未接続だったため、`companyLab/runner.ts`がこの接続を行う。 |
| 8. 完成品を納期順に契約へ充当 | `applyFulfillments`（Phase4の`sales/backlog.ts`） | 一致。 |
| 9. 約定残、原料在庫、完成品在庫、各種パイプラインを更新 | `updateContractStatusesForQuarterEnd` + `consumeFinishedGoods` | 一致。 |
| 10. 次四半期状態とレポートを生成 | `advanceScenarioTurn` + `buildCompanySummary`（会社別サマリー・理由コード集計） | 一致。 |

要約すると、既存`runTurn`は実装指示のステップ1・3(一部)・4・5・6を1回の呼び出しにまとめて提供する（既存の公開契約を尊重し分割しない）。company-labの`advanceCompanyLabQuarter`は、`runTurn`呼び出しの前にPD/VAP供給シグナル集計（ステップ3の残り、新規配線）を追加し、`runTurn`呼び出しの後にPhase6生産（ステップ7）・契約充当（ステップ8）・状態更新（ステップ9）・レポート生成（ステップ10）を追加する、という構成になっている。

## 2. 統合ターンランナー（`runner.ts`）の主要関数

- `initializeCompanyLab(config: CompanyLabConfig)`: シナリオ初期化・5社フィクスチャ構築・`ProductionState`初期化・初期原料在庫の投入を行い、`{ state, fixtures }`を返す。
- `advanceCompanyLabQuarter(state, fixtures, decisionsByCompanyId)`: 1四半期分だけ状態を進める純粋関数。同じ`state`・`fixtures`・`decisionsByCompanyId`を渡せば常に同じ結果を返す（決定論性はテストで検証済み、§6参照）。入力オブジェクトは一切変更しない。
- `buildCompanyOwnState(state, fixture)` / `buildPublicMarketInfo(state)`: 自動方針・プレイヤー入力編集画面が参照してよい情報だけを取り出すアダプター（§4「情報分離」参照）。
- `runCompanyLabWithAutoPolicyForAllCompanies(config, decisionProvider)`: 初期化から完走まで、指定した意思決定生成関数（通常は自動方針）で全社を動かすヘルパー。CLIと8/32ターン一括実行はこれを使う。

新しい会社ID・商品区分・数量単位・Period型は一切追加せず、Phase1〜6の既存型（`HosoEqTons`・`CompanyId`・`Product`・`PeriodV2`等）をそのまま再利用している。

## 3. 5社の暫定テスト用フィクスチャ（`fixtures.ts`）

**重要**: 以下の5社は本番会社設定ではなく、統合テスト・GM確認用のフィクスチャである（財務三表が未実装のため、保守的会社は「行動」でしか表現できない）。`buildCompanyFixtures(startPeriod)`が生成する。

| 会社ID | アーキタイプ | 特徴 |
|---|---|---|
| BAL | バランス型 | HOSO/PD/VAPをバランス良く生産。中庸な価格・在庫方針。 |
| MASS | 大量生産・価格競争型 | HOSO中心の大量生産、値引き提示で成約量を稼ぐ。工場・養殖能力が最大。 |
| JPQ | 日本・品質志向型 | PD比重が高く、日本向け高値販売志向。 |
| VAP | VAP特化型 | VAP能力が最大、VAPプレミアムに強く依存。 |
| CONSV | 保守的・財務慎重型 | `commitmentRestraint`係数（0.65）で成約・買付・生産希望量を抑制し、過剰契約・過剰在庫を避ける行動を表現（財務三表がないため「行動」でのみ保守性を表す）。 |

各社の工場能力・養殖能力・初期原料在庫は、シナリオの国全体規模（国内原料供給450,000トン/四半期、trailing平均購入90,000トン/四半期規模）と整合するよう、industryLabの小規模テスト値から約100倍にスケールアップして構築している（§5「発見した既存の挙動」参照）。

## 4. 暫定自動方針（`autoPolicy.ts`）— 情報分離の保証

`generateAutoPolicyDecision(fixture, ownState, publicInfo, period, turn)`は、**Phase9で実装予定のAI会社ではなく**、統合テストのために後から交換可能な決定論的ルールベース生成器である（`CompanyDecisionProvider`型を満たす任意の関数に差し替え可能）。

参照してよい情報は、関数シグネチャそのもので保証されている。

- `fixture: CompanyFixture` — 自社の工場・ワーカー基準・養殖能力・営業/調達人員（フィクスチャ定義そのもの）。
- `ownState: CompanyOwnState` — 自社の契約・原料在庫・完成品在庫・前四半期工場負荷指標のみ（`buildCompanyOwnState`が他社データを一切含めずに構築する）。
- `publicInfo: PublicMarketInfo` — 前四半期の実際の市場結果（`lastMarketResult`）とベトナム国内原料の前期価格のみ。当期の市場結果はまだ確定していないため参照できない。
- `period` / `turn` — 現在四半期。将来のシナリオ・イベントスケジュールは一切渡されない。

他社の非公開計画・意思決定オブジェクトそのものを受け取る経路は型シグネチャ上存在しない。生成する意思決定は、市場×商品の販売希望量・価格調整・営業配置、国内買付量・提示価格・調達配置、輸入注文、養殖池入れ・強度・バイオセキュリティ、工場×商品の生産希望量・優先順位、ワーカー配置・残業の全項目をカバーする。

価格調整（`priceAdjustmentUsdPerHosoEqKg`）は、絶対USD固定値ではなく基準価格に対する比率として保持し、`ratioAdjustmentToUsd(ratioAdjustment, referencePrice)`で実際のUSD額へ変換する（比率は[-0.3, +0.3]にクランプ）。理由: シナリオ価格が暴落・フロア近くになった場合でも、`assertValidBidPrice`等の価格範囲検証（市場価格の0.5〜2.0倍）に違反しない頑健性を確保するため。

## 5. 発見した既存の挙動・パラメータ調整（`parameters.ts`）

5社フィクスチャの経済規模をシナリオの国全体規模に合わせる過程で、次の2点を確認・対応した。

1. **国内原料価格のフロア暴落はシナリオ自体に内在する挙動**（company-lab固有のバグではない）。industryLabの`runIndustrySimulation`をデフォルト設定（会社行動なし）で実行しても、turn1の国内原料価格0.96からturn5以降フロア値0.05まで暴落する（`VIETNAM_RAW_MATERIAL_SURPLUS`ドライバー）。5社の需要規模を国全体のtrailing平均（90,000トン程度）と同オーダーに合わせることで、この暴落を実運用上妥当な範囲に抑えた。

2. **調達処理能力パラメータのスケール不整合**: Phase 6.2当初は、company-lab専用に調達処理能力を約100倍へ一律補正した`COMPANY_LAB_RAW_MATERIALS_PARAMETERS`で対処していたが、**Phase 6.3でこの一律補正は廃止した**（経済的根拠がなく、補正後は調達能力が工場能力の7〜11倍と過大で、制約として一度も機能していなかったため）。現在は`rawMaterials/domesticPurchase.ts`の工場能力連動方式（`capacityFactoryLinked`: 調達能力 = 工場共通原料処理能力 × 人員曲線。通常時1.0〜1.5倍）へ置き換えている。詳細は`docs/v2/ECONOMIC_CALIBRATION_PHASE_6_3_v0.1.md` §6を参照。

## 6. 理由コード（`reasonCodes.ts`）

生成AIは使わず、既存Phaseの出力（`shortfallReasons`・`MarketPriceDriver`・契約状態・養殖収穫結果等）から機械的にコード化された理由へ変換するだけの純粋関数群。安値提示による成約増（`LOW_PRICE_WON_SHARE`）、営業能力不足（`SALES_FORCE_SHORTAGE`）、国内買付競争激化（`DOMESTIC_COMPETITION_INTENSE`）、原料不足（`RAW_MATERIAL_SHORTAGE`）、輸入到着待ち（`IMPORT_IN_TRANSIT`）、設備能力不足（`EQUIPMENT_CAPACITY_SHORTAGE`）、ワーカー不足（`LABOR_SHORTAGE`）、残業上限到達（`OVERTIME_CAP_REACHED`）、PD/VAP供給増加によるプレミアム低下（`PD_SUPPLY_INCREASE_LOWERS_PREMIUM`/`VAP_SUPPLY_INCREASE_LOWERS_PREMIUM`）、契約過多による納期超過（`OVER_CONTRACTED_OVERDUE`）、疾病による養殖収穫減（`DISEASE_HARVEST_LOSS`）の全14種類を判定する。

## 7. UI（`/v2/company-lab`）

`app/v2/company-lab/page.tsx`が唯一の状態保持者（React `useState`のみ、Redis・API・localStorage/sessionStorageは一切使わない）。設定（シナリオ・モード・シード・プレイヤー操作会社）、初期化、四半期進行操作（1四半期／8ターン一括／32ターン一括／リセット）、四半期履歴選択、表示モード切替（自社表示／GM全社表示）、タブ切替（意思決定／結果／全社比較）を提供する。

- **意思決定編集**（`DecisionEditor.tsx`）: プレイヤー操作会社のみ、販売計画・国内原料買付・輸入・養殖・生産計画・ワーカー配置の各セクションを編集可能。初期値は当四半期の`generateAutoPolicyDecision`出力から構築し、能力上限・在庫・約定残を併記する。
- **意思決定ルーティング**（重要な規約、`page.tsx`のコメント参照）: 「1四半期進める」はプレイヤー操作会社のみ編集済みドラフトを使い、他4社は各社自身の`fixture`/`ownState`から生成した自動方針を使う。「8/32ターン一括実行」は仕様どおり、プレイヤー操作会社を含む全5社を暫定自動方針で動かす（この操作ではプレイヤー編集は使わない）。
- **情報分離**: 自社表示モードでは、プレイヤー操作会社以外の`companySummaries`・意思決定を一切描画しない（データ自体はクライアント内メモリにあるが、UIが表示しない）。GM全社表示は明示的に「GM専用」ラベルを付け、実際のプレイヤーが見ない情報であることを画面上に明記する。
- **全社比較**（`ComparisonPanel.tsx`、GM専用）: 成約量・履行率・納期超過量・原料確保率・生産量・約定残・原料/完成品在庫のみを表示し、財務指標（未実装）は一切仮計算しない。

## 8. CLI（`npm run v2:company-simulate`）

`app/lib/v2/companyLab/cli/`が、画面と同じ`runCompanyLabWithAutoPolicyForAllCompanies` + `generateAutoPolicyDecision`を呼び出す。

```
npm run v2:company-simulate -- --scenario baseline --mode canonical --seed company-demo-001 --turns 8 --format summary
npm run v2:company-simulate -- --scenario baseline --seed company-demo-001 --turns 32 --company BAL --format json > bal.json
npm run v2:company-simulate -- --scenario baseline --seed company-demo-001 --turns 8 --format csv > result.csv
```

`--format summary`は人間可読、`--format json`/`--format csv`は説明文・ログを一切含まない機械可読出力（`runCompanyLabCli`が標準出力・標準エラー出力・終了コードを値として返し、`scripts/v2CompanySimulate.ts`だけが実際に書き込む）。`--company`省略時は5社比較、特定会社ID指定で個社詳細に絞り込む。

## 9. テスト・検証結果

- `app/lib/v2/companyLab/__tests__/runner.test.ts`（15件）: 5社×8/32ターン完走、決定論性（同一seed→同一結果のJSON完全一致）、全数量非負、原料消費量=完成品数量+加工損失（バッチ単位の数量保存）、契約履行の非過剰性、完成品在庫の非過剰消費、工場×商品の生産量が能力/原料/ワーカー制約を超えない、ワーカー配分が配置人数を超えない（Phase6.1の共有プール保証が統合環境でも成立）、国内買付希望量増加→国内原料価格上昇、PD/VAP供給増加→プレミアム低下、HOSO国際価格の個社非依存性、自動方針の情報分離、プレイヤー入力の会社限定適用、入力オブジェクトの不変性。
- `app/lib/v2/companyLab/cli/__tests__/runCli.test.ts`（21件）: JSON/CSV出力の妥当性（`JSON.parse`可能・CSV列数一致）、summary可読性、`--company`フィルタ、8/32ターン完走、CLIとランナー直接呼び出しの結果一致、再現性、`--help`、11種類の異常系入力での非ゼロ終了コード。
- 既存テスト572件 + 新規36件 = **合計608件、全件成功**（`npm test`）。
- `npx tsc --noEmit`・`npx eslint app/lib/v2 app/v2 scripts`: いずれもエラー・警告0件。

## 10. 画面目視確認（Playwright、コンソールエラー0件）

- PC相当（1440×900）・iPad横向き相当（1194×834）の両方で、初期化→1四半期進行→結果表示（自社表示/GM全社表示）→全社比較タブの一連の操作をスクリーンショットで確認。
- 表・フォームは横スクロール対応（`overflow-x-auto`）。意思決定・結果・全社比較はタブで明確に分離。
- ブラウザコンソールエラー・ページエラーはいずれの解像度でも0件。

## 11. V1への非影響

`app/v2/industry-lab/`配下・V1コード（`main`/`v1-maintenance`ブランチ、V1画面）は一切変更していない。company-labは`app/lib/v2/companyLab/`・`app/v2/company-lab/`・`app/lib/v2/companyLab/cli/`・`scripts/v2CompanySimulate.ts`という独立した新規ファイル群のみで完結する。

## 12. 既知の制約・将来課題

- 財務三表が未実装のため、保守的会社（CONSV）の「財務慎重さ」は行動抑制係数（`commitmentRestraint`）でのみ表現している。将来Phaseで財務三表を接続する際、この係数の意味づけを再校正する必要がある。
- （Phase 6.3更新）調達処理能力は工場能力連動方式へ再校正済み（旧・約100倍一律補正は廃止）。残る暫定値（農家留保価格・外部需要・プレミアム経済性等）は`docs/v2/ECONOMIC_CALIBRATION_PHASE_6_3_v0.1.md` §11参照。
- Phase9のAI会社実装時は、`CompanyDecisionProvider`型を満たす新しい生成器を追加するだけで、既存の自動方針（`generateAutoPolicyDecision`）と差し替え可能な設計になっている。

## 13. Phase 7B: 品質・信頼・納期ダッシュボード（`feature/v2-quality-dashboard`）

Phase 7A（`app/lib/v2/quality/`）が計算・保存した品質・操業リスク・顧客信頼・納期信頼性の実績値を、`/v2/company-lab`上で「なぜ今期の成約量がこうなったか」を経営者が理解できる形へ可視化する。**quality/・sales/の計算式は本Phaseでは一切変更しない**（唯一の計算元とし、UI側で経済計算・品質計算を再実装しない）。

### 13.1 画面構成

既存タブ（意思決定／結果／全社比較）に「品質ダッシュボード」タブを追加した（`page.tsx`）。既存の会社選択・シナリオ設定・四半期進行操作は変更していない。

- **A. 当期経営サマリー**（`QualitySummaryCard.tsx`）: 総生産量・販売可能完成品数量・格落ち/再加工/廃棄量・納期遵守率・重大品質事故の有無、最も深刻な警告1件。
- **B. 商品別品質**（`QualityProductTable.tsx`）: HOSO/PD/VAPごとの品質スコア・操業リスク・生産量・格落ち/再加工/廃棄量・販売可能回収率・重大品質事故。
- **C. 市場別信頼**（`QualityMarketTrustTable.tsx`）: 市場（CN/US/EU/JP/OTHER、`market/types.ts`の既存`DEMAND_MARKET_IDS`をそのまま使用）ごとの顧客信頼・納期信頼性（前期比つき）・当期の納期遵守率。
- **D. 成約競争力の説明**（`QualityCompetitivenessExplanation.tsx`）: 市場×商品ごとに、価格・営業カバレッジ・顧客関係・品質・納期信頼性の5要素の実際の寄与度（後述13.3）と、固定ルールによる日本語説明文（`dashboardExplanation.ts`、生成AI不使用）を表示。
- **警告**（`QualityWarningsList.tsx`）: 急増産・高稼働率・残業負荷・臨時ワーカー依存・商品構成複雑化・原料滞留・品質事故・廃棄増加・信頼低下を、表示専用の「注意／警戒／重大」に区分（13.4）。
- **5社比較**（`QualityCompanyComparison.tsx`、GM専用）: 既存`ComparisonPanel.tsx`と同じ「実プレイヤーは他社の非公開結果を見られない」規約に従い、GM全社表示モードでのみ表示。商品/市場フィルタ切替可能。
- **推移**（`QualityTrendPanel.tsx`）: 8/32ターンを切替可能。品質スコア・操業リスク・数量損失・納期遵守率・信頼・成約量を、意味の近い指標ごとに分けたスパークライン（`QualitySparkline.tsx`、軽量SVG。新規グラフライブラリは追加していない）で表示。

自社表示モードでは常にプレイヤー操作会社のみを対象にし（既存の情報分離規約を踏襲）、GM全社表示モードでのみ表示会社を切替可能にしている。

### 13.2 表示用データ層（`dashboardViewModel.ts`・`dashboardWarnings.ts`・`dashboardExplanation.ts`）

`app/v2/company-lab/dashboardViewModel.ts`が、`CompanyQuarterRecord`（`companySummaries`・`qualityAdjustments`・`deliveryObservations`・`salesRecord.allocations`・`decisions`）から表示用の行・カード・系列データを抽出する。ここで行ってよいのは「抽出・合計・平均・除算による比率表示・前期比較・丸め」だけであり、品質スコア・操業リスク・事故判定・信頼スコア・成約競争力/配分量の**再計算は一切行わない**（テストで直接検証、13.6参照）。`dashboardWarnings.ts`は表示専用の警告閾値判定、`dashboardExplanation.ts`は固定ルールによる日本語説明文生成（生成AI不使用）を担当し、いずれも経済ロジックには影響しない。

### 13.3 エンジン側の最小限の型拡張（計算式・パラメータ値は変更なし）

成約競争力の内訳（価格/カバレッジ/顧客関係/品質/納期信頼性の5要素それぞれの寄与度）は、既存の`CompanyAllocationEntry`（`sales/types.ts`）には合成後の`competitivenessWeight`しか保存されておらず、UI側で内訳を再現しようとすると計算式の再実装が必要になってしまう。これを避けるため、`sales/allocation.ts`の`computeCompetitivenessWeight`を「内訳を返す`computeCompetitivenessBreakdown`」＋「5つのcontributionを合計するだけの`computeCompetitivenessWeight`」へリファクタし、`CompanyAllocationEntry`へ`competitivenessBreakdown: CompetitivenessWeightBreakdown`（読み取り専用の説明用データ）を追加した。

- 計算式・加算順序は変更していないため、`competitivenessWeight`の値はリファクタ前と完全に同一（既存テスト・新規テストの両方でビット単位一致を確認済み）。
- `CompetitivenessWeightBreakdown`は5つのcontribution・clamp前後の価格スコア・価格競争力が上限/下限に到達しているかのフラグを持つ。5つのcontributionの合計は必ず`competitivenessWeight`と一致する（`allocation.test.ts`受入確認D-1〜D-4、`dashboardViewModel.test.ts`受入確認V-3で検証）。
- 併せて、`CompanyQuarterRecord`へ`deliveryObservations`（`quality/deliveryObservation.ts`がrunner.ts内で既に算出していた、会社×市場の当期納期観測。従来は破棄されていた）を追加保存し、市場別の当期納期遵守率をUI側で再計算せずに表示できるようにした。

いずれも既存の計算結果・配分結果・パラメータ値には一切影響しない、追加的な保存のみの変更である。

### 13.4 警告の閾値校正（表示専用、経済ロジックに影響しない）

`dashboardWarnings.ts`の`WARNING_THRESHOLDS`に閾値を集約している。実装当初の暫定値では、5シナリオ×canonical/variation×32ターン（1,600 company-turns）の実測で「商品構成の複雑化」が98.75%、「高い労働稼働率」が61%のターンで警告してしまう校正ミスがあり、実測分布（中央値・p90等）を踏まえて調整した。特に`complexityStress`は現行のcompany fixture設計（ほぼ全社が常に複数商品を生産）のもとではほぼ常に1.0に張り付き、レベル閾値では「異常」と「通常」を判別できないため、現行の生産構成では到達し得ない閾値に置いている（品質パラメータ自体の校正は対象外のため、Phase 8以降の校正時に要見直し）。回帰確認は`dashboardWarnings.test.ts`受入確認W-9（実エンジン出力を使い、単一の警告種別が異常な頻度で発生しないことを検証）。

### 13.5 companyLabの永続化状態（QUALITY_RELIABILITY_ARCHITECTURE_v0.1.md §9と同一の前提）

本Phaseでもこの前提は変わらない。companyLabはブラウザ内メモリ状態のみで保持され（リロード・再起動で消失）、Redis/APIへの実配線は行っていない。品質ダッシュボードが表示するデータもすべて同一セッション内のクライアントメモリ上の値であり、永続化・共有の対象ではない。

### 13.6 テスト・検証結果

- `app/v2/company-lab/__tests__/dashboardViewModel.test.ts`（13件）: 表示用データがPhase 7A保存結果とビット単位で一致すること（再計算していないことの直接証明）、HOSO/PD/VAP商品別表示、重大品質事故あり/なしの表示、生産ゼロ時に誤った事故検出をしないこと、5社比較の対応関係、8/32ターン推移の件数、同一シードでの完全再現性、NaN/Infinity不在（32ターン×5社の全表示データ走査）。
- `app/v2/company-lab/__tests__/dashboardWarnings.test.ts`（9件）: 正常操業時に警告が出ないこと、生産ゼロ時に誤検出しないこと、急増産/高稼働率/品質事故/廃棄増加/信頼低下それぞれの閾値境界、警告の重大度ソート、実エンジン出力での校正回帰確認。
- `app/v2/company-lab/__tests__/dashboardExplanation.test.ts`（9件）: 価格競争力上限到達時に「追加値下げ余地あり」と矛盾する文言を出さないこと、品質/信頼/納期評価の高低に応じた文言の整合性、前期比較コメントの断定回避。
- `app/lib/v2/sales/__tests__/allocation.test.ts`に追加した4件（受入確認D-1〜D-4）: `competitivenessBreakdown`の合計と`competitivenessWeight`の厳密一致、価格競争力上限到達時の`isPriceScoreAtCeiling`判定。
- 既存テスト753 - 35 = 718件（develop/v2マージ後時点）に、本Phaseの新規35件を加えた**合計753件、全件成功**（`npm test`）。
- `npx tsc --noEmit`・`npm run lint`: いずれもエラー・警告0件。

### 13.7 画面目視確認（Playwright）

- PC相当（1440×900）・iPad横向き相当（1180×820）の両方で、初期化→8ターン一括実行→GM全社表示→品質ダッシュボードタブの一連の操作をスクリーンショットで確認。全セクション（当期経営サマリー・警告・商品別品質・市場別信頼・成約競争力の説明・推移・5社比較）が両解像度で正しく表示され、NaN/undefined等の異常表示は見られなかった。
- 自社表示モードでは5社比較セクションが描画されないこと（既存の情報分離規約の踏襲）を確認。
- 比較表・成約競争力の説明は横スクロール対応（`overflow-x-auto`）。警告・主要指標は横スクロールの外（先頭）に配置し、確認が隠れないようにしている。

### 13.8 対象外・将来課題

- 品質パラメータの本格校正（`complexityStress`が常に飽和する等の根本原因）、Phase 7B UI以外のQA人員/品質投資、再加工費/廃棄損/格落ち価格差の財務計上、ブランド価値、companyLab→Redis/API実配線、V2本番ゲーム画面への統合は、いずれも本Phaseの対象外。
- 警告閾値（`WARNING_THRESHOLDS`）は表示専用の暫定値であり、Phase 8以降の品質パラメータ校正と合わせて再校正する余地がある。

### 13.9 develop/v2マージ前の重点受入確認（追記）

三宅さんの重点受入確認指示に基づき、develop/v2へのマージ前に以下を追加確認した。

**競争力計算の同一性**: `sales/__tests__/competitivenessRefactorEquivalence.test.ts`（新規9件）で、リファクタ前の元計算式を本ファイル内へ独立して再現し、境界値（価格競争力の上限/下限ちょうど）・複数商品市場・カスタムパラメータ・NaN/Infinity/負数の拒否・200件の決定論的疑似ランダムケースを含め、現行実装とビット単位で一致することを確認した（13.3の「ビット単位一致」を、代表例だけでなく網羅的境界値・多シナリオで裏付け）。

**deliveryObservationsの時系列**: `companyLab/__tests__/deliveryObservationsHistory.test.ts`（新規7件）で、会社×市場の全組合せの過不足がないこと、過去四半期レコードが後続ターン実行後も不変であること（同一シードでのJSON完全一致による確認）、8ターン実行と32ターン実行で共通する先頭ターン分の値が一致すること、`period`がターン順に単調増加すること、表示層（`buildMarketTrustRows`）が参照する値が生データと一致することを確認した。

**情報分離のDOM検証**: Playwrightで自社表示モード時、品質ダッシュボードタブのDOM（`innerText`/`innerHTML`）に他社の会社名・会社ID・GM専用ラベル・比較セクションが一切出現しないこと、GM全社表示モードでは正しく出現し会社切替が機能することを直接検証した（検証用に`page.tsx`の品質タブ直下へ`data-testid="quality-tab-panel"`を追加。表示ロジック・データには影響しない）。なお検証中、自社表示モードのDOMに文字列"VAP"が出現するケースを検知したが、これは他社「VAP特化水産」のデータ漏洩ではなく、商品コードVAP（Value-Added Product、`PRODUCT_LABELS`）が同名であることによる正常な表示であることをHTML該当箇所の直接確認で切り分けた。

**本番統合時のサーバー側情報分離**: §4「自社表示モードでは...UIが表示しない」は、companyLabがブラウザメモリ上に全社データを保持しつつUI側で非表示にする現状の設計を説明しているが、本番プレイヤー画面へ統合する際に「サーバー側で他社の非公開データをそもそもクライアントへ送らない」設計が別途必要であることは明記されていなかったため、ここに追記する。**将来課題（本Phase対象外）**: 本番統合時は、companyLabのようにクライアントメモリへ全社データを保持する方式ではなく、APIレスポンス自体を要求元プレイヤーの会社に絞り込むサーバー側フィルタリングが必須である。companyLabは開発・GM専用のローカル検証画面であるため、この制約は本Phaseのブロッカーにはしない。

**complexityStress診断**: 一時診断スクリプト（5シナリオ×canonical/variation×32ターン、4,770バッチ、確認後削除済み）による実測は以下の通り。

- 根本原因: `productMixComplexity = (生産商品種類数 - 1) / 2`（`production/loadMetrics.ts`）に対し`calculateComplexityStress`は`clamp01`を適用するだけ（`quality/operationalRisk.ts`）。5社フィクスチャの各工場がほぼ常に3商品（HOSO/PD/VAP）すべてを生産する設計のため、`complexityStress`は99.37%のバッチで1.0、0.21%で0、残りが0.5となり、事実上ほぼ恒常的に飽和する。
- 操業リスク全体への寄与度: `complexity`の重みは0.1（`QUALITY_PARAMETERS_V1.operationalRisk.weights.complexity`）。反実仮想比較（複雑度項を0として他5要因だけで合計した場合）により、`operationalRisk`の平均値は複雑度項ありで0.3029、なしで0.2034となり、平均差分は0.0996——理論上の最大寄与（重み0.1×complexityStress=1.0）とほぼ一致する。つまり複雑度項は「差を生む変数」としてではなく、ほぼ全社・全四半期に一律加算される定数（約+0.10）として機能している。
- 5社×32ターンでのoperationalRisk分布: 会社別平均はBAL 0.312、MASS 0.304、JPQ 0.250、VAP 0.262、CONSV 0.386（会社間の最大-最小差0.136）。この差は複雑度項（一律+0.10）以外の5要因（設備稼働・残業・臨時ワーカー・原料経過期間・急増産）から生じており、複雑度項が飽和していても会社間の意味のある差別化は依然として機能している。
- 重大事故・品質損失への実際の影響: 4,770バッチ中、重大事故発生は52件（1.090%）、総生産量に対し格落ち0.621%・再加工0.345%・廃棄0.499%（うち重大事故起因の廃棄が78,474のうち14,006）。`calculateMajorIncidentProbability = 0.002 + 0.08 × operationalRisk²`（二乗）のため、複雑度項による約+0.10の一律加算は、平均的な重大事故確率をおよそ0.52%（複雑度項なし試算）から0.92%（複雑度項あり試算）へ引き上げている計算になり、単なる表示上の飽和にとどまらず、重大事故発生確率の底上げという実質的な影響を持つ。ただし本Phaseでは計算式・係数は変更しない（三宅さんの指示どおり）。
- 警告機能への影響: `WARNING_THRESHOLDS.complexityStress`（warn 1.5 / alert 1.7 / critical 1.85）は`complexityStress`の実際の取りうる範囲（0〜1）を超えており、到達不能に設定されている。**「商品構成複雑化」警告カテゴリは、本Phaseの表示閾値設定により実質的に常時休止中である**（他の警告カテゴリは正常に機能する）。
- 結論・Phase 8以降への申し送り: 現行のcompany fixture設計（各社が常時ほぼ全商品を生産）を前提とする限り、`complexityStress`を「警告に使える差別化変数」として機能させるには、(1) `productMixComplexity`の算出方法自体の見直し（例: 商品種類数ではなく生産量シェアの偏り等を使う）、(2) 5社フィクスチャの商品構成に意図的な差を持たせる、のいずれかが必要。いずれも品質パラメータ・fixtureの本格校正であり、本Phaseの対象外のためPhase 8以降の校正課題として送る。
