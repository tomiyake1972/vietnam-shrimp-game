# Standard AI 営業採用・減員（経営ボトルネック判定）設計文書

作成: Cowork #05（AI設定）／2026-08-05
Branch: `feature/v2-sai-salesforce-bottleneck-hiring`
実装ファイル: `app/lib/v2/companyLab/standardAi/decision/salesForceHiring.ts`

## 1. 設計方針（三宅さんご指示の核心）

単に`salesForceHireCount`を意思決定へ追加するのではなく、営業採用を

```
market opportunity → sales capacity → production capacity → Worker
→ raw material → cash / borrowing capacity → Action
```

という連鎖の中で、1人ずつ（incremental）marginal economicsを確認しながら判断する構造にした。全体の呼び出し順序は`policy.ts`の`generateStandardAiDecisionWithDiagnostics`内で以下の通り（既存の販売・生産・Worker・原料・資金の各decisionが計算済みの値を読むだけで、これらのロジック自体は一切変更していない）。

1. `buildStandardAiSalesPlans`（既存）→ 販売希望・realistic sales・営業工数制約後の値
2. `buildCurrentPeriodDeliveryDemand`→`productionRequirement`（既存）→ 当期生産必要量
3. `buildStandardAiProductionPlans`（既存）→ 生産計画
4. `buildStandardAiUnitEconomics`（既存、Forward Unit Economics）→ 市場×商品別貢献利益
5. `buildStandardAiSituationDiagnosis`（既存）→ 原料供給制約の状態（shortage/unknown等）
6. **新設**: `buildStandardAiSalesForceHiringDecision` — 上記すべてを入力として、1人ずつのmarginal economicsを評価し、`salesForceHireCount`/`salesForceLayoffCount`を決定する

## 2. hard-code禁止の徹底（#04共有パラメータ・共有関数の参照）

本モジュールは以下を一切再実装しない。すべて既存の共有モジュールをそのまま呼ぶ。

| 参照するもの | 参照元 |
|---|---|
| 営業人員→処理能力の式（現行は飽和曲線） | `sales/salesForce.ts`の`processingCapacity` |
| 商品別営業工数係数（現行hoso=1.0/pd=1.2/vap=3.0） | `sales/parameters.ts`の`SalesParameters.salesEffortCoefficients` |
| 市場別営業工数制約・比例縮小ロジック | `sales/marketEffort.ts`の`computeMarketSalesEffort`・`salesEffortWeightedQuantity` |
| 人員の市場別配分 | `sales/marketEffort.ts`の`allocateHeadcountAcrossMarkets` |
| 営業人員給与 | `finance/parameters.ts`の`FINANCE_PARAMETERS_V1.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter` |
| 貢献利益（商品別） | `standardAi/diagnosis/forwardUnitEconomics.ts`の`buildStandardAiUnitEconomics` |
| トン→kg換算 | `production/parameters.ts`の`hosoEqKgPerTon` |
| 最低現金バッファ | `standardAi/pressures.ts`の`targetMinimumCashUsd`（既存） |

**#04が営業capacity式・パラメータ自体を変更しても（例: 飽和曲線→線形容量モデル、係数の変更）、本モジュールのコードは1行も変更せずに追随する**（呼んでいる関数のシグネチャが変わらない限り）。これが「hard-codeしない」というご指示の実装上の意味である。

### #04へ申し送り（未exportの定数）

`finance/quarterClose.ts`の`SALES_FORCE_SEVERANCE_QUARTERS = 2`（退職金＝2四半期分の給与）はローカル定数でexportされていない。本モジュールは値（2）をコメントで根拠を明示した上で直接引用しているが、将来のドリフト防止のため、`FINANCE_PARAMETERS_V1`へ共有定数として追加exportしてもらうことを推奨する。

## 3. Marginal Salesperson Economics（1人ずつの評価）

`+1`人ごとに以下を評価し、いずれかの条件で採用を停止する（三宅さんご指示§6の停止条件に対応）。

1. **incremental sales tons**: `computeMarketSalesEffort`をheadcount, headcount+1の両方で呼び、商品別realistic salesの差分を取る。
2. **既存FGで賄える分／新規生産が必要な分の分離**（§8・§9対応）: 増分のうち、`observation.finishedGoodsByProduct`で賄える部分は「追加生産不要」として区別する。
3. **incremental contribution margin**: Forward Unit Economics（市場×商品別`contributionMarginUsdPerKg`の単純平均、市場をまたいだ簡略化）×トン換算。採算不明（null）の商品は保守的に0扱い（憶測しない）。
4. **停止条件A（profitable unserved opportunity消滅）**: incremental salesがゼロに近づいたら停止。
5. **停止条件D（marginal contribution <= cost）**: `marginalContributionAfterSalesSalary = incrementalContribution - salespersonSalary`が0以下なら`SALES_HIRING_NOT_ECONOMIC`で停止。
6. **停止条件（production bottleneck）**: 新規生産が必要な増分が、会社全体の生産余力合計（`totalEffectiveCapacityByProduct - finalProductionRequirementByProduct`の正の部分合計）を超えたら`SALES_HIRING_BLOCKED_BY_PRODUCTION`で停止。**設計上の簡略化**: 商品別ではなく会社全体の余力合計で判定しているため、商品別の余力の偏りがある場合（例: HOSOに余力があるがVAPに無い）、実際より緩い判定になりうる（#05引き続きの精緻化課題）。
7. **停止条件（raw supply uncertainty）**: 新規生産が必要かつ`situationDiagnosis.rawMaterialSupplyConstraintState === "shortage"`（真の供給制約が診断済み）の場合のみ`SALES_HIRING_BLOCKED_BY_RAW_SUPPLY_UNCERTAINTY`で停止。`"unknown"`（大半のケース、観測未接続のため）では断定せずブロックしない（既存の憶測しない設計方針を継承）。
8. **停止条件（liquidity buffer）**: 現金の最低バッファ余力から、これまでの累積追加給与を引いた値が負になったら`SALES_HIRING_BLOCKED_BY_LIQUIDITY`で停止。**簡略化**: 当四半期の給与増分のみで判定する単四半期近似であり、複数四半期先のキャッシュタイミングは投影していない（Financial Capacity診断モジュールとの厳密な統合は次のステップ）。

## 4. Target Sales Force方式・安全上限（2026-08-05修正、三宅さんレビュー反映）

### 4.1 旧設計の問題（三宅さんレビューで指摘）

初版では、1四半期の採用ループを「限界利益がプラスな間は増員」しつつ、`max(5, 現在人数×50%)`という反復回数上限で打ち切る設計にしていた。この上限の基準が**現在の（既に増員済みの）営業人員数**だったため、採用が起きるたびに次四半期の上限自体も膨張し、8ターン×5社シミュレーションでBAL社が18→27→41→62→93→140人という複利的な指数増加を示した（`STANDARD_AI_8Q_SIMULATION_SUMMARY_2026-08-05.md`参照）。三宅さんより「バグというより設計通り暴走した」とのご指摘を受けた。

### 4.2 修正後の設計: Target Sales Force方式

「限界利益がプラスな間は増員」を意思決定の中心に置くのをやめ、以下の2段階へ変更した。

1. **Target Sales Force（必要な将来営業能力）の計算**: マージナル経済性ループを、反復回数の恣意的な上限では打ち切らず、A（機会消滅）・D（非経済的）・E（生産余力超）・G（原料供給制約）・H（資金バッファ超）のいずれかの**自然停止条件**に到達するまで評価する。この結果得られる人数を`targetSalesForceHeadcount`とする。ループ自体には`NATURAL_STOP_SAFETY_ITERATION_CEILING=2000`という、ビジネス判断ではなく純粋な暴走防止のための機械的セーフガードのみを設ける。
2. **不足分の計算と、1四半期あたりのガバナー適用**: `targetGap = targetSalesForceHeadcount - 現在人数`を求め、1四半期に実際へ反映する人数（`salesForceHireCount`）は、`targetGap`を**会社の静的な基準規模（`fixture.salesForceHeadcountTotal`、会社設立時の値でターンをまたいでも変わらない）** に対するガバナー`max(5, round(静的基準規模×50%))`でキャップする。ガバナーを超えた分は今四半期には反映せず、次四半期以降、その時点の最新のwish/observationで目標を再計算する形で持ち越される（単純なキューではない）。

この修正により、ガバナー自体が「採用の結果として」膨張することがなくなり、複利成長が構造的に排除される。8ターン再実行では、BAL（静的基準18人・ガバナー9人/期）が18→27→36→45→54→63→72人という**線形**な増加になり、JPQ/VAP（基準14人・ガバナー7人/期）・CONSV（基準10人・ガバナー5人/期）も同様に線形化した。指数的増加は確認されなくなった（回帰テスト`salesForceHiring.test.ts`「複利成長しない」で固定化）。

減員方向にも対称的に同じガバナーを適用した（`layoffCountThisQuarter`）。

### 4.3 既知の限界（今回も残る設計上の簡略化）

- ガバナーが「静的な基準規模」を用いるため、会社規模が非常に小さい状態から急成長すべき正当な理由がある場合でも、ガバナーが基準規模のままで動かない（意図的な保守設計。基準規模自体を動的に更新するかどうかは三宅さんの追加ご判断が必要）。
- Target Sales Force自体は、当四半期のwish/observationに基づく評価であり、複数四半期先を見据えた需要予測ではない（次四半期は改めてゼロから評価し直す）。

## 5. Sales Layoff Decision（§7）

採用候補が0件の場合のみ減員方向を評価する（同一四半期に採用・減員を両方>0にはしない。既存game engine側の入力検証と整合）。末尾の1人（現在の人数）のmarginal contributionが給与以下であり、かつ既存完成品在庫が販売のボトルネックになっていない（`finishedGoodsByProduct`に十分な余裕がある）場合のみ減員候補にする。退職金（現行2四半期分の給与）を考慮しても、3四半期目以降の節約が上回ることを確認する。

「今期売るものが少ないだけで大量解雇しない」というご指示への対応として、在庫が制約になっている場合は減員を見送る（`SALES_LAYOFF_DEFERRED_STRATEGIC_CAPACITY`相当の判断。現行実装では在庫チェックがtrueの場合ループの最初の反復で即break、専用の理由コードは今回未発行——次の拡張点として明記）。

## 6. Inventory-aware logic（§8・§9）

追加営業人員による増分販売のうち、既存FGで賄える部分と新規生産が必要な部分を分離して評価する（`incrementalSalesCoveredByExistingFgTons`/`incrementalSalesRequiringNewProductionTons`）。既存FGで完全に賄える場合は生産・原料調達のいずれのゲートにも引っかからず、「追加productionなし・追加raw procurementなし」でのcash conversionとして高い価値を持つ、という設計意図をコードのゲート順序（経済性→生産余力→原料→資金）で反映した。

## 7. Production/Worker/Procurement/Financeとの非接続の確認（§10-13）

- **Production**: 本モジュールはproductionPlans自体を書き換えない。`policy.ts`内で本モジュールの呼び出しは、既存の生産計画（`finalProductionRequirementByProduct`）を**入力として読むだけ**の位置に置かれている（生産計画の計算より後）。
- **Worker**: `laborResult`（Worker配分）は本モジュールの前に計算済みであり、本モジュールはこれを変更しない。将来販売機会がWorker増員へ直結する経路は今回実装していない（三宅さんご指示§11の通り）。
- **Raw procurement**: `procurementResult`も本モジュールの前に計算済み。sales opportunityから直接raw purchaseへ飛ぶ経路は存在しない。
- **Finance**: 現金バッファチェックのみを行い、`financingRequest`自体は変更しない。

## 8. Reason Codes（§14）

`SALES_HIRING_PROFITABLE_UNSERVED_OPPORTUNITY` / `SALES_HIRING_BLOCKED_BY_PRODUCTION` / `SALES_HIRING_BLOCKED_BY_LIQUIDITY` / `SALES_HIRING_BLOCKED_BY_RAW_SUPPLY_UNCERTAINTY` / `SALES_HIRING_NOT_ECONOMIC` / `SALES_FORCE_EXCESS_CAPACITY` / `SALES_LAYOFF_ECONOMIC_AFTER_SEVERANCE`（未発行。減員が実際に発生する経路自体は実装済みだが、専用の理由コード発行は今回未実装）/ `SALES_LAYOFF_DEFERRED_STRATEGIC_CAPACITY`（同上）を`reasonCodes.ts`の`StandardAiReasonCode`型へ追加した。

## 9. 既知の限界・次のステップ

- 商品別の生産余力を会社全体合計で近似している（§3-6参照）。
- 資金余力チェックが単四半期近似（Financial Capacity診断モジュールとの厳密統合は次のステップ）。
- 減員側の理由コード発行（`SALES_LAYOFF_ECONOMIC_AFTER_SEVERANCE`/`SALES_LAYOFF_DEFERRED_STRATEGIC_CAPACITY`）は型定義のみで、実際の発行ロジックは未実装。
- `situationDiagnosis.ts`の`DiagnosisConstraintCategory`を「sales_capacity_shortage」と「market_opportunity_shortage」に分割する提案（三宅さんご指示§3）は、既存の広範なテスト資産への影響リスクを避けるため、今回は見送った（既存の`sales_shortage`はそのまま維持）。分割は#05の次のタスクとして推奨する。
- 【2026-08-05修正済み】旧安全上限（現在人数に対する相対値）による複利的な指数増加は、§4.2のTarget Sales Force方式への変更により解消した。詳細は`docs/standard_ai/STANDARD_AI_8Q_SIMULATION_SUMMARY_2026-08-05.md`の追記を参照。
- 【2026-08-05解明済み】MASSが8ターン全て採用ゼロだった理由は、診断reason codeの追跡により判明した。turn1は`SALES_HIRING_NOT_ECONOMIC`（限界貢献利益が給与を下回る）、turn2〜8は`SALES_HIRING_BLOCKED_BY_LIQUIDITY`（現金の最低バッファ余力不足。実際MASSはturn6で現金がほぼ0まで低下していた）。詳細は上記報告書を参照。
