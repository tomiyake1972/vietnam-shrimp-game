# pd_labor ブランチ Standard AI 差分マップ（コリジョンマップ、読み取り専用分析）

三宅さん指示（2026-08-05、Test15統合の一時停止後のドキュメントのみラウンド）への対応。

**本ドキュメントは分析成果物のみである。マージ・リベース・コード変更は一切行っていない。
`/tmp/pd_labor`・`/tmp/test15_integration`はいずれも読み取りのみで、内容変更なし
（本ラウンド終了時点でも`pd_labor`は`5f1fa87`のまま保全）。どちらのファイルを残すか・
どちらを正とするかの判断や推奨は一切行わない — オーナーが#05の状況を踏まえて判断する
ための素材のみを提供する。**

対象：`feature/v2-product-labor-and-pd-mechanization`（HEAD `5f1fa87`）の
`app/lib/v2/companyLab/standardAi/*`を`origin/develop/v2`（`90d67bc`）と比較。

## 0. 前提となる重要な構造的事実（分岐点の特定）

`git merge-base HEAD origin/develop/v2` = `083425a`。この`083425a`は、
`origin/develop/v2`側でStandard AIに"SAI-6.1〜6.4 Situation Diagnosis /
Commercial Plan整理 / Current Period Delivery Demand層"を追加した以下2コミットの
**いずれよりも前**の時点である：

- `6aedf6f` feat(standard-ai): SAI-6.1〜6.3 Situation Diagnosis / Commercial Plan整理 / Current Period Delivery Demand層を実装
- `d062120` feat(standard-ai): SAI-6.1診断の意味修正とSAI-6.4 Inventory & Production Plan実装

（`git merge-base --is-ancestor 6aedf6f 083425a` → 偽、確認済み）

つまり **`pd_labor`ブランチは、`origin/develop/v2`にSAI-6.1〜6.4が追加される前の時点で
分岐し、その後一度もSAI-6.x側の変更を取り込んでいない**。以下で「削除」として現れる
`diagnosis/situationDiagnosis.ts`等のファイルは、`pd_labor`側が能動的に削除したのではなく、
**そもそも`pd_labor`の分岐後に`origin/develop/v2`側で新設されたものであり、`pd_labor`には
一度も存在しなかった**という点が正確な理解である（diffの表示上は"D"=削除に見えるが、
歴史的な意味としては「未マージ」に近い）。

一方で、`decision/sales.ts`のコメントに「営業人員採用の反映・SAI-6.2再突合ポイント2」
「develop/v2のSAI-6.2が入れたのと同じ修正」といった記述があることから、**pd_labor側の
作業者はSAI-6.xの存在を認識した上で、同等のロジックを手動で個別に再実装しようと
試みた形跡がある**（正式なリベース/マージではなく、部分的な追随）。また新設ファイル
`decision/marketEvolutionInvestment.ts`の冒頭コメントには明示的に
「#05のSAI-6.x意思決定レイヤの再構成には踏み込まない」「既存の観測フィールドを
拡張して使うのであって、並行する予測システムは作らない」と書かれており、
**設計意図としては#05の領域と衝突しないよう配慮されていた**ことも事実として記録する
（ただし実際のファイルレベルの差分は依然として存在する — 意図と結果は別）。

develop/v2側で、pd_laborが取り込んでいないコミットは以下7件（`app/lib`全体、
standardAi以外も含む）：
```
90d67bc fix(company-lab): AI経営説明のクライアント側20秒timeoutが原因の誤った失敗表示を修正
f6c8935 feat(ai-explanation): 出力量を削減し25秒timeout内での安定成功を狙う
7ee410b fix(ai-explanation): Anthropic SDK自動retry無効化
8eec8c7 docs(standard-ai): Test14 Turn1のAI提案文面サンプルを追加
bc0ca57 docs(standard-ai): Test14 Turn1のSAI-6.4適用前後diagnostics比較を保存
d062120 feat(standard-ai): SAI-6.1診断の意味修正とSAI-6.4 Inventory & Production Plan実装
6aedf6f feat(standard-ai): SAI-6.1〜6.3 Situation Diagnosis / Commercial Plan整理 / Current Period Delivery Demand層を実装
```

## 1. ファイル別の差分一覧・分類

`app/lib/v2/companyLab/standardAi/*` — `origin/develop/v2`比で19ファイル変更
（+957 / −1308行）。

| ファイル | 種別 | 目的（コミット由来） | 分類 | 衝突リスク |
|---|---|---|---|---|
| `decision/marketEvolutionInvestment.ts` | **新規追加**（519行） | 加工品市場進化§h：市場見通しに基づく投資タイミング判断（新工場・PD省人化・VAP開発のタイミング判定を、需要予測×能力不足予測×期待回収×現金余力の4観測量から導出） | market-evolution support | **高**（新設だが、#05のSAI-6.x意思決定レイヤと同じ`policy.ts`から呼ばれる中枢ロジック） |
| `decision/labor.ts` | 修正（+5行） | `mechanizationLevel`をworker必要人員計算へ接続（PD省人化が進むと必要人員が下がる） | PD-mechanization support | 中（変更は小さく局所的） |
| `decision/production.ts` | 修正（+31/-22行相当） | SAI-6.4の`finalProductionRequirementByProduct`（現行develop/v2方式）を、pd_labor独自の`salesDesiredByProduct`ベースの旧方式（`desired+backlog-fg`）へ差し替え | other AI improvement（実質は**SAI-6.4未反映による方式差**） | **高**（生産計画の中枢関数。SAI-6.4のロジックとは非互換な計算方式） |
| `decision/sales.ts` | 修正（+70/-40行相当） | `realisticSalesByProduct`（SAI-6.2で追加されたフィールド）を削除し、加工品市場進化§eの営業能力再設計（`MarketSalesCapabilityContext`等）へ差し替え。コメントに「SAI-6.2再突合ポイント」の記載あり＝手動追随の跡 | 半分market-evolution support・半分other（SAI-6.2との非互換差分） | **高**（明示的にリスト指定されたファイル） |
| `observation.ts` | 修正（+62/-40行相当） | `mechanizationLevel`・`salesCapabilityEnabled`等の新規観測フィールド追加、`rawMaterialInTransitImportQuantity`等SAI-6.1新設フィールドの不在 | PD-mechanization / market-evolution support | 中〜高（Observationは全ドメインの入力源） |
| `policy.ts` | 修正（+28/-72行） | `decideMarketEvolutionInvestments`の呼び出し追加、`resolveOrientationProfile`の導入、SAI-6.x関連コードの縮小 | market-evolution support | **高**（明示的にリスト指定。全ドメインを統括する中枢ファイル） |
| `pressures.ts` | 修正（-14行） | `computeReferenceProductionByProduct`のexport関数を削除しインライン化（SAI-6.1切り出し部分の巻き戻り） | other AI improvement（実質SAI-6.1未反映） | **高**（明示的にリスト指定） |
| `reasonCodes.ts` | 修正（+44/-70行相当） | `StandardAiDomain`から`"diagnosis"`を削除、SAI-6.1で新設された6種の診断理由コード（`SALES_FORCE_BINDING_CONSTRAINT`等）・SAI-6.4の原料診断理由コードが不在 | other AI improvement（SAI-6.1/6.4未反映） | **高**（明示的にリスト指定） |
| `types.ts` | 修正（+22/-14行相当） | `FactoryObservation.mechanizationLevel`・`salesCapabilityEnabled`等追加、SAI-6.1新設の原料内訳3フィールドが不在 | PD-mechanization / market-evolution support | **高**（明示的にリスト指定。型定義の中枢） |
| `autoplay/runCase.ts` | 修正（+18行） | `marketEvolutionEnabled`設定オプションの追加（config一式をopt-inで有効化） | market-evolution support | 低（追加のみ、既存動作は変更なし） |
| `__tests__/marketEvolutionInvestment.test.ts` | **新規追加**（229行） | `decideMarketEvolutionInvestments`の単体テスト | market-evolution support | 低（テストのみ） |
| `__tests__/salesEffort.test.ts` | 修正（+32/-0相当） | sales.ts変更に追随するテスト更新 | market-evolution support | 低 |
| `__tests__/standardAi.test.ts` | 修正（+7行） | 上記変更群の統合テスト微修正 | other | 低 |
| `autoplay/__tests__/buildLog.test.ts` | 修正（+45行相当） | runCase.ts変更に伴うテスト更新 | market-evolution support | 低 |
| `report/__tests__/standardBaseline.test.ts` | 修正（+17行相当） | 上記変更群に追随するテスト更新 | other | 低 |
| `diagnosis/situationDiagnosis.ts` | **未取込（diff上は削除）** | SAI-6.1〜6.3新設、pd_labor分岐後に develop/v2 側で追加されたため pd_labor には存在しない | — | **高**（#05が現在最も活発に触っている可能性が高い領域） |
| `diagnosis/currentPeriodDeliveryDemand.ts` | **未取込（diff上は削除）** | 同上（SAI-6.3） | — | **高** |
| `diagnosis/productionRequirement.ts` | **未取込（diff上は削除）** | 同上（SAI-6.4） | — | **高** |
| `diagnosis/__tests__/situationDiagnosis.test.ts` | **未取込（diff上は削除）** | 同上のテスト | — | 中 |

## 2. 高衝突リスクファイルのサマリ（指示で明示された5ファイル＋追加発見分）

指示で明示された5ファイルは全て変更されており、**全て高リスク**に分類される：
`decision/production.ts`、`decision/sales.ts`、`policy.ts`、`pressures.ts`、`types.ts`。

加えて、指示にはなかったが同等以上のリスクを持つと判断されるファイル：
- `reasonCodes.ts`（`StandardAiDomain`型と診断理由コードの整合性が崩れている）
- `observation.ts`（全ドメインの入力源であり、SAI-6.1新設フィールドの不在は
  #05側コードから見ると「観測値が来ない」形で顕在化しうる）
- `diagnosis/`ディレクトリ3ファイル（pd_labor側に一度も存在しないため、
  マージ時は「削除の取り消し」ではなく「新規追加として両立させるか、
  pd_labor側の代替ロジックと二重化を避けるか」という設計判断が必要）
- 新設`decision/marketEvolutionInvestment.ts`（ファイル自体は新規で直接競合しないが、
  `policy.ts`からの呼び出し方が、#05がpolicy.ts中枢ロジックを再設計した場合に
  configuration/呼び出し順序の面で衝突しうる）

## 3. 明示しておくべき非衝突・低リスク箇所

テストファイル群（`__tests__/*.test.ts`、5ファイル）と`autoplay/runCase.ts`は、
追加的・独立的な変更が中心で、コンフリクト自体は機械的に解消しやすいと考えられる
（ただし、依存先の中枢ファイルが競合する場合はテストの再実行結果は変わりうる）。
