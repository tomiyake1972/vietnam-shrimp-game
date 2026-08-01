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

## 11. npm run build 最終結果（三宅さんの受入確認指示に基づく再実行）

- **結果：失敗**（`EXIT=1`）。ただし失敗箇所は「コンパイル」「TypeScript型チェック」ではなく、
  その後の「ページデータ収集（Collecting page data）」段階。
- コンパイル：`✓ Compiled successfully`／TypeScript：`✓ Finished TypeScript` いずれも成功。
- 失敗の実際のエラー：
  ```
  Error: [redis] 環境変数 "STAGING_KV_REST_API_URL" が設定されていません
  （appEnvironment="development"）。
  Error: Failed to collect page data for /api/game/[gameCode]/admin/clone
  ```
- **今回の変更との関係：無関係。既知のサンドボックス環境制約。**
  失敗しているルートは`/api/game/[gameCode]/admin/clone`（V1のゲーム管理系エンドポイント）で、
  今回変更したV2の`ai-explanation`関連ファイルとは無関係。原因は`app/lib/redis.ts`が
  モジュール読み込み時に`STAGING_KV_REST_API_URL`を要求する既存の実装であり、この環境変数が
  クラウドサンドボックスに設定されていないために発生する。Vercel（本番／Preview）側には
  この環境変数が設定済みのため、実際のデプロイ・実機確認では発生しない
  （現に本件のPreviewデプロイは`READY`まで到達し、Test14／BAL／turn1で正常動作を確認済み）。
- 今回のschema_mismatch対応コミット（`a3a113c`〜`990dba9`）はいずれもこのルート・
  `app/lib/redis.ts`を変更していないため、このビルド失敗は今回の変更で新たに生じたものではなく、
  修正前から存在していた既知の制約がそのまま再現しているだけであると判断する。

## 12. 「営業人員の追加採用」機能のforward-port（Phase 8G §2のみ）

### 12.1 症状・きっかけ

三宅さんより「営業の増員入力が画面から消えている」との報告を受けた。現行の
`develop/v2`のプレイヤー意思決定画面（`DecisionEditor.tsx`）を確認したところ、
「営業人員の追加採用」入力欄が実際に存在しなかった。

### 12.2 根本原因（今回の作業による regression ではないことの確認）

`git log`／`git branch --all --contains`で調査した結果、この機能は元々
`feature/v2-8g-remaining`ブランチ（Phase 8G §2、旧コミット`3f20620`）上に
実装されていたが、このブランチは一度も`develop/v2`へマージされていない
orphanなブランチであることが判明した。

- `feature/v2-8g-remaining`は`89172e2`（7月26日頃）で`develop/v2`から分岐しており、
  その後の`develop/v2`側のSAI-3〜SAI-6の作業には一切合流していない。
- `git merge-base --is-ancestor 3f20620 f6b4e45`は`false`を返し、今回のセッション開始前の
  fast-forwardマージ（`test/sai6-manual-observation-2026-08-01`）以前から、この機能は
  一度も`develop/v2`に存在していなかったことを確認した。

つまり「消えた」のではなく「一度も統合されていなかった」機能であり、
本セッションのschema_mismatch対応や過去のSAI作業による regression ではない。

### 12.3 対応方針（三宅さんの明示指示）

Phase 8G §2〜§6一式を丸ごと統合するのではなく、「営業人員の追加採用」機能のみを
現行の`develop/v2`設計にforward-port（現行コードに合わせた再実装）する方針とした。
`3f20620`のそのままのcherry-pickによるコンフリクト解消は行わず、旧実装は参照資料としてのみ
用いて、ゼロから現行設計に合わせて実装した。

実際に`3f20620`をそのままcherry-pickして試したところ、`persistence/schema.ts`・
`persistence/snapshot.ts`・`persistence/types.ts`・`runner.ts`・`types.ts`・
`DecisionEditor.tsx`・`phase8dPersistence.test.ts`で大量のコンフリクトが発生した
（`develop/v2`側でpersistenceスキーマバージョンやrunner.tsが複数回リファクタされているため）。
三宅さんの指示に従い、この方法は採らずに`git reset --hard HEAD`で中断し、
以降は旧コミットのdiffを設計リファレンスとしてのみ参照する方式に切り替えた。

作業ブランチ：`origin/develop/v2`（HEAD `cac90af`）から新規作成した
`feature/v2-sales-staff-hiring-forward-port`。`develop/v2`・`main`・
`feature/v2-8g-remaining`のいずれも変更・削除していない。

### 12.4 旧実装と現行設計の相違点

- **永続化スキーマバージョン**：旧実装はv3→v4への切り替えとして設計されていたが、
  現行`develop/v2`は既にSAI-5D/5E（消費市場・市場進化）でv4を使用済みのため、
  そのまま流用すると衝突する。今回はv4→v5として新規追加した
  （既存の「追記のみ・移行処理不要」という設計方針に従い、バージョン番号自体で分岐せず、
  キー欠落時は安全なデフォルト値へフォールバックする既存のパターンを維持）。
- **AIの営業人員配分ロジック**：旧実装・現行実装のいずれも、Standard AIの
  `allocateHeadcountAcrossMarkets`は常にfixtureの静的な`salesForceHeadcountTotal`を
  参照しており、動的な採用後人数を反映するようには作られていない。これは今回の
  forward-portで新たに導入した制約ではなく、旧実装の時点から一貫している挙動である。
  「新しい営業採用AIロジックの開発は対象外」という三宅さんの指示と合致するため、
  この挙動はそのまま維持した（Standard AIは常に`salesForceHireCount: 0`を返す）。
- その他、UIコンポーネント構造（`CollapsibleSection`）・`NumberCell`の入力クランプ方式・
  `CompanyDecisionDraft`/`CompanyDecisionInput`の往復変換パターンは、旧実装の意図を保ちつつ、
  現行のコード規約にすべて合わせて再実装した。

### 12.5 実装内容

- 新規ファイル`app/lib/v2/companyLab/salesForceHiring.ts`：会社ごとの営業人員数を
  管理する純粋関数群（`buildInitialSalesForceHiringState`／`deriveNextSalesForceHiringState`／
  `isSalesForceHiringStateEmpty`）。
- `types.ts`／`runner.ts`：`CompanyDecisionInput.salesForceHireCount`（任意、後方互換のため）、
  `CompanyOwnState.salesForceHiringState`・`CompanyLabState.salesForceHiringState`（必須）を追加。
  `advanceCompanyLabQuarter`内で、当期の採用意思決定は当期の
  `validateSalesForceHeadcountBudget`・当期SG&A算出には反映されず（＝当期の販売容量・
  人件費には影響しない）、次期の`salesForceHiringState`にのみ加算される設計とした
  （＝「次四半期から反映」の要件を、runner.tsの状態遷移タイミングそのもので保証）。
- 永続化（`persistence/types.ts`・`schema.ts`・`snapshot.ts`）：
  `CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION`を4→5へ。既存の保存データに
  `salesForceHiringState`キーが存在しない場合は`{ companies: [] }`として復元し、
  `runner.ts`側で会社ごとにfixtureの基準人数へフォールバックするため、
  既存セーブデータは読み込み可能・リセット不要。
- UI（`DecisionEditor.tsx`・`decisionDraft.ts`・`PlayerScreenClient.tsx`）：
  「営業人員の追加採用」セクションを復活。入力単位は人数（0以上の整数、`NumberCell`の
  既存ソフトクランプ方式で負数・小数・NaNを丸める）、初期値0、現在人数・次期見込み人数を
  並べて表示、「次の四半期から」反映される旨を明記。
- `autoPolicy.ts`：Standard AIは常に`salesForceHireCount: 0`を返すよう変更（新規AIロジックは追加せず）。

### 12.6 対象外とした項目（三宅さんの明示指示により今回は含めない）

- Phase 8G §4（消費市場の在庫・前期比表示）
- Phase 8G §5（輸入コスト・landed cost・入荷タイミング表示）
- Phase 8G §6（四半期決算のスプレッドシート風UI）
- コミット`f190d81`（`CollapsibleSection`のdefaultOpenをfalseへ変更する変更）
- `feature/v2-8g-remaining`ブランチ上のドキュメント系コミットの一括統合

### 12.7 テスト・検証結果

- 新規テストファイル`app/lib/v2/companyLab/__tests__/salesForceHiring.test.ts`（11件）：
  初期化・0/正/負/小数/NaN/Infinity/超大値・複数四半期累積・未指定会社のフォールバック等。
- `runner.test.ts`に3件追加：採用当期の販売容量・SG&Aが不変であること、次期に
  採用人数分だけ人件費（`6人×$8,000/四半期`）が増加すること、AI自動方針は常に0人採用で
  既存の計算結果に回帰がないこと。
- `phase8dPersistence.test.ts`に`PS-SFH-1`／`PS-SFH-2`を追加：実際の四半期処理→
  永続化スナップショット化→JSON往復後も`salesForceHiringState`が消失しないこと、
  旧スキーマ（v4、`salesForceHiringState`キー欠落）データが読み込み可能で、
  会社ごとにfixtureの基準人数へ正しくフォールバックすること。
- `decisionDraft.test.ts`に8件追加：`summarizeSalesForceHiring`のプレビュー計算、
  draft往復での採用予定人数の保持・丸め、旧draft（キー自体が存在しない場合）の0フォールバック。
- 既存の型整合性維持のための機械的修正：`CompanyOwnState`／`CompanyLabState`／
  `CompanyLabRuntimeSnapshot`へ必須フィールドを追加したことに伴う9箇所の既存テスト・
  ヘルパーファイルの型エラー修正（新フィールドの追加のみ、ロジック変更なし）。
- 最終検証結果：
  - `npm test`：**2084件全てpass**（fail 0）。
  - `npx tsc --noEmit`：**エラー0件**。
  - `npm run lint`（eslint）：**エラー0件**（既存の警告4件のみ、今回の変更とは無関係）。
  - `npm run build`：コンパイル・TypeScript型チェックは成功。ページデータ収集段階で
    `STAGING_KV_REST_API_URL`未設定により失敗（第11節と同一の既知のサンドボックス環境制約、
    `/api/game/[gameCode]/admin/clone`ルートで発生、今回の変更とは無関係）。
- 実機確認（Playwright、`COMPANY_LAB_UI_E2E_IN_MEMORY=1`によるローカルdevサーバー）：
  新規ラボ作成→「営業人員の追加採用」セクションに6人入力→提出→四半期処理→再読込を実施し、
  turn 2で「配分可能 24人」（採用前18人＋採用6人）へ正しく反映されることを実機で確認した。

### 12.8 今後の検討事項

- 今回はプレイヤーUIの復活のみが対象であり、Standard AI側の動的採用ロジックの新規開発は
  意図的に対象外とした。将来AIにも採用判断をさせる場合は、別タスクとして
  `allocateHeadcountAcrossMarkets`呼び出し側の設計から見直す必要がある。
- 今回の変更は`feature/v2-sales-staff-hiring-forward-port`ブランチ上のみであり、
  `develop/v2`・`main`へはまだマージしていない（三宅さんの指示によりマージは別タスク）。

## 13. 「営業人員の減員・退職金」機能の追加（forward-portの続き作業）

### 13.1 経緯

三宅さんより、営業人員の追加採用に続けて「減員」も実装するよう、詳細仕様（増員・減員の
反映タイミング、退職金の計上方法、同時入力禁止、schema versionの扱い等）を明示指示された。
追加の仕様検討は不要との指示のため、以下は指示内容をそのまま実装した記録である。

### 13.2 実装内容（要点）

- `app/lib/v2/companyLab/salesForceHiring.ts`：`deriveNextSalesForceHiringState`が
  減員（layoffCount）も受け取れるよう拡張し、次期人数＝前期末人数＋採用−減員（0未満には
  ならない）とした。新規関数`computeEffectiveSalesForceLayoffCount`で「実際に減員される
  人数」（前期末人数で頭打ち）を一箇所に集約し、次期人数算出と退職金コスト算出の両方で
  同じ値を使う（二重実装によるズレを防止）。
- `runner.ts`：会社の意思決定受理時に、採用数・減員数が同一四半期に両方>0であれば
  `CompanyLabError`を投げて拒否する（既存の`validateSalesForceHeadcountBudget`と同じ
  検証タイミング・扱い）。減員対象者は当期の配分可能人数・当期の通常給与（SG&A）には
  含まれたまま（既存の採用の設計と対称）。当期に実際に減員される人数を
  `buildCompanyQuarterBusinessActuals`へ`salesForceSeveranceCount`として渡す。
- `finance/quarterClose.ts`：`salesForceSeveranceCount × 2四半期 × salesForceSalaryUsdPerQuarter`
  を退職金として算出し、SG&A合計（したがって営業利益・キャッシュフローの現金支出）へ
  当期一度だけ加算する。既存のコスト記録（固変分解）にも`salesForceSeverance`勘定を
  新設し、`behavior: "variable"`・`shortTermReducibility: "reducible"`として記録した
  （既存の`salesForceSalary`が`stepFixed`・`committed`なのとは異なる特性であることを
  明示するため）。`salesForceSeveranceCount`は既存呼び出し元との後方互換のためoptionalとし、
  省略時は退職金0として扱う。
- UI（`DecisionEditor.tsx`・`decisionDraft.ts`・`PlayerScreenClient.tsx`）：「営業人員の
  追加採用」セクションを「営業人員の追加採用・減員」に改称し、減員入力欄・退職金見積り
  （当期一括）・次期見込み人数を追加。採用と減員が同時に>0の場合は赤字の警告文を表示し、
  「この内容で提出する」ボタンをクライアント側でも無効化する（サーバー側の検証だけに
  頼らない、既存の営業配分オーバー時と同じ二重防御方針）。
- `autoPolicy.ts`：Standard AIは常に`salesForceLayoffCount: 0`を返すのみとし、新規の
  AI減員判断ロジックは追加していない（指示どおり後続課題）。
- 永続化スキーマ：三宅さんの明示指示により`CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION`を
  5→6へ更新した。`CompanyLabRuntimeSnapshot`の構造自体は変更していない
  （`salesForceHiringState`の各社`headcount`は増員・減員のいずれでも同じ形のまま
  増減するだけで、新規フィールド追加は不要だったため）。`CompanyDecisionInput`へ
  `salesForceLayoffCount`をoptionalとして追加した（既存の`salesForceHireCount`と同じ
  後方互換方針。既存のschemaVersion:1〜5データはこのキーが存在しないため0として復元される）。

### 13.3 判明した既存設計上の制約（今回の変更が原因ではない既存の挙動）

統合テスト作成中に、Standard AIの営業人員配分ロジック（`autoPolicy.ts`の
`allocateHeadcountAcrossMarkets`呼び出し）が、動的な現在人数
（`ownState.salesForceHiringState.headcount`）ではなく、常に静的なfixture基準値
（`fixture.salesForceHeadcountTotal`）を参照して配分を提案する設計であることを再確認した。
これは採用機能の実装時点から一貫した既存の設計（今回新たに導入した挙動ではない）だが、
採用（人数が基準値以上に増える一方）では問題が表面化しなかったのに対し、減員
（人数が基準値未満に減る）では、減員後に画面へ表示される自動方針の提案がそのまま
提出すると、配分人数が実在人数を超えて`validateSalesForceHeadcountBudget`に拒否される
ケースが生じうることが分かった。これは既存の「営業配分オーバー時は警告表示＋提出ブロック」
という既存のソフト警告フローの範囲内で正しく検知・防止される（クラッシュや不正な状態には
ならない）が、減員直後の四半期はプレイヤーが自動方針の営業配分を手動で減らす操作を
求められる可能性がある。Standard AIの営業配分ロジック自体の改修は、当初の指示どおり
今回のスコープ外（AIの減員判断ロジックの新設と同様、後続課題）としたため、対応していない。

### 13.4 検証結果

- `npm test`：**2106件全てpass**（fail 0。今回の追加テスト23件を含む）。
- `npx tsc --noEmit`：**エラー0件**。
- `npm run lint`（eslint）：**エラー0件**（既存の無関係な警告4件のみ）。
- `npm run build`：コンパイル・TypeScript型チェックは成功。ページデータ収集段階で
  `STAGING_KV_REST_API_URL`未設定により失敗（第11節と同一の既知のサンドボックス環境制約、
  今回の変更とは無関係）。
- 実機確認（Playwright、`COMPANY_LAB_UI_E2E_IN_MEMORY=1`によるローカルdevサーバー、
  `feature/v2-sales-staff-hiring-forward-port`ブランチ上での実装確認用。**Test14
  （`test/sai6-manual-observation-2026-08-01`ブランチ）にはまだ反映されていない**）：
  減員5人・採用3人を同時入力→赤字警告表示＋提出ボタン無効化を確認→採用を0に修正して
  警告解消・提出可能に戻ることを確認→提出・四半期処理・再読込を行い、turn2で
  現在の営業人員が13人（18−5）へ正しく反映されることを実機で確認した。

### 13.5 今回のスコープ外（三宅さんの明示指示どおり）

- 採用時の別建て採用費・研修費の新設。
- Standard AIの減員判断ロジックの新設（今回は常に減員数0で従来挙動を維持）。
- `test/sai6-manual-observation-2026-08-01`（Test14用）ブランチ・`develop/v2`・`main`への
  マージ・反映、およびdeploy。
