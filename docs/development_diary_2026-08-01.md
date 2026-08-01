# ShrimpX V2 開発日誌

**対象期間：2026年8月1日**
**対象フェーズ：Phase SAI-6（Standard AI経営レポート）— schema_mismatch不具合の修正**

## 0. 本日の到達点

**Standard AI経営レポート機能の`schema_mismatch`不具合を修正し、`develop/v2`へfast-forwardマージ・push した。**

- `develop/v2`: `f6b4e45` → **`990dba9`**（fast-forward、マージコミットなし）
- `main`: `3ae9485` 変更なし
- feature branch `test/sai6-manual-observation-2026-08-01`（および直前の作業ブランチ）は削除せず保存
- Preview環境（`vietnam-shrimp-game-staging`）へのデプロイは実施済み。production への deploy は行っていない
- マージ後の `develop/v2` で `npm test`（**全2059件成功**）・`npx tsc --noEmit`（エラー0）・
  `npx eslint .`（エラー0、今回の変更と無関係の既存警告4件のみ）・`npm run build`を再実行済み
  （`build`はサンドボックス環境変数`STAGING_KV_REST_API_URL`未設定によりページデータ収集段階で失敗。
  これは今回の変更と無関係の既知のサンドボックス制約であり、コード側の不具合ではない。詳細は5.4参照）
- 三宅さんによる実機確認（Test14／BAL／turn1）で、①基本方針〜⑦データ上の制約まで全セクションが
  正しく表示されることを確認済み

## 1. 症状

Standard AI経営レポート（Claude APIによる経営説明生成）が、プレビュー環境での実機確認中に
`schema_mismatch`（Claude応答のtool_use入力がZodスキーマの検証を通らない）として毎回失敗していた。
ユーザー（三宅さん）画面には「経営説明の生成に失敗しました」という文言のみが表示され、
リトライ（1回のみ・仕様どおり）を経ても2回とも失敗する状態だった。

調査の途中で、原因調査そのものを妨げる別の不具合（後述5.2）が見つかり、これも合わせて修正した。

## 2. 原因調査の経過（推測ではなく実データによる特定）

三宅さんからの明確な指示（「推測せず、実データ・実ログで確認すること」）に基づき、以下の順で
段階的に原因を特定した。

1. まずschema_mismatch発生時に、Zodのエラー内容・Claudeのtool_use入力の形（トップレベルの
   キー名と値の型のみ、本文は一切ログに出さない）を安全にログへ出す仕組みを追加。
2. その状態で再現テストを行ったところ、Vercelランタイムログに `キャッシュヒットのため応答
   （Claude呼び出しなし）` という行が出ており、**古い失敗結果がRedisキャッシュに永続化され、
   何度テストしても同じ古い失敗結果が返っているだけ**であることが判明。これでは本来の原因調査が
   できないため、まずこちらを修正（5.2）。
3. キャッシュ修正後に再現し直すと、Claudeのtool_use入力に`headline`・`executiveSummary`の
   2フィールドしか無く、`recommendations`／`keyRisks`／`questionsForPlayer`／`dataLimitations`
   の4配列フィールドが丸ごと欠落していることをログで確認。これは応答が途中で切れている疑いが
   強かったが、ここでも推測で終わらせず、Anthropic API応答の`stop_reason`・`usage.output_tokens`
   をログへ追加。
4. 再度実機テストし、attempt1・attempt2の両方で `stopReason=max_tokens outputTokens=1200
   maxTokens=1200` という実データを確認。**出力トークン数がちょうど設定上限と一致しており、
   応答が途中で打ち切られていたことが確定した。**

## 3. 根本原因

`getExplanationModelConfig()`（`app/lib/v2/companyLab/aiExplanation/claudeClient.ts`）で
設定していた`maxTokens=1200`が小さすぎたため、Claudeが`headline`・`executiveSummary`を
書き終えた時点で1200トークンを使い切り、必須の4配列フィールド（`recommendations`・
`keyRisks`・`questionsForPlayer`・`dataLimitations`）を出力する前に応答が打ち切られていた。
JSON Schema・Zodスキーマの定義自体は一致しており、スキーマ設計側の不整合ではなかった。

## 4. 修正内容

### 4.1 maxTokensの引き上げ（根本原因の修正）

`EXPLANATION_MAX_OUTPUT_TOKENS`を`1200`から`4096`へ変更。この機能のモデル設定を一元管理する
関数1箇所のみの変更で、JSON Schema・Zodスキーマ・TypeScript型は変更していない
（元々整合していたため）。実機再検証では`outputTokens=2624`で成功しており、4096の上限に
対して十分な余裕がある。

### 4.2 失敗結果を永久キャッシュしない（原因調査を妨げていた別不具合の修正）

`handlePostAiExplanation`／`handleGetAiExplanation`（`.../ai-explanation/_lib/handlers.ts`）で、
失敗結果（`result: "failure"`）はキャッシュへ保存しないよう変更。さらに、修正前に保存された
TTL無しの古い失敗結果がRedis上に残っていても、読み出し時に「ヒット」ではなく「ミス」として扱い、
Claudeを呼び直すよう変更（POSTは再試行、GETは404を返す）。これにより、キャッシュされた失敗が
プレイヤーの操作をブロックし続ける状態を解消した。

### 4.3 診断ログの追加

Zodのバリデーションエラー（path・code等の構造情報のみ、レポート本文は含まない）、
tool_use入力の型情報、`stop_reason`・`output_tokens`をログへ追加。いずれも経営説明の
実際の文章・ゲームの機密情報は出力しない設計にしている。

## 5. Vercelログによる実証

修正後の実機テスト（Test14／BAL／turn1）で、以下がVercelランタイムログにより確認できた
（推測ではなく実際のログ記録）。

- `11:44:03` attempt1で成功：`model=claude-haiku-4-5-20251001 inputTokens=6206 outputTokens=2624`。
  Zod検証成功→キャッシュ保存完了→`result=success`。1回の呼び出しで完了し、再試行は発生していない。
- `11:44:15` 別リクエストで一時的な`network_error`が発生。方針どおり再試行せず・キャッシュもせずに
  終了（想定どおりの挙動）。
- `11:44:56` 別リクエストでキャッシュヒットにより、Claudeを呼び出さず同じ成功レポートを返却。
  保存済みレポートの再表示ではAPIを再呼び出ししないことを実証。

## 6. 実機での成功確認

三宅さんがTest14／BAL／turn1で実際に操作し、①基本方針、②経営サマリー、③分野別の重要提案、
④財務管理（見出しの番号表記は既存UIのまま）、重要なリスク、⑥プレイヤーが検討すべき論点、
⑦データ上の制約・不明点まで、すべてのセクションが正しく表示されることを確認した。

**なお、レポート内の見出し番号（④／⑤が見た目上ずれて見える箇所）は、既存UIの表示ロジック側の
番号割り当てであり、今回のschema_mismatch修正の対象外。今回は着手していない。**

## 7. 検証結果（develop/v2統合後、再実行）

- `npm test`：2059/2059件成功
- `npx tsc --noEmit`：エラー0
- `npx eslint .`：エラー0（今回の変更と無関係の既存警告4件のみ：`dashboardCharts.ts`の未使用型2件、
  `companyLabExportAuditLog.test.ts`の未使用引数2件）
- `npm run build`：コンパイル・型チェックは成功。ページデータ収集段階で
  `STAGING_KV_REST_API_URL`未設定によるエラーで失敗（`/api/game/[gameCode]/admin/clone`ルート）。
  これは今回変更したAI経営レポート機能とは無関係の既存のサンドボックス環境制約であり、
  Vercel本番／Preview環境ではこの環境変数が設定されているため発生しない（Previewデプロイ自体は
  正常にREADYへ到達している）。

## 8. 学んだこと・次回への改善点

- Claude APIの`max_tokens`超過による応答切断は、症状としては「スキーマ不一致」に見える
  （必須フィールドが後半から丸ごと欠落するため）。tool_use強制でJSON構造を保証していても、
  トークン上限による途中切断はスキーマエラーとして現れることを踏まえ、`stop_reason`・
  `usage.output_tokens`を最初から常時ログしておく方が、次回以降の同種の不具合の切り分けが早まる。
- 失敗結果を無条件でキャッシュしてしまう設計は、機能の不具合であると同時に、不具合そのものの
  再現・調査を妨げる二次被害を生む。失敗系のキャッシュ方針は、キャッシュ導入時点で明示的に
  検討すべき項目だと再確認した。
- 「推測せず実データで確認する」という方針を最後まで徹底したことで、対症療法（例：スキーマ側を
  緩めて回避する等）に流れず、正しい根本原因（トークン上限）に到達できた。

## 9. 未解決事項

- 経営レポートUIの見出し番号表記のずれ（④／⑤）は今回のスコープ外のため未対応。
- 「全知AIチャット」機能は今回のスコープ外のため着手していない。

## 10. 関連ファイル・コミット

- `develop/v2`統合前の最終コミット（fast-forward元）：`990dba9`
  （`test/sai6-manual-observation-2026-08-01`ブランチ上）
- 今回のschema_mismatch対応コミット一覧（`f6b4e45..990dba9`のうち関連分）：
  - `a3a113c` schema_mismatch発生時のZod issues詳細をログへ出力
  - `1557fb9` schema_mismatch等の失敗結果を永久キャッシュしない
  - `f042e42` 既存のresult=failureキャッシュもヒットとして扱わない
  - `faff3c3` schema_mismatchログにstop_reason/output_tokensを追加
  - `990dba9` 経営説明のmaxTokensを1200から4096へ引き上げ
- 変更ファイル：
  `app/lib/v2/companyLab/aiExplanation/claudeClient.ts`、
  `app/api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-explanation/_lib/handlers.ts`、
  `app/lib/v2/companyLab/aiExplanation/__tests__/claudeClient.test.ts`、
  `app/api/v2/company-labs/_lib/__tests__/aiExplanationHandlers.test.ts`
