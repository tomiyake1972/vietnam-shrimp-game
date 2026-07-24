# ShrimpX V2 — 会社ラボ プレイヤー画面・ブラウザ/サーバー境界（Phase 8C-3B） アーキテクチャ v0.1

対象ブランチ: `feature/v2-company-lab-ui`（`origin/develop/v2` 上のPhase 8C-3A（会社ラボAPI接続）の上に構築。8C-3AのHEAD＝`87ec965945ca245d43ccef5ca981be189e8f611c`をfast-forward統合した状態が起点）。

## 0. 本Phaseの位置づけ・スコープ

Phase 8C-3Aまでで、Company LabのApplication Service（8C-2）とNext.js App RouterのHTTP API（8C-3A、`docs/v2/COMPANY_LAB_API_ARCHITECTURE_v0.1.md`）が完成した。本Phase（8C-3B）は、実際のブラウザ操作からこの永続化状態へ到達し、安全に次四半期へ進められるところまでを実装する。

完成条件は「見栄えの完成」ではなく、次の垂直スライスが実際のブラウザ操作で動くこと：

```
ブラウザ（プレイヤー画面） → Next.js Server Component / Server Action
  → app/api/v2/company-labs/_lib/handlers.ts（8C-3A・既存）
  → CompanyLabQuarterFlowService（8C-2・既存） → Repository(Redis) → シミュレーションエンジン
```

対象外（このPhaseでは実装していない）: 本番向けの実プレイヤーアカウント認証、複数プレイヤー同時参加、チャット風の意思決定UI、AIアドバイザーチャット、全面的なデザイン刷新、Company Lab以外のV1画面変更、ゲームバランス調整、UIでの巨大履歴snapshot表示、Fable監査、`develop/v2`への最終マージ。詳細は§9参照。

## 1. ディレクトリ配置

```
app/v2/company-lab/play/
  page.tsx                 GET /v2/company-lab/play             ラボ一覧（§4.1）
  actions.ts                ログアウトServer Action
  login/
    page.tsx                GET /v2/company-lab/play/login       ログイン画面
    actions.ts               ログインServer Action
  new/
    page.tsx                GET /v2/company-lab/play/new          ラボ作成画面（§4.1）
    actions.ts                ラボ作成Server Action
  [labId]/
    page.tsx                 GET /v2/company-lab/play/[labId]     プレイヤー画面（§4.2）
    not-found.tsx             ラボ不存在時の404表示
    actions.ts                 保存・提出・処理Server Actions（§6）
    PlayerScreenClient.tsx     Client Component（意思決定編集・状態表示）
  _lib/                       Next.js「プライベートフォルダ」（ルーティング対象外）
    uiDependencies.ts          UI用の依存関係解決（§2.4）
    viewModel.ts                プレイヤー画面用のサーバー専用ビューモデル組み立て（§5）
    companyOptions.ts           会社選択肢（既存fixture生成関数から生成。ハードコードしない）
    __tests__/

app/lib/
  companyLabUiSession.ts       セッションCookie発行・検証・CSRF判定（§2）
  stagingAdmin.ts               既存。checkStagingAdminTokenを抽出・export（§2.1）
  __tests__/
    companyLabUiSession.test.ts
    stagingAdmin.test.ts
```

既存の`app/v2/company-lab/page.tsx`（Phase 6.2からのGM/開発者向け統合テスト画面。Redis接続なし、ブラウザ内完結）は**変更していない**。新しいプレイヤー画面は別ルート（`/v2/company-lab/play/**`）として追加し、既存の`DecisionEditor`・`ResultsPanel`・`MarketPanel`・`LabBanner`・`decisionDraft.ts`をそのまま再利用する（新規UIコンポーネントの重複実装を避ける）。

## 2. 認証・セッション境界（指示§7）

### 2.1 設計方針

`STAGING_ADMIN_TOKEN`は、ブラウザへ一切到達させない。Client Component・JSバンドル・`localStorage`/`sessionStorage`・通常Cookie・URL・HTML・API応答・クライアント側ログ・`NEXT_PUBLIC_*`のいずれにも含めない。ブラウザから既存の管理API（Bearerトークン付き）へ直接fetchする構成も採らない。

既存の`app/lib/stagingAdmin.ts`の`assertStagingAdmin`（`NextRequest`のBearerヘッダーからトークンを取り出して検証する、8C-3A JSON APIが使う関数）から、リクエストに依存しない比較ロジック本体を`checkStagingAdminToken(provided: string | null | undefined)`として抽出した。`assertStagingAdmin`はこれを呼ぶだけの薄いラッパーになった（ふるまいは変更なし）。新しいログインServer Actionも同じ`checkStagingAdminToken`を呼ぶ。**本番判定・トークン比較ロジックは、これ一箇所にしか存在しない。**

### 2.2 ログイン〜セッションCookie発行

1. ログイン画面（`/v2/company-lab/play/login`）はServer Componentで、`<form action={loginAction}>`という素のHTMLフォーム（`type="password"`のトークン入力欄）を描画する。JavaScriptに依存しない（プログレッシブエンハンスメント）。
2. `loginAction`（Server Action、`login/actions.ts`）が、フォーム送信された生のトークン文字列を受け取り、サーバー側でのみ`checkStagingAdminToken`に渡す。
3. 検証に成功したら、`attemptStagingLogin`（`companyLabUiSession.ts`）が**署名付きの、トークンそのものを含まないopaqueなセッション値**を生成し、HttpOnly・Secure・SameSite=Laxのcookieとして書き込む。失敗時は理由を区別せず`?error=1`へリダイレクトする（トークン不一致・未設定・本番環境のどれであっても同一表示。既存の`assertStagingAdmin`と同じ「推測防止」方針を踏襲）。

セッション値の構造: `base64url(JSON.stringify({iat, exp, nonce})) + "." + HMAC-SHA256hex`。署名鍵は`sha256("company-lab-ui-session-v1:" + STAGING_ADMIN_TOKEN)`から都度導出する（キャッシュしない）。ドメイン分離用のプレフィックスにより、この署名鍵はBearerトークン比較用途とは別の値になる。この設計により：

- **トークンそのものはCookieに一切含まれない**（ブラウザの開発者ツール・Cookie一覧・HTTPログのいずれで見てもトークン自体は復元できない）。
- **`STAGING_ADMIN_TOKEN`をローテーションすると、発行済みの全セッションが自動的に無効化される**（鍵が変わるため署名検証が失敗する。ユニットテストで確認済み。§7参照）。
- **セッション値は固定値ではない**（発行のたびにランダムな128bit nonceと発行時刻・有効期限を含むペイロードを署名するため、同じユーザーへの再ログインでも毎回異なる値になる）。
- 有効期限は8時間（`SESSION_TTL_MILLISECONDS`）。ステートレス設計（サーバー側の追加ストレージを持たない）で、Redisへ新規アクセス経路を増やさない。

### 2.3 CSRF対策（多重防御）

Server Actions自体、Next.jsの組み込み機能として`Origin`ヘッダーがデプロイ先のホストと一致しないリクエストを拒否する。本Phaseはこれに加えて、状態変更を伴う全Server Action（ログイン・ラボ作成・下書き保存・提出・四半期処理・ログアウト）の先頭で`assertSameOriginRequest()`（`companyLabUiSession.ts`）を呼び、`Origin`ヘッダーの`host`部分が`Host`ヘッダーと一致することをアプリケーション層でも明示的に確認する。判定本体は`isSameOriginHost(origin, host)`という純粋関数として切り出してあり、`next/headers`に依存せず直接ユニットテストできる（§7）。

GETのみのページ（一覧・作成フォーム表示・プレイヤー画面表示）は`requireStagingSession()`（セッションCookieの検証のみ、無効ならログイン画面へ`redirect()`）を呼ぶ。CSRFチェックは状態変更のあるServer Actionだけに限定している（GETはブラウザの通常のnavigationで発生し、CSRF対策の対象外であるため）。

### 2.4 ブラウザ→サーバー→永続化状態の呼び出し経路（指示§7の優先順位）

指示は「(1) 既存の安全な管理セッション/staging認証を再利用 → (2) 共有Application Service/handlerをServer Action/BFF routeからサーバー側で直接呼ぶ → (3) 必要な場合のみ既存Company Lab APIをサーバー側から呼ぶ」の優先順位を示していた。本実装は(1)（既存`checkStagingAdminToken`の再利用）と(2)を採用した：

```
Client Component（ボタン押下）
  → Server Action（app/v2/company-lab/play/[labId]/actions.ts 等）
    → requireStagingSession() / assertSameOriginRequest()
    → resolveCompanyLabUiDependencies()（app/v2/company-lab/play/_lib/uiDependencies.ts）
    → app/api/v2/company-labs/_lib/handlers.ts の handleSaveDraft/handleSubmitDraft/handleProcessQuarter/handleCreateLab/handleListLabs
      （8C-3Aの既存関数をそのまま呼ぶ。route.ts／NextRequest／NextResponseは一切経由しない）
```

同一Next.jsアプリ内での自己HTTP fetch（ブラウザ→自分自身のJSON API route）は行っていない。8C-3AのJSON API route群（`app/api/v2/company-labs/**/route.ts`）自体は変更しておらず、独立して動作し続ける（診断・将来の別クライアント用に温存。§13参照）。`handlers.ts`側の入力検証・turnId導出・エラー分類・冪等性判定ロジックは一切重複実装していない。

`uiDependencies.ts`の`resolveCompanyLabUiDependencies()`は、通常時は8C-3Aの`createCompanyLabApiDependencies()`（実Redis接続）をそのまま返す。**指示§14の明示的な例外**として、非本番環境かつ`COMPANY_LAB_UI_E2E_IN_MEMORY=1`が設定されている場合に限り、既存のin-memory Repository実装（`createInMemoryCompanyLabStateRepository`、Phase 8C-1からのテスト用実装）へフォールバックする。本番環境ではこのフラグは常に無視される（`isProduction`チェックが最優先）。詳細は§8。

## 3. `playerCompanyId`の所有・会社選択（指示§6）

`playerCompanyId`の所有場所・永続化方式・不変性の保証方法は、API/Application Service/永続化層の変更として`docs/v2/COMPANY_LAB_API_ARCHITECTURE_v0.1.md` §13.1に詳しく記録した。ここではUI側の対応のみ記す。

- ラボ作成画面（`/v2/company-lab/play/new`）は、`<select name="playerCompanyId" required>`で5社から明示選択させる（デフォルト選択はあるが、フォーム自体は`required`で送信を強制する）。選択肢は`app/v2/company-lab/play/_lib/companyOptions.ts`の`listCompanyOptionsForUi()`が、既存の`buildCompanyFixtures(INITIAL_PERIOD_V2)`から生成する（UIへのハードコードなし。既存の仮UI`app/v2/company-lab/page.tsx`の`COMPANY_OPTIONS`と同じ手法）。
- 作成後、プレイヤー会社を変更する画面・APIは存在しない（`ProcessQuarterInput`から`playerCompanyId`自体を削除したことにより、そもそも変更する経路が無い。API文書§13.1参照）。
- プレイヤー画面のビューモデル（`viewModel.ts`）は、`stored.playerCompanyId`から対応する`fixture`を解決し、`ownState`・`draft`・`decisionsProvider`の配線すべてがこの1箇所を唯一の正として動く。

## 4. 画面構成（指示§8）

### 4.1 ラボ一覧・作成

一覧画面（`play/page.tsx`）は、8C-3Aの`handleListLabs`をそのまま呼び、`CompanyLabSummaryDto`（labId・プレイヤー会社・現在turn・完了状態・更新日時）をテーブル表示する。各行に「再開」リンク（`/v2/company-lab/play/[labId]`）、画面上部に「新しいラボを作成」リンクとログアウトボタンを置く。

作成画面（`play/new/page.tsx`）は、シナリオ（`ALL_SCENARIO_DEFINITIONS`）・モード・シード・ターン数・プレイヤー会社（必須選択）の入力フォーム。`createLabAction`が8C-3Aの`handleCreateLab`をそのまま呼び、成功時は作成されたラボのプレイヤー画面へ`redirect()`する。失敗時（未知の会社ID・重複labId等）はフォームへ戻り、`handleCreateLab`が返す日本語のエラーメッセージをそのまま表示する（内部例外・スタックトレースは表示しない。8C-3A側で既に保証済み）。

### 4.2 プレイヤー画面

`[labId]/page.tsx`（Server Component）が`requireStagingSession()`→`loadPlayerScreenViewModel()`→`PlayerScreenClient`（Client Component）という流れで描画する。最小限必要な要素（指示§8.2）：

- ラボID・ラボ名相当の識別子、プレイヤー会社、現在turn/合計turn、下書き保存状態、提出状態、処理中状態、完了状態（`phase: "editing"|"submitted"|"completed"`というビューモデル側の3値で表現）。
- 会社の主要な状態・財務情報: 既存の`DecisionEditor`（`ownState`表示込み）・`ResultsPanel`（`CompanyQuarterSummary`＝売上・利益・現金等を含む既存DTO）・`MarketPanel`をそのまま再利用。新しい要約DTOは追加していない（既存DTOで十分だったため。指示§8.2「既存DTOが不十分な場合のみ追加」）。
- 意思決定入力・下書き保存・提出・四半期処理・処理結果・次turnへの遷移・履歴要約（`toHistoryEntrySummaryDto`を再利用、直近10件のみ）。
- 診断専用の`GET .../history/[turn]`は呼んでいない（§8.2「診断専用routeは通常画面から呼ばない」）。

## 5. `viewModel.ts` — サーバー専用の絞り込み地点

`loadPlayerScreenViewModel(deps, labId)`が、Server Componentだけが呼ぶ唯一のデータ取得経路。ここが「巨大な内部状態を読み、画面表示に必要な最小限だけに絞り込んでClient Componentへ渡す」実際の境界になる（指示§8.2）。

**turn 2以降の復元における重要事項**: `stored.currentState.runtime`（`CompanyLabRuntimeSnapshot`）は、それ単体では`buildCompanyOwnState`/`buildPublicMarketInfo`へ渡せる完全な`CompanyLabState`ではない。turn 2以降は直近確定履歴エントリの`record`を注入して復元しないと、前四半期の市場価格・工場負荷等がシナリオのprehistory値へ静かにフォールバックする（Phase 8C-2の`companyLabQuarterFlowService.ts`の`processQuarter`内復元ロジックと全く同じ理由・同じ手順）。`viewModel.ts`はPhase 8C-2の`restoreCompanyLabStateFromRuntimeSnapshot`をそのまま再利用しており、重複実装していない。この復元が正しく行われることは、ブラウザE2Eでturn 2・turn 3への遷移とページリロード後の状態一致を確認することで検証した（§8）。

`repository.loadLatestHistoryEntry(labId)`が返す`CompanyLabQuarterHistoryEntry`（最大約2.5MB）は、`viewModel.ts`内（サーバー側）でのみ扱い、`companySummaries.find(playerCompanyId)`・`marketResult`・`globalReasonCodes`等の小さく絞り込んだ値だけを`PlayerScreenViewModel`（Client Componentへのprops）へ含める。全体をそのままRSC payloadへ流すことはない。

## 6. 下書き編集・提出・四半期処理のUIフロー（指示§9・§10）

- 下書き編集は既存の`CompanyDecisionDraft`型・`DecisionEditor`コンポーネントをそのまま使う。編集はClient Component内のReact state（`useState`）で保持し、「下書きを保存」ボタンで`saveDraftAction`を明示的に呼ぶ（自動保存のデバウンス実装は行わず、指示が明示的に許容する「明示的な保存ボタン」方式を採用。理由: リクエストストーム防止のための実装・テストコストと、本Phaseの完成条件（垂直スライスの動作）とのバランス）。
- `saveDraftAction`/`submitDraftAction`/`processQuarterAction`（`[labId]/actions.ts`）は、いずれも8C-3Aの`handleSaveDraft`/`handleSubmitDraft`/`handleProcessQuarter`をそのまま呼ぶ。turnId導出・draft競合検出（異なるturnIdの提出済みdraftを上書きしようとした場合の`DRAFT_CONFLICT`）は、すべて8C-3A側の既存ロジックに委ねている。
- 提出済みdraftは、Client Component側で`disabled`にして編集不可にする（`phase !== "editing"`のとき）。真の安全性は8C-3AのApplication Service層（turnId・revision・ロックによる状態遷移検証）にあり、UIのdisabled状態はユーザー体験のためのものに過ぎない（指示§10「クライアント側のボタン無効化だけに依存しない」）。
- 四半期処理は「四半期を処理する」ボタン押下後、確認パネル（「本当にturn Nの四半期処理を実行しますか？」＋「はい、処理する」/「キャンセル」）を経ないと実行されない（指示§10の明示的確認要件）。処理中は`useTransition`の`isPending`で全操作ボタンを無効化するが、これもUX目的の保護であり、真の冪等性保証は8C-3Aのサーバー側turnId解決（`resolveInFlightTurnId`）にある。
- `processQuarterAction`は、8C-3Aの応答が`status: "processed"`か`"alreadyProcessed"`かをそのままクライアントへ返し、`alreadyProcessed`の場合は専用の説明文（「この四半期はすでに処理済みでした（再送信を検知したため、重複しては処理していません）」）を表示する（指示§10）。

## 7. リロード・再開・エラー表示（指示§11・§12）

プレイヤー画面のClient Component（`PlayerScreenClient`）は、`viewModel`のうち「サーバー側の状態が実際に変わったことを表す値」（`labId`・`currentTurn`・`revision`・`phase`・`draftUpdatedAt`）を結合したキーを親から渡し、そのキーが変わった時だけコンポーネントを再マウントする（Reactの「keyでstateをリセットする」定石）。これにより、保存・提出・処理いずれかの操作成功後は、必ずサーバー側の最新値（`router.refresh()`で再取得したServer Componentの新しいprops）だけがローカル編集stateの初期値になる。ブラウザリロード時は当然ながらServer Componentが再実行され、`viewModel.ts`が`loadCurrentState`/`loadDraft`/`loadLatestHistoryEntry`からRedis（またはin-memoryフォールバック）の永続状態を読み直す。**React local stateだけに依存する箇所は無い。**

- 未提出の下書きがあれば、リロード後もその内容で編集画面が復元される（`coerceDraftOrRebuild`が、保存済みdraftが構造的に妥当なら`envelope.draft`を、そうでなければ自動方針から再構築した初期値を返す）。
- 提出済みなら編集画面ではなく「提出済み・処理待ち」表示になる（`phase === "submitted"`。フォーム自体は`disabled`で表示はするが、編集不可）。
- 処理済みなら次turnの編集画面になる。完了していれば「このラボは完了しました」という専用の完了表示になり、それ以上の操作（下書き編集・提出・処理ボタン）は一切表示しない。
- 存在しないラボIDへのアクセスは`notFound()`（Next.jsの標準機構）を使い、実際にHTTP 404を返す専用の`not-found.tsx`を表示する。
- セッション期限切れ・未ログイン状態でのアクセスは、`requireStagingSession()`が`redirect()`でログイン画面へ遷移させる。この際、元にいた画面のURLや操作内容等の情報は一切URLパラメータ等へ含めない（秘密は含まれないため漏洩リスクは無いが、単純さを優先しログイン後は常に一覧画面へ戻す設計にした）。
- HTTP/ドメインエラーは、8C-3Aの`mapDomainErrorToHttp`が生成した日本語メッセージ（`result.body.error.message`）をそのまま画面に表示する。メッセージが無い場合のフォールバックとして、`actions.ts`の`describeStatusFallback(status)`が400/401・403/404/409/422/423/500それぞれに対応する定型文を用意している（指示§12の対応表）。409・423を含むすべての操作後、成功・失敗にかかわらず`router.refresh()`を呼び、画面を最新状態へ回復させる。

## 8. ブラウザE2E検証（指示§14）

実Upstash認証情報がこの開発環境には無いため、`COMPANY_LAB_UI_E2E_IN_MEMORY=1`（§2.4）でin-memory Repositoryへフォールバックした状態のNext.js開発サーバー（`next dev`）に対し、Playwright（Chromium、`/opt/pw-browsers/chromium`）で実際のブラウザ操作を行い、次を確認した（すべてPASS。詳細は8C-3B最終報告を参照）：

1. 未ログインでの一覧アクセス→ログイン画面へリダイレクト。
2. 誤ったトークンでのログイン→エラー表示。正しいトークンでのログイン→一覧画面へ到達。
3. セッションCookieがHttpOnly・Secure・SameSite=Laxであり、値に管理トークン文字列を含まないこと。一覧画面のHTML全体にも管理トークンが含まれないこと。
4. ラボ作成画面で5社の選択肢が表示され、`MASS`を選んで作成するとプレイヤー画面（`playerCompanyId = MASS`・turn 1）へ遷移すること。
5. 下書き保存→ページリロード→編集中の内容が復元されること。
6. 提出→「提出済み・処理待ち」表示→リロードしてもその表示が保持されること（React local state非依存の確認）。
7. 四半期処理（確認パネル経由）→結果表示・turn 2への遷移。
8. turn 2の下書き保存・提出後、「はい、処理する」ボタンに対して同一イベントループ内での二重クリック（ネイティブDOM `click()`を2回連続呼び出し）を行い、リロード後の最終状態が`revision`・`turn`とも正確に1回分だけ進んでいること（多重処理されていないこと）を確認。
9. 一覧画面からの「再開」で同じラボへ戻れること。
10. 存在しないラボIDへのアクセスがHTTP 404・専用のNot Found表示になること。
11. ログアウト後、一覧・プレイヤー画面への直接アクセスがいずれもログイン画面へリダイレクトされること。
12. （追加検証）turns=1のラボで四半期処理まで実行し、「このラボは完了しました」という完了表示になること、リロード後も完了表示が保持されること。

**実環境で別途確認が必要な項目**（このin-memoryフォールバックでは検証できない範囲。§10参照）: 実Upstash（Redis REST API）に対する実際のネットワーク往復・レイテンシ、Vercel実行時間制限下での処理完了、複数インスタンス・複数リクエストが本当に同時に競合した場合のロック挙動（本検証は同一ブラウザページ内の同期的な二重クリックであり、真の意味でのネットワークレベルの同時リクエストではない）、本番同等のCookieのSecure属性がHTTPS配信下で実際に機能すること（この検証はHTTPのlocalhostで行っており、Chromiumが`localhost`を安全なコンテキストとして扱う挙動に依存している）。

## 9. 対象外（このPhaseでは実装していない。指示§17）

正式な本番ユーザーアカウント認証、複数プレイヤー同時参加、チャット風の意思決定UI、AIアドバイザーチャット、全面的なデザイン刷新、Company Lab以外のV1画面変更、ゲームバランス調整、UIでの巨大履歴snapshot表示、Fable監査、`develop/v2`への最終マージ。

## 10. 本番運用可能性・将来の実プレイヤー認証との違い

本Phaseの認証境界（§2）は、**本番環境では常に機能しない**（`checkStagingAdminToken`が`isProduction`を最優先でチェックし、トークンの正当性に関わらず403を返すため。ログイン自体が成立しない）。これは意図的な設計であり、Company Lab全体が「スタッフ・開発者向けのstaging限定テストプレイツール」であるという既存の位置づけ（8C-3A文書§2）を踏襲している。

将来、実プレイヤー（一般ユーザー）向けの認証を実装する場合は、本Phaseのセッション方式（単一の共有管理トークンから導出した単一セッション種別）とは根本的に異なる設計が必要になる: ユーザーごとに異なる認証情報・ユーザーごとに異なる`playerCompanyId`の割り当て（現在は「ラボ1つ＝プレイヤー1人＝会社1社」という単純な1:1関係を前提にしている）・同一ラボへの複数ユーザーの同時アクセス制御（指示§17で明示的に対象外とされている「複数プレイヤー同時参加」）。本Phaseのコードはこれらを見据えた抽象化を意図的に行っていない（過剰な一般化を避け、最小限の安全なstagingテストプレイ境界に留める、という指示の方針に従った）。

## 11. Phase 8C全体への申し送り

- 実Upstash環境での§8「別途確認が必要な項目」の実施。
- Fableによる Phase 8C全体（8C-1〜8C-3B）の節目監査。
- `develop/v2`へのPhase 8C-3Bマージ判断（本Phaseでは行っていない。`feature/v2-company-lab-ui`へのpushで停止）。
- 複数プレイヤー・実認証方式の検討（§10）。
- ゲームバランス調整（本Phaseでは意図的に対象外。操作可能性のみ確認）。
- UI/UXの磨き込み（本Phaseは「動作する垂直スライス」を優先し、視覚的な仕上げは行っていない）。
