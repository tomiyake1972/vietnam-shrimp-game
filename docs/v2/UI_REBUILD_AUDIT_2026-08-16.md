# ShrimpX V2 UI再構築 — 実装前 技術監査レポート

作成日: 2026-08-16
作業ブランチ: `claude/shrimpx-v2-ui-audit-aypqr4`（develop/v2 と同一HEADから作成）
対象: 情報画面（Sales / Management Intelligence）と入力画面（Sales Planning / Decision Studio）の再構築

本レポートは**コードを一切変更しない**現行実装の監査である（本ドキュメントの追加のみ）。

---

## 1. repository / branch / HEAD

| 項目 | 実測値 |
|---|---|
| remote | `https://github.com/tomiyake1972/vietnam-shrimp-game` (origin, fetch/push とも) |
| 現在branch | `claude/shrimpx-v2-ui-audit-aypqr4` |
| HEAD | `90d67bc` `fix(company-lab): AI経営説明のクライアント側20秒timeoutが原因の誤った失敗表示を修正し、経過秒数表示を追加` |
| develop/v2 HEAD | `90d67bc`（**現在branchと同一。差分0**） |
| working tree | clean |
| 遠隔branch総数 | 51本（後述 §11） |
| open PR | #5 `feature/v2-sales-force-saturation-calibration` → `main`（**営業能力曲線の再校正。§11で詳述**） |

技術構成（package.json 実測）:

- Next.js `16.2.10` / React `19.2.4` / TypeScript `^5` / Tailwind CSS `v4`（@tailwindcss/postcss）
- zod `^4.4.3`, `@upstash/redis`, `@anthropic-ai/sdk`, exceljs, jszip
- App Router、`app/` 直下がソースルート（`src/` なし）。パスalias `@/*`

検証コマンドと**基準線の実測結果**（`npm ci` 後に本ブランチで実行）:

| コマンド | 結果 |
|---|---|
| `npx tsc --noEmit` | **エラー0**（exit 0） |
| `npm test`（tsx --test） | **2,128 tests / 2,128 pass / 0 fail**（57.6秒） |
| `npm run lint` | eslint（`eslint.config.mjs`, eslint-config-next） |
| `npm run build` | next build |

テスト対象glob: `app/lib/**/__tests__/**/*.test.ts`, `app/v2/**/__tests__/**/*.test.ts`, `app/api/**/__tests__/**/*.test.ts`（合計192ファイル）。
**UI層（app/v2）のテストは「view-model の純粋関数テスト」形式**（Reactレンダリングテストは存在しない）。新規UIも同じ形式に合わせるべき。

---

## 2. 現行 player UI の route / component 構造

```
/v2/company-lab/play/[labId]              ← プレイヤーの唯一の意思決定画面
  page.tsx                (Server Component。loadPlayerScreenViewModel を呼ぶだけ)
  PlayerScreenClient.tsx  (634行, "use client"。draft の useState を保持する唯一の場所)
  actions.ts              (Server Actions: saveDraft / submitDraft / withdrawDraft / processQuarter / fetchAiExplanation)

  _lib/viewModel.ts       (298行。サーバー専用。巨大snapshot → 画面用最小データへの絞り込み地点)
  _lib/financialViewSelectors.ts (record から companyId 抽出)
  _lib/uiDependencies.ts / aiExplanationUiDependencies.ts
```

他のroute: `/v2/company-lab`(GM/管理), `/v2/company-lab/play`(ラボ一覧), `/play/new`, `/play/login`, `/play/export/[labId]`, `/v2/industry-lab`。

`PlayerScreenClient.tsx` の縦の並び（現状）:

1. ラボ情報ヘッダ（turn / revision / phaseバッジ）
2. 「自社の状態（turn開始時点）」← `OpeningCompanyStatePanel`（**現行の唯一の情報画面相当**）
3. 「AIが見ている市場情報」← `AiMarketInfoPanel`
4. 「Standard AIの提案」（Claude生成の説明文 + 判断ログ）
5. **「意思決定編集」← `DecisionEditor`（948行。全意思決定が1コンポーネントに同居）**
6. 保存 / 提出ボタン、四半期処理ボタン
7. 直近四半期結果（`MarketPanel` / `ResultsPanel` / `FinancialResultsSection`）
8. 履歴

`DecisionEditor.tsx` 内の意思決定セクション（すべて `CollapsibleSection` で `tone="input"` or `"info"`）:

| セクション | 行 | tone |
|---|---|---|
| 現在の入力に対する警告 | 274 | info |
| 凍結・包装処理能力／保管能力 | 296 | info |
| 工場の加工能力 | 316 | info |
| 設備投資 | 337 | input |
| **販売計画（市場×商品）** | **402** | **input** |
| **営業人員の追加採用・減員** | **502** | **input** |
| 国内原料買付 / 輸入 / 養殖 / 生産計画 / ワーカー / 資金調達 | 以降 | input |

**すでに存在する「情報 vs 入力」の色コントラクト**（`components/panelStyles.ts`）:

- 入力エリア = sky（青）系 / 情報エリア = gray（灰）系 の**2系統のみ**と明文化済み
- `INPUT_CONTROL_CLASS`（入力欄）、`INFO_VALUE_CLASS`（読むだけの数値。意図的に彩度を落とす）、`NO_VALUE_TEXT = "－"`（0で埋めない）
- **禁止事項として「コンポーネント内で色クラスを直書きしない」が明記されている**

→ §4「READ ONLY / EDITABLE を一目で区別」の要件は、**新しい色体系を作らず、この既存コントラクトを拡張する**のが正しい（例: `AreaTone` に READ ONLY バッジと Draft バッジを追加する）。

---

## 3. Sales 関連 decision / state / function のファイルマップ

### 3-1. 型・状態の source

| 対象 | source（唯一の正） |
|---|---|
| 意思決定1式 | `app/lib/v2/companyLab/types.ts` `CompanyDecisionInput` |
| 販売計画1行 | `app/lib/v2/sales/types.ts` `CompanySalesPlanEntry`（market × product × desiredQuantity × priceAdjustment × salesForceHeadcount） |
| 会社の当期state | `companyLab/types.ts` `CompanyOwnState`（contracts / rawMaterialLots / finishedGoodsLots / financeState / financingState / capexState / workforceState / **salesForceHiringState** / quality・trust各種） |
| 営業人員の実在数 | `companyLab/salesForceHiring.ts` `CompanySalesForceHiringState.headcount`（**fixture.salesForceHeadcountTotal は静的な基準値であり、当期の配分可能人数ではない**） |
| 公開市場情報 | `companyLab/types.ts` `PublicMarketInfo`（lastMarketResult / vietnamDomesticPriorPrice / lifecycle / supplyPressure） |
| draft（画面編集用プレーン値） | `app/v2/company-lab/decisionDraft.ts` `CompanyDecisionDraft`（計算ロジックを持たない型変換層と明記） |

### 3-2. 項目別のマップ（ご指示 §2-B への回答）

| 項目 | state source | decision source | 計算関数（エンジン） | selector / view-model | UI表示箇所 |
|---|---|---|---|---|---|
| **市場別営業人数** | `ownState.salesForceHiringState.headcount`（総数） | `draft.salesPlans[].salesForceHeadcount`（市場×商品行だが**市場単位で同値を共有**） | `sales/salesForce.ts` `validateSalesForceHeadcountBudget` | `decisionDraft.ts` `summarizeSalesForceAllocation` / `syncMarketSalesForceHeadcount` | DecisionEditor L402〜492 |
| **営業員採用** | 同上 | `draft.salesForceHireCount` | `companyLab/salesForceHiring.ts` `deriveNextSalesForceHiringState`（**当期は配分可能人数に加算されない。翌期から**） | `decisionDraft.ts` `summarizeSalesForceHiring` | DecisionEditor L502〜 |
| **営業員削減** | 同上 | `draft.salesForceLayoffCount` | `computeEffectiveSalesForceLayoffCount`（現人数で頭打ち）＋ `finance/quarterClose.ts` L941, L1624（退職金＝**四半期給与×2**） | 同上（`severanceCostUsd`） | 同上 |
| **市場×商品別 販売希望数量** | — | `draft.salesPlans[].desiredQuantity` | `sales/marketEffort.ts` `applyMarketSalesEffortCapacity`（能力超過時に**市場内全商品を同一係数で比例縮小**） | **なし（未実装）** | DecisionEditor L451（入力欄のみ。合計表示なし） |
| **販売価格 / 価格調整** | 基準価格 = `sales/marketAdapter.ts` `deriveVietnamBasePrices` / `deriveVietnamMarketReferencePrices` | `draft.salesPlans[].priceAdjustmentUsdPerHosoEqKg` | askPrice = basePrice + adjustment（`sales/allocation.ts`） | **なし（提示価格の絶対額が画面に出ない）** | DecisionEditor L463（調整額のみ） |
| **Standard AI default** | — | `standardAi/policy.ts` `generateStandardAiDecisionWithDiagnostics` → `standardAi/decision/sales.ts` `buildStandardAiSalesPlans` | 同左（`desiredByProduct` / `realisticSalesByProduct` / `salesWishByMarketProduct` を返す） | `viewModel.ts` `coerceDraftOrRebuild` → `buildInitialDraft` | **AI値はdraftの初期値として「溶け込む」だけで、AI値とプレイヤー値の対比表示がない** |
| **sales effort（営業工数）** | — | — | `sales/marketEffort.ts` `salesEffortWeightedQuantity`（HOSO×1.0 + PD×1.2 + VAP×3.0）、`computeMarketSalesEffort` | **なし** | **表示なし** |
| **営業能力** | — | — | `sales/salesForce.ts` `processingCapacity(h)` = 200 + 4800·h/(h+10)、`salesCoverageScore(h)` | `companyLab/openingStateSummary.ts` `computeSalesForceCapacitySummary`（限界増分つき） | OpeningCompanyStatePanel（**会社合計のみ。市場別ではない**） |
| **実成約量** | `record.salesRecord.allocations[].companies[].allocatedQuantity` | — | `sales/allocation.ts` `allocateMarketProduct` / `computeCompetitivenessWeight` | `dashboardViewModel.ts` `buildCompetitivenessExplanationRows` | ResultsPanel（会社合計 `newContractedQuantity` のみ）、品質ダッシュボード |
| **受注残** | `ownState.contracts[]`（status open / partiallyFulfilled / overdue） | — | `sales/backlog.ts` `applyFulfillments` / `updateContractStatusesForQuarterEnd` | **`openingStateSummary.ts` `computeBacklogByMarketProduct`（市場×商品別・最短納期つき。既に存在）** | OpeningCompanyStatePanel |

### 3-3. 保存 / 提出処理の経路

```
PlayerScreenClient (useState draft)
  → actions.ts saveDraftAction/submitDraftAction   [Server Action]
  → app/api/v2/company-labs/_lib/*                 [Application Service]
  → companyLab/application/companyLabQuarterFlowService.ts
  → persistence/repository.ts → redis
processQuarterAction → advanceCompanyLabQuarter（companyLab/runner.ts L709）
```

`viewModel.ts` の `key` によるstateリセット（`labId:turn:revision:phase:draftUpdatedAt`）が「サーバーの正 vs 編集中ローカル値」の同期方式。**新画面もこの方式を踏襲しなければならない**（別のstate保持方式を導入しない）。

---

## 4. 情報画面（Sales / Management Intelligence）に必要なデータの取得元

**すべて既存の `viewModel.ts` が既に読み込んでいる `ownState` / `publicInfo` / `latestEntry.record` から取得可能**（Redisへの追加アクセスは1件も不要）。

| ご指示の項目 | 取得元 | 既存の集計関数 | 状態 |
|---|---|---|---|
| 国別×商品別 受注残 | `ownState.contracts` | `openingStateSummary.computeBacklogByMarketProduct` | **そのまま使える** |
| 前回 市場別営業人数 | `latestEntry.record.decisions[playerCompanyId].salesPlans[].salesForceHeadcount` | なし | **selector新設が必要**（データは存在） |
| 前回 市場×商品別 販売希望数量 | 同上 `.desiredQuantity` | なし | 同上 |
| 前回 市場×商品別 実成約量 | `record.salesRecord.allocations[].companies[]`（`allocatedQuantity`） | なし | 同上 |
| 前回 販売価格 | 同上 `askPrice` | なし | 同上 |
| 営業効率（工数制約の発動） | `record.salesRecord.salesEffortAdjustments[]`（`scaleFactor`・`capacityHosoEqTons`） | なし | 同上（**エンジンが既に記録済み**） |
| 現在販売相場 | `publicInfo.lastMarketResult`（hosoPrices / vietnamDomestic / pdPremium / vapPremium） | `marketPriceViewModel.ts` `buildDestinationMarketPriceRows` / `buildOriginCountryPriceRows` / `buildMarketIndicatorRows` | **そのまま使える** |
| 市場需要 | `record.salesRecord.allocations[].targetDemand`（市場×商品の対象需要）、`marketResult.worldDemand/worldSupply` | なし（targetDemand側） | selector新設 |
| CTS等 | **`CTS` という指標はコードベースに存在しない**（全文検索でヒット0） | 近似指標: `record.consumerMarketRecords[]`（`inventoryCoverageMonths` / `targetCoverageMonths` / `marketPhase` / `purchasePressureIndex` / `inventoryTightnessIndex`） | **要確認事項（§9-Q1）** |
| FG在庫 HOSO/PD/VAP | `ownState.finishedGoodsLots[]` | `investmentPlanningViewModel` 内で集計済み | 使える |
| 原料在庫 | `ownState.rawMaterialLots`（status=available） | `openingStateSummary.groupRawMaterialLotsByAvailability` | **そのまま使える** |
| 当期/翌期 原料入荷予定 | 同 lots の `availableFromPeriod` × `status`（`inTransitImport` / `growingAquaculture`）× `source` | `groupRawMaterialLotsByAvailability`（**source別の内訳は未対応**） | 拡張が必要（薄い） |
| Cash | `ownState.financeState.cash` | `openingStateSummary.computeOpeningBalanceSheetSummary` | **そのまま使える** |
| Debt | `financeState.shortTermLoans/longTermLoans` + `financingState.loanPortfolio` | 同上（不整合検算 `loanPortfolioMismatchUsd` つき） | 同上 |
| Borrowing headroom | `latestEntry.record.financingResults[].borrowingCapacity.availableAdditionalCapacityUsd` | `financialViewSelectors.extractCompanyFinancingResult` | **前期末の確定値として使える**（当期分の再計算はしない。§9-Q2） |
| 前期 Cash Flow | `record.financialResults[].cashFlow`（operating/investing/financing/netCashChange/opening/closingCash） | `financialViewSelectors.extractCompanyFinancialResult` | **そのまま使える** |
| 工場能力 | `fixture.factories` + `ownState.capexState` | `processingCapacityViewModel.buildCompanyProcessingCapacityViewModel`（**完成済み投資の増加分を含む、エンジンと同一の導出**） | **そのまま使える** |
| Worker | `ownState.workforceState` | `investmentPlanningViewModel` `workforceRows` | **そのまま使える** |
| 進行中投資 | `ownState.capexState.portfolio.projects` | `capexViewModel.buildCapexPortfolioViewModel` | **そのまま使える** |
| AI briefing | `viewModel.aiProposalDiagnostics`（Standard AI自身の理由コード）＋ Claude生成レポート（`fetchAiExplanationAction`） | 既存 | **そのまま使える。ただしAI値として明示すること** |

---

## 5. Sales Planning 入力画面に必要なデータの取得元

| 画面要素 | 取得元 | 備考 |
|---|---|---|
| A. Current（市場別 現行営業人数） | **前期の `record.decisions[].salesPlans[].salesForceHeadcount`**（市場単位で重複排除） | 「現在の配置」を保持する専用stateはエンジンに無い。前期の配置が実質的なCurrent |
| A. Planned | `draft.salesPlans[].salesForceHeadcount` | `syncMarketSalesForceHeadcount` で市場内同期（既存関数） |
| A. Reference Required | `sales/marketEffort.ts` `computeMarketSalesEffort` の逆算（工数需要 → 必要人数） | **`processingCapacity(h)` を h について解く逆関数がエンジンに無い（§9-Q3）** |
| A. Delta | Planned − Reference Required | 画面側の引き算のみ |
| B. Current headcount | `ownState.salesForceHiringState.headcount` | fixture値ではない |
| B. New hires / Reductions / Next-quarter | `draft.salesForceHireCount` / `salesForceLayoffCount` / `summarizeSalesForceHiring().nextQuarterHeadcount` | **既存関数がすべて計算済み** |
| B. 採用費 | **エンジンに存在しない**（`salesForceHiring.ts` に「採用一時費用係数は今回追加しない」と明記） | **画面で固定値を作ってはならない → 「採用一時費用なし」と明示表示する（§9-Q4）** |
| B. salary | `FINANCE_PARAMETERS_V1.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter` = **$8,000/人/四半期** | パラメータから取得 |
| B. severance | `summarizeSalesForceHiring().severanceCostUsd` = 実減員数 × 2四半期 × salary | 既存関数 |
| C. AI Default Qty | `buildStandardAiSalesPlans` の出力（市場×商品） | **現在はdraft初期値に溶けており、別枠で保持されていない（§7で新設）** |
| C. Player Planned Qty | `draft.salesPlans[].desiredQuantity` | |
| C. Price / Price Adjustment | 基準価格 `deriveVietnamMarketReferencePrices(marketResult)` ＋ `draft...priceAdjustment` | **提示価格の絶対額を表示できる（現在は未表示）** |
| D. market total / product total / total | `draft.salesPlans` の単純合計 | 純粋な派生値 |
| D. market mix / product mix | 同上の比率 | 同上 |
| D. sales effort | `salesEffortWeightedQuantity(qtyByProduct, SALES_PARAMETERS_V1)` | **エンジン関数をそのまま呼ぶ** |
| D. reference required salesperson count | §9-Q3 参照 | |
| D. assigned vs required delta | 上記の差 | |
| D. Expected Contract Range | **決定論的には計算不能**（成約は他4社の非公開計画に依存する `allocateMarketProduct` の結果） | **AI ESTIMATE表記が必須。§9-Q5** |
| §7 Production Preview（当期/翌期原料入荷・FG・backlog・商品別合計） | §4 の各行と同じsource | 表示のみ |
| §8 Impact Bar（Raw Requirement） | `rawMaterials/requirements.ts` `summarizeRawMaterialRequirements` | **HOSO換算1:1（歩留まり換算なし）＝ご指示どおり** |
| §8 Impact Bar（Worker Constraint） | `investmentPlanningViewModel` `workforceRows`（必要Worker vs 現在Worker） | 既存 |
| §8 Impact Bar（Approx Cash-out） | capex初回支払 `capexDraftThisQuarterPaymentUsd`（DecisionEditor L251に既存）＋ 原料買付 ＋ 退職金 | **Projected Ending Cash は表示しない（ご指示どおり）** |

---

## 6. 「Input model.xlsx」型の自動計算のうち、既存関数で再利用可能なもの

**UI独自の計算式を1つも作らずに済む**（以下はすべて既存の pure function）:

| 計算 | 既存関数 | 場所 |
|---|---|---|
| 営業工数換算数量（HOSO+1.2PD+3.0VAP） | `salesEffortWeightedQuantity` | `sales/marketEffort.ts` |
| 市場別 営業能力と比例縮小 | `computeMarketSalesEffort` | 同上 |
| 営業人員の市場別配分（最大剰余法） | `allocateHeadcountAcrossMarkets` | 同上 |
| 営業処理能力 C(h) | `processingCapacity` | `sales/salesForce.ts` |
| 営業カバレッジ | `salesCoverageScore` | 同上 |
| 営業能力サマリー（限界増分つき） | `computeSalesForceCapacitySummary` | `companyLab/openingStateSummary.ts` |
| 営業配分の合計・超過判定 | `summarizeSalesForceAllocation` | `decisionDraft.ts` |
| 採用・減員・退職金プレビュー | `summarizeSalesForceHiring` | 同上 |
| 市場×商品別 受注残 | `computeBacklogByMarketProduct` | `openingStateSummary.ts` |
| 原料在庫の利用可能時期別グルーピング | `groupRawMaterialLotsByAvailability` | 同上 |
| 期首BS（Cash/Debt/自己資本） | `computeOpeningBalanceSheetSummary` | 同上 |
| 工場能力（名目/有効） | `computeFactoryCapacitySummaries` / `calculateFactoryEffectiveCapacity` | 同上 / `production/capacity.ts` |
| 工場能力（完成投資を含む現時点＋追加中） | `buildCompanyProcessingCapacityViewModel` | `processingCapacityViewModel.ts` |
| 生産処理見込み（優先度反映） | `buildCompanyProcessingForecast` | `processingForecastViewModel.ts` |
| 必要Worker・スペース・警告 | `buildCompanyInvestmentPlanningViewModel` | `investmentPlanningViewModel.ts` |
| 必要原料量（約定残から） | `summarizeRawMaterialRequirements` | `rawMaterials/requirements.ts` |
| 市場価格の各種行 | `buildDestinationMarketPriceRows` 他 | `marketPriceViewModel.ts` |
| 提示価格の基準 | `deriveVietnamBasePrices` / `deriveVietnamMarketReferencePrices` | `sales/marketAdapter.ts` |
| draft → エンジン入力 | `buildDecisionInputFromDraft` | `decisionDraft.ts` |

**重要な確認（ご指示 §3「数量単位」）**: エンジンは既にご指示どおりの設計になっている。
`production/yieldConversion.ts` の冒頭に「HOSO換算という単位変換は殻・頭の除去を既に織り込んでいるため、物理歩留まりをHOSO換算数量へさらに掛けてはならない（二重計上になる）」と明記され、`calculatePhysicalOutputTons`（PD÷0.54相当）は**参考情報専用・非永続**で、契約履行・在庫・能力判定のいずれにも使われていない。
→ **新UIはこの関数を呼ばない**だけでご指示を満たす。エンジン変更は不要。

---

## 7. 新しく必要になる selector / view-model（すべて UI/view-model 層で完結）

いずれも `app/v2/company-lab/` 配下の**純粋関数**として新設し、React component 内に計算を書かない。

| # | 新設ファイル（案） | 内容 | 依存 |
|---|---|---|---|
| S1 | `salesIntelligenceViewModel.ts` | 前期の 市場別営業人数 / 市場×商品 希望量・成約量・askPrice / 工数制約の発動を、`CompanyQuarterRecord` から抽出する（**転記と集計のみ**） | record.decisions, record.salesRecord |
| S2 | `salesPlanTotalsViewModel.ts` | draft から market total / product total / grand total / market mix / product mix | draft のみ |
| S3 | `salesEffortViewModel.ts` | 市場別の 工数需要・C(h)・充足率・不足工数を **`salesEffortWeightedQuantity` + `computeMarketSalesEffort` を呼んで**組み立てる | sales/marketEffort.ts |
| S4 | `salesAiDefaultViewModel.ts` | Standard AI の提案値（市場×商品の Qty / priceAdjustment / headcount）を**draftとは別枠で**保持し、Player値との差分を出す | standardAi 出力 |
| S5 | `askPriceViewModel.ts` | 基準価格 + 調整額 → 提示価格の絶対額、基準比% | sales/marketAdapter.ts |
| S6 | `rawMaterialIncomingViewModel.ts` | 当期/翌期の入荷予定を **source別**（domestic / import / aquaculture）に内訳表示 | ownState.rawMaterialLots |
| S7 | `decisionImpactBarViewModel.ts` | Planned Sales / mix / Raw Requirement / Worker Constraint / Approx Cash-out / Bottleneck（**Projected Ending Cash は含めない**） | S2,S3 + 既存planning VM |
| S8 | `viewModel.ts` への追加フィールド | `previousQuarterSales`（S1の入力）、`aiDefaultSalesPlans`（S4の入力）。**Redisアクセスは増えない**（`latestEntry` は既に読み込み済み） | 既存 |

新規 component（案）:

- `app/v2/company-lab/play/[labId]/intelligence/`（READ ONLYページ）＋ `components/intelligence/*.tsx`
- `components/sales-planning/*.tsx`（EDITABLEセクション群）
- `components/ReadOnlyBadge.tsx` / `DraftStatusBadge.tsx` / `DecisionImpactBar.tsx`
- `panelStyles.ts` に READ ONLY / Draft バッジのクラス定数を**追加**（色コントラクトの拡張。直書きしない）

---

## 8. game engine 変更なしで実現できる範囲

**ご指示 §5（Sales Intelligence）・§6（Sales Planning）・§7（Production Preview）・§8（Impact Bar）のほぼ全項目が、engine変更ゼロで実現可能**。理由:

- 必要な数値はすべて `CompanyOwnState` / `PublicMarketInfo` / `CompanyQuarterRecord` に**既に存在**する
- 集計関数の多くが `openingStateSummary.ts` / `*ViewModel.ts` に**既に存在**する
- 営業人員が「市場単位で共有される」というご指示の前提を、**エンジンが既に強制している**（`validateSalesForceHeadcountBudget` / `applyMarketSalesEffortCapacity` が同一市場内の人数不一致をエラーにする）
- HOSO換算1:1・歩留まり換算なしという前提も**エンジンが既に採用済み**

engine変更なしで**できないのは以下3点のみ**（→ §9）。

---

## 9. engine 変更が必要そうな項目 / 確認が必要な項目

いずれも**私の判断では変更せず、ご指示を仰ぐ**。

| # | 項目 | 状況 | 私の推奨 |
|---|---|---|---|
| Q1 | **CTS** | コードベースに該当指標が存在しない（検索ヒット0） | CTSの定義をご教示ください。`consumerMarketRecords` の `inventoryCoverageMonths`（在庫月数）/ `marketPhase`（tight/restocking/destocking/balanced）が最も近い。**代替表示でよければengine変更不要** |
| Q2 | **Borrowing headroom の当期値** | `computeBorrowingCapacity` は `financing/liquidityClose.ts` が四半期処理中に呼ぶ設計で、**期首時点の値は保存されていない**。表示できるのは「前期末の確定値」 | 前期末値を「前期末時点」と明記して表示する（**engine変更不要**）。当期値を出すには期首でも同関数を呼ぶ配線が必要＝engine/service層の変更 |
| Q3 | **Reference Required salesperson count** | `processingCapacity(h) = 200 + M·h/(h+k)` の**逆関数がエンジンに無い** | 数学的逆関数（`h = k·(需要−200)/(M−(需要−200))` の切り上げ）はUI側の純粋関数として書けるが、**同じ曲線の式を2箇所に持つことになる**。`sales/salesForce.ts` に `requiredHeadcountForCapacity()` を**追記**するのが正しい（既存関数の変更ではなく追加。振る舞い変更ゼロ）。→ **要許可（共有coreファイルへの追記のため）** |
| Q4 | **採用費** | エンジンに採用一時費用が存在しない（`salesForceHiring.ts` に「今回追加しない」と明記）。severanceのみ存在 | UIで固定値を捏造しない。「採用一時費用: 設定なし（給与は翌期から発生）」と明示。**engine変更不要** |
| Q5 | **Expected Contract Range** | 成約量は他4社の非公開計画に依存する `allocateMarketProduct` の結果であり、**自社情報だけでは決定論的に計算不能** | `AI ESTIMATE` バッジ＋Confidence 表記で提示。根拠として決定論的に出せるのは `targetDemand × maximumSupplierShare(0.35)` の**上限**と `competitivenessBreakdown`（前期実績）まで。**engine変更不要** |
| Q6 | **「Current 営業人数」の正式なsource** | 「市場別の現在の配置」を保持する専用stateが無く、前期decisionsから読むしかない（turn1では存在しない） | turn1は「－」表示（0で埋めない）。**engine変更不要** |

---

## 10. 想定変更ファイル一覧

### 新規作成（競合リスク低）

```
app/v2/company-lab/salesIntelligenceViewModel.ts
app/v2/company-lab/salesPlanTotalsViewModel.ts
app/v2/company-lab/salesEffortViewModel.ts
app/v2/company-lab/salesAiDefaultViewModel.ts
app/v2/company-lab/askPriceViewModel.ts
app/v2/company-lab/rawMaterialIncomingViewModel.ts
app/v2/company-lab/decisionImpactBarViewModel.ts
app/v2/company-lab/components/intelligence/*.tsx        （READ ONLY パネル群）
app/v2/company-lab/components/sales-planning/*.tsx      （EDITABLE セクション群）
app/v2/company-lab/components/DecisionImpactBar.tsx
app/v2/company-lab/play/[labId]/intelligence/page.tsx   （情報画面ルート・新設する場合）
app/v2/company-lab/__tests__/*.test.ts                  （新VMの単体テスト）
```

### 既存ファイルの変更（競合リスク**高**）

```
app/v2/company-lab/play/_lib/viewModel.ts              ← previousQuarterSales / aiDefaultSalesPlans を追加
app/v2/company-lab/play/[labId]/PlayerScreenClient.tsx ← 画面構成の変更
app/v2/company-lab/components/DecisionEditor.tsx       ← 販売セクションの切り出し
app/v2/company-lab/components/panelStyles.ts           ← READ ONLY / Draft バッジ定数の追加
app/v2/company-lab/decisionDraft.ts                    ← （変更しない方針。必要なら要相談）
```

### 触らないファイル（engine core）

```
app/lib/v2/sales/**            （Q3の requiredHeadcountForCapacity 追記のみ要許可）
app/lib/v2/companyLab/runner.ts, types.ts, salesForceHiring.ts
app/lib/v2/finance/**, financing/**, production/**, rawMaterials/**, market/**
```

---

## 11. 他Claudeと競合しそうなファイル ⚠️ **最重要**

### 11-1. `feature/v2-32q-management-console`（**本日 11:58 に更新。稼働中**）

develop/v2 より **169コミット先行**（develop/v2 のHEADを含む＝分岐ではなく前進）、**517ファイル / +142,555行**。
**私の担当領域とほぼ完全に重複している**:

| そのbranchで既に作られているもの | 私の担当との関係 |
|---|---|
| `app/v2/company-lab/play/_lib/openingInfoViewModel.ts` | **§5 Sales Intelligence の情報画面VMそのもの**（期初BS・償却資産・市場情報） |
| `app/v2/company-lab/components/OpeningInfoPanels.tsx`（399行） | 同上の表示コンポーネント |
| `app/v2/company-lab/salesPlanTotals.ts` | **§6-D「market total / product total / total」そのもの** |
| `app/lib/v2/companyLab/marketDemandObservation.ts`（新設） | **§5「市場需要」の遅行公開層**（targetDemand の観測値化） |
| `app/lib/v2/companyLab/domesticReferencePrice.ts`（新設） | turn1の国内原料参考価格 |
| `app/lib/v2/sales/salesCapacityModel.ts`（新設） | **営業能力モデルの3案切替（perMarket/…）＝ Q3 の直接の関係先** |
| `DecisionEditor.tsx` **+428行** / `PlayerScreenClient.tsx` **+162行** / `decisionDraft.ts` +71行 | **私が変更予定の同一ファイル・同一箇所** |
| `sales/parameters.ts` +127行 / `sales/marketEffort.ts` +56行 / `sales/allocation.ts` +30行 / `sales/runner.ts` | engine core の営業ロジック |
| `standardAi/decision/sales.ts` +334行、`salesForceHiring.ts`（新設898行） | AI側の営業判断 |

→ **このまま develop/v2 起点で実装すると、ほぼ確実に大規模コンフリクトになる。** §12 で選択肢を提示する。

### 11-2. PR #5 `feature/v2-sales-force-saturation-calibration`（open、→ main）

`app/lib/v2/sales/parameters.ts` のみを変更し、営業処理能力曲線を再校正:

```
capacityMaxIncrementTons:  4,800 → 24,000
capacitySaturationHeadcount:  10 → 70
```

→ **UI側は `SALES_PARAMETERS_V1` の数値を絶対に写経してはならない。**必ず `processingCapacity()` / `salesEffortWeightedQuantity()` を呼ぶこと（そうすれば校正が自動で反映される）。この方針は当初から遵守する。

### 11-3. その他

- `feature/v2-8g-remaining`, `claude/turn-processing-engine`, `feature/v2-ai-explanation-*` 等は develop/v2 に取り込み済み or 差分なし（競合リスク低）
- `claude/github-remote-state-check-im8jpc` は develop/v2 と同一SHA

---

## 12. 推奨実装ステップ

### ステップ0（実装前・**ご判断待ち**）

1. **ブランチの整合**: 私の実行環境は `claude/shrimpx-v2-ui-audit-aypqr4` を指定branchとして与えられており、ご指示の `feature/v2-ui-decision-studio-sales` とは名前が異なる。どちらで進めるかご指示ください（勝手に別branchへpushしません）。
2. **`feature/v2-32q-management-console` との関係**（§11-1）。3案:
   - **案A（推奨）**: 同branchを起点に私のbranchを作り直す。既存の `openingInfoViewModel` / `salesPlanTotals` / `marketDemandObservation` を土台に使え、二重実装とコンフリクトを避けられる。
   - **案B**: develop/v2 起点のまま進め、統合は後日そちらの担当が行う。→ 大規模コンフリクト確実、`salesPlanTotals` 等の二重実装が発生。
   - **案C**: 担当範囲を分離（例: 私は Sales Intelligence の READ ONLY 画面のみ、Sales Planning 入力は先方）。
3. **§9 の Q1〜Q6** への回答（特に Q1 CTS の定義、Q3 の `sales/salesForce.ts` への関数追記の可否）。

### ステップ1以降（承認後・小さなcommitに分割）

| # | 内容 | 変更ファイル | 検証 |
|---|---|---|---|
| 1 | view-model 層のみ新設（S1〜S3）＋単体テスト。UIからは未使用 | 新規のみ | `npm test` |
| 2 | `viewModel.ts` に `previousQuarterSales` / `aiDefaultSalesPlans` を追加（既存フィールドは不変） | viewModel.ts | tsc + test |
| 3 | **Sales Intelligence（READ ONLY）を新ルートで追加**。既存画面は無改変 → 並行開発の衝突が最小 | 新規 page/components + panelStyles にバッジ定数追加 | build |
| 4 | `DecisionImpactBar` prototype（S7）。Projected Ending Cash を出さないことを**テストで固定** | 新規 | test |
| 5 | Sales Planning（EDITABLE）を新セクションとして構築。**既存 DecisionEditor は残したまま**、feature flag 的に併存させて比較可能にする | 新規 + PlayerScreenClient 最小変更 | build |
| 6 | Production Preview（§7）を Sales Planning 下部へ | 新規 | build |
| 7 | 既存 DecisionEditor の販売セクション削除（**最後に、承認を得てから**） | DecisionEditor.tsx | 全テスト |

各ステップで `npx tsc --noEmit` → `npm test` → `npm run lint` を通し、**develop/v2・他featureへのmerge、Vercel deploy は一切行わない**。

---

## 付録: 遵守する原則の確認

- engine の計算式・パラメータ数値を UI へ写経しない（必ず関数呼び出し）
- 同じロジックを React component 内に複製しない（view-model の純粋関数へ）
- 値が取れないときは `NO_VALUE_TEXT`（`－`）。**0で埋めない・捏造しない**（既存の全ファイルが明記している方針）
- エンジン確定値（deterministic）と AI 推定値（estimate）を視覚的に分離
- `Projected Ending Cash` を表示しない
- 営業人員は市場別のみ（商品別に置かない）
- HOSO換算MTで統一。PD÷0.54 / VAP÷0.90 の歩留まり換算を新UIへ持ち込まない
