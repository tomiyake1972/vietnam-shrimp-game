# Phase 8G 中間報告①：営業配分の詰み状態解消 + 初回ターン消費市場価格表示バグ修正

対象：Phase 8G の§9実装順序 手順(2)〜(4)、(6)。指示§9の「営業配分問題を修正した段階で、
残りの実装が継続中でもTest13を再開できる方法がある場合は、その時点で報告してください」
に基づく中間報告。

Section 2（営業人員の追加採用）、Section 4のCompany Lab新規表示（適正在庫・在庫率・
価格への圧力テキスト）、Section 5（輸入原料の追加費用・到着原価表示）、Section 6
（四半期結果スプレッドシートUI）は本報告の対象外で、未着手のまま継続する。

## 1. 作業開始前の回帰調査（Section 0）で判明した事実

- **消費市場価格が全市場一律-20.0%になった直接原因**は、`app/v2/company-lab/marketPriceViewModel.ts`の
  `buildDestinationMarketPriceRows()`にあった。初回ターン（前期の確定`MarketQuarterResult`が
  存在しない場合）に限り、"前期価格"の代用として`storedPriorVietnamHoso × coefficients[市場].baseValueCoefficient`
  を使っていた。当期価格も`hosoBasePrice_current × 同じcoefficient`であるため、
  `(当期-前期)/前期`の計算で市場係数が約分され、結果として**全市場がベトナム自身の
  産地国changeRatioをそのままecho**していた。
- そのベトナム自身のchangeRatioが厳密に-0.2だった理由は、これとは別の**既存の**仕組み――
  `app/lib/v2/market/hosoPricing.ts`の`clearHosoMarket()`内にある
  `maxQuarterlyPriceChangeRatio: 0.2`という四半期あたり変動幅の一律クランプ（Phase 6.3、
  コミット`f589a7b`で導入済み）――が単純にヒットしていたため。このクランプはショックの
  種類（通常の需給変動か、大規模イベントか）を一切区別しない設計で、`MarketQuarterInput`に
  シナリオ/イベント種別のフィールド自体が存在しない。
- つまり「過去に行ったはずの価格安定化修正」は、**表示層のバグとは別物**である産地国価格の
  変動幅クランプとして最初から存在しており、develop/v2に統合済みで有効に働いている。
  「効いていない」ように見えたのは、表示層（Company Lab）が代用値によって全市場を
  同じ数値に潰していたためで、価格計算エンジン自体の不具合ではない。
- ±8%/±12%の2段階クランプを新設する対応は、「このショックは何%までなら許容するか」という
  情報をエンジンに新規に持ち込む必要があり、本プロジェクトの既存設計原則
  （イベントは需給の基礎変数のみを動かし、価格へ直接触れない）と衝突するため、指示§10の
  停止条件に該当すると判断し、AskUserQuestionで確認。結果：**表示バグのみ修正**
  （既存の±20%クランプは変更しない）を採用。
- 消費国在庫（`app/lib/v2/market/consumerInventory.ts`）は、永続化されたプレイヤー画面
  （`/v2/company-lab/play/[labId]`）向けの`loadPlayerScreenViewModel`が、API層の
  軽量DTO（意図的に`consumerMarketRecords`を落とす）を経由せず、リポジトリから
  `latestEntry.record.consumerMarketRecords`を直接読んでいるため、**永続化プレイヤー画面自体は
  実は断線していなかった**。時系列の逆転（今期の期末在庫を今期の価格算定に使う誤り）も
  確認できず、`deriveNextQuarterDestinationPriceCoefficients`経由で価格へ実際に効いている
  ことも確認済み。Section 4で残っている作業は「壊れた配線の修正」ではなく、
  適正在庫・在庫率・価格への圧力テキストといった**新規表示項目の追加**である。

## 2. Section 1：営業配分の詰み状態の再現・修正

### 直接原因

`app/lib/v2/companyLab/application/companyLabQuarterFlowService.ts`の`saveDraft()`は、
`submittedAt`が設定済みのdraftへの再保存を`CompanyLabDraftAlreadySubmittedError`で拒否する
（Phase 8C-1で導入された「正式提出後の編集防止」という意図的仕様）。一方、
`processQuarter`が営業人員の配分超過（`validateSalesForceHeadcountBudget`）で失敗しても
`submittedAt`はクリアされない。この2つの組み合わせにより、配分超過で提出してしまった
プレイヤーは、**編集にも再提出にも戻れず恒久的に詰む**状態になっていた。リポジトリ全体を
検索した結果、取り消し（unsubmit/withdraw）に相当する操作は元々どこにも存在しなかった。

### 実施した修正

1. `app/v2/company-lab/decisionDraft.ts`に`summarizeSalesForceAllocation`
   （配分済み／配分可能／未配分・超過数の単一の計算源）と
   `resetAllSalesForceHeadcountToZero`を追加。
2. `app/v2/company-lab/components/DecisionEditor.tsx`：常時表示の配分状況バナー
   （「配分済み X人 / 配分可能 Y人 / 未配分 Z人」、超過時は赤色で
   「現在の人員数に収まるように再編集してください」）、「営業配分をすべて0に戻す」ボタン、
   超過している行への警告スタイルを追加。
3. `companyLabQuarterFlowService.ts`に新規`withdrawDraft`操作を追加（提出取り消し。
   draft本体は変更せず`submittedAt`のみnullへ戻す。未提出への取り消しは冪等にno-op）。
   API層（`handlers.ts`の`handleWithdrawDraft`、新規ルート
   `POST /api/v2/company-labs/[labId]/draft/withdraw`）、プレイヤー画面のServer Action
   （`withdrawDraftAction`）、UI（提出済み画面に「編集に戻す（提出を取り消す）」ボタンを常設）
   まで一貫して配線。
4. `PlayerScreenClient.tsx`：配分超過時は提出ボタンをdisabledにして警告文を表示
   （入力欄自体は常に編集可能なまま）。

### 検証（実際のTest13相当の詰み状態を再現）

- `companyLabQuarterFlowService.test.ts`：BALの営業人員配分を実在人数より過大にしたdraftを
  提出→`processQuarter`が失敗→`submittedAt`が残ったまま詰むことを確認→`withdrawDraft`で
  `submittedAt`をnullに戻し、draft本体（`{ note: "over-budget-draft" }`）が変更されずに
  残ることを確認→修正済みdraftへ差し替え→再提出→再処理が成功することを確認。
- `handlers.test.ts`（HTTPハンドラー層）：同じシナリオをAPI層で再現し、
  失敗時422・取り消し200・再処理200を確認。加えて、draft無し409、labId不存在404、
  完了済みラボへの取り消し409、未提出draftへの冪等な取り消し200を個別に確認。

## 3. Section 3：初回ターン消費市場価格の前期比表示バグ修正

`buildDestinationMarketPriceRows()`から、HOSOのみに存在した特殊な代用値パス
（`storedPriorVietnamHoso`分岐）を完全に削除。初回ターン／真正な前期確定データが
存在しない場合は、HOSO・PD・VAPの3商品すべてが一律に「前期比：―」
（`source: "unavailable"`, `changeRatio: null`）を返すよう統一した（PD/VAPは元々この挙動
だったため、その挙動にHOSOも揃えた形）。`buildOriginCountryPriceRows()`側の
産地国HOSOの`storedPriorPrice`フォールバック（真正な国別保存データを使っているため
問題なし）は変更していない。

### 検証

- `marketPriceViewModel.test.ts`：新規2件の回帰テストで、(a) 代用値を使わず
  HOSO/PD/VAPが揃って`unavailable`になること、(b) 全市場のHOSO changeRatioが
  同一値にechoされないこと（全て`null`）を確認。既存の「PD/VAPは0で埋めない」テストは
  維持。

## 4. 検証結果一式

- `npx tsc --noEmit -p .`：エラー0件。
- `npm test`：**1606/1606件 全て成功**（本修正前は1591件。+15件はwithdrawDraft関連
  10件（application service層5件×2コンテキスト）＋handlers層5件＋marketPriceViewModel
  関連の差分）。
- `npx eslint app/`：エラー0件。既存の無関係な警告2件のみ（本修正と無関係な
  テストファイルの未使用変数）。
- `npm run build`：成功。新規ルート`/api/v2/company-labs/[labId]/draft/withdraw`が
  ビルド出力に登録されていることを確認。

## 5. Git / デプロイ状態

- ブランチ：`fix/v2-8g-sales-allocation-and-price-display`（`develop/v2`のコミット
  `c096f01`から分岐）
- コミット：`95a6c151c5be8e714dfc126de617766bd0647e46`
- ローカル・リモートHEAD一致：確認済み（`git status`は`up to date` / `working tree clean`）
- Vercel Preview：`https://vietnam-shrimp-game-staging-git-fix-v2-8g-sales-6e1795-tomiyake.vercel.app`
  （READY確認済み）
- **develop/v2へはまだマージしていない**（マージの可否は三宅さんの確認を待つ）

## 6. Test13は再開できるか

コードの変更・テストによる再現/解消の確認は完了した。ただし、**Test13の実際の保存データに
対する実地確認（ブラウザでの実プレイ）はまだ行っていない**。理由は、過去のセッションで
プレイヤー画面がログインセッション（STAGING_ADMIN_TOKEN）で保護されており、
このセッションからは実地確認ができなかったため（このトークンをチャットで要求すること
自体が禁止事項のため、要求もしていない）。

そのため、今回の確認は「Test13相当の詰み状態（実在18人に対し配分24人）を単体・結合テストで
厳密に再現し、それが解消されることを確認した」という水準に留まる。三宅さんご自身の環境で
このPreview URLからTest13（またはその複製）にログインし、実際に配分を0人に戻す／
「編集に戻す」ボタンで詰みから復帰できることを確認いただくのが、実地の最終確認になる。

## 7. 次の作業

このブランチは develop/v2 へマージ可能な状態にあると考えているが、マージするかどうかは
三宅さんの判断を仰ぐ。並行して、Section 2（営業人員の追加採用）以降の実装を継続する。
