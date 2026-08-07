# Standard AI Phase C/D/E 診断基盤 設計文書

2026-08-03 Cowork #05（AI設定）実装

## 0. 位置づけ

本ラウンドで実装したPhase B（Forward Unit Economics）・Phase C（Market×Product Opportunity診断）・Phase D（Shadow Sales Allocation Engine）・Phase E（Financial Capacity診断）は、すべて**診断専用（read-only）**である。本番Standard AIの販売・生産・調達・人員配置・設備投資・借入の意思決定ロジック（`decision/*.ts`）は一切変更していない。`grep`で`decision/`配下のいずれのファイルもこれらの新規モジュールをimportしていないことを構造的に確認済み。

目的は、「人間案へStandard AIを近づける」ことではなく、Standard AIが**市場機会→営業配分候補→採算→資金制約**という一連の経営判断を、正しい情報に基づいて組み立てられる基盤を作ることである。

## 1. 今回変更していないもの（Section 1の4項目）

- A. 商品別労務係数・労働集約度パラメータ（`production/labor.ts`等）
- B. 販売容量モデルの曲線・effort coefficient（`capacity(h)=200+4800h/(h+10)`、HOSO=1.0/PD=1.2/VAP=3.0）
- C. 国内原料市場エンジン（供給・価格・買い手シェア上限・清算メカニズム）
- D. 生産エンジンの能力ルール（共通前処理・凍結包装・商品別能力・設備利用可能率・base utilization）

## 2. Phase B: Forward Unit Economics（`diagnosis/forwardUnitEconomics.ts`）

市場×商品ごとに、参照売価・原料費（国内参照価格のみを主原料費として採用。輸入は参考値のみ・養殖は常にnull）・原料以外の変動費・貢献利益（**販売価格－原料費－原料以外の回避可能変動費**という正しい定式化。加工費だけを引く簡易式は使っていない）・配賦固定費・製造フルコスト・許容原料価格（貢献利益基準・フルコスト基準）・3区分採算分類（FULLY_PROFITABLE/CONTRIBUTION_POSITIVE_ONLY/UNECONOMIC）を計算する。

配賦固定費は、当期の実際の生産ミックスがまだ決まっていない（意思決定前の将来診断のため）という制約から、`totalEffectiveCapacityByProduct`（実効能力）を暫定の参考生産ミックスとして使っている。**この基準を正式な最終配賦基準として固定してはいない**。将来、production planが確定した時点で、その実際の生産ミックス（`productionByProductTons`のような具体的な計画値）を配賦基準として再計算できるよう、配賦ロジックは`allocatedManufacturingFixedCostByProductUsdPerKg(observation)`という単一の内部関数に閉じ込めてあり、この関数の引数を「observationの実効能力」から「呼び出し元が渡す任意の生産ミックス」へ差し替えるだけで対応できる構造にしている（シグネチャ変更のみで済む設計）。

既存パラメータの再利用: `production/parameters.ts`の`baseProcessingCostUsdPerTon`（HOSO$350/t・PD$520/t・VAP$780/t）、`finance/parameters.ts`の変動ユーティリティ費$25/t・変動販売物流費$100/t・工場固定費$1.2M/工場/四半期・設備固定費$0.25M/工場/四半期・固定費配賦係数（HOSO1.0/PD1.5/VAP2.4）。新しい原価パラメータは1つも作っていない。

## 3. Phase C: Market×Product Opportunity診断（`diagnosis/marketOpportunity.ts`）

需要規模・営業制約・採算性を**別々の軸**として保持する。「市場価格が高い」ことと「営業人員を増やす価値が高い」ことを同義にしないための構造上の工夫は次の3点:

1. `referenceSellingPriceUsdPerKg`（価格）と`salesForceEffortCapacityHosoEqTons`（営業容量）は完全に独立したフィールドであり、後者はheadcountのみの関数（価格に一切依存しない）。
2. `priceRelatedDemandEffect`（価格要因）と`ctsRelatedDemandEffect`（顧客関係・品質・納期信頼性・営業基盤要因）を、`sales/allocation.ts`の実際の合成競争力式（`computeCompetitivenessBreakdown`）からそのまま内訳として取り出し、別フィールドとして保持する。
3. `profitabilityClass`/`contributionMarginUsdPerKg`はPhase Bの結果をそのまま参照するだけで、価格ランキングとは無関係に決まる。

**構造的な限界（#04確認事項）**: 現行の`StandardAiObservation`/`PublicMarketInfo`には、市場（CN/US/EU/JP/OTHER）別の絶対需要量（target demand）が一切存在しない。市場エンジンの出力（`MarketQuarterResult`）にも、市場別需要の内訳は含まれていない（`sales/marketAdapter.ts`のコメントで既に明示されている暫定前提と同じ限界）。したがって`targetDemandTons`/`supplierShareCeilingTons`は恒常的にnullとし、憶測で埋めていない。この1点は「実需要データが観測構造上取得不能」という停止条件に文字どおり該当するが、残り9項目は計算可能なため、この1項目のみnullとして先へ進める判断をした。

`unservedOpportunityWithinCurrentCapacityTons`は、真の需要ベースの未開拓機会ではなく、「今の営業人員規模の範囲内で、商品ミックスを変えればまだ何トン積めるか」という容量制約だけを反映した参考値であることを型コメント・フィールド名の両方で明示している。

## 4. Phase D: Shadow Sales Allocation Engine（`diagnosis/shadowSalesAllocation.ts`）

1人ずつの貪欲法（greedy）で、「次の1人をどこに置くと最も有効か」を評価する決定論的アルゴリズム。大規模最適化（LP等）ではない。

- **volume-oriented shadow**: 各ステップで、追加効果容量を最もトン数が増える商品（effort係数が最小の利用可能商品）へ割り当てる市場を選ぶ。
- **contribution-oriented shadow**: 各ステップで、追加効果容量をCM$/effort係数が最大の商品（かつCM>0）へ割り当てる市場を選ぶ。負の貢献利益の機会は一度も選ばれない。

両者は最初から1本化していない（volume指標とcontribution指標を両方保持し、比較可能にしている）。将来、戦略価値・市場育成価値を追加する場合は、`pickBestProductForMarket`の`objective`分岐へ3つ目のケース（例: `"strategic"`）を追加するだけで拡張できる構造にしている。

**需要ceilingの扱い**: 市場別の絶対需要が観測不能なため、本エンジンが尊重する唯一のceilingは、`decision/sales.ts`が既に計算している`desiredByProduct`（会社全体の商品別理論上限。同ファイルのコメントで「診断専用の参考値」と既に明記されている値）である。市場別の需要配分を伴わないため、本番AIの「前期価格最高位の市場へ50%」という批判対象のヒューリスティックを、shadow engine自身が継承してしまう心配がない。

## 5. Phase E: Financial Capacity診断（`diagnosis/financialCapacity.ts`）

借入意思決定そのものは作っていない（診断のみ）。`StandardAiObservation`へ新規追加した4組のフィールド（`receivablesDueThisPeriodUsd`/`NotYetDueUsd`、`payablesDueThisPeriodUsd`/`NotYetDueUsd`、`existingLoanInterestUsdThisQuarterEstimate`、`existingLoanScheduledPrincipalDueUsdThisQuarterEstimate`）は、いずれも既存の`ownState.financeState.receivables`/`payables`（既存の`dueSettlementPeriod`）と`financing/loanSchedule.ts`の既存関数（`computeLoanQuarterlyInterest`/`computeScheduledPrincipalDue`）をそのまま転記・適用しただけであり、新しい回収・支払・金利ルールは1つも作っていない。

**AR/APタイミングの正しい扱い**: 帳簿上の売掛金残高全体を当期の使える現金として扱わず、`dueSettlementPeriod`が当期のものだけを`receivablesDueThisPeriodUsd`として計上する。輸入原料の買掛金も同様に、当期新規発注分は当期の現金支出に計上せず（次期決済のため）、既に決済期日を迎えている既存買掛金のみを計上する。

**捏造していない未知値**: `aquacultureRelatedCashOutUsd`（養殖原価パラメータが観測に存在しない）と`availableBorrowingHeadroomUsd`（信用スコア・EBITDA相当・担保USD評価等、複数の未配線入力を要求する）は恒常的にnullである。近似値を作っていない。

`quarterLevelLiquidityHeadroomUsd`は四半期末時点の目安であり、四半期内の日次・週次の最低現金残高（intra-quarter minimum）ではないことを`dataQuality`ノートで明示している。

## 6. ExplanationContextへ将来接続すべき項目（今回は未接続）

今回はC/D/Eの結果を本番説明文へ全部接続していない（三宅さんの指示どおり）。将来Claude説明へ渡すべき候補は次のとおり（型のみ用意し、UI表示までは実施していない）:

- **Opportunity**: 会社全体で最も採算性の高い機会2〜3件（market×product、profitabilityClass=FULLY_PROFITABLE、CM$/kg降順）と、最も非経済的な機会1〜2件（UNECONOMIC）。15セル全体のraw JSONは渡さない（前回のtimeout問題を再発させないため）。
- **Shadow allocation**: volume-orientedとcontribution-orientedそれぞれの「現在の配分から最も離れている市場」1件（headcount差分が最大の市場）とその理由。
- **Contribution profitability**: 会社全体のFULLY_PROFITABLE/CONTRIBUTION_POSITIVE_ONLY/UNECONOMICの件数比率のみ（15セル個別値は渡さない）。
- **Financial capacity**: `quarterLevelLiquidityHeadroomUsd`・`liquidityWarning`・`existingBorrowingUsd`の3値のみ（`opening cash`等の内訳は渡さない）。

## 7. テスト・品質ゲート

`npx tsc --noEmit`クリーン、`npm test`は全件通過（各Phaseコミット時点の件数は各コミットメッセージ・最終報告に記載）、`npm run lint`は既存の無関係な警告4件のみ。
