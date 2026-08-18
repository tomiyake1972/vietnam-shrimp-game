# ShrimpX V2 — Preview / Player URL 報告ルール（恒久ルール）

Deploy完了報告・「リンクをください」「実際のゲームに入りたい」等の依頼に対しては、
必ず以下のルールに従う。過去に、Vercelのbranch Preview root URLと、実際に
プレイヤーが現在のRun/Sessionへ入るURLが混同され、古い画面や参加画面へ
案内される問題が繰り返し発生したため、これを恒久的に防ぐ。

## 1. URLは必ず3種類に分けて報告する

- **A. Deployment Preview URL** — Vercel branch previewそのもの
  （`https://xxxxx.vercel.app`）。「そのbranch/commitがdeployされている環境」を
  示すだけで、Playerの現在Run・特定シナリオ・最新Sessionへ直接入れることを
  意味しない。単なるroot URLをPlayer Test URLとして報告しない。
- **B. GM / Admin URL** — Management Console等、GM/Session Controlへ直接入る
  完全URL（必要なquery付き）。
- **C. Player Test URL** — 実際に現在のtestplay Session/Run/Companyへ
  プレイヤーとして直接入れる完全URL（`run=`/`company=`/`session=`/`labId=`/
  `player=`等のIDを実state/sessionから取得し、推測しない）。

## 2. Player Test URLは実ブラウザ確認必須

報告前に必ずPlaywright等の実ブラウザでそのURLを開き、以下を確認する：
1. URLを直接開ける
2. 期待しているRun/Sessionである
3. 期待しているCompanyである
4. 最新実装の画面が表示される
5. 古いPreview/Join/Login画面へ誤遷移しない
6. 今回実装したfeatureが実際に見える

「おそらくこのURL」「branch aliasだから使えるはず」という推測での報告は禁止。
確認できない場合は `PLAYER_TEST_URL_NOT_VERIFIED` と明記し、理由を書く
（無理にURLを作らない。誤ったURLより未確認の方が良い）。

## 3. Tested commit / Deployed commit を併記する

URL報告時は必ず `Tested commit: <SHA>` を併記し、可能なら
`Deployed commit: <SHA>`（Vercel deployment APIのgithubCommitSha等）も確認し、
両者が一致することを確認する。一致しなければ最新版URLとして報告しない。

## 4. 完了報告フォーマット（最低限）

```
Deployment Preview URL:
<URL>

GM / Admin URL:
<URL or NOT_APPLICABLE>

Player Test URL:
<完全なdirect URL or PLAYER_TEST_URL_NOT_VERIFIED（理由つき）>

Tested commit:
<SHA>

Deployed commit:
<SHA>

Browser verification:
PASS / FAIL

Verified screen:
（例）Decision Studio 7 tabs / Dynamic Scenario News / Game End / Final Results / Player Session Waiting 等
```

## 5. 古いURLを再利用しない

過去の会話・以前のdeploy報告に出てきたURLを、現在の最新版URLとして再利用しない。
毎回、現在branch・current HEAD・current deployment・current run/sessionを確認する。
以前のURLがまだ有効でも、今回の最新実装が載っていると確認できなければ使用禁止。

## 6. Branch PreviewとSession URLを混同しない

Branch Preview URL＝「コード環境」、Player Session URL＝「実際のゲーム世界」。
Preview rootを開いて「ゲームコードを入力してください」のようなJoin画面になる
場合、それはPlayer Test URLではない。現在進行中のRunへ直接入れるURLを別途取得する。

## 7. run/company付きURLが必要な場合

IDを推測しない。実state/sessionから取得する。「hostだけ差し替えれば動く」という
推測も禁止。実際に開いて確認する。

## 8. Session Flow導入後の区別

新Player Session Flow導入後、Join URL / Session Control URL / Player Workspace
URLが別になる場合はそれぞれ区別して報告する（Join URL / Admin URL / Player URL）。

## 9. 認証が必要でURLを取得・検証できない場合

Management Console等のサーバー保存（persist）にはstaging admin token（またはUIログイン
セッションCookie）が必要。それが無い環境からの検証では、client-side限定の
ephemeral runしか作れず、server persistenceは確認できない。その場合は
Deployment Preview URLと「コードが最新であること」の検証結果のみ報告し、
Player Test URLは検証済みの実運用Sessionとしてではなく、あくまで
verification-only（保存未確認）である旨を明記する。ユーザー自身の既存Run/
Session ID・admin tokenが分かればそれを使って再検証する。

## 10. 適用範囲

このルールはPreview deploy・Testplay・Player Session・Management Console・
Dynamic Scenario・Final Results等、ShrimpX V2の今後すべてのURL報告に適用する。
