# ShrimpX V2 — 業界シミュレーション・テスト環境 アーキテクチャ v0.1（Phase 3）

対象コード: `app/lib/v2/industryLab/`（純粋ロジック）、`app/v2/industry-lab/`（画面）
関連ドキュメント: `docs/v2/CORE_ARCHITECTURE_v0.1.md`、`docs/v2/MARKET_PRICING_ARCHITECTURE_v0.1.md`、`docs/v2/SCENARIO_EVENT_ARCHITECTURE_v0.1.md`

## 1. 目的

Phase 1（市場・価格形成モジュール）とPhase 2（長期シナリオ・イベントモジュール）は、それぞれ独立してテスト済みだが、実際につないで「32四半期にわたり世界の生産・需要・疾病・景気とHOSO・ベトナム原料・PD/VAP価格がどう動くか」を目視・数値で確認できる場所がまだ存在しなかった。

Phase 3は、会社経営機能（販売・調達・生産・財務・AI会社等）が一切なくても、この2モジュールを実際に接続して動かし、開発者・GMがバランス調整のために結果を確認できるテスト画面を提供する。ゲーム本編には一切接続しない、開発者・GM専用の検証環境である。

## 2. シナリオモジュールと市場モジュールの接続順序

`app/lib/v2/industryLab/simulationRunner.ts` が、次の順序で1四半期分の計算を行う（実装指示 §3のパイプラインそのもの）。

```
1. シナリオ選択        findScenarioDefinition(scenarioId) — ALL_SCENARIO_DEFINITIONS（5シナリオ）から検索
2. シナリオ初期化       initializeScenario(definition, mode, seed) — Canonical/Variation・乱数シードを確定
3. 当期シナリオ入力生成  getScenarioTurnInput(state, turn)
4. 市場入力へ変換       toMarketQuarterInput(turnInput, previousMarketContext)
                        ※ previousMarketContextは本モジュールが組み立てる（§4参照）
5. 市場・価格形成計算    calculateMarketQuarter(marketInput, MARKET_PARAMETERS_V1, randomStream)
                        ※ randomStreamはターンごとに導出した専用シードから作成（§5参照）
6. 当期結果を履歴へ保存  IndustryQuarterRecordとしてIndustrySimulationState.quartersに追加
7. 市場結果をフィードバックへ渡す
                        ScenarioTurnFeedback = { realizedMarketResult: marketResult }
8. 次四半期へ進む        advanceScenarioTurn(state, feedback) → 次のScenarioState
```

このパイプラインは3つの純粋関数として公開されている。

- `initializeIndustrySimulation(config): IndustrySimulationState` — 1〜7を実行せず、シナリオ初期化のみ行う（quarters: []）。
- `advanceIndustrySimulation(state): IndustrySimulationState` — 上記1四半期分（3〜8）を実行し、新しいstateを返す（入力stateは変更しない）。
- `runIndustrySimulation(config): IndustrySimulationResult` — 初期化後、`isComplete`になるまで`advanceIndustrySimulation`を繰り返す一括実行版。

Redis・API Route・外部サービスには一切依存しない。市場・シナリオモジュールへは、それぞれの安全な公開口（`app/lib/v2/market`・`app/lib/v2/scenario`）からのみアクセスし、`app/lib/v2/index.ts` の一括importは使っていない。

## 3. ターン境界の扱い

シナリオ定義には固有の`durationTurns`（20〜40、標準32）があり、ユーザーが指定する実行ターン数`config.turns`はこれ以下でなければならない（`initializeIndustrySimulation`が検証）。

`advanceScenarioTurn`はシナリオの`durationTurns`に到達した状態で呼ぶと例外を投げるため、`advanceIndustrySimulation`は`turn < scenarioDefinition.durationTurns`のときだけ`advanceScenarioTurn`を呼び、それ以外は`scenarioState`を据え置いて`isComplete`をtrueにする。`isComplete`は「`config.turns`分の四半期を生成し終えた」または「シナリオ自体の最終ターンに到達した」のどちらかで真になる。

## 4. 会社意思決定未接続の暫定前提（`assumptions.ts`）

販売・5社の調達意思決定・海外生産者の価格反応はまだ実装されていない。市場モジュールの入力（`PreviousMarketContext`）には「直近のベトナム国内調達希望量」が必要だが、会社側の意思決定が無いため、これだけは本テスト環境固有の仮置きが必要になる。

`INDUSTRY_LAB_ASSUMPTIONS_V1`（`IndustryLabAssumptions`）が持つのは`domesticProcurementIntentToTrailingAverageRatio`（既定値1.0）のみで、ターン2以降の`domesticProcurementIntent`を「シナリオモジュールが実際の市場結果から計算した直近4四半期の国内買付移動平均 × この比率」として導出する。会社が「直近と同水準を買うつもりでいる」という最も単純な代替である。

実装指示 §5が明示的に確認を求めた他の5項目は、いずれもPhase1/Phase2がすでに持っている値をそのまま使っており、Phase 3独自の仮置きは追加していない（画面・コード双方に出典を明記）。

| 項目 | 出典 | Phase3の新規仮置きか |
|---|---|---|
| ベトナム国内調達希望量（ターン1） | `ScenarioDefinition.initialStateOverrides.initialDomesticProcurementIntentHosoEqTons` | いいえ（既存値） |
| ベトナム国内調達希望量（ターン2以降） | 上記の移動平均 × `domesticProcurementIntentToTrailingAverageRatio` | **はい（本モジュール固有の唯一の仮置き）** |
| 過去4四半期の国内買付平均 | シナリオモジュールが`ScenarioTurnFeedback.realizedMarketResult`から算出 | いいえ（既存の計算結果） |
| 初期の前期HOSO価格・初期需要 | `ScenarioDefinition.prehistory`（2〜4年分の前史データ） | いいえ（既存値） |
| PD/VAP需要構成 | シナリオモジュールの既存パラメータ（地域別需要合計に対する固定シェア） | いいえ（既存値） |
| 海外生産者の価格反応 | `ScenarioTurnFeedback.externalProducerResponses`（記録用の型のみ） | 未実装（次期供給計算へは未反映。画面に明記） |

画面には`AssumptionsNotice`コンポーネントが常時表示され、上記6項目すべてを開閉式パネルで説明する（実装指示 §5「会社意思決定未接続の暫定前提であることを表示する」）。

## 5. 四半期ごとの乱数シード

市場モジュールの`RandomStream`はターンごとに`` `${baseSeed}::market::turn${turn}` ``という文字列から`createRandomStream()`で導出する。シナリオモジュール自身の`RandomStream`（イベントのVariationジッター等に使用）は`initializeScenario`内部で一度だけ作成される別系統であり、混同しない。`Math.random()`は一切使用していない。

同じ`seed`・`scenarioId`・`mode`・`turns`であれば、常に同じ結果が再現される（シナリオ比較機能はこの再現性を前提にしている）。

## 6. 画面構成

URL: **`/v2/industry-lab`**（V1画面とは衝突しないV2専用ルート）。`app/v2/industry-lab/page.tsx`が全状態を保持するClient Componentで、下位コンポーネント（`app/v2/industry-lab/components/`）は表示のみを担当する。

構成:

- `LabBanner` — 常時表示のテスト環境バナー（インディゴ、V1の環境バナーとは配色を変えて区別）。
- `AssumptionsNotice` — §4の暫定前提の開閉式パネル。
- `ScenarioControls` — シナリオ選択（5種）・Canonical/Variationモード・乱数シード入力・実行ターン数（20〜40、既定32）・開始/1四半期進める/最後まで一括実行/リセット。
- `SummaryPanel` — シナリオ名・モード・シード・ターン進捗・期間・世界供給/需要/需給ギャップ・国際HOSO価格（国別）・ベトナム国内価格・現在発生中の主要イベント。
- 折れ線グラフ4種（`LineChart`、後述）。
- `PriceDriversPanel` — 価格変動理由（理由コード＋数値内訳）。
- `EventsPanel` — イベントの内部の真実（GM専用ビュー）。
- `InformationPanel` — 情報レベル別の公開情報。
- `ComparisonPanel` — 同シード・同モード・同ターン数での2シナリオ比較。

「表示する四半期」セレクタで任意のターンを選んで過去の四半期を確認でき、既定は「最新に追従」（新しく進めるたびに自動で最新四半期を表示）。

### 「入力変更が古い結果に混ざらない」設計

フォームの下書き値（`draftScenarioId`・`draftMode`・`draftSeed`・`draftTurns`）と、実行中のシミュレーション状態（`labState: IndustrySimulationState`）は明確に分離している。`labState`は「シミュレーション開始」を押した瞬間の下書き値のスナップショットから`initializeIndustrySimulation`で作られ、以後は下書き値をどう変更しても`labState`（＝画面に表示される実際の計算結果）には一切影響しない。新しい設定を反映するには、必ずもう一度「シミュレーション開始」を押す必要がある（内部的には新しい`IndustrySimulationState`に丸ごと置き換わる）。

## 7. 情報レベルの分離

`IndustryQuarterRecord`は、四半期ごとにpublic/standard/advanced/gmの4レベルの`InformationRelease[]`をあらかじめ計算済みで保持している（`getAvailableInformation`をレベルごとに4回呼んで生成）。画面側（`selectInformationForLevel`）は選択されたレベルに対応する配列を選ぶだけで、フィルタや再計算は行わない。これにより「public表示中にadvanced/gm情報が混入する」ことが型・実装の両方で構造的に起こらない。

`EventsPanel`（紫系、「内部の真実 — GM専用ビュー」）はテスト環境が開発者・GM専用であることを踏まえ、`hiddenDescription`を含むイベントの生データをそのまま表示する。`InformationPanel`（青系、「公開情報」）とは配色を変え、一方が内部の真実、他方がプレイヤー相当の公開情報であることを視覚的に区別している。Playwrightでの検証では、baselineシナリオの疾病イベントについて、publicレベルでは情報0件、standardレベルでは噂1件、gmレベルでは噂＋確定情報＋GM専用情報2件が表示されることを確認した（レベルの累積関係 public⊂standard⊂advanced⊂gm が実際に機能している）。

## 8. シナリオ比較

`ComparisonPanel`は、現在の`labState.config`（シナリオ以外のmode・seed・turnsはそのまま）を使って、比較対象シナリオIDだけを差し替えた`IndustrySimulationConfig`で改めて`runIndustrySimulation`を実行する。プライマリのシミュレーションがどこまでステップ実行されているかに関わらず、比較は常にA・Bとも`1..turns`の完全な実行結果同士で行われる。

差分計算は`app/lib/v2/industryLab/ui/comparison.ts`の`compareIndustrySimulations(a, b)`が担い、ターン数が一致しない2結果を渡すと例外を投げる。画面（`ComparisonPanel`・`page.tsx`）はこの結果を並べて表示するだけで、価格・需給の計算をUI側で再実装していない。差分は国別HOSO価格・ベトナム国内価格・世界供給・世界需要・PD/VAPプレミアム・イベントの片方のみ登場分（`onlyInA`/`onlyInB`）を含む。

## 9. グラフ

既存プロジェクトにグラフ用ライブラリの依存が無いため（`package.json`確認済み）、新規に大きな依存を追加せず`app/v2/industry-lab/components/LineChart.tsx`としてSVGのみで折れ線グラフを自作した。凡例・軸目盛・単位・対象期間を表示し、系列は色に加えて線種（実線/破線/点線等）でも識別できるようにしている。

実装済みグラフ: 国際HOSO価格トレンド（国別FOB）、ベトナム国内原料価格トレンド、世界供給・需要トレンド、PD/VAPプレミアムトレンド、シナリオ比較（HOSO価格差・世界供給/需要差）。データはすべて`app/lib/v2/industryLab/ui/chartData.ts`・`comparison.ts`の純粋関数がシミュレーション結果から取り出すだけで、価格計算は一切行わない。

## 10. クライアント安全性

- Redisインポートなし。`app/lib/redis.ts`（V1）・`app/lib/v2/redis/*`はどこからもimportしていない。
- API Routeなし。すべてブラウザ内（クライアントサイド）で計算する。
- `process.env`・`APP_ENV`・`APP_VERSION`をクライアントへ渡していない。`app/lib/v2/core/version.ts`の環境変数読み取り関数（`readAppVersionFromEnv`等）は本モジュールから一切呼び出していない。
- 秘密情報をクライアントへ渡していない。
- `Math.random()`不使用。既存の`RandomStream`（`app/lib/v2/core/random.ts`）のみ使用。
- インポートは`app/lib/v2/market`・`app/lib/v2/scenario`の安全な公開口、および`app/lib/v2/core/{period,units,random}`から直接行い、`app/lib/v2/index.ts`の一括importは使っていない（将来Redis関連モジュールが増えても本モジュールに影響しない）。

## 11. テスト方法

`app/lib/v2/industryLab/__tests__/`配下に、既存のNode組み込みテストランナー（`tsx --test`、globは`app/lib/**/__tests__/**/*.test.ts`のまま変更なし）で実行されるテストを配置した。

- `simulationRunner.test.ts` — シナリオ初期化・1四半期進行・最終ターンでの停止・ターン数超過時のエラー・履歴の不変性・乱数シードの再現性等、約17項目。
- `comparison.test.ts` — 同一シナリオ・同一シード比較で差分が0になること、シナリオが異なる場合の差分、ターン数不一致時のエラー等、5項目。
- `ui.test.ts` — ラベル・フォーマッタ・セレクタ・グラフ用データ変換の純粋関数テスト（情報レベルの累積関係 public⊂standard⊂advanced⊂gm の検証を含む）。

`page.tsx`・`components/*.tsx`自体は自動テストの対象にしていない（新規の大規模なReactテスト依存を追加しない方針のため）。表示用の計算ロジックはすべて`app/lib/v2/industryLab/ui/*`の純粋関数へ分離済みで、そちらがテスト対象になっている。UI自体の動作確認はPlaywrightによる目視検証（本ドキュメント作成時に実施、開発サーバー上で5シナリオ選択・32ターン一括実行・1ターンずつ進行・比較機能・情報レベル切り替え・PC/iPadランドスケープ相当の画面幅を確認、コンソールエラーなし）で行った。

## 12. 未実装項目

以下は本Phase 3の対象外であり、実装していない。

- Redis永続化・ゲームセッション永続化
- API Route
- GMによるシナリオ編集・シナリオ作成UI
- 各社の個別意思決定（販売・契約・原材料調達・生産/工場/人員・財務諸表）
- AI会社・Claude API・自然言語コメンタリー
- 本番Vercel設定の変更・V2専用Vercelプロジェクトの新設
- V1コードの変更・既存のPreviewエラーの修正

## 13. 今後ゲーム本体と接続する際の接点

- `IndustrySimulationConfig`・`runIndustrySimulation`/`advanceIndustrySimulation`はゲームセッションの永続化層（Redis等）を挟めばそのまま「実際のゲーム進行エンジン」の中核として再利用できる（本モジュール自体はRedisを知らないため、呼び出し側で状態を都度保存すればよい）。
- `PreviousMarketContext.domesticProcurementIntent`は、5社の実際の調達意思決定が実装された時点で、`IndustryLabAssumptions`の仮置きロジックを置き換えるだけで差し替えられるよう分離してある。
- `ScenarioTurnFeedback.externalProducerResponses`は型としてはすでに用意されているため、海外生産者の価格反応ロジックが実装された際はここへ実際の値を渡すだけでよい（現状はundefinedのまま）。
- `InformationRelease`の4レベル構造は、将来AI会社・プレイヤー会社ごとに異なる情報アクセス権を与える設計にそのまま利用できる。
