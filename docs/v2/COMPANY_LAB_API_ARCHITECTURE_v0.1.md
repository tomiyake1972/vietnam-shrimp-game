# ShrimpX V2 — 会社ラボ API接続（Phase 8C-3A） アーキテクチャ v0.1

対象ブランチ: `feature/v2-company-lab-api`（`origin/develop/v2` 上のPhase 8C-1（永続化基盤）・Phase 8C-2（Application Service／四半期処理フロー接続）の上に構築）。

## 0. 本Phaseの位置づけ・スコープ

Phase 8C-2までで、Company Labの永続化（Redis Repository・原子コミット）とApplication Service（`companyLabQuarterFlowService.ts`）が完成した。本Phase（8C-3A）は、そのApplication ServiceをNext.js App RouterのHTTP API経由で安全に呼べるところまでを実装する。**UIの再構築は行わない**（既存の`app/v2/company-lab/page.tsx`はこのPhaseでは変更していない）。UIをこのAPIへ接続する作業はPhase 8C-3Bで行う。

垂直スライスとしての到達点は次のとおり：

```
(将来のUI) → Next.js API route → CompanyLabQuarterFlowService → CompanyLabStateRepository(Redis) → シミュレーションエンジン
```

## 1. 層構造とディレクトリ配置

既存コードベースの厳格なlib/UI分離（`app/lib/v2/`＝フレームワーク・UI非依存、`app/v2/`＝UI隣接コード）を壊さずに、Application Serviceと`decisionDraft.ts`（UI隣接だがReactを持たない純TS）の両方に依存する配線コードを置く必要がある。そのため、新規に「統合層」として`app/api/v2/company-labs/`を新設した。

```
app/api/v2/company-labs/
  route.ts                          POST/GET /api/v2/company-labs
  [labId]/route.ts                  GET      /api/v2/company-labs/[labId]
  [labId]/draft/route.ts            PUT      /api/v2/company-labs/[labId]/draft
  [labId]/draft/submit/route.ts     POST     /api/v2/company-labs/[labId]/draft/submit
  [labId]/process-quarter/route.ts  POST     /api/v2/company-labs/[labId]/process-quarter
  [labId]/history/route.ts          GET      /api/v2/company-labs/[labId]/history
  [labId]/history/[turn]/route.ts   GET      /api/v2/company-labs/[labId]/history/[turn]（診断専用）
  _lib/                              Next.js「プライベートフォルダ」（ルーティング対象外）
    withApiContext.ts                認証→依存関係組立→handler呼出→NextResponse変換の共通アダプター
    dependencies.ts                  実行時（Redis）依存関係の遅延組立
    handlers.ts                      フレームワーク非依存のハンドラー本体（route.tsから呼ばれる）
    validation.ts                    入力検証
    errorResponse.ts                 ドメインエラー→HTTP変換
    turnId.ts                        turnId導出・解決ロジック（§4参照）
    decisionsProvider.ts             decisionsProviderの配線（§5参照）
    responseDto.ts                   応答DTO（巨大snapshotの除外）
    labIdGenerator.ts                サーバー生成labIdの衝突検査つき生成
    __tests__/                       上記各モジュールのユニット・結合テスト
```

`route.ts`は薄いアダプターに徹し、`NextRequest`からJSONボディ・パスパラメータ・クエリを取り出して`handlers.ts`の対応する`handle*`関数へ渡すだけ。`handlers.ts`側は`NextRequest`/`NextResponse`を一切importしない、純粋な非同期関数群として実装した（指示§11「実Upstash認証情報なしでもAPIの主要経路を検証できるようにする」を、テストが`NextRequest`を組み立てずに`handlers.ts`を直接呼べる形で実現している）。

## 2. 認証

既存の`app/lib/stagingAdmin.ts`の`assertStagingAdmin`をそのまま再利用する。`Authorization: Bearer {STAGING_ADMIN_TOKEN}`ヘッダーが必須で、本番環境（`isProduction`）では常に403。

Company Labの全route（GETを含む）に一律で適用した。V1のスナップショット一覧のように読み取り系だけ認証を免除する設計も検討したが、Company Labは今のところ「進行中ゲームを画面上で見る」閲覧用途を持たないため、Redisへの新規アクセス経路を極力絞る側を優先した。UI接続が具体化するPhase 8C-3Bで、この認証方針（特に読み取り系）は再検討してよい。

## 3. API一覧・リクエスト/レスポンス概要

いずれも応答は`Content-Type: application/json`。エラー応答の形式は §6 を参照。

### 3.1 `POST /api/v2/company-labs` — ラボ作成
- リクエスト: `{ labId?: string, scenarioId: string, mode: "canonical"|"variation", seed: string, turns: number }`
- `labId`省略時はサーバーが`labIdGenerator.ts`で衝突検査つき生成する（`lab-` + base36ランダム6文字、Redis上の既存labIdと衝突すれば最大10回まで再試行。V1の`app/api/game/route.ts`と同じ「生成→存在確認→再試行」パターンを踏襲）。
- 成功: `201 { lab: CompanyLabSummaryDto }`
- 重複labId: `409 LAB_ALREADY_EXISTS`

### 3.2 `GET /api/v2/company-labs` — ラボ一覧
- 成功: `200 { labs: CompanyLabSummaryDto[] }`（各labIdの現在状態を要約で返す。巨大な内部snapshotは含まない）

### 3.3 `GET /api/v2/company-labs/[labId]` — ラボ状態取得
- 成功: `200 { lab: CompanyLabStateDto }`（`CompanyLabSummaryDto` + `draft: CompanyLabDraftSummaryDto | null`）
- 不存在: `404 LAB_NOT_FOUND`

### 3.4 `PUT /api/v2/company-labs/[labId]/draft` — ドラフト保存
- リクエスト: `{ turnId?: string, draft: unknown }`（`draft`本体の詳細スキーマは`app/v2/company-lab/decisionDraft.ts`の`CompanyDecisionDraft`。APIレイヤーは形の粗いチェック（サイズ上限のみ）に留め、深い妥当性検証は既存のdraft⇔engine変換層に委ねる）
- 成功: `200 { draft: CompanyLabDraftSummaryDto }`
- turnId不一致（クライアントが明示指定した場合のみ）: `409 TURN_MISMATCH`
- 別turnIdの提出済みdraftが既に存在: `409 DRAFT_CONFLICT`（Fable Minor-1対応。§7参照）
- 完了済みラボ: `409 LAB_COMPLETED`

### 3.5 `POST /api/v2/company-labs/[labId]/draft/submit` — ドラフト提出
- リクエストボディなし
- 成功: `200 { draft: CompanyLabDraftSummaryDto }`
- draft不在: `409 DRAFT_NOT_FOUND`
- 完了済みラボ: `409 LAB_COMPLETED`（Fable Minor-2対応。§7参照）

### 3.6 `POST /api/v2/company-labs/[labId]/process-quarter` — 四半期処理
- リクエスト: `{ turnId?: string }`（省略可。§4参照）
- 成功: `200 { status: "processed"|"alreadyProcessed", revision: number, turn: number, turnId: string, processedAt: string }`
  - `alreadyProcessed`も200（エラーではない）で返す。同一turnIdの再試行が安全であることの外部的な現れ。
- draft未提出: `409 DRAFT_NOT_FOUND` / `409 DRAFT_NOT_SUBMITTED`
- turnId不一致: `409 TURN_MISMATCH`
- revision競合: `409 REVISION_CONFLICT`
- ロック競合（処理中）: `423 LOCK_UNAVAILABLE`
- エンジン処理自体の失敗: `422 QUARTER_PROCESSING_FAILED`

### 3.7 `GET /api/v2/company-labs/[labId]/history?afterTurn=&limit=` — 履歴ページング取得
- クエリ: `afterTurn`（0以上の整数、省略可）、`limit`（1〜50、省略時デフォルト10）
- 成功: `200 { entries: CompanyLabHistoryEntrySummaryDto[], nextAfterTurn: number|null }`
- 常にRepositoryの`loadHistoryPage`（カーソル方式）を使い、`loadFullHistory`は使わない。

### 3.8 `GET /api/v2/company-labs/[labId]/history/[turn]` — 単一履歴エントリ全体取得（診断専用）
- 成功: `200 { entry: CompanyLabQuarterHistoryEntry }`（`pre/postProcessingStateSnapshot`・`record`を含む、1件あたり最大約2.5MBの完全なエントリ）
- **このrouteだけ**が巨大な内部snapshotを返す。通常の一覧・状態・履歴ページング応答（3.2/3.3/3.7）は要約DTOのみを返し、経路を明確に分離している。

## 4. turnIdの生成・保持・再試行方式

指示書が提示した2方式「(a) クライアントが生成・保持」「(b) draft作成時にサーバーが払い出し、以後同じ値を使う」のうち、実装は値自体を`(labId, 対象turn番号)`から決定論的に導出する第三の方式（`turnId.ts`の`deriveTurnId(turn) = "turn-${turn}"`）を採用した。クライアント側の乱数生成・保持や、サーバー側の追加ストレージが不要という利点がある。

**ただし単純に「毎回、呼び出し時点の`currentTurn`からその場で再計算する」だけでは、実装中に自分のテスト（`handlers.test.ts`の冪等性テスト）で不十分であることが判明した**：`processQuarter`がコミットに成功すると、`currentTurn`は次のturnへ進み、コミット済みturnのdraftは原子的に削除される。ここで「コミット自体は成功したが応答が失われ、クライアントが同じ操作を再送する」というturnIdベース冪等性の主目的そのものにあたるケースが起きると、再送時に読み直した`currentTurn`は既に次のturnを指しており、素朴な再計算は別のturnId（まだdraftすら無い次turn向けの値）を導出してしまい、`DRAFT_NOT_FOUND`（409）として誤って拒否される（正しい`alreadyProcessed`（200）に到達できない）。

この不備を修正するため、`turnId.ts`に優先順位ベースの解決関数を2つ用意し、`handlers.ts`から呼び出す：

- **`resolveNewDraftTurnId`**（`PUT .../draft`で使用）: ① 既存の（未提出/提出済みの）draftがあればそのturnIdをそのまま使う（継続編集）。② 無ければ`currentTurn`から新規導出する。draftは常に「これから提出する対象」であり、過去の確定turnId（`lastProcessedTurnId`）を参照する意味がないため、これは見ない。
- **`resolveInFlightTurnId`**（`POST .../draft/submit`・`POST .../process-quarter`で使用）: ① 現在保存されているdraftのturnId（存在すれば、それが今まさに提出・処理しようとしている対象そのもの）。② draftが無ければ`current.lastProcessedTurnId`（直近処理成功→draft原子削除後の状態。応答消失後の再送はここで直近確定turnIdへ正しく解決され、Application Service層の`current.lastProcessedTurnId === turnId`判定＝`alreadyProcessed`へ到達する）。③ どちらも無ければ`currentTurn`から新規導出する（このラボで一度もdraftが作られていない最初の状態のみ）。

クライアントが`turnId`を明示的に指定した場合（`draft`・`process-quarter`とも省略可能なオプション欄）、サーバー側の解決値と一致するかを検証し、不一致なら`409 TURN_MISMATCH`として明示的に拒否する（対象turn外への誤送信の検出）。

## 5. decisionsProviderの配線（`decisionsProvider.ts`）

Phase 8C-2の`companyLabQuarterFlowService.ts`は、`CompanyLabDecisionsProvider`という注入点を通じて「全社ぶんの意思決定（`CompanyDecisionInput`）をどう組み立てるか」を呼び出し側に委ねる設計になっている（lib層はUI型の`CompanyDecisionDraft`に依存しないため）。本Phaseでこれを実装した：

- **プレイヤー会社**（`playerCompanyId`と一致する会社。デフォルトは`COMPANY_LAB_COMPANY_IDS[0]`＝`"BAL"`、フィクスチャに存在しなければ先頭のフィクスチャ）: 提出済みdraft本体（`unknown`）を、まず構造検証（`isPlausibleCompanyDecisionDraft`。companyId一致・必須フィールドの配列/オブジェクト存在チェック）してから、既存の`app/v2/company-lab/decisionDraft.ts`の`buildDecisionInputFromDraft`で`CompanyDecisionInput`へ変換する。構造検証・変換のいずれかが失敗した場合は`CompanyLabQuarterProcessingError`（HTTP 422）として扱い、型変換中の生の例外がAPI応答へ漏れないようにしている。
- **AI会社**（プレイヤー以外の4社）: 既存の決定論的`generateAutoPolicyDecision`をそのまま呼ぶ。**新しいAI API呼び出しは本Phaseでは一切導入していない**。同一入力・同一ロジックであれば常に同じ結果になることをテスト（`decisionsProvider.test.ts`）で確認済み。
- 全社ぶんの意思決定が揃わない場合（フィクスチャに存在しない会社を`playerCompanyId`に指定する等）や、companyIdの重複・範囲外は、既存のApplication Service側の検証にそのまま委ねる。

配置は`app/api/v2/company-labs/_lib/decisionsProvider.ts`（統合層）。`app/lib/v2/companyLab/`（純粋lib層）へは置かない — lib層がUI隣接の`decisionDraft.ts`へ依存することになり、8C-1/8C-2で確立したlib/UI分離が崩れるため。

## 6. ドメインエラー → HTTP応答マッピング（`errorResponse.ts`）

応答形式は`{ error: { code: string, message: string } }`で統一。

| ドメインエラー | HTTP status | code |
|---|---|---|
| `CompanyLabNotFoundError` | 404 | `LAB_NOT_FOUND` |
| `CompanyLabHistoryEntryNotFoundError` | 404 | `HISTORY_ENTRY_NOT_FOUND` |
| `CompanyLabAlreadyExistsError` | 409 | `LAB_ALREADY_EXISTS` |
| `CompanyLabCompletedError` | 409 | `LAB_COMPLETED` |
| `CompanyLabDraftNotFoundError` | 409 | `DRAFT_NOT_FOUND` |
| `CompanyLabDraftNotSubmittedError` | 409 | `DRAFT_NOT_SUBMITTED` |
| `CompanyLabDraftAlreadySubmittedError` | 409 | `DRAFT_ALREADY_SUBMITTED` |
| `CompanyLabDraftConflictError`（新規。§7） | 409 | `DRAFT_CONFLICT` |
| `CompanyLabDraftTurnMismatchError` | 409 | `DRAFT_TURN_MISMATCH` |
| `CompanyLabRevisionConflictError` | 409 | `REVISION_CONFLICT` |
| `CompanyLabTurnConflictError` | 409 | `TURN_CONFLICT` |
| `CompanyLabLockConflictError` | 409 | `LOCK_CONFLICT` |
| `CompanyLabLockUnavailableError` | 423 | `LOCK_UNAVAILABLE` |
| `CompanyLabQuarterProcessingError` | 422 | `QUARTER_PROCESSING_FAILED` |
| `CompanyLabError`（エンジン層。不正scenarioId・turns範囲外等） | 400 | `INVALID_REQUEST` |
| APIレイヤーの入力形式検証エラー（`validation.ts`） | 400 | `INVALID_REQUEST` |
| その他（`CompanyLabIntegrityError`・`CompanyLabRepositoryError`・(de)serialization失敗・`CompanyLabRedisKeyGuardError`・未分類の例外） | 500 | `INTERNAL_ERROR`（定型メッセージのみ。元例外の詳細は応答に含めない） |

500応答のメッセージは常に固定の定型文（`GENERIC_INTERNAL_MESSAGE`）で、内部snapshot・Redisキー・lock token・環境変数・スタックトレースは一切含めない。詳細はサーバー側の`console.error`にのみ出力する（`withApiContext.ts`）。この非露出はテスト（`errorResponse.test.ts`）で確認済み。

## 7. Fable監査Follow-up 4件の対応状況

1. **異なるturnIdによる提出済みdraftの静かな上書き**（Minor-1）: 本Phaseで修正。`companyLabQuarterFlowService.ts`の`saveDraft`に、既存の提出済みdraftが異なるturnIdを持つ場合に`CompanyLabDraftConflictError`（新規、`persistence/errors.ts`）を投げるガードを追加した。**Application Service層（契約レイヤー）に実装した**ため、API層だけでなく将来の別呼び出し元にも保護が及ぶ。回帰テスト（同一turnId再保存時の既存動作＝`DraftAlreadySubmittedError`が壊れていないこと）も追加済み。
2. **完了済みラボへのsubmitDraft**（Minor-2）: 本Phaseで修正。`submitDraft`に、`saveDraft`と同様の`isComplete`チェックを追加し、`CompanyLabCompletedError`を明示的に投げる。current・draft・historyが変更されないことをテストで確認済み。
3. **in-memory版とRedis版のロックTTL実装の差異**: 既知の差異として現状維持。本Phaseでは対応しない（指示どおり）。
4. **将来のラボ削除機能とZSETスコアの整合性問題**: 将来課題として記録のみ。本Phaseでは実装しない。

## 8. Redis接続・環境分離

既存のV2初期化チェーン（`readAppEnvV2FromEnv()` → `createDefaultCompanyLabRedisClient(appEnv)` → `createCompanyLabStateRepository({client, appEnv})` → `createCompanyLabQuarterFlowService({repository})`）を、`dependencies.ts`の`createCompanyLabApiDependencies()`に一本化した。各route.tsが個別に初期化コードを複製することはない。この関数はモジュール読み込み時には一切呼ばれず、必ずroute handler内部（`withApiContext.ts`経由）で遅延呼び出しされる（ビルド時・モジュール読み込み時に環境変数未設定で失敗しないようにするため）。

環境変数未設定・Redis接続不可はここで捕捉し、内部詳細を含まない500として返す（`withApiContext.ts`）。APP_ENVベースのキー接頭辞・Company Lab Redisキーガードは既存のRepository実装（Phase 8C-1/8C-2）をそのまま利用しており、API層で独自のキー生成やガード回避は一切行っていない。V1キーへの書き込みは発生しない。

## 9. 並行処理・処理時間

安全性の中核はPhase 8C-2のRedis lock（`SET NX PX`取得・compare-and-delete Lua解放）と原子コミットLuaに委ねており、API層では「先に読んで確認したから安全」という疑似CASは一切行っていない。`handleProcessQuarter`は毎リクエストごとに新しい`lockToken`（`randomUUID()`）を生成するが、これは同一turnIdの冪等判定（ロック取得より前に行われる）を損なわない。

処理時間の実測（in-memory Repository、5社×32ターンのbaselineシナリオ、`handleProcessQuarter`のエンジン実行部分のみを計測。実Upstash認証情報がこの環境に無いため、Redis REST往復を含む実測はPhase 8C-2の診断（原子コミットREST要求約3.65MB）から間接的に見積もるのみ）：1ターンあたり平均約14ms・最大約51ms（初回のJITウォームアップを含む）。ロックTTLのデフォルト（`DEFAULT_PROCESSING_LOCK_TTL_MS = 60,000`＝60秒）に対して十分に余裕がある。Vercelの実行時間制限が厳しい環境では、Redis REST往復（ペイロードサイズから見て数百ms〜数秒のオーダーになりうる）が支配的になる可能性があるが、実測できていないため、ロック自動延長・非同期ジョブ化等は本Phaseでは実装せず、この事実と見積り値の報告に留める。

## 10. 応答サイズの抑制方針

`CompanyLabPersistedStateV1.currentState.runtime`（内部snapshot、turn32時点で実測約1.04MB）と`CompanyLabQuarterHistoryEntry`（1件あたり最大約2.5MB）は、通常の一覧・状態取得・履歴ページング応答には一切含めない。`responseDto.ts`の`toLabSummaryDto`/`toDraftSummaryDto`/`toLabStateDto`/`toHistoryEntrySummaryDto`が、revision・turn・完了状態等の軽量な値のみへ変換する。フル内部snapshotが必要な診断用途は`GET .../history/[turn]`だけに分離してある（§3.8）。

## 11. Phase 8C-3BのUI統合に向けた申し送り

- 呼び出し順序の想定: `POST /company-labs`（作成）→ `GET /company-labs/[labId]`（画面初期表示、`draft`欄で編集再開状態を復元）→ `PUT .../draft`（編集の都度保存、`turnId`は省略してサーバー解決に任せてよい）→ `POST .../draft/submit`（提出）→ `POST .../process-quarter`（処理実行。応答が届かなかった場合はクライアント側で同一リクエストを再送してよい＝冪等）→ `GET .../history?afterTurn=...&limit=...`（結果の一覧・ページング）。
- `playerCompanyId`は現状APIが`"BAL"`固定（フィクスチャに存在しなければ先頭の会社）。UIが5社の中からプレイヤー会社を選べるようにする場合、`decisionsProvider.ts`の`DEFAULT_PLAYER_COMPANY_ID`をリクエストパラメータ化する対応がPhase 8C-3B以降で必要になる。
- `draft`本体のスキーマはAPI層では深く検証していない（サイズ上限のみ）。UIは`app/v2/company-lab/decisionDraft.ts`の`CompanyDecisionDraft`型をそのまま使ってdraftを組み立てること。
- 認証（`Authorization: Bearer`）は現状すべてのroute（GET含む）に必須。UIから直接叩く場合、トークンの扱い（サーバーコンポーネント経由にする等、クライアントへ露出させない設計）をPhase 8C-3Bで検討する必要がある。
- 全route診断専用の`GET .../history/[turn]`は、通常のプレイ画面からは呼ばない想定（デバッグ・GM用途）。

## 12. 対象外（このPhaseでは実装していない）

プレイヤー画面の再構築、5社UIの完成、AI生成API方式での意思決定、Vercel本番デプロイ、Redis Cluster対応、非同期ジョブ基盤、ロック自動延長、古い履歴の圧縮、スナップショット差分保存、ラボ削除/リセット機能、V1側の変更、他worktreeの作業との統合。UIとの接続はPhase 8C-3Bで行う。
