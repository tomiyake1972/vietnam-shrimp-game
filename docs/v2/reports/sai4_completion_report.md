# Phase SAI-4 完了報告 — 標準AI異質5社テスト実装（小幅な経営性格差・養殖上限4,000トン）

対象ブランチ: `feature/v2-sai4-heterogeneous-standard-ai`
分岐元: `feature/v2-sai3b-excel-analysis`（コミット`b933b04`。三宅さんの追加条件1のとおり）
本Markdownは`docs/v2/reports/sai4_completion_report.md`としてgit管理下にあります。
生成物（`artifacts/sai4/*`）自体はgit管理対象外です（`.gitignore`参照）。

> **重要な依存関係（三宅さんの追加条件1）**: 本ブランチは`feature/v2-sai3b-excel-analysis`
> （SAI-3B-2の受入レビュー2回目対応まで含む、コミット`b933b04`）を土台にしています。
> `develop/v2`は現時点で`b1733e1`（SAI-3A統合まで）であり、SAI-3B-2はまだ`develop/v2`へ
> 統合されていません。したがって**本ブランチの成果は、SAI-3B-2の統合に依存する子
> ブランチ**です。将来`develop/v2`へ統合する際は、原則として**SAI-3B-2を先に受け入れ・
> 統合し、その後に本ブランチ（SAI-4）を統合する**という順序を推奨します（本ブランチを
> 先に、あるいは単独で`develop/v2`へマージすると、SAI-3B-2のコミットが未統合のまま
> 本ブランチの差分だけが混入する可能性があるため）。`main`・`develop/v2`への変更は
> 今回も一切行っていません。

## 0. スコープ境界の確認（§12・§13）

- `main`・`develop/v2`への変更は一切ありません。
- 実装したのは以下のみです: (1) 5社への小幅な経営性格バイアス、(2) 養殖上限
  4,000トンの実行時override機構、(3) 上記2点の診断ログ・自動テスト・試験run・
  Excel分析・設計メモ・本報告書。
- 対象外（§12）としていた以下は一切実装していません: 各社の初期能力・財務差、
  役員個別AI対話、Claude API取締役会、役員階級、プレイヤー向け助言UI、
  全面的なゲームバランス調整、特定社を勝たせるための係数調整、`main`変更、
  `develop/v2`への無断統合。
- `develop/v2`への統合は行っていません（三宅さんの指示・追加条件7のとおり）。

## 1. 実装内容（§2〜§6）

### 1.1 経営性格プロファイル（`managementProfile.ts`、新規ファイル）

新規ファイル`app/lib/v2/companyLab/standardAi/managementProfile.ts`に、以下を
一箇所に集約しました:

- `ManagementProfileId`（`"balanced" | "growth" | "conservative" | "valueAdded" | "opportunistic"`）
- `MANAGEMENT_PROFILES`: 5プロファイルの定義（値の意味・基準値・許容範囲は
  各フィールドのdocコメントに明記）
- `MANAGEMENT_PROFILE_BY_COMPANY_ID`: 会社ID→プロファイルの対応表
  （**会社IDによる分岐はここだけに存在**。`policy.ts`・`decision/*.ts`には
  一切持ち込んでいません）
- `deriveStandardAiParameters(base, profile)`: 比率/絶対値バイアスを
  `StandardAiParameters`へ適用し、適用したバイアス項目一覧（§8用）を返す
  純粋関数。許容範囲（±10%、`MAX_BIAS_RATIO`）を超えるプロファイルは
  実行時エラーになる安全弁つき。
- `createManagementProfileParamsResolver()`: `policy.ts`の
  `createStandardAiProvider({ resolveParams })`へそのまま渡せるリゾルバ

会社IDとプロファイルの対応（BAL/MASS/JPQ/VAP/CONSVはPhase 6.2由来の会社ID
ラベルで、現在は5社とも初期条件が完全に同一であることに変わりありません）:

| 会社ID | プロファイル | 三宅さんの指示上の呼称 |
|---|---|---|
| BAL | balanced | A社（基準・バイアスなし） |
| MASS | growth | B社（成長・シェア重視） |
| CONSV | conservative | C社（財務保守・CFO視点） |
| VAP | valueAdded | D社（高付加価値(PD/VAP)重視） |
| JPQ | opportunistic | E社（機会追求・速い反応） |

BAL→balanced、CONSV→conservative、VAP→valueAddedはPhase 6.2のarchetype名
（balanced/conservative/vapSpecialist）と自然に対応します。MASS
（massMarket＝大量生産・価格競争）はB社の成長・シェア重視像と対応させました。
JPQ（Phase 6.2では"japanQuality"）だけは対応する性格が残っていなかったため、
消去法でE社を割り当てています（Phase 6.2の"品質重視"という意味合いは今回の
プロファイルに一切引き継いでいません。単なる会社IDラベルの再利用です）。

### 1.2 プロファイルごとのバイアス値一覧（§6「一か所で確認できる」）

基準値はすべて`STANDARD_AI_PARAMETERS_V1`（既存の全社共通デフォルト、
本ファイル自体は無変更）。許容範囲は原則±5%、最大±10%（絶対値バイアスは
「参照基準に対して10%相当まで」という同じ考え方を適用）。

| 項目（意味） | 対象パラメータ | 基準値 | A社 | B社(growth) | C社(conservative) | D社(valueAdded) | E社(opportunistic) |
|---|---|---|---|---|---|---|---|
| 販売積極性（能力に対する目標販売比率） | `salesUtilizationTarget` | 0.8 | ±0% | +5%→0.84 | −3%→0.776 | ±0% | +3%→0.824 |
| 値引き許容度（在庫過剰時の最大値引き率） | `maxDiscountRatioForExcessStock` | 0.12 | ±0% | +5%→0.126 | −5%→0.114 | ±0% | ±0% |
| 調達構成の輸入依存度 | `importMixRatio` | 0.15 | ±0% | +5%→0.1575 | −5%→0.1425 | ±0% | ±0% |
| 在庫是正の反応速度 | `inventoryCorrectionDamping` | 0.5 | ±0% | ±0% | −5%→0.475 | ±0% | +8%→0.54 |
| 正社員人数調整ペース | `regularHeadcountAdjustmentDamping` | 0.5 | ±0% | +5%→0.525 | −5%→0.475 | ±0% | ±0% |
| 養殖自給選好 | `maxAquacultureShareOfRequirement` | 0.35 | ±0% | ±0% | −5%→0.3325 | +5%→0.3675 | ±0% |
| 高付加価値(PD/VAP)受注選好（絶対値・参照基準1.0） | `valueAddedOrderFactorBoost` | 0 | ±0 | ±0 | ±0 | +0.05 | ±0 |
| PD/VAP設備投資前倒し（絶対値・参照基準1.05） | `capexShortfallThresholdBiasByProduct.pd/vap` | 0 | ±0 | ±0 | ±0 | +0.05（各） | ±0 |

**安全ガード対象外（一切バイアスしない）**: `cashBufferQuarters`・
`minimumCashBufferFloorUsd`・`capexCashSafetyMultiple`・
`capexMaxLoanToSizeRatio`・`severeCashPressureThreshold`・
`cashConstrainedProcurementDampingAtSeverePressure`・
`capexSustainedUtilizationThreshold`・`expectedAquacultureHarvestRatio`・
`aquacultureIntensity`・`bioSecurityLevel`・`finishedGoodsTargetQuarters`・
`rawMaterialTargetQuarters`・`minDomesticPurchaseRatioOfBase`。これらは現金
危機対応・赤字回避・容量/在庫/資金制約・デフォルト回避に直結するため、
どのプロファイルでも`STANDARD_AI_PARAMETERS_V1`と完全に同値であることを
自動テストで保証しています（`managementProfile.test.ts`）。

E社（opportunistic）は、実装指示§6「無理に新しい状態管理を追加しない」の
制約に対応するため、**既存の`inventoryCorrectionDamping`（在庫是正の反応
速度）という既存パラメータの範囲内だけ**で「反応の速さ」を表現しました。
新規の記憶・カウンタ等は一切追加していません。

### 1.3 養殖上限4,000トンの実装（§3、追加条件2）

`buildCompanyFixtures`・`standardBaseline.ts`の校正値は**一切変更していません**。
`autoplay/runCase.ts`の`AutoplayCaseConfig`に`aquacultureCapacityOverrideHosoEqTons`
オプションを追加し、既存の`salesForceHeadcountOverride`と同じ設計方針
（実行時オプションによる上書きのみ、本番fixtureは不変）で、5社共通の
`fixture.aquacultureCapacity`を上書きできるようにしました。

上限そのものの強制は、AIの自己抑制（`decision/procurement.ts`の
`Math.min(aquacultureCapacity, ...)`）と、エンジン側のハード制約
（`rawMaterials/aquaculture.ts`の`assertValidStockingPlan()`。
`plannedStockingQuantity > aquacultureCapacity`なら`RawMaterialsValidationError`）
の両方で担保されます。エンジン側の制約は既存コード・既存テスト
（`rawMaterials/__tests__/aquaculture.test.ts`）でカバー済みのため、今回は
「上書きしたfixture.aquacultureCapacityが実際に例外なく一貫して効くこと」を
自動テスト・試験runの両方で確認しました（§9・§10参照）。

### 1.4 会社IDによる分岐の集約（§6）

会社IDによる分岐は、`managementProfile.ts`の`MANAGEMENT_PROFILE_BY_COMPANY_ID`
（1箇所）だけに存在します。`policy.ts`の`createStandardAiProvider()`は
「注入されたリゾルバ関数を`fixture.companyId`で呼ぶ」だけで、それ自体は
会社IDによる分岐を持ちません。`decision/*.ts`の内部にも会社ID分岐は
一切追加していません（既存どおり`params`の値を素直に使うだけです）。

`--management-profiles`未指定時（既定）は、リゾルバ自体が注入されないため
`createStandardAiProvider()`は従来どおり全社`STANDARD_AI_PARAMETERS_V1`固定で
動作し、既存の出力・既存の全1807件のテストへの影響はゼロです（実測: 今回の
変更後も既存テストは1件も壊れていません。§9参照）。

## 2. 診断ログ・追跡性（§8）

`StandardAiQuarterDiagnostics`（`policy.ts`）に、`managementProfilesEnabled`時
のみ`managementProfile`フィールドを追加しました:

```ts
interface StandardAiManagementProfileDiagnostics {
  profileId: string;
  appliedBiasItems: readonly AppliedManagementBiasItem[]; // 基準値→バイアス後の項目一覧
  baselineDecision?: CompanyDecisionInput; // バイアスなし(STANDARD_AI_PARAMETERS_V1)での判断
}
```

- `appliedBiasItems`は「どのパラメータが」「基準値からどう変わったか」を
  会社×四半期ごとに保持します（A社は常に空配列）。
- `baselineDecision`は、`appliedBiasItems`が1件以上ある場合のみ計算します
  （A社のようにバイアスがない場合は無駄な二重計算を省略します）。
- 「安全ガード適用後の最終判断」は、`decision`（実際にゲームへ提出される
  意思決定）そのものです。安全ガード（現金・在庫・容量制約等）は
  `decision/*.ts`の中で既に反映済みであり、別途「安全ガード適用前」の値を
  保持する仕組みは既存実装にもともと存在しないため、今回新設していません。

**§4の制約への対応（正直な開示）**: 「基準判断」を得るために、
`generateStandardAiDecisionWithDiagnostics`を基準パラメータでもう一度呼び出す
（＝標準AIの意思決定計算をバイアスありの会社・四半期だけ2回実行する）
という最小実装にとどめています。ゲームエンジン本体・状態遷移・乱数系列には
一切影響しません（純粋関数の再呼び出しのみ）。「Standard AI全体の大規模な
二重実行」（例: 全ケースをシナリオごと2周させる等）は行っていません。

## 3. 自動テスト（§9）

新規追加した自動テストは以下の3ファイル・37件です（既存テストは無変更・
全件成功のまま）。

- `standardAi/__tests__/managementProfile.test.ts`（18件）
  - 5社への重複のないプロファイル割当て
  - A社(balanced)はSTANDARD_AI_PARAMETERS_V1と完全に同値（`deepEqual`）
  - 各プロファイルの比率バイアスが許容範囲(±10%)内であること
  - 各プロファイルが安全ガード対象フィールドを一切変更しないこと
  - B社/C社/D社/E社それぞれの方向性テスト（「常にB社が勝つ」ではなく、
    「同一基準からの傾向（どちら向きに動くか）」を検証）
  - 許容範囲を超えるプロファイル（比率・絶対値の両方）を渡すとエラーに
    なること（バイアス幅の安全弁）
  - `appliedBiasItems`の記録内容（バイアスがない項目は含まれないこと）
- `autoplay/__tests__/runCase.test.ts`（既存6件＋新規12件）
  - `aquacultureCapacityOverrideHosoEqTons`指定で5社全fixtureが上書きされること
  - 上限4,000トン下でAIの池入れ計画が一度も4,000を超えないこと（かつ
    8ターン例外なく完走すること）
  - 上書き未指定時は候補既定値のままであること
  - `managementProfilesEnabled`未指定時は診断に`managementProfile`が
    付与されないこと（既存出力と完全同一）
  - `managementProfilesEnabled=true`でも同一seed・同一configなら常に
    同一結果（決定論性の維持）
  - A社(BAL/balanced)は`appliedBiasItems`が常に空であること
- `autoplay/__tests__/heterogeneousProfiles.test.ts`（7件）
  - 5社の初期条件（会社ID・会社名・プロファイル等の識別情報を除く、
    財務・設備能力・人員/営業能力・品質/信用・在庫/債権債務・利用可能情報・
    養殖能力4,000トン）が完全に同一であること
  - E社(JPQ)の8四半期にわたる配分（養殖池入れ・販売希望数量・生産計画）が
    乱高下しないこと（複数seed、しきい値60%。実測の最大変化率は約23%で、
    十分な余裕を持たせています）
  - `baselineDecision`が、バイアスがある会社・四半期でのみ設定されること

**テスト結果**: `npm test`（既存1807件＋新規37件＝計1844件）**全件成功**。
`npx tsc --noEmit -p .`・`npx eslint`（変更ファイル対象）も警告・エラー
ゼロです。

## 4. 試験run（§10）

> **2026-07-30追記（三宅さんの受入確認への対応）**: 三宅さんのご指摘のとおり、
> 当初の試験runはコミット前の作業ツリー（`appCommitId`が分岐元の`b933b04`の
> まま）で実行してしまっていました。**SAI-4完成コードを確定したコミット
> `dd478af`（本報告書§7参照）の上で、同一の8seed・8四半期・4パターンを
> 再実行**し、以下4.1〜4.5節の数値・成果物をすべて更新しました。再実行後の
> 各runの`manifest.json`はいずれも`"appCommitId": "dd478af20d143c38634314ca3087df65bc7a4c8e"`
> であることを確認済みです。再実行結果は、コミット前に実行した最初の試験run
> （実装ロジックは同一のため）と全指標が完全に一致しており、再現性も併せて
> 確認できました。

### 4.1 単一seed・8四半期の正常性確認

```
npx tsx scripts/sai3aAutoplay.ts --seeds sai4-trial-single-001 --quarters 8 \
  --management-profiles --aquaculture-cap 4000 --run-id sai4-single-seed-sanity \
  --out-dir artifacts/sai4
```

5社×8四半期、完了ケース5/5・エラー0件。デフォルト・与信凍結は発生せず、
養殖池入れ計画は全四半期・全社で4,000トン（上限ちょうど）で一貫していました。
`manifest.json`の`appCommitId`は`dd478af...`（確定コミット）です。

### 4.2 複数seed試験（既存SAI-3B分析パイプライン再利用）

同一の8seed（`sai4-het-001`〜`008`）・8四半期で、以下4パターンを実行し比較
しました（要因を切り分けるため、経営性格プロファイルと養殖上限4,000トンを
個別にON/OFFした4通り）。いずれもコミット`dd478af`上で実行しています。

| run | 経営性格プロファイル | 養殖上限4,000t | 完了ケース | appCommitId |
|---|---|---|---|---|
| `sai4-baseline-8seed-8q` | OFF | OFF（候補既定値） | 40/40・エラー0 | `dd478af...` |
| `sai4-profilesonly-8seed-8q` | ON | OFF | 40/40・エラー0 | `dd478af...` |
| `sai4-caponly-8seed-8q` | OFF | ON | 40/40・エラー0 | `dd478af...` |
| `sai4-heterogeneous-8seed-8q`（本命） | ON | ON | 40/40・エラー0 | `dd478af...` |

いずれもエラー0件・8ターン完走。既存SAI-3B-1 Excel生成CLI
（`scripts/sai3bExcel.ts`）で、baseline runとheterogeneous runの2run比較
ブック（`artifacts/sai4/sai4_baseline_vs_heterogeneous_comparison.xlsx`、
既存のダッシュボード・Layer1/Layer2構成をそのまま再利用）を再生成しました。
併せて、4run全てを横並びで確認できる小さな補足成果物として
`docs/v2/reports/sai4_4run_comparison_summary.csv`（git管理対象、5指標×4run）
を追加しました。既存Excelの多run比較機能（「80/85/90人比較」シート）に
4run全てを流し込むことも試しましたが、これは元々headcount比較専用に設計
されたシートであり、意味的に対応しないうえ出力が約58MBと大きくなりすぎる
ため採用せず、上記の軽量なCSVという形にしました（本報告書§6参照）。

### 4.3 同一初期条件の証明

自動テスト（4.1節参照）に加え、上記4パターンいずれの試験runでも、
turn1開始時点のfixture・ownStateを目視確認し、会社ID・会社名以外の差異が
ないことを確認しました（詳細な機械的証明は自動テスト側の責務）。

### 4.4 財務・運営トレンドの比較（run全体平均、8seed、4run横並び）

三宅さんのご指摘に対応し、「最大養殖希望量」（AIの意思決定=池入れ計画の
`aquacultureStockingDesiredQuantity`、40ケース×8ターン=320件中の最大値）を
含めた5指標を4run横並びで示します（同じ表は
`docs/v2/reports/sai4_4run_comparison_summary.csv`にも保存済み）。

| run | デフォルト率 | 平均累計売上(USD) | 平均累計営業利益(USD) | 平均期末現金(USD) | 最大養殖希望量(トン) |
|---|---|---|---|---|---|
| baseline（プロファイルOFF・上限OFF） | 45.0% | 367,380,117 | 7,336,307 | 10,327,990 | 9,096.3 |
| profilesOnly（プロファイルON・上限OFF） | 57.5% | 359,365,252 | 3,033,158 | 8,012,386 | 9,555.0 |
| capOnly（プロファイルOFF・上限4,000t） | 0% | 362,495,541 | 6,004,647 | 13,686,694 | 4,000.0 |
| heterogeneous（両方ON、本命） | 0% | 357,488,868 | 3,532,845 | 14,387,168 | 4,000.0 |

養殖上限を設定していないbaseline/profilesOnlyでは最大養殖希望量が
9,000トン超（候補既定の養殖能力に応じた自然な需要水準）まで達している一方、
capOnly/heterogeneousでは4,000トンちょうどに揃っており、上限が意図どおり
拘束条件として機能していることが run全体の数値からも確認できます。

**要因の切り分け**: デフォルト率が45%→0%へ劇的に下がった主因は**養殖上限
4,000トン**です（capOnly単独でも0%）。経営性格プロファイル単独
（profilesOnly）は、むしろデフォルト率を45%→57.5%へ**悪化**させています。
「moderate-pressure」シナリオ（意図的に資金繰りが厳しいストレステスト
シナリオ）の下では、小幅な性格バイアスが一部の会社の挙動をわずかに
リスク側へ押し、デフォルトの発生確率を変化させるという、意図どおりの
副作用が観測されました（三宅さんの指示どおり、これを「勝たせる／負けさせる」
ために事後調整することはしていません）。

会社別のデフォルト発生回数（8seed中、baseline vs profilesOnly）:

| 会社 | baseline | profilesOnly |
|---|---|---|
| BAL（balanced/A社） | 4 | 4（**baselineと完全一致**） |
| MASS（growth/B社） | 4 | 6 |
| JPQ（opportunistic/E社） | 3 | 6 |
| VAP（valueAdded/D社） | 4 | 6 |
| CONSV（conservative/C社） | 3 | **1** |

これは以下の点で一貫した、直感に合う結果です:

- **A社(BAL)はbaselineと完全に同じデフォルト回数**（4/8）。プロファイル
  有効時でもA社の判断は従来のStandard AIから変わらないという実装指示§6の
  要件が、パラメータレベルの単体テストだけでなく、**8四半期の実際の試験
  runでも実測レベルで裏付けられました**。
- **C社(CONSV/conservative)はbaselineより明確に安全**（3→1）。値引き・
  輸入依存・人員増強・在庫是正・養殖自給のいずれも控えめにするという
  設計どおり、ストレスシナリオ下でのデフォルト回避に効いています。
- **B社(MASS/growth)・D社(VAP/valueAdded)・E社(JPQ/opportunistic)は
  baselineよりデフォルトが増加**（4→6, 4→6, 3→6）。積極的な性格ほど、
  厳しいシナリオ下でリスクが高まるという、これも直感に合う結果です。

### 4.5 その他の§10必須項目

- **最大実現養殖数量**: AIの意思決定（池入れ計画）は40ケース×8ターン
  （320件）すべてで**ちょうど4,000トン**（`aquacultureStockingDesiredQuantity`）
  でした（0件も超過なし）。一方、収穫比率・疾病影響を経た**実現収穫量**
  （`aquacultureStockingFinalQuantity`）は最大約2,999.9トン・最小約86.8トンと、
  池入れ計画（4,000トン）よりも常に小さい値でした（期待収穫比率
  `expectedAquacultureHarvestRatio=0.9`や疾病損失により、池入れ量そのものが
  そのまま収穫量になるわけではないため。これは既存の養殖ロジックの仕様で
  あり、今回変更していません）。
- **乖離が最初に現れる四半期**: プロファイルはturn1から即座にパラメータへ
  反映されるため（状態やカウンタに依存しない設計）、理論上はturn1から会社間の
  判断に差異が生じえます。実測でも、turn1の`decision-trace.jsonl`時点で
  会社ごとに異なる`aquacultureStockingDesiredQuantity`・生産計画等が見られ
  ました（上限4,000tがバインドする場合を除く）。なお5社は元々「同一市場を
  取り合う」ため、プロファイルなしのbaselineでもturn1から会社間に僅かな
  差異（市場配分の非対称性）が生じうることを確認しています（既存SAI-1〜3の
  既知の挙動であり、SAI-4で新たに導入したものではありません）。
- **バイアスが小さすぎて効果がほぼ見えなかった項目**: 個別四半期・個別
  ケースを見ると、B社(growth)・C社(conservative)・E社(opportunistic)の
  「販売希望数量合計」が、営業工数・供給余力等の既存の制約によって
  baselineと完全に同一になるケースが複数観測されました（例:
  `sai4-inspect-directional`調査時点でturn1〜4のMASS/CONSV/JPQの
  desiredQuantity合計はbaselineと差0）。これは失敗ではなく、実装指示にも
  明記された「小さなバイアスが既存の制約で吸収され、可視化されない場合が
  ある」という想定どおりの結果として、そのまま報告します。
- **想定より大きく広がったバイアス**: 観測されませんでした。全プロファイルの
  パラメータ差は設計どおり±10%以内に収まっており（自動テストで保証）、
  四半期を重ねても発散・増幅する挙動は確認していません。
- **振り子的・不自然な挙動**: E社(JPQ)を含む全社で、8四半期にわたる
  四半期間の変化率は最大でも約23%（複数seed実測）にとどまり、明確な
  振り子的挙動（数倍への跳躍等）は観測されませんでした（自動テストで
  60%という余裕を持ったしきい値による継続的な回帰検知を導入済み）。
- **デフォルトの直接原因**: 発生したデフォルトはいずれも、既存の与信・
  資金繰りロジック（`financeState`・`financingState`の既存判定）による
  ものであり、経営性格プロファイルが安全ガードを迂回した結果ではありません
  （安全ガード対象フィールドが一切バイアスされないことは自動テストで保証
  済み）。プロファイルは「安全ガードが発動するに至る手前の行動」
  （販売積極性・値引き・輸入依存等）だけを動かしており、ガード自体は
  全社で完全に同一のまま機能しています。
- **ゲームバランス上の所見 と 実装バグの切り分け**: 上記4.4節の
  デフォルト率変化（特にprofilesOnlyでの悪化）は**ゲームバランス上の所見**
  です（moderate-pressureという意図的な高ストレスシナリオ下で、小幅な
  性格差が意図どおりリスク選好の違いとして現れた結果であり、実装の不具合
  ではありません）。今回の実装過程で発見した実装バグは、tsc/lint/既存
  1807件のテストいずれにも現れておらず、**新たなバグは確認していません**。

### 4.6 確定コミットでの再確認チェックリスト（三宅さんの受入確認§4対応）

コミット`dd478af`での再実行後、以下をすべて確認しました。

- [x] **heterogeneousの全社・全quarterで養殖希望量が4,000トン以下**:
  40ケース×8ターン=320件のAI意思決定（`aquacultureStockingDesiredQuantity`）
  すべてが4,000トン以下（最大値=ちょうど4,000トン、超過0件）。
- [x] **baselineおよびA社の再現性**: 4run全体平均（デフォルト率・売上・
  営業利益・現金・最大養殖希望量）は、コミット前に実行した最初の試験runと
  完全に一致。会社別デフォルト発生回数（baseline: BAL=4/MASS=4/JPQ=3/
  VAP=4/CONSV=3、profilesOnly: BAL=4/MASS=6/JPQ=6/VAP=6/CONSV=1）も
  完全に一致し、特にA社(BAL)はbaseline・profilesOnlyの両方で
  デフォルト回数4/8のまま変化していません。
- [x] **4runすべて完走、エラー0**: baseline/profilesOnly/capOnly/
  heterogeneousいずれも完了ケース40/40・エラー0件。
- [x] **`npm test` 1844件成功**: 既存1807件＋新規37件（3節参照）、全件成功。
- [x] **tsc・eslintに新規エラーなし**: `npx tsc --noEmit -p .`・
  `npx eslint .`ともにエラー0（eslintの4件の警告はいずれもSAI-4と無関係な
  既存コードのもの）。

係数調整・ゲームバランス調整は行っていません（4.4〜4.5節の数値は
再実行後もコミット前の初回試験runと完全一致しており、結果を見て後から
チューニングした事実はありません）。`develop/v2`への統合も行っていません。

## 5. 生成物一覧（§11）

| 種別 | 場所 | 備考 |
|---|---|---|
| プロファイル実装 | `app/lib/v2/companyLab/standardAi/managementProfile.ts` | 新規 |
| プロファイル設定一覧 | 本報告書1.2節、および`managementProfile.ts`内docコメント | |
| プロファイルバイアスログ | `policy.ts`の`StandardAiManagementProfileDiagnostics`（診断構造） | |
| 4,000トン上限実装 | `autoplay/runCase.ts`・`runBatch.ts`・CLI一式 | |
| 4,000トン上限の検証 | `autoplay/__tests__/runCase.test.ts`・試験run（4.5節） | |
| 自動テスト | 3ファイル・37件（3節参照） | |
| 試験結果 | `artifacts/sai4/`以下（git管理対象外、コミット`dd478af`で再実行済み） | |
| Excel分析 | `artifacts/sai4/sai4_baseline_vs_heterogeneous_comparison.xlsx`（約28.6MB、既存SAI-3B構造を再利用、コミット`dd478af`で再生成済み） | git管理対象外 |
| 4run簡易比較表 | `docs/v2/reports/sai4_4run_comparison_summary.csv` | 新規（git管理対象、5指標×4run） |
| 将来二層設計メモ | `docs/v2/design/sai4_officer_vs_company_personality_memo.md` | 新規（§7、実装無し） |
| 完了報告書 | 本ファイル | |

## 6. 既知の制約・注意点

- §4の制約: 「基準判断」の追跡は、バイアスがある会社・四半期に限定した
  最小限の二重計算にとどめています（2章参照）。
- 複数run比較ブック生成時、CLIから
  `複数のrunが同一の営業人員数（salesForceHeadcountTotal）を持っています`
  という警告が出ます。これは既存SAI-3B-1の「headcount比較」検出ロジックが
  今回の比較軸（プロファイル・養殖上限）を想定していないための誤検出で、
  実害はありません（既存のheadcount比較機能自体は変更していません）。
- JPQ→opportunistic(E社)の対応は、Phase 6.2由来のarchetype名
  （"japanQuality"）とは意味的に対応しません（1.1節に明記のとおり、単なる
  ラベルの再利用です）。将来、会社ID自体の命名を見直す場合は要調整です。
- Excel比較ブック（約28.6MB）はSendUserFileの30MB上限に近いため、環境に
  よっては送付できない可能性があります（Part A完了報告時と同様の制約）。

## 7. ブランチ運用（§13）

- ブランチ名: `feature/v2-sai4-heterogeneous-standard-ai`
- 分岐元: `feature/v2-sai3b-excel-analysis`（コミット`b933b04`）
- **SAI-4実装の確定コミット（§4の全試験runの`appCommitId`）**: `dd478af`
  （フルハッシュ: `dd478af20d143c38634314ca3087df65bc7a4c8e`）。プロファイル
  実装・4,000トン上限・診断ログ・自動テスト37件・将来設計メモは、いずれも
  このコミットに含まれています。
- 本コミット（このcommitted版の完了報告書自体）は、上記`dd478af`に対する
  **追跡性の修正コミット**（テスト件数表記の修正、`dd478af`確定後の4パターン
  再実行、4run比較表の追加）であり、実装コード自体の変更は含んでいません。
  最終的なコミットハッシュは`git log`・`git show --stat`で確認してください。
- `develop/v2`への統合は行っていません。統合時は、上記の「重要な依存関係」
  節のとおり、SAI-3B-2を先に統合してから本ブランチを統合することを推奨します。
- 試験run・Excel分析の保存場所: `artifacts/sai4/`（git管理対象外、ローカル
  生成物、`dd478af`上で再実行済み）。4run簡易比較表のみ
  `docs/v2/reports/sai4_4run_comparison_summary.csv`としてgit管理下に
  保存しています。
- 残課題: 6章「既知の制約・注意点」を参照。追加の実装作業は不要と判断して
  います（三宅さんのレビューをお待ちします）。係数調整・ゲームバランス
  調整・`develop/v2`への統合は行っていません。
