# ShrimpX V2 開発日誌

**対象期間：2026年7月24日**
**対象フェーズ：Phase 8C-1（会社ラボ永続化基盤）のdevelop/v2統合～Phase 8C-2（四半期処理フロー接続）～Phase 8C-3A（API接続）／三宅さんテストプレイ開始・初回バグ2件修正**

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

## 4. Phase 8C-3A: 会社ラボAPI接続

Phase 8C-2完了後、独立監査（Fable、結論: 監査十分に合格・develop/v2への統合を承認）を経て、Phase 8C-2をdevelop/v2へfast-forward統合し（メイン作業ディレクトリ`/root/shrimpx`には一切触れず、専用worktreeから`git push origin <sha>:develop/v2`で実施。統合前後でメインディレクトリの`git status`が完全に不変であることを確認済み）、続けて新規ブランチ`feature/v2-company-lab-api`（updated `origin/develop/v2`起点）でPhase 8C-3Aを実装した。

目標は、Phase 8C-2のApplication ServiceをNext.js App RouterのHTTP API経由で安全に呼べるところまでの実装（UIの再構築はPhase 8C-3Bへ明示的に分離）。詳細な設計判断・API仕様は新設した `docs/v2/COMPANY_LAB_API_ARCHITECTURE_v0.1.md` にまとめた。本節では要点のみ記す。

1. **新規APIレイヤーの新設**（`app/api/v2/company-labs/`）。既存の厳格なlib/UI分離（`app/lib/v2/`＝フレームワーク非依存、`app/v2/`＝UI隣接）を壊さずに、Application Serviceと`decisionDraft.ts`（UI隣接だが純TS）の両方へ依存できる「統合層」として新設した。`route.ts`はNextRequest/NextResponseを扱う薄いアダプターに徹し、実処理は`_lib/handlers.ts`のフレームワーク非依存な純粋関数群が行う。
2. **turnId解決ロジックの設計不備を自己発見・修正**（本Phase最大の技術的山場）。当初「毎回`currentTurn`から`turn-${currentTurn}`を再計算する」方式で実装したところ、自作の冪等性テスト（`handlers.test.ts`）で、「四半期処理のコミットは成功したが応答が失われクライアントが再送する」という、turnIdベース冪等性が本来守るべき主要シナリオそのものが壊れていることが判明した（コミット成功時にdraftが原子削除され`currentTurn`が進むため、再送時の再計算が誤って次turn向けの値になり`DRAFT_NOT_FOUND`へ誤って倒れる）。`turnId.ts`に優先順位ベースの解決関数`resolveNewDraftTurnId`（draft保存用）・`resolveInFlightTurnId`（提出・処理用。draft不在時は`current.lastProcessedTurnId`を優先）を追加して修正し、再修正後は冪等性テストが正しく通ることを確認した。
3. **decisionsProviderの配線**。プレイヤー会社は提出済みdraftを既存の`buildDecisionInputFromDraft`で変換、AI会社（4社）は既存の決定論的`generateAutoPolicyDecision`をそのまま使用（新しいAI API呼び出しは導入せず）。
4. **Fable監査Follow-up 2件をApplication Service層で修正**。Minor-1（異なるturnIdの提出済みdraftを別turnIdのdraftで静かに上書きできてしまう）は`companyLabQuarterFlowService.ts`の`saveDraft`に新規`CompanyLabDraftConflictError`ガードを追加。Minor-2（完了済みラボへのsubmitDraftが素通りしうる）は`submitDraft`に`isComplete`チェックを追加。いずれもAPI層ではなく契約レイヤー（Application Service）に実装し、将来の別呼び出し元にも保護が及ぶようにした。回帰テストも追加。
5. **入力検証・エラー応答の統一**。`validation.ts`（labId・draft本体サイズ上限1MB・履歴limit上限50等）と`errorResponse.ts`（ドメインエラー→HTTP status+JSON定型応答、内部詳細非露出）を整備。
6. **応答サイズの抑制**。一覧・状態・履歴ページング応答は要約DTO（`responseDto.ts`）のみを返し、巨大な内部snapshot（turn32時点で約1.04MB）・履歴エントリ全体（最大約2.5MB）は診断専用route（`GET .../history/[turn]`）のみに分離した。
7. **テスト**: 新規`app/api`配下のテスト68件（validation・errorResponse・decisionsProvider・labIdGenerator・responseDto・turnId・handlers結合テスト）を追加。`package.json`のtestスクリプトにNext.jsのプライベートフォルダ（`_lib/`）配下も含めるようグロブを追加。Application Service側にもFable Follow-up 2件ぶんの回帰テストを追加（in-memory/Redis双方の実行コンテキストで計6ケース）。全体テストは1,280件全pass（既存の1,206件＋今回の74件）。

品質確認は、TypeScript（エラー0）、ESLint（エラー0・警告0）、全体テスト1,280件全pass、V1差分なし、メイン作業ディレクトリ完全不変を確認。ビルドは既知の`STAGING_KV_REST_API_URL`環境変数未設定エラー（V1の`/api/game/[gameCode]/admin/clone`route、本Phaseと無関係）のみが再現し、コンパイル・型チェック自体は成功した。

Phase 8C-3Aの成果物は`origin/feature/v2-company-lab-api`へpushし、**develop/v2へのマージは本Phaseでは行わない**（Phase 8C-3BでUIを接続したうえで、あらためて統合判断を行う）。

## 5. Phase 8C-3B: 会社Labプレイヤー画面接続・ブラウザE2E

Phase 8C-3A受入後、Fable監査を今回は省略し（指示により明示的に許可）、(A) Phase 8C-3Aの`develop/v2`統合、(B) プレイヤー画面のUI接続、を続けて実施した。

### 5.1 Phase 8C-3Aの統合

`origin/feature/v2-company-lab-api`（`87ec965`）が`origin/develop/v2`（`51326231740fab97081ecf8658e8827bb5b0768d`）上でfast-forward可能であることを確認したうえで、専用worktree（`/tmp/shrimpx_company_lab_api`）から`git push origin 87ec965...:develop/v2`を実行し、`develop/v2`のHEADを`87ec965`へ更新した。メイン作業ディレクトリ（`/root/shrimpx`）には一切触れておらず、統合前後で`git status --short`が完全に不変であることをスナップショット比較で確認した。続けて、更新後の`origin/develop/v2`から新規worktree（`/tmp/shrimpx_company_lab_ui`）・新規ブランチ`feature/v2-company-lab-ui`を作成した。

### 5.2 `playerCompanyId`のBAL固定fallback廃止

8C-3A時点では、`playerCompanyId`はどこにも永続化されず、四半期処理のたびにAPI層が`"BAL"`固定（フィクスチャに存在しなければ先頭の会社）で渡していた。本Phaseでこれを廃止し、`playerCompanyId`をラボ作成時の必須パラメータ・`CompanyLabPersistedStateV1`の不変フィールドへ変更した。**最も強い保証を選んだ設計判断として、`ProcessQuarterInput`から`playerCompanyId`フィールド自体を完全に削除**し、`processQuarter()`は内部で`stored.playerCompanyId`のみを参照するようにした。これにより「処理requestごとに別会社へ差し替える」ことが実装上そもそも不可能になる（フィールドが存在しないため、悪意・バグのいずれによっても渡しようがない）。詳細な設計判断は`docs/v2/COMPANY_LAB_API_ARCHITECTURE_v0.1.md` §13.1に記録した。

この変更は永続化層（`persistence/types.ts`・`repository.ts`・`redisRepository.ts`・`schema.ts`）・Application Service層・API層（`validation.ts`・`handlers.ts`・`responseDto.ts`）に波及し、既存テストの多くの`createLab`呼び出しに`playerCompanyId`を追加し、`processQuarter`呼び出しから削除する機械的な修正が必要になった。永続化状態バリデータ（`schema.ts`）では、当初`playerCompanyId`をfixturesとクロスチェックする実装を試みたが、既存の多くのテストフィクスチャが`fixtures: []`（空配列）を使っているため常に失敗することに気づき、クロスチェックは`createLab()`側だけの責務とし、バリデータ側は構造検証（空でない文字列であること）のみに留める設計へ修正した（テストを実行する前に自己発見・修正）。

### 5.3 ブラウザ/サーバー境界（`STAGING_ADMIN_TOKEN`の非露出）

既存の`assertStagingAdmin`（Bearerヘッダー認証、8C-3A JSON APIが使用）から、リクエストに依存しない比較ロジック本体`checkStagingAdminToken`を抽出・export化した。新設した`app/lib/companyLabUiSession.ts`は、この共通ロジックを使ってログイン時に一度だけトークンを検証し、成功したら**トークン自体を含まない署名付きopaqueセッション値**をHttpOnly・Secure・SameSite=Laxのcookieへ書き込む。署名鍵はSTAGING_ADMIN_TOKENから都度導出する（ドメイン分離文字列を前置。ローテーションで全セッションが自動失効する）。以後の画面・操作はこのセッションCookieだけを検証し、STAGING_ADMIN_TOKEN自体を読み返すことは一切ない。

ブラウザ→永続化状態への呼び出し経路は、同一Next.jsアプリ内での自己HTTP fetchを避け、Server Component・Server Actionから8C-3Aの`app/api/v2/company-labs/_lib/handlers.ts`の`handle*`関数を**サーバー側から直接呼ぶ**構成にした（8C-3AのJSON API route群自体は変更せず、独立して動作し続ける）。状態変更を伴う全Server Actionには、Next.js組み込みのOrigin検証に加えて、アプリケーション層でも`Origin`/`Host`一致を確認する`assertSameOriginRequest`を多重防御として追加した。

実Upstash認証情報がこの開発環境には無いため、非本番環境限定・明示的な環境変数（`COMPANY_LAB_UI_E2E_IN_MEMORY=1`）でのみ有効になる、既存のin-memory Repository実装へのフォールバック（`uiDependencies.ts`）を追加した。本番環境ではこのフラグは常に無視される。詳細設計は新設した`docs/v2/COMPANY_LAB_UI_ARCHITECTURE_v0.1.md`にまとめた。

### 5.4 画面構成・状態遷移

ラボ一覧・作成・プレイヤー画面（意思決定編集・下書き保存・提出・四半期処理確認・結果表示・履歴要約）を実装した。既存の`DecisionEditor`・`ResultsPanel`・`MarketPanel`・`LabBanner`・`CompanyDecisionDraft`型をすべて再利用し、新規UIコンポーネントはページ・Server Action・ビューモデル組み立て層（`viewModel.ts`）のみに限定した。

`viewModel.ts`では、Phase 8C-2で確立した「turn 2以降はruntime snapshotに加えて直近確定履歴のrecordを注入して復元しないと、前四半期の市場価格等が静かにprehistory値へフォールバックする」という復元ロジック（`restoreCompanyLabStateFromRuntimeSnapshot`）を、実装前の設計段階で意識的に再適用した（重複実装せず、既存関数をそのまま呼ぶ）。

状態はサーバー側永続状態（Redis or in-memoryフォールバック）を唯一の正とし、Client Component側のReact local stateは編集中の一時的な値としてのみ使う。保存・提出・処理いずれかの操作成功後は、`revision`・`currentTurn`・`phase`・`draftUpdatedAt`を結合したkeyでClient Componentを再マウントし、常にサーバーの最新値を初期値にする（Reactの定石パターン）。

### 5.5 テスト・ブラウザE2E

新規ユニットテスト37件を追加した（`stagingAdmin.test.ts` 12件、`companyLabUiSession.test.ts` 18件、`uiDependencies.test.ts` 7件）。`next/headers`のcookies()/headers()に依存する関数（`attemptStagingLogin`等）はNext.jsのリクエストスコープ外から呼ぶと例外になるため直接ユニットテストできないことを確認したうえで、署名検証・有効期限・CSRF判定等の**セキュリティ上重要なロジックはすべてリクエストスコープに依存しない純粋関数として切り出し**（`createSessionToken`/`verifySessionToken`/`deriveSessionSecret`/`isSameOriginHost`をexport化）、そちらを直接テストした。本番環境判定（`isProduction`）はモジュール読込時に一度だけ確定するトップレベルconstであるため、`APP_ENV=production`を設定した別プロセス（`execFileSync`で`npx tsx -e`を起動）でのみ検証した。全体テストは1,325件全pass（8C-3A時点の1,288件＋今回の37件）。

ブラウザE2E（Playwright、Chromium）は`COMPANY_LAB_UI_E2E_IN_MEMORY=1`のNext.js開発サーバーに対して実施し、ログイン（成功・失敗）・セッションCookie属性・管理トークン非露出・ラボ作成（5社選択）・意思決定入力・下書き保存・リロード後の復元・提出・四半期処理・turn2以降への遷移・二重クリックでの多重処理防止（`revision`・`turn`が正確に1回分だけ進むことを確認）・一覧からの再開・存在しないラボの404・ログアウト後の再アクセス拒否・全ターン処理後の完了表示、をすべて確認した（全項目PASS）。詳細は`docs/v2/COMPANY_LAB_UI_ARCHITECTURE_v0.1.md` §8。

品質確認は、TypeScript（エラー0）、ESLint（エラー0・警告0、`<a>`タグを`next/link`の`<Link>`へ修正した1件のみ発生・即修正）、全体テスト1,325件全pass、`npm run build`成功（既知の`STAGING_KV_REST_API_URL`未設定エラーはV1の`/api/game/[gameCode]/admin/clone`routeで従来どおり再現するのみで本Phaseと無関係。ダミー環境変数を与えたビルドでは新規routeを含め全routeが正常に生成されることを確認）、本番ビルドの client bundle（`.next/static`）に管理トークンの値が一切含まれないことをgrepで確認、V1差分なし、メイン作業ディレクトリ完全不変。

成果物は`origin/feature/v2-company-lab-ui`へpushし、**develop/v2へのマージは本Phaseでは行わない**。詳細な設計判断は`docs/v2/COMPANY_LAB_UI_ARCHITECTURE_v0.1.md`、API層への差分は`docs/v2/COMPANY_LAB_API_ARCHITECTURE_v0.1.md` §13を参照。

## 6. 三宅さんテストプレイ開始・Vercel Preview公開・初回バグ2件の発見と修正

Phase 8C-3B完了後、三宅さん自身によるCompany Labテストプレイを開始できる状態にすることを最優先タスクとして取り組んだ。

### 6.1 Vercel Preview公開・アクセス確認

`develop/v2`の最新コミット（`72e7062`）に対応するVercel Preview（`vietnam-shrimp-game-staging-git-develop-v2-tomiyake.vercel.app`）のデプロイ状態がREADYであることを確認した。PreviewはVercelプラットフォーム側のDeployment Protection（Vercel Authentication）でログイン画面へ転送されるため、一時的なバイパスリンク（`_vercel_share`トークン付きshareable URL、有効期限約23時間）を発行して三宅さんへ提供した。自動化ツール側ではこのSSOハンドシェイクを最後まで通過できないことを確認したうえで、三宅さん自身のブラウザでの実アクセスを依頼し、成功を確認した。あわせてProduction環境（別コミット・別ブランチ）には一切影響がないことをVercel APIで確認した。

三宅さんが最初に旧いV1ゲーム（`/api/game`、会社A〜E）へ迷い込んでいたことを、スクリーンショットから確認し、正しいCompany Lab v2の入り口（`/v2/company-lab/play`）へ案内した。二度目のスクリーンショットで、Test12・担当会社BAL・turn1/32が、`initializeCompanyLab()`を独立に実行した計算結果と完全一致することを確認した。

### 6.2 ChatSense向け参謀AI資料・Excel経営状況データブックの作成

テストプレイ開始時点のTest12/BALの初期状態を、JSON/CSVで出力し（`initializeCompanyLab()`実行結果を直接ソースとし、推測値は一切含まない）、Excel管理シート化した。あわせて、ChatSense上でBALの経営相談を行うための「参謀AI」事前プロンプトと、限定情報版（BALのみ）・ゲーム全体版（5社・エンジンパラメータ含む）の2種の参考資料を作成した。三宅さんの依頼により、その後この資料をお手本ファイル（`BAL_経営状況データブック_お手本.xlsx`）と同水準の21シート構成へ拡張し、turn1（意思決定前）時点で確定している情報のみを実データで、決算後にしか確定しない情報は「turn1決算後に判明」と明示したプレースホルダーで構成し直した。

これらの資料・Excelはゲーム本体のコード変更を一切伴わない、Claude側の手動生成物である。ゲーム側に同等の自動出力機能を実装するための仕様書2件（Excel経営状況データブック自動出力機能、毎ターン・ゲーム状態データ化機能）も設計・提出した（実装はしていない）。

### 6.3 バグ発見1：営業人員(salesForceHeadcount)の重複配置

三宅さんが画面上のBALの営業人員合計が54人に見える（実在は18人）ことを指摘したことをきっかけに調査し、次の設計不整合を確認した。

- 販売計画(`salesPlans`)は市場×商品ごとの行で構成され、各行が独立に`salesForceHeadcount`を持つ。
- カバレッジ・処理能力（`sales/allocation.ts`）は各行を独立に評価するため、同じ人員をあたかも複数商品ラインへ同時配置できるかのように扱える（BALなら3市場×3商品=9行×6人=54人ぶんの効果）。
- 一方、人件費（`finance/quarterClose.ts`）は固定フィクスチャ値`salesForceHeadcountTotal`（BALは18人）のみを参照し、各行の入力値を一切見ない。
- 各行の入力に上限チェックが存在しない（`sales/salesForce.ts`は非負整数であることのみ検証）。

三宅さんの了承を得て、`sales/salesForce.ts`へ`validateSalesForceHeadcountBudget()`（1社の全salesPlans行の合計が実在人数を超えないことを検証）を追加し、`companyLab/runner.ts`の`advanceCompanyLabQuarter`冒頭で5社全社に一律適用した。AIの自動方針（`autoPolicy.ts`）自体もこの制約を満たすよう、各行の営業人員を「実在人数÷生成される行数」で均等割りする方式へ修正した（端数は最初の行に寄せる）。

この修正でAI各社の売上・現金水準がより現実的な（従来より小さい）値になった副作用として、`capexIntegration.test.ts`（2ファイル）の一部シナリオで、投資案件が現金不足の四半期に一時停止（`suspended`）状態へ入り、それまで想定していなかった「明示的な再開要求（`resumeRequests`）がない限り自動再開しない」という既存の意図的な設計（`projectLifecycle.ts`のbuildPaymentQueue）が顕在化し、テストが失敗した。これは今回のバグ修正が引き起こした新しい不具合ではなく、従来から存在した「一度提出した投資は完成させたい」という自然なプレイヤー意図を、テストの意思決定プロバイダーが表現していなかったための失敗だったため、該当テストの意思決定プロバイダーへ「自社のsuspended案件を毎期自動的に再開要求する」ロジックを追加して対応した（エンジン本体は変更していない）。

修正後、`npm run test`は1,347件全pass、ESLint・TypeScriptともにエラー0を確認し、`develop/v2`へpush・Vercel Previewへ反映した。

### 6.4 バグ発見2：意思決定画面に資金調達（借入・返済）の入力欄が存在しない

三宅さんが、テストプレイ中に追加借入・返済に関する入力欄が画面に一切ないことを指摘した。調査の結果、`CompanyDecisionInput.financingRequest`は内部データモデル・ドラフト変換層（`decisionDraft.ts`）には存在し、AIの自動方針の推奨値がそのまま初期ドラフトへ設定されていたが、`DecisionEditor.tsx`にこれを表示・編集するUIセクションが一度も実装されていなかった（`decisionDraft.ts`のコメントに「財務画面・借入UIの実装はPhase 8B-1の対象外」と明記されており、意図的なスコープ外のまま後続フェーズでも実装されずに残っていた抜け漏れ）。

`DecisionEditor.tsx`へ「資金調達（借入・返済）」セクションを新規追加した。既存借入一覧（借入ID・種別・残高・年率・返済方式・満期）を参考表示し、追加希望借入額・借入種別（運転資金/設備・長期資金/緊急融資）・希望期間・返済方式（満期一括/元金均等）・任意期限前返済希望額・緊急融資許容可否を編集可能にした。他セクション（国内原料買付等）と同じ入力コンポーネント・レイアウト規約に揃え、計算ロジックは一切持たせていない（表示・編集のみという既存の設計方針を踏襲）。

TypeScript・ESLintともにエラー0、既存テスト1,347件全passを確認したうえで（UI層のみの変更で既存テストへの影響なし）、`develop/v2`へpush・Vercel Previewへ反映した。

### 6.5 今後の申し送り

- turn1完了後の実績（PL/CF・契約履行・市場実勢価格等）は、三宅さんから提供いただく実際の画面情報を唯一の正として、BAL限定版・ゲーム全体版の資料とExcel経営状況データブックを都度更新する（Claude側で推測値を埋めることはしない）。
- 今回の2件は、いずれも三宅さん自身のテストプレイで初めて発見された。「Q1以降の経営結果・ゲームバランス・不自然な挙動はテストプレイで確認しながら修正する」という当初方針どおりの進み方であり、今後も同様の発見的な修正が続く見込み。
