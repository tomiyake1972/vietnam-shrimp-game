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

## 4. 安全上限（maximum reasonable hiring limit）

新設パラメータ`MAX_HIRE_PER_QUARTER_ABSOLUTE_FLOOR=5`・`MAX_HIRE_PER_QUARTER_RELATIVE_RATIO=0.5`により、1四半期の提案上限を`max(5, 現在人数×50%)`とした。これは**ゲームバランス上のcapacity式のパラメータではなく**、「AIが1回の判断で極端な人数を動かさない」ための意思決定ガバナー（rate limiter）であり、三宅さんご指示§6「新たに発明する場合は慎重に」に対応する最小限の安全策として、既存の会社規模に対する相対値のみを使っている。

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
- **【重大・要報告】安全上限（§4）が「現在の（既に膨張した）人数」に対する相対値であるため、8ターン×5社の実行検証でBAL/JPQ/VAP/CONSVの営業人員数が複利的に指数増加した（BAL: 18→18→27→41→62→93→140→140）。三宅さんご指示§22で明示的に警告されていた「salespeople endlessly increasing」の失敗モードに該当する。詳細と実データは`docs/standard_ai/STANDARD_AI_8Q_SIMULATION_SUMMARY_2026-08-05.md`を参照。**三宅さんのご指示「チューニングしすぎないでください。まず問題を報告してください。」に従い、今回はこの安全上限の修正は行っていない。**worker_shortageという独立した制約が最終的に採用を停止させている（turn7以降）ため、無限に増加し続けるわけではないが、中間ターンでの増加ペースは意図した「1回の判断で極端な人数を動かさない」というガバナー本来の趣旨から外れている。
- 同シミュレーションでMASSが8ターン全てで採用ゼロ（headcount=22固定）だった。原因未調査（上記報告書§3参照）。
