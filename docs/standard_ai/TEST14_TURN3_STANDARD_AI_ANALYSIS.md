# Test14 Turn2 Counterfactual（新capacity仕様）・Turn3 Standard AI提案 分析

作成: Cowork #05（AI設定）／2026-08-05

## 1. スコープと制約（最初に明記）

この文書には2種類の異なる確度の分析が混在するため、区別を最初に明示する。

- **§2（Turn2 Counterfactual）**: 三宅さんが今回のご指示で示された「想定新仕様」（HOSO 600t/PD 300t/VAP 200t per person per quarter、effort係数HOSO1.0/PD2.0/VAP3.0）を前提に、実際のTest14 Turn2データ（`BAL_company_Test14_turn2.json`）へ手計算で適用した**分析的な推計**である。**#04によるこの新仕様の実装は、本リポジトリのどのbranchにもまだコミットされていないことを確認済み**（`git log --all`で該当するcapacity式変更のcommitが存在しない）。したがって、この推計は「新モジュール実装後に自動的に得られるはずの値」の見積もりであり、実際にそのコードを実行した結果ではない。
- **§3（Turn3 Standard AI提案のshadow simulation）**: 新設した`buildStandardAiSalesForceHiringDecision`（実コード、単体テスト済み）を、Test14 Turn3の実際の状態（実データ）に対して**このセッション内では実行していない**。理由: `StandardAiObservation`（約90フィールド）を、Test14のライブ状態（Export JSON、内部の`CompanyOwnState`とは異なるスキーマ）から欠落なく正確に再構築するマッピング作業が、今回の実装作業と並行して完結しなかったため。この点は§5「未解決事項」に明記し、次回セッションの最優先タスクとして持ち越す。代わりに、新設モジュールが実際に正しく機能することは、リポジトリの既存シナリオ（`baseline`）に対する8ターン×5社の実行（本ドキュメント§4参照）で検証済みである。

## 2. Turn2 Counterfactual（新capacity仕様、分析的推計）

### 2.1 前提

新仕様（三宅さんご提示、線形容量モデルと解釈）: `capacity(h) = 600 × h`（effort-t）。effort係数: HOSO=1.0, PD=2.0, VAP=3.0（旧仕様のPD=1.2から変更）。市場別の縮小メカニズム自体（希望量をeffort容量に収まるよう比例縮小）は#04が変更しないと仮定し、旧仕様と同じ計算パターンを適用した。

### 2.2 Turn2実績配置（BAL、CN12/US8/EU9/JP4/OTHER5）での再計算

| 市場 | 商品別希望量(t) | 新effort換算希望量 | 新capacity(600×h) | 縮小率 | 推計成約量(t) |
|---|---|---|---|---|---|
| CN | hoso4000/pd1200/vap1000 | 4000+2400+3000=9,400 | 7,200 | 76.6% | 4,748.9 |
| US | hoso2000/pd3000/vap1000 | 2000+6000+3000=11,000 | 4,800 | 43.6% | 2,618.2 |
| EU | hoso3000/pd2000/vap1000 | 3000+4000+3000=10,000 | 5,400 | 54.0% | 3,240.0 |
| JP | hoso1000/pd1200/vap1200 | 1000+2400+3600=7,000 | 2,400 | 34.3% | 1,165.7 |
| OTHER | hoso1200/pd800/vap1000 | 1200+1600+3000=5,800 | 3,000 | 51.7% | 1,551.7 |
| **合計** | **24,600** | **43,200** | **22,800** | | **13,324.5** |

**新仕様下でのTurn2推計成約量: 約13,325t**（旧仕様の実績7,396.1t比 +80.1%）。ただし希望量24,600tには依然として届かない（54.2%の達成率）。旧仕様の達成率30.1%からは大きく改善するが、「営業人員数を増やせば希望量どおり売れる」という状態にはならない。

### 2.3 Standard AIが同時点で提案した採用人数（未実施）

三宅さんご指示§15後段「Standard AIがTurn2開始時点にいたとして、何人採用を提案したか」のshadow simulationは、§1で述べた理由により今回未実施である。新設モジュールは新capacity仕様が実装された時点で、コード変更なしに正しい値を計算できる設計になっている（§設計文書2章）ため、#04の実装完了後に本文書を更新する形で追記することを推奨する。

## 3. Turn3 Standard AI提案（shadow simulation、未実施）

上記の理由により、Test14 Turn3の実際の状態に対する新設モジュールの実行は今回未実施である。三宅さんご指示§16が要求する「Sales(desired/realistic/market allocation/hire/layoff)・Production(HOSO/PD/VAP)・Worker(hire/layoff)・Raw(domestic/import/aquaculture)・Capex・Financing」の一式は、次回セッションでの最優先タスクとする。

## 4. 代わりに実施した検証: 既存シナリオでの8ターン×5社実行

新設モジュールを実際に`policy.ts`へ接続した状態で、既存の`baseline`シナリオ（5社×8ターン、`standardAi.test.ts`の既存テスト経路）を実行し、以下を確認した（詳細は`docs/standard_ai/STANDARD_AI_8Q_SIMULATION_SUMMARY_2026-08-05.md`参照）。

- 8ターン×5社、32ターン×5社のいずれも例外なく完走（既存テスト`ok`）。
- `salesForceHireCount`/`salesForceLayoffCount`を含む全数値フィールドが有限（NaN・Infinityなし）。
- 採用・減員が同一四半期に同時発生しない。
- 決定論性（同一入力→同一出力）を維持。

これはTest14の実データに対する直接検証ではないが、新設ロジックがゲーム全体のルール（会社規模・複数四半期の連続実行）の中で構造的に破綻していないことの実証にはなる。

## 5. 未解決事項（次回優先）

1. `StandardAiObservation`をTest14の実際のExport JSON（またはライブ状態）から構築するマッピングコードの作成（最優先）。
2. 上記完了後、Turn2 counterfactual（§2）とTurn3 shadow proposal（§3）を実際のコード実行で再検証・更新。
3. `SALES_HIRING_BLOCKED_BY_PRODUCTION`判定の商品別精緻化（設計文書§9参照）。
4. Financial Capacity診断モジュール（`financialCapacity.ts`）との厳密な多四半期統合。
