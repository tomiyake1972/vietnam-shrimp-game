# 空欄・不正数値が 0 として扱われる件（監査後の修正と、前回説明の訂正）

更新: 2026-10-08 JST（最終監査でのJSON送信時の検証漏れ修正を反映）/ 状態: **修正済み・実ブラウザで確認済み**

## 0. 前回説明の訂正

前回この文書と `app/v2/company-lab/components/InputCells.tsx` のコメントには、

> `<input type="number">` では空欄と 0 を区別できないため、空欄は 0 として提出される（残る制約）

と書いた。**これは誤りだった。**

`onChange` が受け取る `e.target.value` は文字列であり、`Number()` へ渡す前に
`raw === ""` を判定できる。区別できないのではなく、旧実装が `Number("") === 0`
という JavaScript の性質にそのまま乗っていただけである。
`<input type="number">` は空欄のとき `e.target.value` に空文字列を返すので、
「空欄」と「利用者が明示的に打った 0」は入力段階で完全に区別できる。

監査の指摘どおり、この点を前提から直した。以下は修正後の仕様である。

## 1. 何が問題だったのか（0 の受理自体は正しい）

0 は正当な意思決定である。

- 販売数量 0 = その市場へは売らない
- 配当 0 = 今期は配当しない
- 採用 0 人 = 今期は採用しない

したがって「0 を受け付けない」ようにするのは誤りで、**0 は必ず受理しなければならない**。
実際の欠陥は、利用者が 0 と決めていないのに 0（または範囲内の別の値）へ
**黙って書き換えられていた**ことだった。

### 旧実装で実測した無言の書き換え

| 利用者の操作 | 旧実装で下書きへ入った値 | 利用者への通知 |
| --- | --- | --- |
| 販売数量を空欄にした | `0` | なし。そのまま確定でき、`buildDecisionInputFromDraft` が数量0の行を落とすため**その販売計画が消える** |
| 販売数量に `abc` 等を入れた | `0` | なし |
| 増員／減員欄を空欄にした | `0`（増減なし） | なし |
| 臨時人数に負数を入れた | `0`（`n > 0 ? n : 0`） | なし |
| 残業率に `99` と打った（`0.99` の打ち間違い） | `1`（`Math.min(1, Math.max(0, n))`） | なし。**残業率100%として保存される** |
| 設備投資の申請額を空欄にした | 見込み支払額の表示が `NaN` | 表示が壊れるだけで理由が出ない |

## 2. 監査で見つかった未修正箇所 — `WorkforcePanel.tsx`

前回の修正は共通入力セル `InputCells.tsx` だけを直していた。
しかし**人員配置と比率の入力欄は共通コンポーネントを使っていなかった**。
`app/v2/company-lab/components/WorkforcePanel.tsx` が独自の `<input>` を 3 つ持ち、
その中に上表の `n > 0 ? n : 0` と `Math.min(1, Math.max(0, n))` が残っていた。

さらに構造的な問題があった。この 3 つの入力欄は

```
draft → buildDecisionInputFromDraft（サニタイズ）→ workforceRows（view-model）→ input の value
```

という経路で**サニタイズ後の値**にバインドされていた。
そのため入力欄を空欄にしても、次のレンダリングでサニタイズ結果の `0` が
書き戻され、「空欄にしたはずが 0 になる」が構造的に避けられなかった。

## 3. 修正の内容（最小変更）

| ファイル | 変更 |
| --- | --- |
| `app/v2/company-lab/components/InputCells.tsx` | `toSafeNumber` / `toSafeRatioNumber` を `parseNumberInput` / `parseRatioInput` へ置き換え。空欄・空白のみ・非数は `NaN` を返し、0 へ変換しない。明示的な `"0"` は 0 として受理。負数・範囲外は丸めない。`NaN` のときは入力欄を空欄表示にし、警告枠と `data-invalid="true"` / `aria-invalid` を付ける。編集中は利用者が打った文字列をそのまま保持し（`0.` のような入力途中が 0 に戻って小数点が打てなくなるのを防ぐ）、blur で下書き側の値へ戻す。 |
| `app/v2/company-lab/components/WorkforcePanel.tsx` | 独自の `<input>` 3 つを撤去し、共通の `NumberCell` / `RatioCell` に置き換え。編集対象の 3 項目は **view-model ではなく下書きの生値**にバインドする（読み取り専用の列だけ view-model を使う）。減員は負の差分が正当なので `NumberCell` に `min={null}` を追加して下限を外した。 |
| `app/v2/company-lab/decisionDraft.ts` | `regularHeadcountChange` 自体の検証を追加。画面が編集するのは差分であり、`regularHeadcount` は engine の `applyHeadcountChange`（変更禁止・非有限を 0 扱い）を通るため「前期末人数のまま」の正当な値になり、既存の `regularHeadcount` 検証では空欄を検出できなかった（実測）。減員があるので範囲は課さず、数値であることだけを求める。 |
| `app/v2/company-lab/decisionStudioViewModel.ts` | 申請額が `NaN` のとき `??` では既定値へ落ちず見込み支払額の表示が `NaN` になるため、表示だけ標準予算で代替。入力の不正そのものは提出前検証が項目名を示して止める。 |

**変更していないもの**: engine の計算式、`applyHeadcountChange`、
`buildDecisionInputFromDraft` のサニタイズ（`safeNonNegative` / `safeInRange01`）、
Scenario、P1 係数、AI 判断、TSV 評価式。
engine 直前のサニタイズを残しているため、二重防御のままである。

## 4. 要求項目との対応

| 要求 | 実装 | 確認方法 |
| --- | --- | --- |
| 明示的な 0 は正当な値として受け付ける | `parseNumberInput("0") === 0`。検証も 0 を通す | 単体 INT1-IP-1 / INT1-IP-8、E2E INT1-BLANK-1(a) / BLANK-3 |
| 空欄・不正な数値を、利用者に知らせず 0 として確定しない | 空欄・非数は `NaN`。入力欄は空欄表示＋警告枠＋`data-invalid` | 単体 INT1-IP-1 / IP-7 / IP-9 / IP-10、E2E INT1-BLANK-1(b) / BLANK-2 |
| 入力途中の削除・打ち直しを妨げない | 編集中は打った文字列をそのまま保持し、blur で下書き値へ戻す | 単体 INT1-IP-11、E2E INT1-BLANK-1(e) / BLANK-2 末尾 / BLANK-3 |
| 無効な入力が残っている場合、対象項目を示して提出・確定を止める | `validateDecisionDraftNumbers` が項目名付きで拒否 | E2E で `提示数量` / `増員／減員` / `残業率` の文字列を実画面で確認 |
| Console内PLAYER と Independent Player の両経路で有効 | 前者は `PlayerWorkspace.handleConfirm`、後者は `/api/v2/play/submit` が同じ関数を呼ぶ | E2E INT1-BLANK-1・2（Console内）／INT1-BLANK-3（Independent） |
| Engine計算・Scenario・AI判断は変更しない | 上記「変更していないもの」 | `npm test` 4448 件すべて通過（計算系テストを含む） |

## 5. 実ブラウザでの確認（API直送ではない）

`e2e/int1BlankInputGuard.e2e.ts` で、実際の dev server に Chromium で接続し、
入力欄を操作して確認した。ログは `docs/int1/logs/e2e-blank-input-guard.log`。

| 試験 | 経路 | 対象 | 確認した内容 |
| --- | --- | --- | --- |
| INT1-BLANK-1 | Console内PLAYER | 販売数量 | `0` を入れると値 `0` のまま・警告なし／空欄にすると値は空のまま `data-invalid=true`／空欄で確定すると `提示数量` と `保存していません` を表示して確定されない／空欄のまま 0 へ戻らない／`1500` へ打ち直すと確定できる |
| INT1-BLANK-2 | Console内PLAYER | 人員配置・比率 | 増員／減員を空欄にすると空のまま／確定が `増員／減員` を示して止まる／残業率に `99` を入れても `1` へクランプされず `99` のまま／確定が `残業率` を示して止まる／残業率を空欄にしても 0 にならず止まる／`0.1` へ打ち直すと確定できる |
| INT1-BLANK-3 | Independent Player | 販売数量 | `0` は警告なしで受理／空欄のまま提出すると `提示数量` と `保存していません` を表示し提出されない／`1200` へ打ち直すと提出できる |

### 負の対照（この試験が本当に欠陥を検出できるか）

`InputCells.tsx` を旧挙動（空欄→0・比率クランプ）へ一時的に戻して同じ 3 件を実行し、
**3 件すべてが失敗する**ことを確認した。失敗内容は
`Expected: "" / Received: "0"`（空欄にしたのに 0 が表示される）であり、
修正前の欠陥そのものを捉えている。ログは
`docs/int1/logs/e2e-blank-input-negative-control.log`。対照実行後ただちに復元した。

## 6. 各段での値の変化（最終コードでの実測）

`docs/int1/logs/input-path-audit.log` の抜粋。
`UI経由` の行が「利用者が入力欄に打った文字列が下書きへどう入るか」である。

```
--- 販売計画の数量を空欄（打った文字列: ""）
    UIセルが下書きへ入れる値   null        ← NaN。JSON送信でnullになる。0ではない
    提出前検証（UI経由）      ["販売計画 CN/hoso の提示数量: 0以上の数値を入力してください（受け取った値: null）。"]

--- 販売計画の数量に明示的な0（打った文字列: "0"）
    UIセルが下書きへ入れる値   0
    提出前検証（UI経由）      []          ← 0は正当な値として通る

--- 人員配置の増員／減員を空欄（打った文字列: ""）
    提出前検証（UI経由）      ["人員配置 BAL-F1 の増員／減員: 数値を入力してください（受け取った値: null）。"]

--- 残業率に範囲外の99（打った文字列: "99"）
    UIセルが下書きへ入れる値   99          ← 1へクランプされない
    提出前検証（UI経由）      ["人員配置 BAL-F1 の残業率: 0〜1の数値を入力してください（受け取った値: 99）。"]
```

明示的な 0 の行で「送信→保存される値」が
`（この行は保存されなかった＝消えた）` と出るのは正しい挙動である。
数量 0 は「その市場へは売らない」という意思決定であり、
`buildDecisionInputFromDraft` が数量 0 の販売計画行を engine へ渡さないのは既存仕様
（engine の入力契約は変更していない）。検証は 0 を通し、engine へは
「その市場の計画なし」として伝わる。

## 6b. 最終監査で見つかった JSON 送信時の検証漏れ（修正済み）

### 再現した事実

`app/v2/play/workspace/page.tsx`（Independent Player）は下書きを
`JSON.stringify` して POST する。入力欄の空欄は `NaN` で下書きへ入るが、
**JSON では `null` になる**。
一方 `validateDecisionDraftNumbers` は「省略可能な項目」を
`value !== undefined && value !== null` で検証対象から外していたため、
`null` になった空欄が「省略」と同じ扱いで検証を通過していた。

対象は検証関数内で `!== null` を使っていた 4 項目すべてだった
（司令塔のご指摘は前 2 項目。残り 2 項目は同じ漏れをこちらで限定確認して発見した）。

| 項目 | NaN のまま（Console内PLAYER） | JSON 変換後（Independent Player） |
| --- | --- | --- |
| `workerAssignments[].regularHeadcountChange` | 拒否（増員／減員） | **通過していた** |
| `capexDecision.newProjectProposals[].requestedBudgetUsd` | 拒否（申請額） | **通過していた** |
| `capexDecision.newProjectProposals[].priority` | 拒否（優先度） | **通過していた** |
| `importOrders[].leadTimeTurns` | 拒否（リードタイム） | **通過していた** |

再現スクリプト `scripts/int1/reproJsonNullBypass.ts`。修正前後の両方で動く。

### 修正

省略と空欄は次のように区別できる。

```
省略  JSON.stringify は undefined のキーを落とすため、キー自体が存在しない
空欄  NaN は null になるため、キーが存在して値が null
```

そこで「キーが無ければ検証しない／キーがあれば値を検証する」へ変えた。

```ts
const optional = (record, key, label, check) => {
  if (!(key in record)) return;          // 省略（キーが無い）
  if (record[key] === undefined) return; // 画面内の明示的なundefinedも省略として扱う
  check(record[key], label);             // null はここで型違反として項目名付きに
};
```

2 行目が必要な理由: JSON を通らない Console内PLAYER の確定経路では
`{ leadTimeTurns: undefined }` のようにキーが存在して値が `undefined` に
なることがあり（`buildInitialDraft` が実際にそう作る）、これは従来どおり
省略として扱わなければならない。

あわせて `app/v2/play/workspace/page.tsx` の提出処理に、同じ
`validateDecisionDraftNumbers` による提出前の確認を追加した。
これで JSON 変換を経る前にこの画面で止まり、server 側でも同じ関数が
`null` を拒否する（クライアント・サーバーの二重の確認で、
経路によって厳しさが変わらない）。

### 維持したこと（実測で確認）

| 維持すべき意味 | 結果 |
| --- | --- |
| 明示的な 0 | 通過（正しい） |
| 正当な減員（増減差分 −30 / 実ブラウザでは −10） | 通過（正しい） |
| 増減差分のキーを省略 | 通過（正しい） |
| リードタイムのキーを省略（標準リードタイムを使う意思決定） | 通過（正しい） |
| 申請額なしの設備投資提案（標準予算を使う意思決定） | 通過（正しい） |
| 画面内の明示的な `undefined` | 省略として通過（正しい） |

### 変更していないもの

Engine、Scenario、AI 判断、TSV 評価式、保存形式（Persistence v9）。
`buildDecisionInputFromDraft` のサニタイズも変更していない。

### この件に対応するテスト

| テスト | 内容 |
| --- | --- |
| `int1InputPathIntegrity.test.ts` INT1-IP-13 | 空欄の増員／減員が JSON 変換後も項目名付きで拒否される |
| 同 INT1-IP-14 | 空欄の設備投資申請額・優先度が JSON 変換後も拒否される |
| 同 INT1-IP-15 | 空欄の輸入リードタイムも JSON 変換後に拒否される |
| 同 INT1-IP-16 | 省略可能な項目の「省略」が JSON 変換後も通る |
| 同 INT1-IP-17 | 明示的な 0 と正当な減員が JSON 変換後も通る |
| 同 INT1-IP-18 | 画面内の明示的な `undefined` が省略として扱われる |
| `e2e/int1BlankInputGuard.e2e.ts` INT1-BLANK-4 | Independent Player の実画面で、増減欄を空欄にして提出 → 「増員／減員」「保存していません」を表示し未提出（`EDITING`＝入力中・まだ提出していません）→ −10 へ直すと同じ Turn に提出でき、GM が Turn を進められる |

## 7. 残る制約

- **`<input type="number">` に打てない中間文字列**: Chromium は `-` や `1e` のような
  確定前の不正入力に対して `e.target.value` に空文字列を返す。このため負数の入力は
  打ちにくい。ただし数量・人数・比率の欄はいずれも `min={0}` であり負数は不正値なので、
  実害は「負数を打ちにくい」ことに留まる（打てた場合も検証が項目名を示して止める）。
  減員差分の欄だけは負値が正当なため `min` を外している。
- **輸入発注のリードタイム入力欄**（`ImportProcurementSection.tsx`）は共通入力セルを
  使わず独自の `<input>` を持ち、`raw === "" ? undefined : Math.max(1, Math.round(Number(raw) || 1))`
  としている。空欄は `undefined`（＝標準リードタイムを使う正当な省略）になるため
  今回の `null` 漏れは起きないが、数値にならない入力は `|| 1` で 1 へ、
  範囲外は `Math.max(1, …)` でクランプされる無言の書き換えが残っている。
  今回の指示は JSON 送信時の検証漏れ修正に限定されているため変更せず、
  残件一覧へ回した（検証側は `optional` により、null が届けば拒否する）。
- **Company Lab のテストプレイ画面**（`app/v2/company-lab/page.tsx`・
  `app/v2/company-lab/play/[labId]/`）は今回の対象（Console内PLAYER と
  Independent Player）に含まれない。共通入力セルは共有しているので空欄が 0 に
  ならなくなるが、この経路の提出前検証は今回追加していない。
  空欄のまま進めた場合は engine 直前のサニタイズで 0 となり、計算結果は従来と同じになる。
  この経路にも同じ検証を入れるかは残件一覧へ回す。

## 8. この件に対応するテスト

| テスト | 内容 |
| --- | --- |
| `app/v2/company-lab/__tests__/int1InputPathIntegrity.test.ts` | INT1-IP-1〜12。明示的な0の受理、空欄・非数が0にならないこと、負数・範囲外が丸められないこと、増減差分の空欄検出、打ち直しで再び通ること、JSON送信で `NaN` が `null` になっても項目名付きで止まること、engine直前のサニタイズが無変更であること |
| `app/v2/company-lab/__tests__/int1DraftValidation.test.ts` | 検証関数の網羅（13件）。形が壊れた下書きでも例外を投げず項目名を返す |
| `e2e/int1BlankInputGuard.e2e.ts` | 上記 §5 の実ブラウザ3件 |
| `scripts/int1/auditInputPath.ts` | 各段の値の変化を列挙する監査出力（§6） |
