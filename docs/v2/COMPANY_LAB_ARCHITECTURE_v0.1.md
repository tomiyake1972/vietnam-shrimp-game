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
