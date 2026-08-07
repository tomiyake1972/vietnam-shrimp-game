# Test15分析スクリプト移植リスト（移植の実施は行わない、リストのみ）

三宅さん指示（2026-08-05、#05統合待ちラウンド）Part 5への対応。
**本ドキュメントは「統合ブランチを組み立てる際に、この順序でこのファイルだけを
移植する」というリストであり、実際のcherry-pick/移植作業は行っていない。**

出典：`feature/v2-test15-preflight-calibration`（`/tmp/test15_integration`、
HEAD `1921298`）固有の6コミット（前ラウンドの差分マップドキュメント
`test15_preflight_calibration_branch_diff_map.md`と対応）。

## 1. 再利用可能な分析スクリプト＋対応テスト（4組）

### 1-1. 新工場建設プリフライト校正（Phase6・コミット`1562fcc`）

| ファイル | 依存先 |
|---|---|
| `scripts/test15NewFactoryConstructionPreflightCalibration.ts`（554行） | `companyLab/runner.ts`(`advanceCompanyLabQuarter`/`buildCompanyOwnState`/`buildPublicMarketInfo`/`initializeCompanyLab`)、`companyLab/autoPolicy.ts`(`generateAutoPolicyDecision`、**Standard AIではない旧来の別エンジン**)、`companyLab/types.ts`、`sales/types.ts`、`market/types.ts`、`app/v2/company-lab/play/_lib/financialViewSelectors.ts`(`extractCompanyFinancialResult`)、`capex/factoryConstruction.ts`(`buildNewFactoryId`/`computeEffectiveFactories`)、`capex/parameters.ts`、`production/types.ts`、`production/labor.ts`(`calculateLaborCapacityFromAssignedHeadcount`)、`production/parameters.ts`、`core/units.ts`、`finance/types.ts` |
| `app/lib/v2/companyLab/__tests__/test15NewFactoryConstructionPreflightCalibration.test.ts`（118行） | 上記スクリプトの純粋関数部分 |

**AI依存**：`standardAi/*`への依存なし（`autoPolicy.ts`のみ使用、Standard AIとは別エンジン）。

### 1-2. PD省人化投資プリフライト校正（Phase5・コミット`a0b0a16`）

| ファイル | 依存先 |
|---|---|
| `scripts/test15PdMechanizationPreflightCalibration.ts`（672行） | 上記1-1と共通の`runner.ts`/`autoPolicy.ts`/`types.ts`系に加え、`companyLab/pdMechanizationState.ts`(`buildPdCoefficientOverridesByFactory`)、`capex/pdMechanization.ts`(`computeEffectivePdCoefficient`/`PD_MECHANIZATION_PARAMETERS_V1`)、`production/capacity.ts`(`calculateFactoryEffectiveCapacity`)、`production/labor.ts`(`effectiveEfficiencyPerHeadTons`/`requiredHeadcountForQuantity`)、`finance/parameters.ts` |
| `app/lib/v2/companyLab/__tests__/test15PdMechanizationPreflightCalibration.test.ts`（168行） | 上記スクリプトの純粋関数部分 |

**AI依存**：なし（`autoPolicy.ts`のみ）。

### 1-3. VAP商品開発投資プリフライト校正（Phase7・コミット`57fe528`）

| ファイル | 依存先 |
|---|---|
| `scripts/test15VapProductDevelopmentPreflightCalibration.ts`（320行） | `runner.ts`/`autoPolicy.ts`/`types.ts`系に加え、`companyLab/productDevelopmentState.ts`(`PRODUCT_DEVELOPMENT_PARAMETERS_V1`/`VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD`)、`companyLab/premiumPolicy.ts`(`VAP_CAPABILITY_WEIGHTS_V1`/`calculateCompanyCapabilityCoefficient`)、`companyLab/salesBase.ts`(`lookupSalesBaseScore`)、`market/types.ts`(`DEMAND_MARKET_IDS`) |
| `app/lib/v2/companyLab/__tests__/test15VapProductDevelopmentPreflightCalibration.test.ts`（101行） | 上記スクリプトの純粋関数部分 |

**AI依存**：なし（`autoPolicy.ts`のみ）。

### 1-4. 標準AI統合自動プレイ観測（Phase8・コミット`4cdf3a1`）

| ファイル | 依存先 |
|---|---|
| `scripts/test15StandardAiIntegratedAutoplay.ts`（278行） | `companyLab/standardAi/autoplay/runCase.ts`(`runAutoplayCase`)、`companyLab/standardAi/report/standardBaseline.ts`(`STANDARD_BASELINE_CANDIDATES`/`SELECTED_STANDARD_BASELINE_CANDIDATE_ID`)、`companyLab/standardAi/report/decomposeHarness.ts`(`ALL_COMPANY_IDS`) |
| `app/lib/v2/companyLab/__tests__/test15StandardAiIntegratedAutoplay.test.ts`（63行） | 同上 |

**AI依存：あり。** このスクリプトのみ`standardAi/*`（`autoplay/runCase.ts`・
`report/standardBaseline.ts`・`report/decomposeHarness.ts`）へ直接依存するため、
**#05の統合方針が確定するまで移植を保留すべき**（本ラウンドの凍結指示に合致）。

## 2. 移植順序の推奨（実施はしない、順序案のみ）

1. まず1-1〜1-3（AI非依存の3組）を移植し、`app/lib`本体の依存先
   （`runner.ts`/`capex/*`/`production/*`/`companyLab/pdMechanizationState.ts`/
   `companyLab/productDevelopmentState.ts`等）が移植先ブランチに実在することを
   ビルド・テストで確認する。
2. 1-4（標準AI統合自動プレイ）は、#05の`standardAi/*`最終形が確定してから、
   依存先パス（`autoplay/runCase.ts`・`report/standardBaseline.ts`・
   `report/decomposeHarness.ts`）が移植先に存在するか個別に確認した上で移植する。

## 3. Phase5〜8の校正結果レポート（参照専用、本番機能として扱わない）

以下は明確に「ある時点・あるパラメータでの一回限りの数値検証結果」であり、
そのまま本番機能や仕様として扱ってはならない：

- `docs/v2/reports/test15_new_factory_construction_preflight_calibration_report.md`
- `docs/v2/reports/test15_pd_mechanization_preflight_calibration_report.md`
- `docs/v2/reports/test15_vap_product_development_preflight_calibration_report.md`
- `docs/v2/reports/test15_standard_ai_integrated_autoplay_report.md`
  （**注記**：この報告書に記録された「現行パラメータ下でStandard AIが全5社を
  3seed全てで16四半期以内に債務超過へ導く」という所見自体は、Test15開始判断上
  重要な背景情報として引き続き有効。ただしこの所見はAI側の問題であり、本ラウンドの
  スコープ（AI非改変）では対応しない）
- `docs/v2/reports/test15_preview_deploy_and_smoke_test_report.md`
  （Vercel Preview がpush権限なしでブロックされたという結果は、本ラウンドでも
  同一のgit proxy 403エラーとして再現済み。状況は変わっていない）

## 4. 移植不要と判断されるもの

`.gitignore`の5行追加（コミット`a0b0a16`由来、Test15スクリプト実行時の一時出力
除外設定）：移植先ブランチの`.gitignore`に同等のパターンが無ければ追加を検討する
価値はあるが、必須ではない。
