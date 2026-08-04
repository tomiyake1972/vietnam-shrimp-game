# 営業人員headcountのend-to-end本番トレース分析（Part B・観測事実のみ）

三宅さんovernight指示（2026-08-04夜間、Part B/C）に基づく調査報告。
本ドキュメントは`feature/v2-sales-effect-diminishing-returns`ブランチ
（`origin/develop/v2` HEAD `90d67bc`から派生、財務診断ブランチとは完全に分離）
の一部。**production coreコード（`sales/salesForce.ts`の数式・
`companyLab/standardAi/*`・`autoPolicy.ts`・financing関連・48コミット
スタック・pd_labor）への変更は一切ない。** 新規の診断スクリプト2本と本
ドキュメントのみを追加する。

前提として、`docs/v2/design/sales_headcount_hardcap_investigation.md`
（前ラウンド・Part B投稿）の結論——「販売効果の計算式自体
（`salesCoverageScore`・`processingCapacity`）にコード上のハードキャップは
無い」——はそのまま維持する。本ドキュメントはその先、「headcountを実際に
変えたとき、production の実コード経路全体（sales→production→shipment→
receivables→cash）で何が起きるか」を、Standard AIの評価（Cowork #05の
担当領域）とは切り離した「ゲーム環境の事実」として記録する。

## B-1. 実際の本番コール経路（段階別）

コードを実際に読んで確認した、headcount→cash-inまでの経路。

| # | 段階 | 入力 | 主要関数（file:function） | 出力 | 次段階への受け渡し | 制約・キャップ |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 営業人員→カバレッジ・処理能力 | `headcount`（会社×市場で共有、`salesForceHiringState`由来） | `sales/salesForce.ts:salesCoverageScore`, `sales/salesForce.ts:processingCapacity` | `coverageScore`(0〜1)、`processingCapacity`(HOSO換算トン) | `allocation.ts`・`marketEffort.ts`の入力 | Michaelis-Menten飽和曲線。漸近上限=`baselineCapacityTons+capacityMaxIncrementTons`=5000t（ハードキャップなし。前ラウンド確認済み） |
| 2 | 市場別営業工数配分 | 会社×市場の`headcount`、商品別`desiredQuantity` | `sales/marketEffort.ts:computeMarketSalesEffort`, `applyMarketSalesEffortCapacity` | 工数超過時、市場内全商品の`desiredQuantity`を比例縮小した`adjustedPlans` | `allocation.ts`の各行の入力 | 営業工数換算数量（HOSO×1.0+PD×1.2+VAP×3.0）が`processingCapacity(h)`を超えない範囲へ比例縮小 |
| 3 | 成約配分（水位法） | `adjustedPlans`、`basePrice`、`targetDemand`（市場需要） | `sales/allocation.ts:allocateMarketProduct` | `MarketProductAllocationResult`（会社別`allocatedQuantity`・`askPrice`・`competitivenessWeight`） | `contracts.ts`の入力 | `cap = min(desiredQuantity, processingCapacity(h), shareCap, approvedCap)`。加えて水位法の予算総額=`targetDemand`自体が上限（B-1で詳細を下記に列挙） |
| 4 | 契約生成 | `MarketProductAllocationResult[]` | `sales/contracts.ts:createContractsFromAllocation` | `SalesContract`（`originalQuantity`=`allocatedQuantity`、`dueDate`=`nextPeriod`適用、既定`standardLeadTimeTurns=1`） | `backlog.ts`・生産計画の入力 | 成約量0の会社には契約を作らない。標準リードタイム1四半期（**quarter lag**、B-7参照） |
| 5 | 生産配分 | 前期までの契約残高（`outstandingQuantity`）、原料在庫、工場・労働キャパ | `production/*`（`companyLab/runner.ts`が`rawMaterialRequirements`・`productionAllocation`・`batches`を生成） | 実際の生産量（HOSO/PD/VAP別）、`ProductionAllocationEntry` | 完成品在庫・出荷計画 | 工場処理能力・ワーカー人数（`equipmentUtilizationRate`/`laborUtilizationRate`が1.0に達すると頭打ち）、原料在庫不足（`rawMaterialShortfall`） |
| 6 | 履行・出荷 | 完成品在庫、契約残高 | `sales/backlog.ts:applyFulfillments`、`production/*:ContractFulfillmentPlan` | `fulfilledQuantity`、`outstandingQuantity`、`overdueQuantity` | 財務モジュール（`finance/quarterClose.ts`）の売上計上入力 | 完成品在庫が契約量に届かなければ`overdueQuantity`（延滞）として繰越 |
| 7 | 財務（売上・粗利・現金） | 履行実績、契約単価、原価 | `finance/quarterClose.ts:closeFinancialQuarter` | `netRevenue`・`grossProfit`・`operatingProfit`・`accountsReceivable`・`cash` | 与信・融資モジュールの入力 | 売掛金の回収サイクル、原価（原料・加工・営業人件費含むSG&A） |
| 8 | 与信・融資 | 財務結果、担保（売掛金・原料在庫・完成品在庫） | `financing/*`（本セッション財務診断ブランチで詳細測定済み） | 通常融資承認額、緊急融資、`cash`最終値 | 次期の運転資金 | 借入限度額（担保・収益・信用区分ベース）。詳細は財務診断ブランチのdocを参照 |

### B-1詳細: allocation.tsの実際の制約一式（`allocation.ts:216-259`を実際に読んで確認）

```
cap = Math.min(
  unwrapUnit(entry.desiredQuantity),                          // 販売希望量
  unwrapUnit(capacity),                                        // processingCapacity(headcount)
  unwrapUnit(targetDemand) * maximumSupplierShareFor(entry, params),  // shareCap（対象需要×最大供給者シェア）
  entry.approvedAllocationCap !== undefined                    // approvedCap（承認済み取引枠、未指定ならInfinity）
    ? unwrapUnit(entry.approvedAllocationCap)
    : Number.POSITIVE_INFINITY
)
```

上記`cap`はあくまで「1社の成約量の個別上限」であり、実際の`allocatedQuantity`は
これに加えて**水位法（`waterFillAllocate`）の予算総額=`targetDemand`**という
市場全体レベルの制約も受ける（5社+外部選択肢で対象需要を奪い合うため、
自社の`cap`に届く前に市場全体の需要が尽きることがある）。したがって
「headcountを増やしてもallocatedQuantityが伸びない」場合の原因は、実際には
**この5つのうちどれが効いているかを個別に切り分けないと判定できない**
（B-5で実測して切り分ける）。

## B-2/B-3. 比較条件

- **初期条件**: `standardBaseline.ts`の「moderate-pressure」（8Q基準として
  確定済みの標準初期条件、`SELECTED_STANDARD_BASELINE_CANDIDATE_ID`）。
  標準初期headcount=**80人**（本diagファーストラウンドの調査で使った18人は
  `companyLab/fixtures.ts`の個別会社BAL用の値であり、標準baselineとは別物
  だった。今回は標準baseline側の実際の値=80人を基準に取り直した）。
- **headcountステップ**: baseline(80) / +10%(88) / +25%(100) / +50%(120) /
  +100%(160)。
- **seed**: `sai3a-grid-001`〜`003`（3シード、本セッション一貫して使用の
  seed）。
- **固定した条件**: 市場環境・価格パラメータ・工場設備・労働力・原料調達
  ルール・初期現金・初期債務・非販売系の意思決定はすべてStandard AI
  （`generateStandardAiDecision`、本番の意思決定ロジック・無改変）に委ね、
  差し替えるのは初期fixtureの`salesForceHeadcountTotal`のみ。

**2つの測定方法を使い分けた（B-3の要求どおり）**:

1. **`scripts/b1IsolatedAllocationTrace.ts`（真に因果分離された測定）**:
   Standard AIを一切介さず、`allocateMarketProduct`を直接呼ぶ。対象会社の
   headcountだけを動かし、他4社・`basePrice`・`targetDemand`は完全固定。
   これにより「allocation段階でheadcountがallocatedQuantityへ与える
   純粋な効果」を交絡なしに測定できる。
2. **`scripts/b4DynamicHeadcountTrace.ts`（Standard AI駆動の動的トレース）**:
   company-lab harness（`initializeUnifiedCompanyLabFromTemplate`+
   `runFromInit`+`generateStandardAiDecision`）で8四半期を実際に
   再シミュレーションする。production/raw material/財務への波及は
   この方法でしか観測できないため、B-4以降はこちらを主に使う。**この
   測定は動的であり、headcount以外の意思決定（生産計画・調達・価格提示）も
   Standard AIの判断としてturnごとに内生的に変わりうる**——ただし
   headcountそのものをAIが動かすことは無い（前ラウンド確認済み：
   `salesForceHireCount`は`standardAi/*`に一切出現しない）ため、
   「headcount以外の意思決定は環境の変化に応じて自然に追随するが、
   headcount自体はシナリオ間で外生的に固定されている」という設計になる。

## B-4/B-5. allocation段階の因果分離結果（`b1IsolatedAllocationTrace.ts`）

対象会社Aのheadcountを0〜320まで動かし、他4社はheadcount=80（moderate-pressure
基準値）で固定。市場CN・商品HOSO・basePrice=4.5。

### シナリオ1: 大きい市場（targetDemand=50,000t、誰のcapにも届かない）

| headcountA | coverageA | capacityA(t) | shareCap(t) | allocatedA(t) | 実際の拘束要因 |
| --- | --- | --- | --- | --- | --- |
| 0 | 0.1500 | 200.0 | 17,500.0 | 200.0 | processingCapacity |
| 40 | 0.8891 | 4,040.0 | 17,500.0 | 4,040.0 | processingCapacity |
| 80 | 0.9407 | 4,466.7 | 17,500.0 | 4,466.7 | processingCapacity |
| 88 | 0.9457 | 4,510.2 | 17,500.0 | 4,510.2 | processingCapacity |
| 100 | 0.9519 | 4,563.6 | 17,500.0 | 4,563.6 | processingCapacity |
| 120 | 0.9595 | 4,630.8 | 17,500.0 | 4,630.8 | processingCapacity |
| 160 | 0.9693 | 4,717.6 | 17,500.0 | 4,717.6 | processingCapacity |
| 240 | 0.9793 | 4,808.0 | 17,500.0 | 4,808.0 | processingCapacity |
| 320 | 0.9844 | 4,854.6 | 17,500.0 | 4,854.6 | processingCapacity |

市場が十分大きい限り、`allocatedQuantity`は常に`processingCapacity(headcount)`
と一致する——**headcountを増やせば増やすほど、allocation段階では素直に
成約量が伸び続ける**（漸近的に5,000tへ近づくのみで、頭打ちにはならない）。
限界効果（headcount→headcount+1のΔallocated）: 0→1で+436.4t、79→80で
+6.0t、159→160で+1.65t——**滑らかに逓減するが、一度もゼロにはならない**。

### シナリオ2: 小さい市場（targetDemand=5,000t、対象需要が容易に埋まる）

| headcountA | capacityA(t) | shareCap(t) | allocatedA(t) | 実際の拘束要因 |
| --- | --- | --- | --- | --- |
| 0 | 200.0 | 1,750.0 | 200.0 | processingCapacity |
| 40 | 4,040.0 | 1,750.0 | 888.7 | targetDemand不足（水位法予算・他社との競合） |
| 80 | 4,466.7 | 1,750.0 | 903.3 | targetDemand不足（水位法予算・他社との競合） |
| 160 | 4,717.6 | 1,750.0 | 911.4 | targetDemand不足（水位法予算・他社との競合） |
| 320 | 4,854.6 | 1,750.0 | 915.6 | targetDemand不足（水位法予算・他社との競合） |

市場規模が小さい場合、headcount=40付近から**拘束要因がprocessingCapacityから
「市場需要（水位法予算）と他社との競合」へ切り替わる**。この後はheadcountを
40→320（8倍）に増やしても、allocatedQuantityは888.7t→915.6t（+3%程度）
しか伸びない——**allocation段階の計算式そのものは頭打ちしていないが、市場が
小さい場合は他の制約（対象需要・競合）が先に効いてしまうため、実務上の
限界効果はきわめて小さくなる**。

**B-5の結論（allocation段階）**: headcountの効果が「実質的に伸びなくなる」
現象は、`salesCoverageScore`/`processingCapacity`という計算式自体の
問題ではなく、**市場規模（targetDemand）・他社との競合が先に効くケースが
存在するため**である。これは自然な市場制約（前ラウンドの分類#6）であり、
人為的なハードキャップではない。

## B-4/B-5/B-6. Standard AI駆動の動的トレース結果（`b4DynamicHeadcountTrace.ts`）

BAL社・3シード平均・8四半期累計（moderate-pressure標準初期条件、seed=
sai3a-grid-001〜003）。

| headcount | 平均新規成約量(t) | 平均純売上(USD) | 平均粗利(USD) | 平均営業利益(USD) | 平均原料不足累計(t) | turn8末平均現金(USD) | 8Q人件費概算(USD) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 80（baseline） | 70,981 | 370,621,699 | 47,477,816 | 27,954,756 | 18,600 | 25,640,494 | 5,120,000 |
| 88（+10%） | 74,679 | 387,303,148 | 49,157,493 | 28,752,549 | 22,506 | 22,357,023 | 5,632,000 |
| 100（+25%） | 77,940 | 402,859,514 | 50,889,957 | 29,390,925 | 28,203 | 22,332,023 | 6,400,000 |
| 120（+50%） | 83,942 | 431,131,801 | 53,545,026 | 30,165,810 | 41,030 | 19,232,301 | 7,680,000 |
| 160（+100%） | 90,706 | 424,761,931 | 36,537,723 | 10,735,371 | 89,038 | 9,442,109 | 10,240,000 |

（人件費概算=`salesForceHeadcountTotal × finance/parameters.tsの
`salesForceSalaryUsdPerQuarter`(8,000USD) × 8四半期`。会社の実際の
給与体系のsanityチェック用であり、正確な会計上のSG&A計上とは別。）

### 限界効果（B-6）

| 区間 | Δheadcount | Δ新規成約量(t) | Δ粗利(USD) | Δ営業利益(USD) | Δ人件費(USD) | Δ粗利/人 | Δ営業利益/人 | 粗利増分が人件費増分を上回るか |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 80→88 | 8 | 3,699 | 1,679,677 | 797,793 | 512,000 | 209,960 | 99,724 | **YES** |
| 88→100 | 12 | 3,261 | 1,732,464 | 638,376 | 768,000 | 144,372 | 53,198 | **YES** |
| 100→120 | 20 | 6,002 | 2,655,069 | 774,885 | 1,280,000 | 132,753 | 38,744 | **YES** |
| 120→160 | 40 | 6,763 | **-17,007,303** | **-19,430,439** | 2,560,000 | **-425,183** | **-485,761** | **NO（大幅な逆転）** |

**観測事実**:
1. **80→120の範囲では、headcountを増やすほど新規成約量・純売上・粗利・
   営業利益のすべてが単調に増加する**。1人あたりの限界粗利（Δ粗利/人）は
   逓減する（209,960→144,372→132,753）が、常に人件費（1人あたり
   64,000USD/8Q）を明確に上回る。
2. **120→160では逆転が起きる**——新規成約量は依然として増加する
   （+6,763t）が、粗利は**17,007,303USD減少**、営業利益は
   **19,430,439USD減少**する。**「headcountを増やすほど成約量は伸びるが、
   経済的な結果（粗利・営業利益）はある水準を超えると悪化に転じる」**
   という、成約量と収益性が乖離する現象が実測された。
3. **原料不足（rawMaterialShortfall）が、headcountの増加とともに加速度的に
   拡大する**（80: 18,600t → 120: 41,030t → 160: 89,038t、120→160の
   40人増加だけで不足量が2倍以上に急増）。これは、営業側の成約量が
   生産側の原料供給能力を超えて先行し続けている（原料が追いつかない
   契約を積み増している）ことを示す。
4. **turn8末の現金は、headcountが増えるほど一貫して減少する**
   （25.6M→22.4M→22.3M→19.2M→9.4M）。160人ケースでは3シード中1つで
   `cashShortfall`（資金不足フラグ）が実際に発生した。
5. **設備稼働率(equipmentUtilizationRate)はどのケースでも0.4〜0.8の
   範囲にとどまり、1.0（完全飽和）には一度も達しない**——工場設備は
   headcount増加に対してボトルネックになっていない。
6. **労働稼働率(laborUtilizationRate)はどのケースでも一貫して1.000**
   （常に完全稼働）——これは生産側の労働力（ワーカー）であり、営業人員
   （headcount）とは別のリソースプールである。労働はheadcountの変化と
   無関係に、既にどのケースでも上限まで使われている。

**B-5の結論（動的トレース）**: 「headcountを増やしても最終結果が伸びなくなる」
現象は、allocation段階（成約量そのもの）では発生しない
（新規成約量は80→160まで単調増加）。**チェーンが実際に壊れる場所は
「原料調達」段階である**——契約は取れるが、原料が追いつかず生産できない
（`rawMaterialShortfall`の急拡大）。この生産不足は完成品在庫の不足→
`overdueQuantity`（延滞）予備軍の増加→キャッシュフローの悪化という形で
財務へ波及し、120→160の区間では粗利・営業利益の絶対的な悪化として現れる。
**「設備」や「労働力」がボトルネックになっているのではなく、「原料調達」が
ボトルネックになっている**、と明確に切り分けられる（equipmentUtilizationRate
は飽和しておらず、laborUtilizationRateはheadcountと無関係に常に飽和済み）。

## B-7. 四半期ラグの有無

コード確認（`sales/contracts.ts:resolveDueDate`）: 成約時の標準リードタイム
`SalesParameters.standardLeadTimeTurns = 1`（parameters.ts）。**成約
（allocation）が起きたturnの契約は、翌turn（+1四半期）が納期となる**
——headcountを増やして今turnの成約量が増えても、その分の生産・出荷・
売上計上は基本的に翌turn以降にずれる。動的トレースのturn1データ
（新規成約量が9,380〜11,558tなのに対し、turn1の履行量は7,942tで
やや少なめ）はこのラグと整合する。**1四半期だけの単発比較では
headcountの効果を過小評価しうる**ため、本分析ではB-4のとおり8四半期
累計で比較した。

## Part C. Cowork #05向けサマリー（観測事実のみ、AI実装への言及なし）

1. **headcount vs 販売効果の関係**: `salesCoverageScore`/`processingCapacity`
   は滑らかな逓減曲線であり、headcountがどれだけ増えても数式上の頭打ちは
   ない（前ラウンド確認済み、再確認）。
2. **headcount vs 成約量の関係**: 大きい市場では成約量はheadcountに対して
   単調に増加し続ける（漸近的に逓減）。小さい市場ではheadcount≈40付近から
   市場自体の制約（他社との競合）が支配的になり、それ以上の増員の効果は
   わずかになる。
3. **headcount vs 売上・粗利の関係**: 80〜120人の範囲では単調増加。
   120→160では成約量は伸び続けるが粗利・営業利益は大きく悪化する
   （非単調）。
4. **headcount vs 現金の関係**: headcountが増えるほど、turn8末の現金は
   一貫して減少する（人件費増・原料調達負担増・在庫積み増しによる
   運転資金圧迫）。160人では資金不足（cashShortfall）が実際に発生する
   ケースがある。
5. **最初に効く制約**: 市場規模が十分あれば、まず効くのはallocation段階の
   `processingCapacity`（headcount由来）。市場規模が小さければ市場需要・
   他社競合が先に効く。動的トレース（実際のゲーム全体）では、
   headcount=120→160の範囲で「原料調達」が支配的なボトルネックになる。
6. **さらなるheadcount増加の効果が逓減する理由**: (a)
   `processingCapacity`自体が数式として漸近曲線であるため（自然な逓減）、
   (b) 市場規模・他社競合による頭打ち（自然な逓減）、(c) 原料供給が
   成約量の伸びに追いつかず、契約はできても生産できない状態が拡大する
   ため（原料調達というゲーム内の別リソース制約）。
7. **1人あたりの限界経済効果**: 80→120人の範囲では、1人あたりの限界粗利は
   132,753〜209,960USD/8Q（逓減）で、1人あたり人件費64,000USD/8Qを
   明確に上回る。120→160人の範囲では、1人あたりの限界粗利は
   **-425,183USD/8Q（マイナス）**——採用コストを差し引く前から既に
   マイナスの効果である。
8. **headcount増員の限界価値が高い条件（観測事実として）**: 原料調達余力に
   まだ十分な余裕があり（`rawMaterialShortfall`が小さいか0）、設備稼働率が
   1.0未満で余力がある状況では、headcountの増員は成約量・粗利の両方を
   押し上げる方向に働く（80→120人の範囲で観測）。
9. **他の制約緩和を優先すべき条件（観測事実として）**: `rawMaterialShortfall`
   が既に大きく、かつheadcountをさらに増やそうとしている状況では、
   原料調達能力（domesticPurchase・輸入・養殖能力）を先に拡大しない限り、
   追加のheadcountは契約だけが積み上がり生産・出荷・現金化に結びつかない
   （120→160人の区間で観測）。
10. **Standard AI設計作業が参照すべき本番フィールド一覧**（今回の測定で
    実際に使用したもの）: `CompanyQuarterSummary.newContractedQuantity` /
    `.fulfilledQuantity` / `.overdueQuantity` / `.rawMaterialShortfall` /
    `.equipmentShortfall` / `.laborShortfall` /
    `.equipmentUtilizationRate` / `.laborUtilizationRate`、
    `CompanyFinancialQuarterResult.profitAndLoss.{netRevenue,grossProfit,
    operatingProfit}`、`.balanceSheet.{cash,accountsReceivable}`、
    `.cashShortfall`、`.negativeEquity`、`MarketProductAllocationResult.
    {allocatedQuantity,competitivenessWeight}`、
    `BorrowingCapacityResult`（財務診断ブランチのdoc参照）。

## 付録: スプレッドシート化について

`scripts/b4DynamicHeadcountTrace.ts`のB-6集計部分（headcountケース×
3シード平均の8Q累計比較表）は、そのままCSV化してGoogle Sheets/Excel
比較表の元データとして使える構造になっている。オーケストレーター側で
Excel変換が有用と判断すれば、このB-6サマリー表（5行×8列）と、
`b1IsolatedAllocationTrace.ts`のallocation段階の表（2シナリオ×9行）の
2つを渡せば十分（生の四半期別ログはテキスト出力のみで、CSV化していない
——必要であれば追加で書き出す）。
