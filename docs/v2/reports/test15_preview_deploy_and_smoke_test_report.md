# Test15前 プレビューデプロイ・ブラウザスモークテスト報告（Phase9）

- 対象ブランチ: `feature/v2-test15-preflight-calibration`、コミット `4cdf3a1e7a1dc0661d133d387520d73b3f7d8ca6`
  （作業ツリー `/tmp/test15_integration`）。
- 本サンドボックスの制約（結論を先に明示）: **本物のブラウザ自動操作ツール
  （Playwright等）がこのセッションでは一切利用できず、リポジトリにも
  ブラウザ駆動のE2Eテスト基盤（Playwright設定・jsdom/React Testing Library
  コンポーネントテスト）が存在しない。** そのため、9-1（実際にブラウザで
  クリック・選択して画面が更新されることの目視確認）はこのセッションでは
  実行不可能である。代わりに、（a）Vercel Previewの到達可否そのものを確認し、
  （b）実際にサーバーを起動してのHTTPレベルの疎通確認、（c）既存の
  実エンジン・実Excel生成ロジックを通した自動テスト（今回新規に追加した
  ものではなく、本ブランチに既存の統合テスト）の再実行、（d）UIソース
  コードの該当箇所の確認、の4本立てで、可能な範囲の実質的な検証を行った。
  ブロックされている項目は「blocked」として明示し、代替で確認できた内容と
  オーナーが後で実施すべき最短の確認手順を併記する。

---

## 0. Vercel Previewデプロイ

**結果: blocked（実施せず。理由は以下のとおり）。**

- Vercel MCPツールは利用可能で、実在するチーム（`tomiyake`, `team_LMcTQ4W66vEGFeRc8nCRfGP8`）・
  既存プロジェクト（`vietnam-shrimp-game`, `prj_XgMSkuDVQiENDJZSVpISicYOb3Mu`。
  git連携済み、ドメイン`vietnam-shrimp-game-git-main-tomiyake.vercel.app`等）を
  確認した。ただし、
  1. **本サンドボックスにはgit push権限が無い**（本プロジェクト全体を通じて
     繰り返し確認済みの制約）。Vercelのgit連携によるブランチPreviewは、
     リモートへブランチをpushして初めて自動生成される仕組みのため、
     このルートは使えない。
  2. 利用可能な`deploy_to_vercel`（MCP）は、gitと無関係にソースファイル群を
     直接アップロードして**新規デプロイを作る**方式であり、（i）本アプリの
     全ソースファイル（数千ファイル規模のNext.js/TypeScriptプロジェクト）を
     このツール呼び出しへ手動で列挙するのは今回の時間的制約内では非現実的、
     （ii）既存プロジェクトのgit連携・環境変数設定（本番/ステージング用の
     Redis資格情報等）を引き継がない、切り離された一発限りのデプロイになり、
     「このブランチの忠実なPreview」とは言えない（後述のとおりRedis資格情報が
     無いため、そのままではAPI Route側がエラーになる可能性が高い）。
  3. 既存プロジェクトの最新デプロイ自体も`readyState: "ERROR"`・`live: false`
     であることを確認した（本ブランチの変更とは無関係の、既存プロジェクト側の
     既知の状態と考えられる）。

**オーナーが後で実施すべき最短の確認手順**: プッシュ権限のある環境から
`git push origin feature/v2-test15-preflight-calibration`（または該当リモートへの
push）を行えば、Vercelのgit連携により
`vietnam-shrimp-game-git-feature-v2-test15-preflight-calibration-tomiyake.vercel.app`
相当のPreview URLが自動生成されるはずである（プロジェクト設定のPreview
デプロイが有効な場合）。Preview環境の環境変数（Redis資格情報等）が
正しく設定されていることを事前に確認すること。

---

## 1. 9-1: UI確認

| チェック項目 | 結果 | 根拠 |
|---|---|---|
| 新工場建設の入力（投資額・支払・完成・稼働開始タイミング表示） | **partial（実ブラウザでの目視未確認。ソースコード上の実装は確認済み）** | `app/v2/company-lab/capexViewModel.ts`が全投資種別（`newFactoryConstruction`含む）共通で、支払スケジュール・`completedPeriod`（`computeOperationalStartPeriod`経由で竣工後の操業準備期間を加味した稼働開始期）を算出し、`investmentPlanningViewModel.ts`の「投資カード」へ渡す実装を確認した。実際にブラウザでこのカードが正しく描画されるかは未確認（下記ブロッカー参照）。 |
| PD省人化投資の対象工場選択・効果/コスト/Worker削減の表示 | **partial（同上）** | `app/v2/company-lab/components/DecisionEditor.tsx`（307〜563行）で、対象工場セレクタ・投資金額・支払スケジュール・想定稼働開始時期・稼働開始後の四半期あたり減価償却費/保守費・`pdMechanizationWorkerReductionEstimate`（Worker削減見込み）が実装されていることをソースコードで確認した。 |
| VAP開発費4段階の選択・スコア・次四半期見込みの表示 | **partial（同上）** | 同ファイル372〜681行で、`VAP_PRODUCT_DEVELOPMENT_SPEND_TIER_OPTIONS_USD`の4段階選択肢、`currentVapProductDevelopmentScore`（現在スコア表示）、`nextQuarterVapProductDevelopmentScorePreview`（実際に`companyLab/productDevelopmentState.ts`の`updateProductDevelopmentState`をそのまま呼んで算出する、次四半期末スコア見込み。並行計算式ではなく本物のロジックを再利用）を確認した。 |
| 稼働開始した新設Factoryが意思決定UIに現れる | **verified（実ブラウザではなく、実エンジン統合テストで確認）** | 既存の`app/lib/v2/companyLab/__tests__/test15NewFactoryDecisionInput.test.ts`（NF-1〜NF-6、本セッションで再実行し全6件パス確認済み）が、`buildInitialDraft`（DecisionEditorが実際に使うドラフト構築関数）に`effectiveFactories`を渡した場合、稼働開始した、まさにその四半期から新設Factoryの生産計画・ワーカー配置入力行が現れることを、実際のUI層の関数（`buildInitialDraft`・`buildDecisionInputFromDraft`）を通して確認している。 |

**ブロッカー（共通）**: 本セッションにはブラウザ自動操作ツール（Playwright等のMCPツール）が
一切利用できず、リポジトリ自体にもブラウザ描画を伴うE2E/コンポーネントテスト基盤
（Playwright設定ファイル・jsdom/React Testing Library）が存在しないことを確認した
（`package.json`にe2eスクリプトなし、`playwright.config.*`なし、`.test.tsx`に
これら3項目を検証するテストなし）。加えて`/v2/company-lab/play`（実際のプレイヤー
画面）は`requireStagingSession`によるログインゲートがあり、ログインはNext.jsの
Server Action（`app/v2/company-lab/play/login/actions.ts`）経由で、生のcurlでは
実ブラウザと同じプロトコルを安全に再現できない（同一オリジン検証・Server
Action参照IDの仕組みのため）。そのため「実際に選択・入力してその場で画面が
更新される」ことの目視確認はこのセッションでは実施できなかった。

**オーナーが後で実施すべき最短の確認手順**: ローカルまたはPreviewで
`COMPANY_LAB_UI_E2E_IN_MEMORY=1`を設定し（本番以外限定のフォールバック）、
`STAGING_ADMIN_TOKEN`を設定したうえで`/v2/company-lab/play/login`から
ログインし、新規ラボを作成→新工場建設を提案→PD省人化投資の対象工場を選択→
VAP開発費を4段階のいずれかへ設定→画面表示（投資カードの支払・完成・稼働
開始予定、対象工場のPD効果、VAP次四半期見込み）が期待どおりかを目視確認する。

---

## 2. 9-2: 保存・進行確認

| チェック項目 | 結果 | 根拠 |
|---|---|---|
| 保存が永続化される | **verified（実HTTP経由ではなく、永続化ロジック自体の統合テストで確認）** | `app/lib/v2/companyLab/persistence/__tests__/test15Migration.test.ts`のMIG-9「フルラウンドトリップ（save→load→1四半期進行→save）」を含む全18件を本セッションで再実行し、全件パスを確認した。 |
| リロード後も保持される | **verified（同上）** | 同上（`restoreCompanyLabStateFromRuntimeSnapshot`による復元後、PD稼働率・VAP開発スコア・capex案件が失われないことをMIG-9で確認済み）。 |
| 四半期進行が機能する | **verified** | 上記に加え、Phase6〜8のすべての診断スクリプトが`advanceCompanyLabQuarter`を通じて12〜16四半期を繰り返し正常に進行させている（本セッション中に数百回規模で実行済み）。 |
| 投資の支払/完成/準備/稼働開始がスケジュールどおり進む | **verified** | Phase6の新工場建設プリフライト（実測: turn1着工→turn2/3分割払い→turn3完成→turn4稼働開始）、MIG-3/MIG-3b（各建設段階・稼働中状態の保存復元）で確認済み。 |
| 旧形式保存データの読み込みでマイグレーションエラーが出ない | **verified** | MIG-7（Test15新規フィールドが全く無い旧保存データ）・MIG-10（v4形式）・MIG-11（v5形式）・MIG-12（v6形式）・MIG-13（現行v7形式）のいずれも例外を投げず、非中立値を捏造しない既定補完で読み込めることを確認した（本セッションで再実行、全件パス）。 |

**注記**: 上記はすべて「永続化ロジック自体」（`companyLab/persistence/`配下の
純粋関数）を直接呼ぶ統合テストによる検証であり、実際のHTTP API Route
（`app/api/v2/company-labs/**`）・実Redisを経由した end-to-end の確認では
ない。API Route層は本番用Redis資格情報（`STAGING_KV_REST_API_URL`等）を
必要とし、本サンドボックスにはこれが設定されていない（後述4節、`npm run build`
失敗の直接原因でもある）。永続化ロジックそのものの正しさは高い確度で確認
できているが、「HTTP経由で実際に保存・取得できるか」はこのセッションでは
検証できていない。

---

## 3. 9-3: Excel確認

| チェック項目 | 結果 | 根拠 |
|---|---|---|
| 正常に開ける（例外なく生成・読み込みできる） | **verified** | `app/lib/v2/companyLab/adminExport/__tests__/test15ExcelIntegration.test.ts`（3件、本セッションで再実行し全件パス）が、実際の8四半期分の状態（BAL:新工場建設提案、JPQ:PD省人化投資提案、MASS:VAP開発費$250,000）から、実際のDTO（`buildAllCompaniesExportPayload`）→実際のExcel生成（`buildAllCompaniesExportExcelWorkbook`）を通し、`ExcelJS`で実際に読み込めることを確認している。 |
| 既存シートの欠落なし | **verified** | 本セッションで追加実施したスキャン（既存builderをそのまま呼ぶ使い捨てスクリプト、コミットには含めていない）で、シート一覧`Meta / Capacity_BAL / Capacity_MASS / Capacity_JPQ / Capacity_VAP / Capacity_CONSV / 生産・設備・労務 / 意思決定項目 / StandardAI入力`の9シートすべてが揃っていることを確認した。 |
| VAP開発費・スコアの存在 | **verified** | 「意思決定項目」シートにMASSのVAP商品開発費$250,000の行が存在し、既存テスト（test15ExcelIntegration.test.ts 2件目）でセル値が実際の入力値（250,000）と一致することをスポットチェック済み。 |
| 新設Factoryの状況の存在 | **verified（生成は確認済み。値の網羅的スポットチェックは既存テストの範囲内）** | BALの新設Factory提案を含む状態からワークブックが例外なく生成されることを確認（1件目のテスト）。 |
| PD省人化投資の対象・状況の存在 | **verified** | 「生産・設備・労務」シートにJPQの対象工場行が存在し、そのセル値（PD稼働率）が実際のエンジン計算値（`jpqPd.previousQuarterPdUtilization`）と一致することを既存テスト（2件目）で確認済み。 |
| 工場別PD稼働率の存在 | **verified** | 同上。 |
| Standard AI入力の関連フィールドの存在 | **verified** | 「StandardAI入力」シートが存在し、かつ非公開ground truth系フィールド（`trueDemand`・`groundTruth`・`futureShock`等）が一切含まれないことを既存テスト（3件目）で確認済み。 |
| 画面/エンジン状態との値の一致 | **verified（一部のスポットチェック範囲内）** | 上記のJPQ PD稼働率・MASS VAP開発費のスポットチェックで確認。全セル・全シートの網羅的な一致検証は行っていない。 |
| 列のズレ・空白/NaN/undefinedセルが無いこと | **verified** | 本セッションで追加実施したスキャン（使い捨てスクリプト）で、全9シート・データ行全体（`includeEmpty: true`で全セルを走査）に対し、`null`・`undefined`・数値型`NaN`・文字列`"NaN"`/`"undefined"`のいずれも**0件**であることを確認した。 |

**注記**: 上記の検証は、実際のExcel生成ロジック（`companyLabAdminExcelBuilder.ts`）を
直接呼ぶ統合テスト・スクリプトによるものであり、HTTP経由の実際のダウンロード
（`app/api/v2/exports/company-labs/[labId]/route.ts`）を経由したものではない。
このAPI Routeは実Redis資格情報を必要とし、本サンドボックスには設定されて
いないため、「実際にブラウザ/curlでダウンロードボタンを押して.xlsxファイルを
取得する」という意味での確認はできていない（4節のとおり`npm run build`が
同じ理由で失敗することからも、この制約は本ブランチの変更とは無関係の
既存の環境制約であることが確認できる）。

---

## 4. 補足: ビルド・コンパイル確認

- `npx tsc --noEmit -p .`: 本セッション中、Phase6〜8すべての追加後も一貫してクリーン
  （エラー0件）であることを確認済み。
- `npm run build`（本番ビルド）: Turbopackによるコンパイル自体は成功
  （`✓ Compiled successfully`、TypeScriptチェックも成功）したが、ページデータ
  収集段階で`/api/game/[gameCode]/admin/clone`が`STAGING_KV_REST_API_URL`
  未設定のため例外を投げ、ビルド全体が失敗した。これは本ブランチの変更が
  原因ではなく、本サンドボックスにRedis資格情報が一切設定されていないという
  既存の環境制約（コーディネーターが本ラウンドの指示で事前に言及した
  「Redis credentials for the export API, as found in earlier rounds」と同じ
  制約）であることを、当該APIルートが本Phaseで一切変更していないファイルで
  あることから確認した。
- `npm run dev`（開発サーバー、`COMPANY_LAB_UI_E2E_IN_MEMORY=1`）: 正常に起動し
  （551ms）、GM/開発者向けページ`/v2/company-lab`（Redis非依存のクライアント
  専用ページ）はHTTP 200で応答することを確認した。`/v2/company-lab/play`は
  ログインゲートにより`/v2/company-lab/play/login`へ307リダイレクトされる
  ことを確認した（1節のブロッカー参照）。

---

## 5. 総括

| 区分 | 状態 |
|---|---|
| Vercel Previewデプロイ | **blocked**（push権限なし。理由・代替手順は0節） |
| 9-1 UI確認（新工場建設・PD省人化・VAP・新設Factory表示） | **partial**（ソースコード実装＋エンジン層の統合テストで裏付けたが、実ブラウザでの目視確認はブロック） |
| 9-2 保存・進行確認 | **verified**（永続化ロジック自体の統合テスト、実HTTP/実Redis経由ではない） |
| 9-3 Excel確認 | **verified**（実Excel生成ロジックの統合テスト＋本セッション追加スキャン、実HTTPダウンロード経由ではない） |
| ビルド確認 | tscクリーン・devサーバー起動確認。本番ビルドは既存のRedis資格情報不足により失敗（本ブランチと無関係の既存環境制約） |

**成功したと偽っている項目はない。** 実ブラウザでの操作確認・実HTTP API経由の
保存/Excel取得確認は、このサンドボックスのツール制約（ブラウザ自動操作
ツール不在、Redis資格情報不在、git push不可）により実施できなかった。
可能な範囲で最も実質的な代替検証（実エンジン・実Excel生成ロジックを直接
通す統合テストの再実行＋新規スキャン、UIソースコードの実装確認、開発
サーバーの起動確認）を行い、その結果と限界を本報告に明記した。
