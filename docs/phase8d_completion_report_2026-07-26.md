# Phase 8D 完了報告 — 設備投資・工場スペース・Worker・能力表示の再設計

作成日：2026年7月26日
対象ブランチ：`feature/v2-post-test-redesign-8d`
対象範囲：Phase 8D-0 〜 8D-6、UI、永続化、テスト

---

## 1. 開始時の `origin/develop/v2` HEAD

```
e6e0d57  feat(v2-export-api): 読み取り専用エクスポートAPI(STAGING_EXPORT_TOKEN)を新規実装
```

### 起点についての判断（重要）

`git fetch origin` の結果、**`origin/develop/v2` には Phase 8C-3B の15コミットがまだマージされていません**でした。
指示どおり `origin/develop/v2` から分岐すると、Phase 8D が土台にする
`processingCapacityViewModel.ts` / `processingForecastViewModel.ts`（Phase 8C-3B成果物）が
存在しない状態から始まることになり、共通ルールの
**「Phase 8Cまでの完了済み実装を失わない」に反します。**

そこで、`origin/develop/v2` に対して **fast-forward 可能な上位互換**である
`feature/v2-export-download-ui`（＝ `origin/develop/v2` + Phase 8C-3B の15コミット、HEAD `bfeebb5`）を
起点としました。作業ツリーはクリーンで、今回と競合する未コミット変更はありませんでした。

```
分岐元 HEAD : bfeebb5  docs: Coworkセッション移行のための引き継ぎ書
              （= e6e0d57 + Phase 8C-3B 15コミット）
```

---

## 2. 作業ブランチ名

```
feature/v2-post-test-redesign-8d
```

---

## 3. 最終HEADとコミット一覧

```
c0c2a0f  docs(v2-8d): Phase 8D completion report
36bfb6d  chore(v2-8d): drop the superseded capex candidate list component
9172ec6  test(v2-8d): cover the Phase 8D acceptance checklist
1dfd222  feat(v2-8d): persist worker headcount, add shared planning view-model and UI
d9545c6  feat(v2-8d): separate freezing/packaging throughput from cold storage, add factory space
174bee1  test(v2-8d): preserve pre-Phase-8D baseline as a deterministic 32-quarter regression
```

（最終HEADのハッシュはpush後の実際の値。上記は本報告書コミット時点の並び。）

---

## 4. 変更ファイル一覧

### 新規（エンジン）

| ファイル | 役割 |
|---|---|
| `app/lib/v2/production/factorySpace.ts` | 工場スペースの係数・使用量・予約・空き・不足（**係数の唯一の集約地点**） |
| `app/lib/v2/production/coldStorage.ts` | 冷凍・冷蔵保管能力（ストック）の状態・使用量・警告・未接続の明示 |
| `app/lib/v2/capex/factorySpace.ts` | 設備投資と工場スペースの接続（案件のスペース所要量・予約・承認枠） |
| `app/lib/v2/companyLab/workforce.ts` | Worker総人数の状態・増減差分・必要人数・人件費試算 |

### 新規（表示層）

| ファイル | 役割 |
|---|---|
| `app/v2/company-lab/investmentPlanningViewModel.ts` | **Phase 8Dの共通forecast/view-model**（能力・処理見込み・Worker・スペース・保管・投資カード・警告） |
| `app/v2/company-lab/components/WorkforcePanel.tsx` | Worker増減の表示・入力 |
| `app/v2/company-lab/components/FactorySpacePanel.tsx` | 工場スペースの表示 |
| `app/v2/company-lab/components/ColdStoragePanel.tsx` | 凍結・包装処理能力（フロー）と冷凍保管能力（ストック）の表示 |
| `app/v2/company-lab/components/InvestmentCardList.tsx` | 再設計した投資カード |
| `app/v2/company-lab/components/PlanningWarningsPanel.tsx` | 警告の種別分けと文章での説明 |

### 新規（テスト・ドキュメント）

`phase8dBaseline.test.ts` / `phase8dFactorySpace.test.ts` / `phase8dCapacitySeparation.test.ts` /
`phase8dInvestmentPlanning.test.ts` / `phase8dPersistence.test.ts` /
`docs/phase8d_baseline_2026-07-26.md` / 本報告書

### 変更

`capex/types.ts` `capex/parameters.ts` `capex/capacityEffect.ts` `capex/capexClose.ts`
`capex/projectLifecycle.ts` `capex/index.ts` / `production/types.ts` `production/labor.ts` /
`companyLab/types.ts` `companyLab/runner.ts` `companyLab/fixtures.ts` /
`companyLab/persistence/{types,schema,snapshot}.ts` /
`app/v2/company-lab/{capexViewModel,decisionDraft,page}.tsx` `components/DecisionEditor.tsx`
`play/_lib/viewModel.ts` `play/[labId]/PlayerScreenClient.tsx` / 既存テストの期待値更新6件

### 削除

`app/v2/company-lab/components/CapexCandidateList.tsx`（`InvestmentCardList.tsx` に置き換わり、参照ゼロ）

---

## 5. 現状調査で判明した実際の能力計算経路

四半期処理のたびに、次の経路で毎回**再導出**されています（累計能力はどこにも永続化されていません）。

```
CompanyFixture.factories（ラボ作成時の静的な基礎能力）
  ＋ CompanyLabState.capexState（投資案件ポートフォリオ）
      ↓ applyCapexCapacityToFactories(baseFactories, capexState, period)   ← runner.ts:669
        （status==="completed" かつ period >= operationalStartPeriod の案件のみ加算）
  ＝ 当期の名目能力 Factory[]
      ↓ calculateFactoryEffectiveCapacity(factory)                          ← production/capacity.ts:30
        実効能力 ＝ 名目能力 × baseUtilizationRate(0.9) × equipmentAvailabilityRate(0.95)
  ＝ 実効能力（**一律 85.5%**。補正要因はこの2つだけで、人員充足率・品質は実効能力を削らない）
      ↓ allocateProductionPlans(plans, factories, workers, lots, period)    ← production/allocation.ts:84
```

`allocateProductionPlans` の制約順序（実装どおり。**冷凍・包装が商品別設備より先**）:

1. 原料在庫（会社単位の共有プール・原料投入量ベース）
2. 工場共通処理能力（工場単位・原料投入量ベース）
3. **凍結・包装処理能力**（工場単位・完成品量ベース）
4. 商品別設備能力（工場×商品単位・完成品量ベース）
5. 有効労働能力（工場単位の共有ワーカープール）

歩留まり（`saleableRecoveryRatio`）は②と③のあいだで一度だけ適用。
優先度は数字が小さいほど優先で、同順位は先着ではなく希望量に比例した水位法配分。

---

## 6. 新しい共通forecast/view-modelの構造

`app/v2/company-lab/investmentPlanningViewModel.ts` の
`buildCompanyInvestmentPlanningViewModel()` が唯一の入口です。

```
入力: companyId / baseFactories / capexState / period
      productionPlans / workerAssignments / workforceState
      rawMaterialLots / finishedGoodsLots / lastQuarterFinancialResult

出力:
  forecast          … 現在の処理見込み（= allocateProductionPlans の出力そのもの）
  workforceRows     … 現在人数・増減・変更後人数・必要人数・過不足・
                      変更後の推定労働能力・人件費（前後・増減）・
                      Worker削減による未処理見込み・不足の説明文
  factorySpace      … 総量・稼働中使用量・建設中予約量・空き・完成後使用量・
                      完成後空き・使用率・不足量
  coldStorage       … 保管能力・使用量・空き・使用率・完成後能力・
                      商品別使用量・超過量・エンジン未接続の注記
  investmentCards   … 設備名・投資額・建設期間・支払予定・現在能力・追加能力・
                      完成後能力・必要スペース・完成後スペース使用率・
                      追加必要Worker・追加人件費・現在の生産計画に対する効果・
                      完成後に処理できる追加量・概算投資回収年数・
                      主なボトルネック・実装済み効果・未実装効果
  warnings          … 7種別の警告（不足量＋理由の文章つき）
```

### 「画面では処理可能なのに実行すると処理できない」を防いだ方法

処理見込みは、UI用の簡易計算ではなく **生産エンジンの純粋関数
`allocateProductionPlans` をそのまま呼んで**得ています
（`processingForecastViewModel.buildCompanyProcessingForecast` 経由）。

**投資完成後の処理量も同じ関数を使います。** 「能力だけを増やした仮の `Factory[]`」を作り、
同じ `buildCompanyProcessingForecast` へもう一度渡し、**その差**を増分としています。
増加量を見積もる別の式は存在しません。

必要Worker人数も同じ考え方で、`production/labor.ts` の
`requiredHeadcountForQuantity` を新設し、**エンジン内部（`allocateWorkersToPlans`）と
画面が同じ関数を共有**するようにしました（エンジン側も従来の内部式を捨ててこの関数を呼びます）。

`phase8dInvestmentPlanning.test.ts` の IP-4 が、
**同じドラフトで画面の見込みと実際のターン実行結果が1トン単位で一致すること**を固定しています。

---

## 7. 工場スペースの定義と採用した係数

### 定義

- 単位は「スペース単位」（工場の設置床面積 1 m² 相当とみなした抽象単位）
- 総量は `Factory.totalFactorySpaceUnits`。**未設定なら基礎能力から決定論的に導出**するため、
  Phase 8D以前に作成された既存ラボもそのまま読み込めます
- 使用量・空き・使用率・警告は**派生値であり保存しません**（毎回再計算）

### 採用した係数（`production/factorySpace.ts` の `FACTORY_SPACE_PARAMETERS_V1` に集約）

| 能力プール | 能力1トンあたりのスペース | 根拠 |
|---|---|---|
| 共通前処理 | 0.8 | 一次加工は面積効率が高い |
| HOSO加工 | 1.0 | 基準 |
| PD加工 | 1.6 | 殻剥きは工程が長くライン長を要する |
| VAP加工 | 2.5 | 付加価値加工は工程数が最も多い |
| 凍結・包装 | 0.6 | 装置型で面積効率が高い |
| 冷凍保管 | 2.0（同時保管1トンあたり） | 棚・通路を含め床を大きく占有する |

| 案件（能力を増やさないもの） | 固定スペース |
|---|---|
| 品質管理設備 | 600 |
| 排水・環境設備 | 900 |

| その他 | 値 |
|---|---|
| 総量導出の余裕率 | 5%（総量 ＝ 基礎能力の占有スペース × 1.05） |
| 逼迫警告のしきい値 | 使用率 90% |

**既存の仕様書・コードに合意済みの係数は存在しなかった**ため、上記はすべて暫定値です。
「工程が複雑なほど、同じ数量を処理するのに広い場所が要る」という順序関係
（VAP > PD > HOSO > 共通前処理 > 凍結包装）が出るように設定しました。

### 実際の効き方（BAL社の例）

```
基礎占有  17,600（共通22,000×0.8）＋10,000（HOSO）＋12,800（PD）
        ＋15,000（VAP）＋12,000（凍結包装）＋20,000（保管10,000×2.0）＝ 87,400
総量      87,400 × 1.05 = 91,770
空き      4,370
```

標準的な案件は HOSO増設500／PD増設560／VAP増設625／共通前処理560／凍結包装480／
冷凍保管2,500／品質600／環境900 を必要とするため、**2〜3件は実行できるが無制限には増設できない**
水準になります（同時進行中案件数の上限3件とおおむね釣り合います）。

### スペース不足時の扱い

- UIで明確に警告（不足量と理由を文章で表示）
- 投資カードに「このまま提出しても承認されません」と表示
- **エンジン側で承認を拒否**（例外ではなく理由つきの `rejectedProposals`）
- 同一四半期に複数提案しても、承認のたびに残枠を減らすため**二重予約は起きません**
- **既存設備の能力は遡って減らしません**（不足は警告と新規承認拒否だけで表現）

---

## 8. Worker変更が生産能力・人件費へどう接続されたか

### 見つかった不具合

Phase 8D以前、意思決定画面のワーカー人数の初期値は
`fixture.workerBaseline` から作られていました。つまり**前四半期にプレイヤーが人数を変えても、
次の四半期の初期値は毎回fixtureの初期人数へ戻っていました。**
会社の人員規模という、本来ターンをまたいで残るべき状態がどこにも保持されていませんでした。

### 接続

```
会社状態 CompanyLabState.workforceState（工場別の常用ワーカー総人数）
  ↓ 意思決定画面は「増減差分」だけを入力
  ↓ 変更後総人数 ＝ 前期末総人数 ＋ 増減差分（applyHeadcountChange。0未満にはしない）
  ↓ WorkerAssignment.regularHeadcount（＝絶対人数。エンジンの入力契約は変更なし）
  ├→ production/labor.ts allocateWorkersToPlans
  │     → 有効労働能力（人数 × 1人あたり効率 × 出勤率 × 技能 × 残業係数、設備能力でクリップ）
  │     → allocation.ts の段階5として**実際に処理量を制約**
  └→ finance/quarterClose.ts
        正社員人件費 ＝ 人数 × $1,000/四半期
        遊休労務費   ＝ 割り当てられなかった人数 × $1,000/四半期
  ↓ 四半期終了後、エンジンが実際に使った絶対人数を次期の総人数として繰り越す
```

したがって **Worker削減は画面上の警告だけでなく、有効労働能力と人件費の両方へ実際に反映されます。**
また、労働能力はエンジン側で設備能力によりクリップされるため、
**人を増やしても設備能力を超えて生産量が増えることはありません**（設備と労働の小さいほうが上限）。

### 今回追加していないもの（指示どおり）

採用費・解雇費・退職金・解雇人数制限・教育期間・習熟度・労使関係・機械化/省人化投資。
そのため人数は毎四半期自由に増減でき、増減そのものに追加費用は発生しません。
この事実は画面へ `WORKFORCE_NOT_MODELED_NOTE` として明示しています。

---

## 9. 凍結・包装処理能力と冷凍保管能力の違い

### 調査結果

Phase 8D以前、工場の能力は `Factory.freezingPackagingCapacity` という1フィールドだけで、
画面・Excelでは「冷凍能力」「冷凍・保管能力」と表記されていました。
しかし生産エンジン（`allocation.ts` 段階3）が実際に使っているのは
**四半期あたりに凍結・包装できる数量の上限（フロー）**であり、
**同時に保管できる量（ストック）ではありませんでした。**
在庫量を制約するロジックはエンジンに**ひとつも存在しません**でした。

さらに、`冷凍・冷蔵保管庫増設` という名前の投資案件が、実際にはフロー能力のほうを増やしていました。

### Phase 8Dでの整理

| 項目 | フィールド | 単位 | 生産上限として働くか |
|---|---|---|---|
| **凍結・包装処理能力** | `Factory.freezingPackagingCapacity` | HOSO換算t／四半期 | **はい**（allocation.ts 段階3） |
| **冷凍・冷蔵保管能力** | `Factory.coldStorageCapacity` | 同時保管HOSO換算t | いいえ（**強制制約は未接続**） |

### 投資案件

| 案件 | 増強対象 | 増加量 | 投資額 | 単価 |
|---|---|---|---|---|
| 冷凍・冷蔵保管庫増設 | 保管（ストック） | 1,250 t | $2,500,000 | **$2,000／保管トン**（指示の目安1,500〜2,500の範囲内） |
| 凍結・包装処理能力増設（**新設**） | 凍結・包装（フロー） | 800 t/四半期 | $2,800,000 | — |

### 後方互換

投資案件の増強対象は**承認時にスナップショット**される既存設計のため、
**Phase 8D以前に承認済みの `coldStorageExpansion` は、これまでどおり凍結・包装処理能力を増やします。**
確定済みの履歴が遡って変わることはありません。

これを固定しているテストは次の3本です（うち2本は**保存・復元を経た**回帰確認）。

| テスト | 検証経路 |
|---|---|
| `CS-10`（`phase8dCapacitySeparation.test.ts`） | 旧スナップショット（`targetProduct: "freezingPackaging"`）を持つ案件 → `applyCapexCapacityToFactories` → 凍結・包装処理能力が+500t |
| **`PS-7`**（`phase8dPersistence.test.ts`） | 旧案件を含む状態 → **schemaVersion:1・workforceStateキー無しのJSONへ保存 → `decodeCompanyLabPersistedState` → `restoreCompanyLabStateFromRuntimeSnapshot`** → 完成四半期では増えず、稼働開始四半期から凍結・包装処理能力が+500t、保管能力は不変 |
| **`PS-9`**（`phase8dPersistence.test.ts`） | 旧案件と新案件が同一会社に併存 → encode/decode/restore → それぞれの対象能力だけが増える |

新規案件についても同様に確認しています。

| テスト | 検証経路 |
|---|---|
| **`PS-8`**（`phase8dPersistence.test.ts`） | 現行テンプレート由来の新規案件 → encode/decode/restore → **保管能力のみ +1,250t、凍結・包装処理能力は不変** |

### 保管能力について今回**行っていない**こと（指示どおり）

期末在庫の自動廃棄／入庫拒否／外部倉庫への自動振替／強制的な販売／保管超過による架空の品質事故。
**現時点では強制制約未接続**であることを、画面・view-model・型のコメントに明示しています
（`COLD_STORAGE_ENGINE_CONNECTION_NOTE`）。

---

## 10. 品質設備の実装済み効果／未実装効果

### 調査（コード経路で確認）

- `app/lib/v2/quality/` 配下から `capex/` への import は**ゼロ**
- `qualityControlEquipment` という文字列は、非テストコードでは
  `capex/types.ts`（union member）、`capex/parameters.ts`（テンプレート）、
  `capexViewModel.ts`（UIラベル）の3箇所にしか現れず、いずれも quality/ から読まれない
- 品質エンジンの入力は `operationalRisk` 6要因のみ
  （稼働ストレス0.35／残業0.20／臨時工比率0.15／商品構成の複雑さ0.10／原料滞留0.10／立ち上がり0.10）
- `batchAdjustment.ts:62` に `baselineQualityOverride` というフックは存在するが、
  **リポジトリ全体で生成側が1つも無く**、`runner.ts:684-693` も渡していない
- テンプレート自体が `capacityIncreaseTonsPerQuarter: 0` かつ `targetProduct` 省略のため、
  `capacityEffect.ts:112-114` の2つのガードで確実に除外される

### 結論

| 分類 | 内容 |
|---|---|
| **実装済み** | 取得原価の固定資産振替、機械コンポーネントの減価償却、稼働開始後の四半期固定保守費（取得原価の1.25%/四半期＝5%/年）、工場スペースの占有 |
| **未実装（エンジン未接続）** | 格落ち率の低下／再加工率の低下／廃棄率の低下／重大品質事故率の低下／品質スコア・顧客信頼の向上／品質検査関連指標の改善 |

**現時点でこの投資は、減価償却費と保守費というコストだけが発生し、操業上の便益はありません。**
この事実を投資カードの「未実装の効果」欄に明示し、能力増加も投資回収年数も数値として出しません
（`IP-7` / `IP-8` テストで固定）。

なお、格落ち・再加工・廃棄そのものは品質エンジンに**実装済み**で、
PLにも反映されています（`rework` / `discardLoss` / `downgradeSalesDeduction`）。
**未実装なのは「品質設備がそれらを改善する」という接続だけ**です。

---

## 11. 環境設備の実装済み効果／未実装効果

### 調査

`wastewater` / `discharge` / `排水` / `環境` / `regulatory` / `規制` / `penalty` / `罰金` /
`audit` / `監査` / `compliance` / `violation` / `違反` を全リポジトリで検索した結果:

- `排水` は非テストコードでは `capexViewModel.ts` のUI説明文と、テンプレートの表示名の**2箇所だけ**
- `環境` の他の出現はすべて「環境変数」「テスト環境」
- `違反` は**財務コベナンツ違反**（銀行融資）のみで、環境とは無関係
- `規制` は `TRADE_RESTRICTION`（貿易規制シナリオイベント）のみ
- `assetCategory: "environmentalEquipment"` は**書かれるだけで、読む側が存在しない**

**環境・排水に関するロジックは、現時点のエンジンにひとつも実装されていません**
（排水処理能力という状態量そのものが存在しません）。

### 結論

| 分類 | 内容 |
|---|---|
| **実装済み** | 取得原価の固定資産振替、建物・機械コンポーネント別の減価償却、稼働開始後の四半期固定保守費（4%/年）、工場スペースの占有 |
| **未実装（エンジン未接続）** | 排水処理能力という状態量そのもの／環境事故の発生率／行政処分・罰金／環境監査・規制遵守の判定／生産計画に対する排水処理の使用率 |

指示どおり、環境事故・行政処分イベントは**新規実装していません**。
状態表示・能力表示・誤認防止注記・将来の接続設計（§17）までに留めています。

---

## 12. 投資回収計算の式と前提

> 【2026-07-26 追補】条件付き承認の指摘を受け、**追加Workerの四半期人件費を
> 増分キャッシュフローから控除する**よう修正しました。二重控除にならない根拠は
> 本節末尾の「二重控除にならないことの確認」を参照してください。

### 式（修正後）

```
1トンあたり限界利益 ＝ 直近確定四半期の実績限界利益額 ÷ 同四半期の実績販売トン
                      （ContributionMarginReport.contributionMargin ÷
                       costRecords の driver="salesQuantity" の driverQuantity）

増分処理可能量     ＝ 「能力だけを増やした仮のFactoryで生産エンジンを再実行した結果」
                      − 「現在の処理見込み」
                      （見積り式ではなく、エンジン出力の差）

増分Worker人数     ＝ ceil( 増分処理可能量を常用Workerだけで処理するのに必要な人数 )
                      （production/labor.ts の requiredHeadcountForQuantity。
                       エンジン内部の配分計算と同じ関数）
増分Worker人件費   ＝ 増分Worker人数 × regularWorkerSalaryUsdPerQuarter（$1,000/四半期）

増分限界利益       ＝ 増分処理可能量 × 1トンあたり限界利益
増分キャッシュフロー ＝ 増分限界利益 − 増分四半期保守費 − 増分Worker四半期人件費
概算投資回収年数   ＝ 投資総額 ÷ （増分キャッシュフロー × 4四半期）
```

### 前提（画面にも必ず併記）

- 限界利益は**直近の確定四半期の実績**をそのまま使用。将来の価格・原料費の変化は織り込まない
- 増分処理可能量はエンジンの再実行結果の差（推測式ではない）
- **減価償却費は非現金支出のため差し引かない**（増分キャッシュフロー基準）
- **追加Workerの人件費は増分キャッシュフローから控除する**
- 追加Worker人数は「増えた処理量をすべて常用Workerで処理する」前提。残業・臨時ワーカーで
  吸収する場合の費用は**限界利益側ですでに控除済み**なので重ねて引かない
- カードに表示する追加Worker人数・追加人件費と、回収計算で控除する金額は**同一の値**
  （人数は整数へ切り上げ。表示と計算で人数が食い違わないようにするため）
- **売上増加そのものは根拠にしていない**（販売できるかは営業の成約次第）

### 追加Worker人件費の扱い

| 項目 | 扱い | 理由 |
|---|---|---|
| 常用Worker（正社員）の増員人件費 | **増分CFから控除する** | 限界利益に含まれていない（固定製造費側） |
| 臨時ワーカー費 | 控除しない | 限界利益ですでに控除済み（変動労務費） |
| 残業費 | 控除しない | 同上 |
| 減価償却費 | 控除しない | 非現金支出 |
| 固定保守費 | 控除する | 現金支出であり、限界利益にも含まれない |

### 二重控除にならないことの確認（コードで確認した費用構成）

`app/lib/v2/finance/quarterClose.ts` を読み、次を確認しました。

| 確認点 | 位置 | 内容 |
|---|---|---|
| 限界利益の定義 | `quarterClose.ts:1026` | `contributionMargin = netRevenue − totalVariableCost` |
| 変動費の内訳 | `quarterClose.ts:1025` | 原料費＋加工費＋**変動労務費**＋品質費＋販売費 |
| 変動労務費の中身 | `quarterClose.ts:1022` | `cogsLaborVariable` ＋（生産ゼロ時の臨時ワーカー費・残業費） |
| `cogsLaborVariable` の元 | `quarterClose.ts:689`／`439` | `laborVariablePerTon` の積み上げ |
| `laborVariablePerTon` の定義 | `finance/types.ts:162` | **「変動労務費（臨時ワーカー費＋残業費の配賦）」** |
| 正社員給与の置き場所 | `finance/types.ts:166`／`quarterClose.ts:441` | **`laborFixedPerTon`（固定労務費＝正社員直接労務費の配賦）** |
| 固定製造費の定義 | `quarterClose.ts:1029-1033` | `regularLaborCost` ＋ 工場固定費 ＋ 固定ユーティリティ ＋ 減価償却 |

**結論：常用Worker（正社員）の給与は `fixedManufacturingCost` に入っており、
限界利益の計算には一切含まれていません。** したがって、増分キャッシュフローから
追加常用Workerの人件費を差し引くことは二重控除ではありません。

逆に、増産を残業や臨時ワーカーで吸収する場合の費用は限界利益側ですでに控除済みであるため、
そちらを重ねて引いてはいけません。本計算では追加人員を**すべて常用Worker**として数え、
臨時ワーカー0人で算出しています（`computeRequiredRegularHeadcount` に `temporaryHeadcount: 0` を渡す）。

この根拠は `PAYBACK_DOUBLE_COUNTING_NOTE` として文字列でも保持し、投資カードの詳細欄に表示します。

### 算定できない場合に数値を作らない

次のいずれかに該当すると、**回収年数を算出せず理由つきで「現在の実装では算定対象外」**と表示します。

1. 増分処理可能量が0（＝別の制約が先に効いている、または能力を増やさない案件）
2. 直近確定四半期の販売実績が無い（初回四半期など）
3. **増分限界利益が「増分保守費 ＋ 増分Worker人件費」の合計を上回らない**

### 固定しているテスト

| テスト | 内容 |
|---|---|
| `IP-10` | 式が売上ではなく限界利益・増分CFであること（限界利益/トン＜売上単価/トンも確認）。表示人数と控除人数が一致すること |
| `IP-13` | 追加Worker人件費を控除すると増分CFが減り、回収年数が伸びること |
| `IP-14` | 増分限界利益が保守費＋Worker人件費を下回るとき、回収年数を算定しないこと |
| `IP-15` | **エンジンの実データ**で、限界利益に正社員給与が含まれず固定製造費側にあること |

---

## 13. 永続化schemaの変更内容と後方互換方法

### 変更

| 追加先 | フィールド | 型 |
|---|---|---|
| `CompanyLabRuntimeSnapshot` | `workforceState` | `{ companies: [{ companyId, factories: [{ factoryId, regularHeadcount }] }] }` |
| `Factory`（fixtures内） | `coldStorageCapacity?` | `HosoEqTons`（省略可） |
| `Factory`（fixtures内） | `totalFactorySpaceUnits?` | `number`（省略可） |

`CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION`: **1 → 2**

### 後方互換の方法（マイグレーション処理は不要）

1. **バージョン検証は「現行より新しいものだけを拒否」**する既存実装のため、
   `schemaVersion: 1` のデータはそのまま読めます。
2. `workforceState` キーが無い場合、schema は**空（`{ companies: [] }`）を補います**
   （`app/lib/v2/persistence/schema.ts` の `validateFinanceStates` 等で確立済みの
   「キーの有無で判定し、無ければ安全な既定値」方式をそのまま踏襲。バージョンで分岐しません）。
3. 空だった場合、`restoreCompanyLabStateFromRuntimeSnapshot` が
   **確定履歴に保存済みの `decisions[].workerAssignments` から実際の人数を復元**します。
   これは推測値ではなく、実際にその四半期を動かした人数の実データです。
4. 履歴も無ければ空のままとし、会社単位で `fixture.workerBaseline` へフォールバックします。
5. `Factory` の2フィールドは、companyLab の schema が `factories` を生配列として
   通過させる既存実装のため、**schema変更なしで保存・復元されます**。未設定の場合は
   `deriveDefaultColdStorageCapacityTons` / `deriveDefaultFactorySpaceUnits` が
   基礎能力から決定論的に導出します。

### 保存量への影響

追加したのは会社数×工場数ぶんのスカラーのみ（5社×1工場＝5エントリ）。
履歴エントリへ2回複製されても保存量への影響は無視できます
（既存の `storageMeasurement.test.ts` の上限チェックも引き続き通過）。

### Redis・バージョン規則

`v2:companyLab:` / `staging:v2:companyLab:` の接頭辞規則、キーガード、
`engineVersion` の扱いはいずれも**変更していません**。新しいRedisキーも追加していません。

---

## 14. 追加・変更したテスト

### 新規（計 56 件）

| ファイル | 件数 | 内容 |
|---|---|---|
| `companyLab/__tests__/phase8dBaseline.test.ts` | 5 | 32ターン完走・決定論性・NaN無し・自動方針は投資提案ゼロ・負値無し |
| `production/__tests__/phase8dFactorySpace.test.ts` | 15 | 係数・総量導出・案件所要量・**二重計上防止**・不足判定・承認枠・不正値無し |
| `companyLab/__tests__/phase8dCapacitySeparation.test.ts` | 11 | **凍結包装が生産上限**・保管は上限でない・**保管超過でも廃棄なし**・完成前は加算されない・完成後のみ増える・**スペース不足で承認拒否**・保管単価・旧案件の後方互換 |
| `company-lab/__tests__/phase8dInvestmentPlanning.test.ts` | 15 | **Worker減で人数と人件費が減る**・**Worker不足で処理量減と未処理見込み**・**Worker増でも設備能力を超えない**・**見込みと実績が一致**・決定論性・不正値無し・**未実装効果を数値化しない**・**回収は限界利益/増分CF** |
| `companyLab/persistence/__tests__/phase8dPersistence.test.ts` | 9 | **round-trip保持**（Worker・スペース・保管・能力・建設中案件）・**旧schema読み込み**・履歴からの復元・**旧/新 coldStorageExpansion の効果が保存復元後も保たれること** |

### 変更（既存テストの期待値更新）

| ファイル | 変更理由 |
|---|---|
| `capex/__tests__/capacityEffect.test.ts` | 能力プールへ `coldStorage` を追加したため期待値に追記 |
| `company-lab/__tests__/capexViewModel.test.ts` | 案件種別が7→8種類になったため（定数から件数を取るよう変更） |
| `company-lab/__tests__/capexIntegration.test.ts` | `coldStorageExpansion` が保管（ストック）を増やすよう変わったため |
| `persistence/__tests__/{roundtrip,atomicCommit,repositoryContract}` ほか3件 | スナップショット型に `workforceState` が加わったため |

---

## 15. typecheck・lint・全テスト・32ターン・build の結果

| 項目 | 結果 |
|---|---|
| TypeScript（`npx tsc --noEmit -p .`） | ✅ **エラー0** |
| ESLint（`npx eslint app/`） | ✅ **エラー0**（警告2件は既存の未使用変数。今回の変更とは無関係） |
| Phase 8D関連テスト | ✅ 50件すべて成功 |
| persistence関連テスト | ✅ すべて成功 |
| companyLab関連テスト | ✅ すべて成功 |
| **全テストスイート（`npm test`）** | ✅ **1,523件／失敗0**（Phase 8D前は1,474件） |
| **32ターンシミュレーション** | ✅ 完走（`phase8dBaseline.test.ts`。決定論性・NaN無し・負値無しも同時に確認） |
| **build（`npm run build`）** | ✅ 成功（既知のV1環境変数問題は再現せず） |
| PC幅（1440×900）の画面確認 | ✅ 実ブラウザで描画確認。JSエラー無し・横スクロール無し |
| iPad横向き幅（1180×820）の画面確認 | ✅ 同上 |

画面確認では、警告セクション・凍結包装／保管の分離表示・工場スペース・Worker増減・
投資カードの「未実装の効果」・概算投資回収年数が、いずれも両方の幅で正しく表示されることを確認しました。

---

## 16. 既知の問題

1. **投資回収年数が、初期状態ではほぼ全案件で「算定対象外」になります。**
   BAL社の Turn 1 では原料在庫が最初のボトルネックであり、加工能力を増やしても
   処理見込みが増えないためです。これは誤りではなく事実であり、カードには
   「現在の入力では、この能力より先に『原料在庫』が処理量を制約しているため、
   この投資だけでは処理見込みが増えません」と理由を表示します。
   原料を確保した状態で見ると、能力投資の効果と回収年数が出ます。

2. **必要Worker人数は目安です。** エンジンは商品ごとに優先順位階層＋水位法で
   ワーカーを配分するため、能力・原料側で先に頭打ちになれば必要人数はこれより少なく済みます。
   実際に処理できる量は「現在の入力に基づく処理見込み」の表が唯一の正であり、
   その旨を画面に明記しています。

3. **工場スペース係数・余裕率5%は暫定値です。** 合意済みの数値が存在しなかったため
   §7の根拠で設定しました。Phase 8H の校正対象です。

4. **Export API・Excel へは、工場スペース・保管能力・Worker総人数をまだ出していません。**
   Phase 8D の指示範囲（画面・永続化・テスト）に限定したためです。Phase 8G で追加します。
   ただし能力プールのラベルは共通定数を経由しているため、
   **Excel側の「冷凍・保管能力」表記は自動的に「凍結・包装処理能力」へ変わります。**

5. **自動方針（AI 4社）は Worker 総人数を参照していません。** 従来どおり
   `fixture.workerBaseline` の人数を毎期返すため、AI各社の総人数は初期値のまま一定です
   （結果として32ターン基準シミュレーションの数値は変わりません）。Phase 8G の対象です。

6. **`laborUtilizationRate` の構造的1.0張り付き**（Phase 8C-3Bで報告済み）は今回も未修正です。
   稼働ストレスが常に最大に張り付くため、人員を減らしても品質は悪化しません。

---

## 17. 次のPhase 8Eへ引き継ぐ事項

### 今回作った、8E以降で再利用できる構造

- `production/factorySpace.ts` の `computeProjectRequiredSpaceUnits` は
  「増強対象＋増加量」だけを引数に取るため、新しい案件種別を足しても係数表の追記だけで済みます
- `production/labor.ts` の `requiredHeadcountForQuantity` は
  **営業人員の必要数算出（Phase 8E）にもそのまま使える形**にしてあります
  （効率・出勤率・技能・残業係数という一般的な引数構成）
- `investmentPlanningViewModel.ts` の `PROJECT_EFFECT_DISCLOSURES` は、
  エンジン接続が進むたびに「未実装」から「実装済み」へ項目を移すだけで済みます
- 警告は `PlanningWarningKind` の union なので、Phase 8E で営業関連の警告種別を追加できます

### Phase 8E（営業人員を市場別入力へ、VAPの営業工数3倍）への申し送り

- 営業人員の合計上限は `fixture.salesForceHeadcountTotal`、検証は
  `sales/salesForce.ts` の `validateSalesForceHeadcountBudget`（`runner.ts:522` から呼ばれる）
- 成約上限は `processingCapacity(h) = 200 + 4800h/(h+10)`。**営業0人でも200t取れます**
- VAPの営業工数を3倍にする場合、「人数」ではなく「工数」を新しい単位として導入するか、
  `salesForceHeadcount` の解釈を市場×商品ごとに重み付けするかの選択になります。
  Phase 8D で Worker に採用した「**状態は総量、意思決定は差分／配分**」という形を
  営業人員にも適用すると、両者の操作感が揃います
- Phase 8D では **8E以降を先回りして実装していません**（営業関連のコードは一切変更していません）

---

## 18. 機械化・省人化投資の将来設計案（今回はコード実装なし）

Phase 8D-4 の指示により、設計案のみ記載します。

### 案

新しい案件種別 `automationEquipment`（自動化・省人化設備）を追加し、
`FutureCapacityEffectPlaceholder` に**能力ではなく効率へ作用する**フィールドを1つ足します。

```ts
readonly laborEfficiencyMultiplier?: number;   // 例: 1.25 = 同じ人数で25%多く処理できる
```

`production/labor.ts` の `calculateLaborCapacityFromAssignedHeadcount` は
すでに「1人あたり効率」を引数に取る形なので、**稼働開始済みの自動化投資の
`laborEfficiencyMultiplier` の積を効率へ掛けるだけ**で接続できます
（`applyCapexCapacityToFactories` と同じ「稼働開始済みの案件だけを毎期再導出する」方式）。

### この案の利点

- 必要Worker人数の逆算（`requiredHeadcountForQuantity`）も同じ効率を使うため、
  画面の必要人数が自動的に減り、**「投資で人を減らせる」ことが数字で見えます**
- 設備能力の上限クリップは既存のままなので、
  **省人化しても設備能力を超えて生産量が増えることはありません**
- 工場スペースは既存の固定スペース方式（品質・環境設備と同じ）で表現できます

### 経営判断として学べること

「人件費を減らすために設備へ投資する」という選択が、
**投資額・保守費・減価償却 vs 削減できる人件費**という形で比較できるようになります。
Phase 8D で投資回収を増分キャッシュフロー基準にしてあるため、
省人化投資の回収は「削減人件費 − 増分保守費」で同じ式に載せられます。

### 注意点

現在のエンジンでは**採用費・解雇費が存在しない**ため、省人化投資をしなくても
人数は自由に減らせてしまいます。省人化投資に意味を持たせるには、
**先に解雇コストか、人数削減による能力低下のいずれかを導入する必要があります**
（さもないと「投資せずに人を減らす」が常に最適になります）。この順序は Phase 8F/8G の検討事項です。

---

## 19. `develop/v2` へのマージ状況

**マージしていません。**
すべての変更は作業ブランチ `feature/v2-post-test-redesign-8d` 上にあり、
リモートへ push した状態で停止しています。ブランチは削除していません。
`develop/v2` へのマージ・統合判断は未実施です。

---

## 20. V1・main・v1-maintenance・`/root/shrimpx` の状況

**いずれも一切変更していません。**

- 変更ファイルは全44件で、**すべて `app/lib/v2/` `app/v2/` `app/api/v2/` `docs/` 配下**です
  （`git diff --name-only` で確認済み）
- `app/lib/redis.ts` `app/lib/redisKeyGuard.ts` `app/api/game/**` など V1 のファイルは無変更
- `main` `v1-maintenance` へのコミット・push は行っていません
- `/root/shrimpx` はこの実行環境に存在せず、触れていません
  （作業ディレクトリは `/tmp/year1_clone` のみ）
- V1 のテストは全テストスイート（1,523件）の中で従来どおり成功しています
