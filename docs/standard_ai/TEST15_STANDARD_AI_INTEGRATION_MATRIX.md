# Test15前 標準経営AI（#05） vs pd_labor 機能比較マトリクス

作成: Cowork #05（AI設定）／2026-08-05

## 重要な前提（必ず先に読むこと）

**`feature/v2-product-labor-and-pd-mechanization`（pd_labor）ブランチ、`feature/v2-test15-preflight-calibration`ブランチ、および`docs/v2/design/test15_pd_labor_standardai_collision_map.md`は、このリポジトリのgit上のどこにも存在しない**（ローカルブランチ・`origin`いずれにも無く、コミットハッシュもgitオブジェクトとして存在しない）。サンドボックスセッションはこのリポジトリの`origin`へpushできないため、#04の当該作業は別セッションで作られたまま一度もこのリポジトリへ到達していない。

本マトリクスの「pd_labor」列は、**#04が作成したClaude Projectの完了報告ドキュメント（プローズ形式の報告書）のみを根拠とした間接情報であり、pd_laborの実コードを直接読んで確認したものではない**。数値・仕様の詳細度は報告書の記述に依存し、実装の細部（エッジケース処理・エラーハンドリング等）までは検証できていない。この制約を踏まえたうえで、Test15に向けた機能単位の移植候補を判断するための参考情報として扱うこと。

## マトリクス

| Feature | Current #05 | pd_labor | Test15 adoption |
|---|---|---|---|
| Situation Diagnosis | 実装あり（`situationDiagnosis.ts`、6カテゴリ診断、一部A・大部分B） | 旧系統/欠落（#04報告によれば、pd_laborはSAI-6診断層より前の系統であり、この診断構造自体を持たない） | KEEP_05 |
| Sales desired qty | 実装あり（A、`decision/sales.ts`、市場×商品別に算定） | 詳細不明（報告書に記載なし） | KEEP_05 |
| Sales pricing | 実装あり（A、FG過剰率連動の値引き圧力あり） | 詳細不明 | KEEP_05 |
| Sales allocation | 実装あり（A、営業工数制約つき配分。35%シェア上限はAI非認識・下流enforced） | 詳細不明。VAP capability weightが`sales/allocation.ts`の競争力加重へ反映される旨のみ報告あり | MERGE_FUNCTIONALLY（VAPケイパビリティの競争力反映という「概念」のみ、#05のsales.ts側に将来組み込む余地を検討。今回は実施しない） |
| Sales hire/layoff | 実装あり（A、本番経路で確認済み。Target Scale帯連動） | 詳細不明（#04報告に直接記載なし） | KEEP_05 |
| Production requirement | 実装あり（A、SAI-6.1〜6.4、当期納品需要・正常在庫目標込み） | 旧系統/欠落（pd_laborの`decisionDraft.ts`は「静的フィクスチャのみから生産・Worker計画を組んでいた」と#04報告が明記する既知のギャップ） | KEEP_05（#05のほうが明確に優れる） |
| Production priority | 実装あり（A、契約充足優先） | 詳細不明 | KEEP_05 |
| FG inventory handling | 実装あり（A、正常在庫目標との差分で生産必要量へ反映。ただしP1課題として高水準滞留あり） | 詳細不明 | KEEP_05 |
| Worker adjustment | 実装あり（A、常用ワーカー増減。ただし単一労務係数のみ） | 製品別労務対応（`laborIntensityCoefficient` HOSO1.0/PD1.8/VAP3.0、機械化後PD1.2/VAP2.6、`resolveLaborIntensityCoefficient`で統一。#04報告書ベース） | PORT_PD_LABOR_INTO_05（商品別労務係数の「概念」のみを#05のworkforce.ts計算へ移植することを推奨。ただしTest15前の今回スコープでは実施しない。P0課題として別途扱う） |
| Temp/overtime | 実装あり（A） | 詳細不明 | KEEP_05 |
| Raw procurement | 実装あり（A、自己抑制型の現金連動） | 詳細不明 | KEEP_05 |
| Factory capex | 汎用ライン拡張のみ（A、工場新設概念なし） | 対応あり（`newFactoryConstruction`：$22M、3Q建設30/35/35%、1Q準備、建屋45%/設備55%、0.75%/四半期維持費、最大4工場、3段階ランプアップ50%→75%→100%。ただしWorker/営業/需要は自動連動しないという既知のギャップつき。#04報告書ベース） | OWNER_DECISION（工場新設は大型ゲーム機能追加に相当し、Test15前に急いで移植する必然性は低い。三宅さんのご判断を仰ぐ） |
| PD mechanization | 未実装（D） | 対応あり（$2.5M/工場、2Q支払40/60%、1Q準備、2Q学習曲線、脱人員化率上限33.33%、PD稼働率は前期実績のみ参照。**重大な既知課題**: 投資承認ゲートが「投資後も現金≧最低バッファの2倍」を要求し、#04がテストした資金制約シナリオでは一度も満たされず、Standard AIが0/15回で一度も自発提案しなかった。#04はこのゲートを意図的に緩めなかった） | NOT_NEEDED_BEFORE_TEST15（Test15の主目的は人間プレイヤーによるPD機械化の手動検証であり、AIが追随しないこと自体は許容範囲。ただし移植する場合は投資ゲートの緩和が前提となり、それ自体がゲームバランス変更を伴うため今回は見送る） |
| VAP development | 未実装（D） | 対応あり（4段階$0/$100k/$250k/$500k、当期SG&A費用化、VAPケイパビリティスコアが`sales/allocation.ts`の競争力加重へ反映。フラグ初期バグでOFFだったが後にデフォルトON修正済み、との報告） | NOT_NEEDED_BEFORE_TEST15（同上の理由。ただし「概念のみ移植」の候補としては最有力＝P2で再検討） |
| Market evolution investment | 未実装（D） | 対応あり（`marketEvolutionInvestment.ts`、内容詳細不明・ファイル存在の言及のみ） | NOT_NEEDED_BEFORE_TEST15（詳細不明のため判断材料不足。今回は見送り） |
| Financial capacity | 診断モジュールは未接続（C、`diagnosis/financialCapacity.ts`はpolicy.tsへ未到達）。ただし営業採用の流動性ゲート自体は`pressures.ts`経由で実接続（A） | 詳細不明 | KEEP_05（現状の簡易ゲートで実用上は機能している。`financialCapacity.ts`の実接続化はP2） |
| Borrowing | capex.tsの借入余力チェックのみ実接続（A、`cashAndBorrowingSafe`） | 詳細不明 | KEEP_05 |
| Strategic Intent | 実装あり（A、`strategicIntent.ts`・`targetScale.ts`・`targetCapability.ts`、全社共通BALANCED_GROWTH固定） | なし（#04報告書に記載なし。pd_laborはSAI-6以前の系統であり、Strategic Intent/Target Scaleの概念自体が存在しない） | KEEP_05 |
| 商品別労務係数（永続化スキーマ含む） | 単一係数のみ（D） | あり。ただし`CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION`を4→5へ独自に上げており、本ブランチ系統は既に4→6へ独自に上げている（salesForceHireCount/LayoffCount関連作業）。**両者は未整合であり、統合する場合はv7新設か手動3-way mergeが必要** | OWNER_DECISION（スキーマ競合の解消方針は実装判断であり、三宅さんのご判断を仰ぐ。今回は判断のみ記録し実施しない） |

## 補足: 移植原則の再確認（三宅さんご指示§21）

現行#05のアーキテクチャ（SAI-6.1〜6.4診断層＋Strategic Intent/Target Scale/Target Capability）は骨格として維持する。pd_laborから救出すべき対象は「工場capex・PD機械化・VAP開発・市場進化投資・商品別労務環境対応」の**機能単位のみ**であり、pd_laborの意思決定アーキテクチャ全体（診断層を持たない旧系統）を採用することは明示的に不適切と判断する。
