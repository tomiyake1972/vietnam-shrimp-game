# ShrimpX V2 Company Lab — 開発引き継ぎ書（Development Handover）

**文書ID**: ShrimpX-KB-01
**版**: v1.0
**作成日**: 2026-07-26
**対象読者**: 本プロジェクトの開発を引き継ぐ人／AIアシスタント
**位置づけ**: Claude Project Knowledge 常設資料。セッションが変わっても本書だけで開発を再開できることを目標とする。

関連文書:

- ShrimpX-KB-02 ゲームマニュアル（プレイヤー・GM向けの遊び方と仕組み）
- ShrimpX-KB-03 パラメータ仕様書（全係数の実値と出典）
- ShrimpX-KB-04 開発ログ（時系列の開発経緯と設計判断の記録）

---

## 0. 新しいセッションで最初に読むべきこと

新しい会話でこのプロジェクトの作業を始めるとき、最初に確認すべき事項を順に並べる。

まず、このプロジェクトは**ベトナムのエビ加工・輸出業界を題材にした経営シミュレーションゲーム**であり、Webアプリケーションとして実装されている。依頼者である三宅さんは非技術者であり、Windows PC の Chrome からプレイする。三宅さんは同時に、このゲームの発注者であり、テストプレイヤーであり、将来のゲームマスター（GM）でもある。したがって成果物は「動くこと」だけでなく「三宅さんが意思決定に使えること」が要求水準になる。

次に、**現在稼働中のテストセッションは `Test12`** であり、2015年Q1から始まる四半期進行で、現在ターン3（2015Q3）の意思決定待ちである。三宅さんが操作する会社は **BAL（バランス型水産）**。

そして、本プロジェクトには**破ってはならない禁止事項**が複数ある。第7章にまとめてあるが、特に重要なのは「確定した実績値を再計算して置き換えない」「推測値を実績として出力しない」「Production 環境へデプロイしない」の3点である。これらは単なる作法ではなく、過去に明示的な是正指示として文書化された制約である。

最後に、コードは `/tmp/year1_clone` にクローンして作業する運用を取ってきた。Bash ツールの作業ディレクトリは呼び出しごとに `/home/claude` へ戻るため、コマンドは常に絶対パスで書く。

---

## 1. プロジェクト概要

### 1.1 何を作っているか

ShrimpX V2 Company Lab は、ベトナムのエビ加工・輸出企業5社が同一市場で競争する、四半期ターン制の経営シミュレーションである。プレイヤーは1社を担当し、原料調達・生産・販売・財務・設備投資の意思決定を毎四半期おこなう。残りの会社は自動方針（`autoPolicy.ts`）で動く。

市場は「世界のエビ市場」と「ベトナム国内原料市場」の二層構造になっている。世界市場ではエクアドル・インド・インドネシア・ベトナムの4原産国が供給し、中国・米国・EU・日本・その他の5需要市場が消費する。国内原料市場ではプレイヤー5社と外部加工業者が養殖農家から原料を買い付けて競合する。

商品区分は HOSO（有頭殻付き）、PD（むき身）、VAP（付加価値加工品）の3種類。すべての数量は **HOSO換算トン（HOSO-equivalent tons）** で統一的に扱う。これは重要な設計判断で、物理的な歩留まり（殻や頭を落とすことによる重量減）はHOSO換算という単位の定義に既に織り込まれている。この点を誤解すると歩留まりの二重計上が起きる（実際に Phase 6 で起きた。第6章および開発ログ参照）。

### 1.2 二つの実験環境

コードベースには2つの「Lab」がある。

**Company Lab**（`app/lib/v2/companyLab/`）が本命であり、5社の会社経営を四半期単位で回す統合実行環境である。プレイヤー向けUI（`app/v2/company-lab/`）はここに接続している。`Test12` もこの環境で走っている。

**Industry Lab**（`app/lib/v2/industryLab/`）は市場価格形成モジュール単体を長期間回して挙動を検証するための環境で、会社経営を伴わない。パラメータ校正の診断に使う。

### 1.3 誰がどう使うか

三宅さんはブラウザで意思決定画面を開き、販売計画・調達計画・生産計画・人員配置・財務・設備投資を入力して提出する。四半期を確定させると、5社分の処理が一括で走り、確定履歴として Redis に保存される。その後、Export API 経由で Excel/ZIP をダウンロードして分析する、という流れである。

Excel 分析ブック（会社別データブック、GM用データブック、ターン別分析ブック）は、この会話セッションの中で Python（openpyxl）で生成して納品してきた。これはアプリ本体の機能ではなく、支援成果物である。

---

## 2. リポジトリとデプロイ環境

### 2.1 GitHub

- リポジトリ: `https://github.com/tomiyake1972/vietnam-shrimp-game.git`
- 作業ブランチ: `feature/v2-export-download-ui`
- 直近のコミット: `bfeebb5`（引き継ぎ書 `docs/handover_2026-07-26.md` の追加）

作業用クローンの git remote には Personal Access Token が埋め込まれている。**push の出力をそのままユーザーへ見せてはならない。** 必ず次のようにマスクする。

```bash
git push origin feature/v2-export-download-ui 2>&1 | sed -E 's#https://[^@]*@#https://#g'
```

また、`scripts/dumpSampleExport.ts` は未追跡のスクラッチファイルであり**コミットしてはならない**。`git add -A` を裸で実行せず、`git add -A app/` と明示的な docs パスを指定してステージする。

### 2.2 Vercel

- Team: `team_LMcTQ4W66vEGFeRc8nCRfGP8`（slug `tomiyake`）
- Staging プロジェクト: `prj_17wdy8hiZA25SgRQSDiAHH2LHI4C`
- Production プロジェクト: `prj_XgMSkuDVQiENDJZSVpISicYOb3Mu`

プレイURL（Preview デプロイ）:

```
https://vietnam-shrimp-game-staging-git-feature-v2-expo-342a11-tomiyake.vercel.app/v2/company-lab/play/Test12
```

**Production へはデプロイしない。** これは明示的な禁止事項である。動作確認は必ず Preview デプロイが `READY` になったことを確認して完了とする。

Vercel の Deployment Protection が有効なため、アプリがサーバー側から自分自身の URL を fetch する場合には `x-vercel-protection-bypass` ヘッダが必要になる。ここで `x-vercel-set-bypass-cookie: true` を付けると解決不能なリダイレクトループに陥る（undici の20リダイレクト上限に到達する）。この件は実際に3段階の Preview 障害として発生し、ShrimpX-KB-04 開発ログ §11 に詳細がある。

環境変数を追加・変更しても既存のデプロイには遡って適用されないため、空コミットで再デプロイを促す必要がある。

### 2.3 Upstash Redis（永続化）

`@upstash/redis` を使う。**Production と Staging で同じ Redis インスタンスを共有している。** これは Vercel Marketplace の無料プランの制約によるもので、意図した設計ではない。

そのため、`app/lib/redis.ts` の `assertAllowedKeys`（`app/lib/redis.ts:43` の薄いラッパー。ロジック本体は純関数 `assertAllowedKeys(keys, isProd)` として `app/lib/redisKeyGuard.ts:17` にある）により、staging 側のキーには必ず `staging:` プレフィックスが付くことを実行時に強制している。書き込み系（`set`/`del`/`lpush`/`lrem`）は Redis へ命令を発行する前に必ずこの検証を通る。`APP_ENV` は Vercel 上で明示的に `production` または `staging` を設定しなければならず、未設定ならアプリは起動時に失敗する（fail-closed）。

この分離は論理的なものにすぎない。Redis を触る変更を入れるときは、キープレフィックスの扱いを必ず確認すること。

---

## 3. 開発環境の立ち上げ

```bash
# クローン（トークン付き remote はマスクして扱う）
git clone https://github.com/tomiyake1972/vietnam-shrimp-game.git /tmp/year1_clone
cd /tmp/year1_clone
npm install
```

主要な npm スクリプト:

| スクリプト | 内容 |
|---|---|
| `npm run dev` | 開発サーバ起動 |
| `npm run build` | 本番ビルド（KVのダミー環境変数が必要） |
| `npm start` | ビルド済みサーバ起動 |
| `npm run lint` | ESLint |
| `npm test` | `tsx --test` によるテスト実行 |
| `npm run v2:simulate` | `scripts/v2Simulate.ts`（市場モジュール単体シミュレーション） |
| `npm run v2:company-simulate` | `scripts/v2CompanySimulate.ts`（会社経営シミュレーション） |

技術スタックは Next.js 16.2.10 / React 19.2.4 / TypeScript / Tailwind 4。依存に `@upstash/redis` ^1.34.9、`exceljs` ^4.4.0、`jszip` ^3.10.1、`tsx` ^4.23.1。

テスト対象パターンは `app/lib/**/__tests__/**/*.test.ts`、`app/v2/**/__tests__/**/*.test.ts`、`app/api/**/__tests__/**/*.test.ts` の3つ（1つ目は `v2` 限定ではなく、V1 のテストも含む）。現在 **1,474 テストが通過**している。

**重要な落とし穴**: `tsx --test` は型チェックをしない。テストが通っても型エラーは残りうる。したがって検証サイクルは次の順で必ず全部走らせる。

```bash
cd /tmp/year1_clone && npx tsc --noEmit -p .
cd /tmp/year1_clone && npx eslint <変更したファイル>
cd /tmp/year1_clone && npm test
cd /tmp/year1_clone && npm run build   # KVダミー環境変数が必要
```

そのうえで commit → push → Vercel Preview が READY になったことを確認する。

もう一つの落とし穴として、`companyLabAdminExcelBuilder.ts` は grep からバイナリファイルとして扱われる。検索するときは `grep -a`、`sed`、または Read ツールを使う。

---

## 4. コードの地図

### 4.1 エンジン層 `app/lib/v2/`

| モジュール | 責務 |
|---|---|
| `core/` | 単位型（`HosoEqTons`, `Score0to100`, `Ratio` 等）と共通ユーティリティ |
| `market/` | 世界市場価格形成、原産国別FOB価格、PD/VAPプレミアム、ベトナム国内原料価格 |
| `scenario/` | 長期シナリオ・イベント、前史（prehistory）、基礎変数のトレンド |
| `sales/` | 販売計画、営業人員、成約競争力、配分、約定残 |
| `rawMaterials/` | 国内買付、輸入、自社養殖、原料ロット在庫 |
| `production/` | 生産計画の能力配分、歩留まり、労働能力、負荷指標 |
| `quality/` | 操業リスク、不適合率、品質スコア、納期信頼性、顧客信頼 |
| `finance/` | 四半期決算（P/L・B/S・C/F）、原価計算、減価償却 |
| `financing/` | 信用スコア、借入余力、財務制限条項、緊急融資 |
| `capex/` | 設備投資案件、建設中資産、固定資産振替、保守費 |
| `turn/`, `turnState/` | ターン進行と状態遷移 |
| `persistence/` | 確定履歴の永続化スキーマ |
| `redis/` | Redis アクセス層 |
| `companyLab/` | 5社統合実行環境（本命） |
| `industryLab/` | 市場モジュール単体の長期検証環境 |

各モジュールには `parameters.ts` があり、**係数はすべてそこに集約されている**。ロジック中にマジックナンバーを書かないのが本プロジェクトの一貫した規約である。実値は ShrimpX-KB-03 パラメータ仕様書を参照。

### 4.2 Company Lab の内部

`app/lib/v2/companyLab/` の主要ファイル:

- `runner.ts` — 四半期処理の統合実行。ここが全体のオーケストレータ。
- `fixtures.ts` — 5社の初期設定（工場能力・人員・技能・原料在庫・加工費）。**統合テスト用フィクスチャであり本番の会社設定ではない**と冒頭コメントに明記されている。
- `parameters.ts` — 外部加工業者需要の前提値、自動資金調達方針の閾値。
- `autoPolicy.ts` — プレイヤー以外の4社の自動意思決定。
- `externalDemand.ts` — 外部加工業者の国内原料需要モデル。
- `initialContracts.ts` — 初期の受注契約。
- `premiumPolicy.ts` — 商品プレミアム価格方針。
- `qualitySummary.ts` / `reasonCodes.ts` — 出力の要約と理由コード。
- `adminExport/` — 管理者向け Excel/ZIP 生成。
- `application/`, `persistence/`, `cli/`, `__tests__/`

### 4.3 UI 層 `app/v2/company-lab/`

- `page.tsx` — Lab 一覧・新規作成
- `play/[labId]/` — 意思決定画面（メイン）
- `play/export/[labId]/` — 管理者向けエクスポート画面
- `components/` — UI 部品（`financial/` に財務表示）
- ビューモデル群: `dashboardViewModel.ts`, `capexViewModel.ts`, `marketPriceViewModel.ts`, `processingCapacityViewModel.ts`, `processingForecastViewModel.ts`, `dashboardExplanation.ts`, `dashboardWarnings.ts`, `decisionDraft.ts`, `capexDraftActions.ts`
- `play/_lib/` — `viewModel.ts`, `financialViewSelectors.ts`, `companyOptions.ts`, `newLabFormModel.ts`, `uiDependencies.ts`

**ビューモデルは新規計算を一切しない。** 確定値を選択して表示形式に整えるだけである。これは表示層の絶対規約（第7章）。

### 4.4 API 層 `app/api/v2/`

```
admin/export-download/[labId]/[turn]

company-labs                                   ラボ一覧・作成
company-labs/[labId]                           ラボ状態の取得
company-labs/[labId]/draft
company-labs/[labId]/draft/submit
company-labs/[labId]/history
company-labs/[labId]/history/[turn]
company-labs/[labId]/process-quarter

exports/company-labs/[labId]
exports/company-labs/[labId]/turns/[turn]
exports/company-labs/[labId]/turns/[turn]/companies/[companyId]
exports/company-labs/[labId]/turns/[turn]/market
```

（`app/api/v2/` 配下の `route.ts` は上記12本。ほかに V1 用の `app/api/game/` 配下が12本ある。）

Export API は **読み取り専用・GET のみ・Bearer 認証のみ・Production では常に拒否**。`CompanyLabReadOnlyRepository` は書き込みメソッドを持たない型として定義されており、構造的に書き込みを不可能にしている。

Export DTO は `app/api/v2/exports/_lib/dto/` にある: `contractDto.ts`, `decisionDto.ts`, `marketDto.ts`, `operationsDto.ts`, `processingCapacityDto.ts`, `salesDto.ts`。**内部型をそのまま spread せず、許可フィールドを明示的に列挙して組み立てる**のが規約。

### 4.5 ドキュメント `docs/`

`docs/v2/` に15本のアーキテクチャ文書がある。設計の根拠を追うときの一次資料。

```
CAPITAL_INVESTMENT_ARCHITECTURE_v0.1.md
COMPANY_LAB_API_ARCHITECTURE_v0.1.md
COMPANY_LAB_ARCHITECTURE_v0.1.md
COMPANY_LAB_UI_ARCHITECTURE_v0.1.md
CORE_ARCHITECTURE_v0.1.md
DESTINATION_MARKET_PRICING_v0.1.md
ECONOMIC_CALIBRATION_PHASE_6_3_v0.1.md
FINANCIAL_ARCHITECTURE_v0.1.md
INDUSTRY_SIMULATOR_ARCHITECTURE_v0.1.md
MARKET_PRICING_ARCHITECTURE_v0.1.md
PRODUCTION_ARCHITECTURE_v0.1.md
QUALITY_RELIABILITY_ARCHITECTURE_v0.1.md
RAW_MATERIALS_ARCHITECTURE_v0.1.md
SALES_CONTRACTS_ARCHITECTURE_v0.1.md
SCENARIO_EVENT_ARCHITECTURE_v0.1.md
```

`docs/` 直下には開発日誌（`development_diary_2026-07-16.md` 〜 `2026-07-25.md` の8本。07-21・07-22 は欠番で、日誌自体が存在しない）、`game_design_principles.md`、`capacity_forecast_report_2026-07-25.md`、`staging_environment.md`、`staging_test_checklist.md`、`handover_2026-07-26.md` がある。

---

## 5. エンジンの重要な事実

ここに挙げるのは、コードを読まずに推測すると必ず間違える事項である。実装を変更する前に必ず確認すること。

### 5.1 生産能力の5段階制約と、その順序

`allocateProductionPlans`（`app/lib/v2/production/allocation.ts`）における制約の適用順序は次のとおり。

1. 原料在庫（`status === "available"` のロットのみ）
2. 工場共通処理能力
3. **冷凍・包装能力**
4. **商品別設備能力**
5. 有効労働能力

歩留まり（`saleableRecoveryRatio`）は ② と ③ のあいだで**一度だけ**適用される。

三宅さん自身がかつて「共通能力、商品別能力、凍結・包装能力」の順だと述べたことがあるが、**実際の順序は上記のとおり③と④が逆**である。この差は、冷凍・包装能力がボトルネックになる局面で結果が変わるため無視できない。

優先順位は **数字が小さいほど優先度が高い**（`production/types.ts:167`）。同順位のときは比例配分（water-fill）で解決し、`rawMaterials/waterFill.ts` の実装は「入力配列の順序には一切依存しない」。

`allocateProductionPlans` は純粋関数であり、結果のフィールド名は **`entries`** である（`allocations` ではない）。

### 5.2 実効能力 85.5% の由来

`calculateFactoryEffectiveCapacity(factory: Factory): FactoryEffectiveCapacity`（`production/capacity.ts:30`）は、内部関数 `applyRates(nominal, baseUtilizationRate, equipmentAvailabilityRate)` で公称能力に2つの係数を掛け、`roundHosoEqTons` で小数2桁に丸める。

```
baseUtilizationRate      = 0.90
equipmentAvailabilityRate = 0.95
0.90 × 0.95 = 0.855 = 85.5%
```

**補正係数はこの2つだけ**であり、1工場の5つの能力プール（共通処理・HOSO・PD・VAP・冷凍包装）すべてに一律で掛かる。`factory.status !== "active"` の場合はすべて 0 になる。

能力の正準な合成は `applyCapexCapacityToFactories(fixtures.flatMap(f => f.factories), state.capexState, state.currentPeriod)`（`runner.ts:662-663`）でおこなわれる。設備投資による能力増分はここで反映される。

### 5.3 営業人員と成約能力

`allocateMarketProduct(market, product, period, entries, basePrice, targetDemand, params)` が市場×商品ごとの成約を決める。

カバレッジ:
```
salesCoverageScore(h) = 0.15 + 0.85 × h / (h + 6)
```

成約処理能力（HOSO換算トン）:
```
processingCapacity(h) = 200 + 4800 × h / (h + 10)
```

**h = 0 でも 200トンの成約力が残る**（既存顧客による最低限の成約力という設計）。実際の値は 1人=636.36 / 2人=1,000 / 3人=1,307.69 / 4人=1,571.43。

1社あたりの上限は次の最小値:
```
min( 希望量, processingCapacity(人数), 対象需要 × 0.35, 承認済み配分上限 )
```

価格競争力:
```
priceScore = exp(-3.0 × (提示価格 - 基準価格) / 基準価格)   → [0.5, 1.6] にクランプ
```

配分は `waterFillAllocate` による比例配分で、**順序に依存しない**。

`maximumSupplierShare = 0.35` は「1社が1つの市場×商品の需要を独占できない」ための上限。これが効く局面では営業人員を増やしても成約が伸びない。実際に BAL の日本向けVAPで、4人（能力1,571.4t）を投入しながら 35%上限の 704.49t で頭打ちになり、約867トン分の能力を無駄にした事例がある。

### 5.4 営業人員の総数は増やせない

`salesForceHeadcountTotal: 18`（BAL の場合、`fixtures.ts:142`）は**ハードな上限**である。`runner.ts:522` の `validateSalesForceHeadcountBudget(d.salesPlans, f.salesForceHeadcountTotal)` が検証している。

つまり営業人員は**再配分しかできず、増員はできない**。これはゲームの中核的な制約であり、意思決定の質が問われるポイントになっている。

### 5.5 労働と遊休コスト

`quarterClose.ts:307-310`:

```
productiveRegularHeadcount = min(総配置正社員数, actuals.regularHeadcount)
idleRegularHeadcount       = max(0, actuals.regularHeadcount - productiveRegularHeadcount)
idleLaborCost              = idleRegularHeadcount × 1000
```

`regularWorkerSalaryUsdPerQuarter` は 1,000 USD/四半期。

**`actuals.regularHeadcount` はプレイヤーが提出した `workerAssignments` からそのまま来る**（`companyLabAdapter.ts:256`）。毎四半期自由に増減でき、上限バリデーションもない。そして**解雇費用も採用費用もモデル化されていない**（`WorkerLifecycleStatus` は `production/types.ts:87` に型として存在するが未使用）。

したがって「必要な人数だけ配置する」のが常に有利になる。BAL の Turn 2 では 6,000人を配置して 2,719人分しか使わず、**遊休人件費 $3,280,530** を計上している。

1人あたりの労働能力:
```
regularEfficiencyPerHeadTons(6) × 出勤率 × 技能レベル
```
BAL の場合: HOSO 6×0.95×0.85 = 4.845 t/人、PD 4.56、VAP 4.275。

### 5.6 品質エンジンの構造的な癖

```
operationalRisk = 0.35·稼働 + 0.2·残業 + 0.15·臨時工 + 0.1·複雑度 + 0.1·原料経過 + 0.1·生産立上
observedQualityScore = 85 - 30 × operationalRisk
```

ここで注意すべきは、`laborUtilizationRate = totalProduced / totalLaborCapacityAllocated`（`production/loadMetrics.ts:59`）が構造的にほぼ 1.0 になることである。その結果 `utilizationStress` は 1.0 に張り付き、**人員を削減しても品質は悪化しない**。これは意図した設計ではなく、指標の定義に由来する副作用である。

また `productionRampStress` は生産量が減少すると 0 になる。

この2点により、現在のバランスでは「人員を絞って遊休費を減らす」戦略に品質面のペナルティがほぼ無い。将来の校正対象として認識しておくこと。

### 5.7 販管費（SG&A）

`quarterClose.ts:774-778`:

```
SG&A = 8,000 × 営業人員数
     + 7,000 × 調達人員数
     + 800,000（管理固定費）
     + 100 × 販売トン数（販売物流費）
```

BAL Q2 の検証値: 144,000 + 84,000 + 800,000 + 1,237,250 = **$2,265,250**。

### 5.8 運転資本

```
arCollectionQuarters     = 1   （売掛金は翌四半期回収）
apImportPaymentQuarters  = 1   （輸入買掛は翌四半期支払）
apDomesticPaymentQuarters = 0  （国内買付は当期現金払い）
```

国内買付が即時現金払いであることが、資金繰りを厳しくする最大の要因である。BAL は Turn 2 で営業キャッシュフロー **−$56,455,122** を計上し、現金が $89.5M から $31.6M へ減少した。黒字（純利益 $9,315,379）でありながらである。

---

## 6. 歩留まりの二重計上問題（歴史的経緯）

Phase 6 の初期実装では `baseYieldRatio`（HOSO 0.92 / PD 0.80 / VAP 0.70）を置いていたが、これは**殻・頭の除去による通常の重量減を二重に計上していた**。HOSO換算トンという単位が既にその物理的減量を織り込んでいるためである。

Phase 6.1 / 6.3 で次のように分離した。

- `physicalYieldRatio`（`{ hoso: 1.0, pd: 0.54 }`）— **参考値であり換算には使わない**。`yieldConversion.ts` の `calculatePhysicalOutputTons` だけが参照し、永続化もされない。VAPには単一の物理歩留まりが存在しないため値を持たない。
- `saleableRecoveryRatio`（`{ hoso: 1.0, pd: 1.0, vap: 1.0 }`）— HOSO換算上の真の回収率。通常操業の基準値は 1.00。品質エンジンが不適合・廃棄に応じてこれを引き下げる。

換算の基準:
```
HOSO原料 100t → 冷凍HOSO 約100 物理t（1.00）
              → HLSO      約60      （0.60。商品enumに無いため値を保持しない）
              → PD        約54      （0.54）
```

同様の是正が `scenario/parameters.ts` でも行われている（旧 `hosoYieldRatio = 0.62` → `hosoEqRecoveryRatio = 1.0`）。

詳細は `docs/v2/PRODUCTION_ARCHITECTURE_v0.1.md` §6 を参照。

---

## 7. 絶対に守る禁止事項

以下は、過去に明示的な是正指示として与えられた制約である。破ると成果物が無効になる。

### 7.1 データの取り扱い

**確定した実績値を再計算して置き換えない。** Export も表示も Excel も、保存された確定値をそのまま転記する。比率や検算が必要なら Excel 数式として書き、TypeScript 側でハードコードした計算結果を出力しない。

**推測値を実績として出力しない。** エンジンは四半期単位なので、存在しない1月・2月・3月の月別実績を作ってはならない。同様に、履歴が欠けている箇所を 0 で埋めてはならない。**`NO_VALUE_TEXT = "－"`（U+FF0D）を表示する。** ゼロと欠測は意味が違う。

**「Export APIに無い」だけを理由にエンジン不足と判定しない。** 多くの場合、データはエンジンにも確定履歴にも存在していて、単に Export DTO が出力対象から除外しているだけである。まず DTO を確認する。

### 7.2 運用上の禁止

- ゲームを再実行しない
- `Test12` を初期化しない
- 永続化スキーマを変更しない
- Production へデプロイしない
- ゲームエンジンや永続化形式を拡張せずに、既存の確定履歴から Export DTO を組み立てる（拡張が本当に必要な場合のみ、根拠を示して提案する）

### 7.3 セキュリティ

`STAGING_EXPORT_TOKEN`、`STAGING_ADMIN_TOKEN`、`VERCEL_AUTOMATION_BYPASS_SECRET` は**サーバ側でのみ読み取り**、`companyLabAdminExportSource.ts` 以外では参照しない。ブラウザレスポンス、URL、ログ行、生成される Excel/ZIP のいずれにも現れてはならない。

診断ログに含めてよいのは、対象URL とエラーの name / message / cause だけである。トークン値や Authorization ヘッダの値は決して出さない。

管理者向け Export 画面・エンドポイントは Production では無効。シークレット未設定時は fail-closed。

### 7.4 スコープ分離

**会社別 Export には他社の非公開意思決定を混入させない。** これはテストで担保されている（`otherCompaniesDecisions`, `financialResults`, `financingResults`, `capexResults`, `companySummaries` の各キー、および他社固有の netIncome 値がシリアライズ結果に現れないことを assert している）。

一方、**GM用ワークブックには他社の非公開意思決定が含まれる**。凡例シートに「取扱注意」と明記してあり、プレイヤーへ配布してはならない。会社別ブックと GM ブックを同じファイルに混在させないこと。

---

## 8. 実装上の作法

### 8.1 レイヤーの責務

表示層と Export 層は**再計算をしない**。許可フィールドを明示的に列挙し、省略可能な値は `?? null` とし、内部型をそのまま spread しない。検算は Excel 数式で行う。

### 8.2 コメント規約

新しく作るファイルには、そのファイルに固有の **【禁止事項】コメント**を明示的に書く。例:

```typescript
// 【禁止事項】確定値を再計算しない。JSONの値を転記し、比率・検算のみExcel数式にする。
```

### 8.3 UI 規約

色の契約（`panelStyles.ts`）:

- 入力エリア = sky（`tone="input"`）
- 情報エリア = gray（`tone="info"`）
- amber / rose は警告・エラー専用

折りたたみはネイティブの `<details>` または `CollapsibleSection` を使う。画面が縦に長くなるため、情報エリアは既定で折りたためるようにする。

数値の増減表示で ▲▼ を使う場合は、**方向を示すだけであることを明示的にラベルする**。比率項目の前期比は「比の比」ではなく **pt差** で表示する。

### 8.4 テスト規約

`node:test` + `assert/strict`。`describe` は使わず、フラットに書く。テスト名は日本語の説明文にする。

```typescript
test("優先順位が同じ場合、配分は入力順に依存しない", async () => {
  ...
});
```

### 8.5 検証サイクル

```
npx tsc --noEmit -p .  →  npx eslint <files>  →  npm test  →  npm run build
→  commit  →  push  →  Vercel Preview が READY であることを確認
```

省略しない。特に `tsc --noEmit` は `npm test` では代替できない。

---

## 9. Test12 の現在地（2026-07-26 時点）

- Lab ID: `Test12`
- プレイヤー会社: **BAL（バランス型水産）**
- 完了ターン: Turn 1（2015Q1）、Turn 2（2015Q2）
- 現在: **Turn 3（2015Q3）の意思決定待ち**

### 9.1 BAL の Turn 2 実績（確定値）

| 項目 | 値 |
|---|---|
| 総売上 | $68,453,509 |
| 品質起因売上控除 | $261,835 |
| 純売上 | $68,191,674 |
| 売上原価合計 | $53,115,200 |
| 　うち原料費 | $36,313,308 |
| 　うち加工費 | $6,665,808 |
| 　うち労務費 | $2,719,470 |
| 　うち工場固定費 | $3,671,875 |
| 　うち手直し費 | $21,304 |
| 　うち廃棄損 | $442,905 |
| 　うち**遊休人件費** | **$3,280,530** |
| 売上総利益 | $15,076,474（22.1%） |
| 販管費 | $2,265,250 |
| 営業利益 | $12,811,224 |
| 支払利息 | $1,167,000 |
| 税引前利益 | $11,644,224 |
| 法人税 | $2,328,845 |
| **当期純利益** | **$9,315,379** |

キャッシュフロー: 営業CF **−$56,455,122**、投資CF 0、財務CF −$1,500,000。現金 $89,546,223 → **$31,591,101**。

貸借対照表（期末）: 総資産 $208,840,966、負債合計 $56,040,000、純資産 $152,800,966。買掛金は 0（国内買付が当期現金払いのため）。

信用: creditScore 73.25、Tier B。借入余力は担保ベースで拘束され **$0**（既存借入 $52,540,000 が担保価値 $14,395,173.77 を上回っているため）。財務制限条項は4項目すべて充足。

### 9.2 5社比較（Turn 2）

| 会社 | 当期純利益 | 粗利率 | 新規成約(t) | 期末約定残(t) | 品質平均 |
|---|---|---|---|---|---|
| BAL | +$9,315,379 | 22.1% | 7,127.56 | 5,981.16 | **79.15（最低）** |
| JPQ | +$5,625,531 | 20.3% | 5,601.99 | 1,086.93 | 81.29 |
| VAP | +$4,200,770 | 20.6% | 5,200 | 2,833.72 | 83.39 |
| CONSV | −$427,593 | 5.5% | 4,500.95 | 6.92 | 80.88 |
| MASS | −$13,354,591 | −86.3% | 6,979.54 | 8,335.38 | 84.31 |

MASS は大幅赤字。VAP社は現金不足（$4,877,304）が発生している。JPQ と VAP には `EQUIPMENT_CAPACITY_SHORTAGE` の理由コードが立っている。

### 9.3 BAL が Turn 3 で直面している問題

**約定残 5,981.16トン（$32,399,294.97）が2015Q3納期で残っている。** 内訳:

| 市場 | 商品 | 数量(t) | 単価 | 金額 |
|---|---|---|---|---|
| CN | HOSO | 1,129.87 | $4.04611918 | $4,571,588.68 |
| EU | PD | 798.06 | $4.94612326 | $3,947,303.13 |
| EU | VAP | 541.05 | $6.76931226 | $3,662,536.40 |
| JP | PD | 500.00 | $4.98584653 | $2,492,923.26 |
| JP | VAP | 704.49 | $6.91539615 | $4,871,827.43 |
| US | PD | 1,307.69 | $4.85863104 | $6,353,583.22 |
| US | VAP | 1,000.00 | $6.49953284 | $6,499,532.84 |

商品別合計: HOSO 1,129.87 / PD 2,605.75 / VAP 2,245.54。

**利用可能な原料は 1,650トンしかない。** 期末の原料ロット合計は 13,316.67トンだが、そのうち養殖分 8,666.67t（`growingAquaculture`）と輸入分 3,000t（`inTransitImport`）は**まだ `available` ではない**。生産に使えるのは国内買付ロットの残 1,650t のみである。この点は Turn 3 の説明資料で最初に明示すべき事項。

### 9.4 検証済みの Turn 3 推奨案

いずれもエンジンで再現確認済み。

**① 正社員配置を 6,000人 → 1,400人へ削減。** 最低必要人数は 1,330人（HOSO 233.2 + PD 571.4 + VAP 525.3）と検証済み。1,300人では VAP に 127.91t の不足が生じ、制約が「有効労働能力」になる。

損益への効果（Q3試算、再計算で確認済み）:

| 配置人数 | 営業利益 | 当期純利益 |
|---|---|---|
| 6,000人 | −$0.12M | **−$1,287,705** |
| 1,400人 | +$4.48M | **+$2,484,221** |

**② 営業18人を15行すべてに再配分。** 成約見込 7,127.6t → **10,060.94t（+41%）**。

| 商品 | JP | EU | US | CN | OTHER |
|---|---|---|---|---|---|
| VAP | 1 | 4 | 3 | 1 | 2 |
| PD | 2 | 2 | 1 | 1 | 1 |
| HOSO | 0 | 0 | 0 | 0 | 0 |

HOSO は 0人でも各200tずつ成約する（h=0 のベースライン能力）。商品別合計は VAP 5,151.85t、PD 3,909.09t、HOSO 1,000t。

**注意**: VAP の 5,151.85t は VAP 実効能力 5,130t を約22t 超過する。CN VAP を CN PD へ振り替えるのが是正案。

**③ 調達**: 国内買付を市場価格 +$0.05 で約2,665〜4,000t。養殖の放養量は縮小。輸入なし、資金調達申請なし、設備投資なし。

### 9.5 商品別の限界利益ランキング（$/t）

意思決定の優先順位付けに使える。

```
JP vap 2,896 > EU vap 2,750 > US vap 2,480 > OTHER vap 2,130 > CN vap 2,112
> JP pd 1,417 > EU pd 1,377 > US pd 1,289 > CN pd 1,194 > OTHER pd 1,182
> JP hoso 829 > EU hoso 809 > US hoso 768 > CN hoso 727 > OTHER hoso 706
```

VAP は PD の約2倍、HOSO の約3倍の限界利益がある。ただし VAP は設備能力と 35%シェア上限の両方で制約されやすい。

---

## 10. 納品済み成果物

この開発の過程で、アプリ本体とは別に次の支援成果物を納品している。

| 成果物 | 内容 |
|---|---|
| `Test12_BAL_経営状況データブック2015.xlsx` | BAL の会社別データブック |
| `test12_turn1_gm_databook.xlsx` | GM用データブック（**取扱注意**） |
| `BAL_Test12_turn2_分析ブック.xlsx` | Turn 2 の BAL 分析ブック（13シート） |
| Turn 3 意思決定シート・ブリーフィング | 意思決定支援資料 |
| `docs/capacity_forecast_report_2026-07-25.md` | 加工能力予測の改善報告 |
| `docs/handover_2026-07-26.md` | 引き継ぎ書（本書の前身） |

`BAL_Test12_turn2_分析ブック.xlsx` の13シート構成: 凡例 / PL / BS / CF / 借入・信用 / 受注契約 / Q3受注残 / 営業計画vs成約 / 生産 / 原料ロット / 品質 / 加工能力 / 提出内容。

Excel 生成時の規約は本書 §10 の以下の記述および xlsx スキルに従う。要点は、**確定値は転記のみ・比率と検算だけを Excel 数式にする**、フォントは Arial、入力セルは青字、前提値は黄色塗り、生成後に必ず `recalc.py` を実行してエラー 0 を確認する、`XLOOKUP`/`FILTER`/`SORT`/`UNIQUE`/`SEQUENCE` は使わない、`TEXTJOIN`/`CONCAT`/`IFS`/`SWITCH`/`MAXIFS`/`MINIFS` には `_xlfn.` プレフィックスを付ける、である。

---

## 11. 未解決事項・既知の制約

**保存されていない値**（推測で埋めてはならない）:

- `aiProposal` / `diffFromAiProposal` — `app/lib/v2/companyLab/persistence/types.ts:165-166` に型はあるが、`companyLabQuarterFlowService.ts` の `entryDraft` が値を代入していない。
- `RawMaterialsQuarterRecord.harvestResults` — `CompanyQuarterRecord` へ引き継がれていない。

**バランス上の既知の歪み**:

- 人員の解雇・採用コストが未モデル化のため、毎期の人員増減が無コストで可能になっている。
- `laborUtilizationRate` の定義により品質の稼働ストレスが 1.0 に張り付き、人員削減に品質ペナルティが無い。
- `qualityControlEquipment` と `environmentalEquipment` は生産能力を増やさず、品質スコアや事故率にも接続されていない。つまり現時点では減価償却と保守費だけが発生し、操業上の便益がゼロである。プレイヤーへ安易に推奨してはならない投資である（`capex/parameters.ts` のコメントに明記）。
- Redis が Production と Staging で共有されている（無料プラン制約）。

**Turn 3 資料の注意点**: 「Q3に13,316.67tの原料が使える」と書くのは誤り。`forecast.availableRawMaterialTons` は **1,650** である。養殖分と輸入分はまだ `available` ステータスではない。

---

## 12. 依頼者とのやり取りで学んだこと

技術的な事項ではないが、成果物の質を左右するので記録しておく。

三宅さんは非技術者だが、**経営判断に必要な情報の粒度には非常に厳しい**。「これだけのデータで経営判断ができると思っているのですか？」という指摘を受けたことがある。要約された数字ではなく、成約明細・ロット明細・市場別商品別の内訳といった**明細レベルのデータ**を求めている。

「Export API に無いのでエンジンにデータが存在しません」と回答して誤りだったことがある。データはエンジンにも履歴にも存在し、DTO が除外していただけだった。**「無い」と結論する前に必ず一次情報（型定義・永続化スキーマ・確定履歴の実データ）を確認する。**

三宅さん自身の記述にも事実誤認が含まれることがある（能力制約の順序など）。その場合は**指摘を避けず、実際の順序を数値付きで明示する**のが正しい対応である。実際にそうして受け入れられている。

過去に「VAPの処理可能量が約810t」と固定値のように述べたことがあるが、これは VAP が優先順位3である場合の条件付きの値であった。**条件付きの値を固定値として提示してはならない。**

成果物を作ったら、納品前に自分で検算する。Turn 3 のワークブックでは、VAP の契約合計 5,151.85t が実効能力 5,130t を約22t 超過していること、および「Q2実績(t)」というラベルの列が実際には Q2 の希望量だったことを、納品前の検証で発見して修正した。この検証工程は省略しない。

---

## 付録A. よく使うコマンド

```bash
# クローンして依存インストール
git clone https://github.com/tomiyake1972/vietnam-shrimp-game.git /tmp/year1_clone
cd /tmp/year1_clone && npm install

# 検証フルセット
cd /tmp/year1_clone && npx tsc --noEmit -p .
cd /tmp/year1_clone && npx eslint app/lib/v2/production/allocation.ts
cd /tmp/year1_clone && npm test
cd /tmp/year1_clone && npm run build

# push（トークンをマスク）
cd /tmp/year1_clone && git push origin feature/v2-export-download-ui 2>&1 | sed -E 's#https://[^@]*@#https://#g'

# バイナリ扱いされるファイルの検索
cd /tmp/year1_clone && grep -a "salesForceHeadcountTotal" app/lib/v2/companyLab/adminExport/companyLabAdminExcelBuilder.ts

# Excel 生成後の必須検算
python3 /root/.claude/skills/xlsx/scripts/recalc.py /tmp/deliver/foo.xlsx
```

## 付録B. 5社の初期設定サマリ

出典 `app/lib/v2/companyLab/fixtures.ts`。詳細は ShrimpX-KB-03 パラメータ仕様書。

| 会社 | 表示名 | 共通前処理 | HOSO | PD | VAP | 冷凍包装 | 正社員 | 技能(h/p/v) | 出勤率 | 養殖能力 | 営業上限 | 調達上限 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BAL | バランス型水産 | 22,000 | 10,000 | 8,000 | 6,000 | 20,000 | 6,000 | .85/.80/.75 | 0.95 | 15,000 | 18 | 12 |
| MASS | 大量生産・価格競争水産 | 36,000 | 30,000 | 6,000 | 2,000 | 34,000 | 9,000 | .90/.60/.50 | 0.95 | 18,000 | 22 | 20 |
| JPQ | 日本・品質志向水産 | 16,000 | 4,000 | 11,000 | 3,000 | 15,000 | 5,500 | .60/.95/.70 | 0.95 | 9,000 | 14 | 10 |
| VAP | VAP特化水産 | 18,000 | 3,000 | 4,000 | 12,000 | 17,000 | 6,500 | .50/.65/.95 | 0.95 | 10,000 | 14 | 10 |
| CONSV | 保守的・財務慎重水産 | 15,000 | 8,000 | 6,000 | 4,000 | 14,000 | 4,500 | .80/.75/.70 | **0.97** | 10,000 | 10 | 8 |

能力はすべて公称値（HOSO換算トン/四半期）。実効能力はこれに 0.855 を掛けた値になる。

---

*本書は ShrimpX V2 Company Lab の開発引き継ぎ資料である。記載されたすべての数値・関数名・ファイルパスは、2026-07-26 時点のリポジトリ `feature/v2-export-download-ui` ブランチのソースコードから直接確認したものであり、推測による記述を含まない。*
