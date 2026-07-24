# ShrimpX V2 開発日誌

**対象期間：2026年7月24日**
**対象フェーズ：Phase 8C-1（会社ラボ永続化基盤）のdevelop/v2統合～Phase 8C-2（四半期処理フロー接続）**

## 1. 本日の到達点

本日は、前日に実装・独立監査（Fable監査、結論: Accept with follow-ups）まで完了していたPhase 8C-1（会社ラボ専用の永続化モデル・Repository・Redis Lua原子コミット基盤）を、fast-forwardで`develop/v2`へ統合した。そのうえで、Phase 8C-2として、その永続化Repositoryを実際の四半期処理フローへ接続するApplication Service層を実装した。

Phase 8C-2の中心成果は次のとおり。

1. **Application Service層の新設**（`app/lib/v2/companyLab/application/companyLabQuarterFlowService.ts`）。ラボ作成・ドラフト保存/提出・四半期処理（ロック取得→復元→エンジン実行→検証→Lua原子コミット→ロック解放）を1つのユースケースとして実行できる。
2. **再開時の直近履歴注入**（監査指摘AUD-01への対応。本Phaseの最重要要件）。turn 2以降の処理では、currentのruntime snapshotに加えて直近確定履歴エントリの`record`を必ず復元時に注入する。「中断なし連続実行」と「毎四半期の保存・復元を挟んだ実行」が、4四半期・全状態フィールドのdeepEqualで完全一致することを回帰テスト化した（履歴注入を外すと実際に乖離することもネガティブコントロールで確認済み）。
3. **冪等性・競合処理**。同一turnIdの再試行は`alreadyProcessed`として保存済み結果を返す（commit成功後の応答消失に安全）。異なるturnIdによる同一turn処理・revision競合・lock token不一致はすべて型付きエラーで拒否し、確定状態は一切変更されない。
4. **Repository契約の統一**（監査指摘AUD-02/03への対応）。不存在ラボへの操作はin-memory版・Redis版ともに`CompanyLabNotFoundError`、重複labIdの作成は`CompanyLabAlreadyExistsError`（Redis版はLuaで存在確認・current作成・labs一覧追加を単一原子処理化）。
5. **コミット前の履歴検証**（監査指摘AUD-04への対応）。`validateCompanyLabQuarterHistoryEntry`を通過しないエントリはコミットに到達しない（「書けるが読めない履歴」の構造的排除）。
6. **labs一覧の維持・履歴ページング**（監査指摘AUD-12・履歴取得のページング化）。`listLabs`・`loadLatestHistoryEntry`・`loadHistoryPage`（afterTurn/limitカーソル方式）をRepository契約へ追加。
7. **処理ロック**。SET NX PXによる取得、compare-and-delete Luaによる自トークンのみの解放、原子コミット時の`expectedLockToken`検証。TTL切れ後に別処理がロックを取得した場合、古い処理はコミットできない。
8. **容量診断の更新**。実運用の入出力単位（処理後current約1.04MB・最大履歴エントリ約2.26MB・原子コミットREST要求約3.65MB＝Upstash 10MB上限の34.8%・単一履歴読取り応答約2.50MB）をUTF-8バイト数で実測する診断をテストへ追加。

品質確認は、TypeScript（エラー0）、ESLint（エラー・警告0）、新規テスト49件を含む全体テスト1,206件全pass、V1差分なし。既知のビルド時環境変数問題（`STAGING_KV_REST_API_URL`）のみ従来どおり再現し、本Phaseとは無関係であることを確認した。

## 2. 設計上の主な判断

- **ドラフト解釈の注入（decisionsProvider）**: ドラフト本体はUI層の型（`CompanyDecisionDraft`）であり、lib層のApplication Serviceはこれに依存しない。提出済みドラフトから全社ぶんの`CompanyDecisionInput`を組み立てる関数を呼び出し側が注入する設計とし、8C-1で確立したlib/UI分離を維持した。8C-3のAPI層が`decisionDraft.ts`とautoPolicy（プレイヤー以外の4社）をここへ配線する。
- **冪等判定の順序**: commit成功時にdraftは原子的に削除されるため、同一turnId再試行の判定（`current.lastProcessedTurnId === turnId`）をdraft確認より先に行う。順序を誤ると、正当な再試行がDraftNotFoundに誤変換される。
- **ドラフトの「処理済み」状態**: 新しい状態モデルは追加せず、「draftが存在しない ∧ `lastProcessedTurnId`が当該turnId」で表現する（既存モデルの範囲で4状態を区別）。
- **ロックTTLの検証方法**: TTL到達を実時間で待つテストは書かず、in-memory版は論理時刻（now引数）、Redis版はキー削除によるTTL到達の模擬という決定論的方法で「TTL切れ後の古い処理はコミットできない」ことを検証した。安全性の中核はTTLの精度ではなく、原子コミット時のロックトークン検証にある。

## 3. 残課題（8C-3以降への申し送り）

- API route・UIからの配線（decisionsProviderの実装、turnId/lockTokenの生成、実Upstash接続の初期化）。
- 実Upstashインスタンスに対するエンドツーエンド接続確認（本環境には認証情報がないため未実施。Luaスクリプト自体はローカルredis-serverで検証済み）。
- 履歴閲覧UI・ロールバック/GM訂正操作・Excel連携（8C-4/8C-5計画どおり）。
- 契約・原料ロット・完成品ロットの累積によるスナップショット線形成長への将来対策（剪定・圧縮・差分保存）。現行32ターン上限では全上限内。
