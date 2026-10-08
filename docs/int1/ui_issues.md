# INT-1 §6 / §10 — UI課題の現状と対処

更新: 2026-10-07 JST / 対象: ローカル統合候補

分類は「統合候補のコードと実測で確認した結果」である。UNVERIFIED は、元の指摘の症状を特定できず判定を保留したもの。

## 1. INT-1 で修正したもの

### (1) 新工場建設カードが「生産能力を増加させません」と表示する — 修正済み
- **原因**: `capex/parameters.ts` は新工場建設の `futureCapacityEffect` を「targetProduct省略・capacityIncreaseTonsPerQuarter=0」にしている（単一プール加算方式ではないため）。その結果 `investmentPlanningViewModel.ts` の「能力を増やさない案件」分岐へ落ち、品質検査機器・環境対応設備・PD省人化と同じ文言が出ていた。`InvestmentCardList.tsx` がそれを描画していた。
- **修正**: Engine が稼働開始時に実際に使う `newFactoryEffect`（`fullCapacities` / `rampMultipliers`）を読んで説明文を作る。UI側で能力値を決め打ちしない。
- **修正後の表示（実測）**: 「この投資は工場を1つ新設します。完成・操業準備の完了後に稼働を開始し、フルランプ時には 共通前処理能力 22,000t/四半期、HOSO加工能力 10,000t/四半期、PD加工能力 8,000t/四半期、VAP加工能力 6,000t/四半期、凍結・包装処理能力 20,000t/四半期、冷凍・冷蔵保管能力 10,000t（同時保管）が加わります。稼働開始直後は能力が段階的に立ち上がります（稼働0四半期目 50% → 稼働1四半期目 75% → 稼働2四半期目 100%。以降はフルランプ）。当期の処理見込みは増えません（稼働開始は完成後です）。」
- **当期の処理見込みは 0 のまま据え置いた**（新工場はまだ存在しないため。架空の即時効果を作らない）。
- **テスト**: `int1NewFactoryCardDisclosure.test.ts` INT1-UI-1〜4（期待値もテスト側で数値を書かず、同じ `CAPEX_PARAMETERS_V1` から導出して突合）。

### (2) COMMERCIAL GROWTH で AI の参考判断と PLAYER 実績が混在する — 修正済み
- **原因（コードで確認した事実）**:
  - ①Vision ②Ambition ③Commitment は `standardAi/diagnosis/commercialGrowth.ts` が作る Standard AI の内部判断。
  - ④Submitted は `aiPack/capture.ts` が `diagnostics.decision.salesPlans` から集計した **Standard AI 自身の提示量**。PLAYER が実際に提出した量ではない。
  - ⑤Contracts ⑥Production は `CompanyQuarterSummary`（エンジンの確定実績）。
  - `packCompanyTurns[].decisionOwner` は利用可能だったが、このviewは参照していなかった。
- **修正**: PLAYER が決めたTurnを含む会社では
  - 系列名に「（AI参考値）」を付け、④は「④ 市場へ提示（AI参考値・PLAYER実提出量は未取得）」にする。
  - ⑤⑥は「（実績）」と明示する。
  - チャート上に注意書きを出し、該当Turn番号を列挙して「PLAYERの実提出量はこの保存記録に含まれないため未取得（推測で補完していない）」と書く。
  - 制約内訳テーブルに「決定者」列（PLAYER / AI）を追加する。
- **値は一切書き換えていない。** 実績を推測で作っていない。

### (3) 提出値の消失・無効な値の保存 — 修正済み
- **再現（統合候補上の実測）**: `buildDecisionInputFromDraft` は安全側に倒して無効値を黙って置換し、数量0以下の行を黙って落とす。
  | 入力 | 修正前の結果 |
  | --- | --- |
  | `salesPlans[0].desiredQuantity = null`（NaN/Infinityの実体） | その行が decision から消える |
  | `salesPlans[0].desiredQuantity = -5000` | その行が消える |
  | `salesPlans[0].desiredQuantity = "abc"` | その行が消える |
  | `productionPlans[0].desiredQuantity = -9999` | その行が消える |
  | `workerAssignments[0].regularHeadcount = -100` | **0 になる**（全員解雇相当） |
  | `workerAssignments[0].overtimeRate = 99` | 1 にクランプ |
  | `dividendAmountUsd = -1000000` / `null` | 0 になる |
  いずれも利用者へ何も伝えない。加えて、`submitPlayerDecision` を直接呼ぶ経路では非有限数がそのまま保存され、JSON往復で `null` になり、GM の Turn 進行が `UnitValidationError` で止まることも実測した。
- **修正**: サニタイズ自体は変更しない（既存Runの再現性を壊さないため）。代わりに `validateDecisionDraftNumbers`（`decisionDraft.ts`）を追加し、サニタイザが値を書き換えざるを得ない入力＝無効入力を提出前に検出して拒否する。判定条件はサニタイザと同じ範囲を写しており、**正当な0は通る**。
  - Independent Player: `/api/v2/play/submit` が HTTP 400 `INVALID_DECISION` を返す。メッセージに「値は保存していません」と該当項目を含める。
  - Management Console 内 PLAYER: 確定時に既存の `workspace-confirm-error` へ同じ文言を出し、保存しない。
  - 形が壊れた下書き（配列欠落・null）も 500 ではなく 400 にする。
- **テスト**: `int1DraftValidation.test.ts` INT1-UI-5〜9（13件）、`int1PlayerInputIntegrity.e2e.ts` INT1-E2E-1/2。

### (4) 古いTurnの結果との混在 — 実機で確認し、データ側の欠陥は無し
- Console 内 PLAYER 画面は `session.state` から毎レンダー導出しており、Console から「この会社を操作」で開き直すと現在のTurnが表示される。E2E（INT1-E2E-3）で、GM が Turn1 を進めた後に開き直すと `Turn 2` が表示され、前Turnの確定表示が残らないことを確認した。
- Independent Player は4秒間隔で自動更新される。
- 古いTurnの提出自体はサーバが拒否する（`validateSubmittable` の `STALE_TURN`、Console保存経路は CAS の `SAVE_CONFLICT`）。
- 検証できるようにするため、ワークスペースのヘッダへ `data-testid="workspace-turn"` / `data-turn` を追加した（表示内容は変えていない）。
- **残る注意**: Console 内 PLAYER 画面は registry を購読しておらず polling もしないため、画面を開いたまま別タブで GM が進行した場合は表示が古いままになりうる。運用上は開き直す。

## 2. 追加で修正したもの（単一窓口指示 §2・§3・§4）

### (5) 商品別受注残が PLAYER の意思決定画面に無い — 修正済み
- **切り分けの結果（情報の欠落ではなかった）**: 市場×商品別の受注残テーブルは `OpeningCompanyStatePanel`（Decision→情報 画面）に既に存在していた。欠けていたのは
  (a) 販売数量・生産数量を決める SALES / PRODUCTION 画面からの導線、(b) 納期超過の分離。
- **修正**: 集計は既存SSoT `aiManagementMeeting/backlogSemantics.ts` の `computeBacklogSemantics` をそのまま使い（新しい集計を作らない）、`BacklogByProductPanel` を SALES / PRODUCTION の両画面へ出す。
  商品別に 受注残合計 / 納期超過 / 当期納期 / 将来納期 / 状態、さらに市場×商品別の上位内訳と最短納期を表示する。
- **混同しない**: 受注残と完成品在庫を別の量として扱い、在庫・納期で充足できる分を無視した警告は作らない（画面側にしきい値判定・警告生成を持たせていない。静的確認テストで固定）。
- **両経路に届く**: Console内PLAYER と Independent Player は同じ `DecisionStudio` を使うため、1箇所の配線で両方に反映される。
- **テスト**: `int1BacklogByProduct.test.ts` INT1-BL-1〜4。

### (6) 借入結果・緊急融資が PLAYER 画面に無い — 修正済み
- **原因**: 分離表示は `FinancingTab.tsx` に既にあったが、それを含む `FinancialResultsSection` は `company-lab/play/[labId]`（GM/開発者用テストプレイ画面）だけが描画していた。PLAYER のワークスペースへは `lastQuarterFinancialResult`（PL/BS/CF）しか渡しておらず、`FinancingQuarterResult` は未配線だった。
- **修正**: `extractCompanyFinancingResult`（既存）で前Turnの確定記録を取り、`LastQuarterFinancingResultPanel` を FINANCE 画面へ出す。表示項目は
  申請額 / 実行額 / 減額・否認された額 / 適用金利 / engine が記録した理由 / 緊急融資（実行有無・申請額・実行額・適用金利・上限・理由）。
- **推測しない**: 記録が無い場合は「未取得」と表示し、借入残高の差から実行額や理由を逆算しない（静的確認テストで固定）。金融ルールは変更していない。
- **テスト**: `int1FinancingDisclosure.test.ts` INT1-FIN-1〜3。

### (7) 営業人員の無効入力で GM の Turn 進行が止まる — 修正済み
- **再現（実測・baseline / BAL / 現員60人・上限18人）**:
  採用19人を提出 → 受理され保存される → GM が「1 Turn」を押すと `CompanyLabError` で停止 →
  PLAYER が同じTurnへ正しい値で再提出すると `DUPLICATE_SUBMIT` で拒否 → **そのTurnが進められず、PLAYER 自身では直せない。**
- **修正**: `validateSalesForceHiringDecision`（`salesForceHiring.ts`）を追加し、提出（`submit.ts`）と Console の確定（`PlayerWorkspace.tsx`）の両方で保存前に拒否する。
  判定は runner.ts が使うのと同じ `computeMaxSalesHiresPerQuarter` を呼ぶため、上限式を UI へ別実装していない。
- **修正後（実測）**: 提出が `INVALID_DECISION` で拒否 → 保存されない → GM の Turn 進行成功 → 同じTurnへ正しい値で再提出成功。
- **乖離防止**: `int1SalesForceHiringValidation.test.ts` INT1-SFH-1/2 が、採用人数を上限の前後で走査して「検証関数が拒否する ⟺ engine が throw する」の一致を実測で固定する。INT1-SFH-3 は UI・サーバが共有関数を経由していること（独自の係数式を持たないこと）を静的に確認する。

### (8) 入力値が無言で別の意思決定に変わる — 修正済み（監査後に再修正）

- **再現（実測・修正前）**
  | 利用者の入力 | 修正前の結果 | 通知 |
  | --- | --- | --- |
  | 販売数量を**空欄**にした | 下書き 0 → 検証通過 → **その販売計画の行が消える** | なし |
  | 販売数量に `-5000` | 下書き 0 → 同上 | なし |
  | 増員／減員欄を**空欄**にした | 下書き 0（増減なし） | なし |
  | 臨時人数に負数 | 0（`n > 0 ? n : 0`） | なし |
  | 残業率に `99`（`0.99` の打ち間違い） | **1 へクランプ**（残業率100%として保存） | なし |
  | 設備投資の申請額を空欄 | 見込み支払額の表示が `NaN` | 理由が出ない |

- **監査で判明した未修正箇所**: 最初の修正は共通入力セル `InputCells.tsx` だけだった。
  **人員配置と比率の入力欄は共通コンポーネントを使っておらず**、
  `WorkforcePanel.tsx` が独自の `<input>` 3 つを持ち、上表のクランプがそこに残っていた。
  さらにその 3 つは `buildDecisionInputFromDraft` を通した**サニタイズ後の view-model 値**に
  バインドされていたため、空欄にしても次のレンダリングで 0 が書き戻される構造だった。

- **「type=number だから空欄と0は区別できない」という以前の説明は誤り**。
  `onChange` の `e.target.value` は文字列で、`Number()` へ渡す前に `raw === ""` を判定できる。
  旧実装が `Number("") === 0` にそのまま乗っていただけだった。

- **修正**
  - `parseNumberInput` / `parseRatioInput`: 空欄・空白のみ・非数は `NaN`。明示的な `"0"` は 0 として受理。負数・範囲外は丸めない。
  - 入力欄は `NaN` のとき空欄表示＋警告枠＋`data-invalid="true"` / `aria-invalid`。
  - 編集中は利用者が打った文字列をそのまま保持し、blur で下書き値へ戻す（`0.` が 0 に戻って小数点が打てなくなるのを防ぐ）。
  - `WorkforcePanel.tsx` の独自 `<input>` を共通セルへ置換し、編集対象 3 項目は**下書きの生値**にバインド。減員差分は `min={null}` で下限を外す。
  - `regularHeadcountChange` 自体を検証に追加（engine の `applyHeadcountChange` が非有限を 0 扱いするため、`regularHeadcount` 側では空欄を検出できないことを実測）。
  - engine 計算式・`applyHeadcountChange`・`buildDecisionInputFromDraft` のサニタイズは変更していない（二重防御のまま）。

- **両経路で有効**: Console内PLAYER は `PlayerWorkspace.handleConfirm`、
  Independent Player は `/api/v2/play/submit` が同じ `validateDecisionDraftNumbers` を呼ぶ。

- **実ブラウザでの確認**: `e2e/int1BlankInputGuard.e2e.ts`（3件）。
  正当な 0 の受理／空欄が空欄のまま保たれる／`99` がクランプされない／
  対象項目（`提示数量`・`増員／減員`・`残業率`）を示して止まる／打ち直すと提出できる、を
  販売数量・人員配置・比率について両経路で確認した。
  旧挙動へ一時的に戻した**負の対照**で 3 件すべてが
  `Expected: "" / Received: "0"` で失敗することも確認済み。

- **テスト**: `int1InputPathIntegrity.test.ts` INT1-IP-1〜12、`e2e/int1BlankInputGuard.e2e.ts`。
- **最終監査で見つかった追加の漏れ（修正済み）**: Independent Player は下書きを
  `JSON.stringify` して POST するため、空欄の `NaN` が `null` になって届く。
  検証関数が省略可能な項目を `!== null` で除外していたため、`null` になった空欄が
  「省略」と同じ扱いで通過していた（実測。対象は `regularHeadcountChange` /
  `requestedBudgetUsd` / `priority` / `leadTimeTurns` の4項目）。
  「キーが無ければ省略／キーがあれば値を検証する」へ変え、
  `app/v2/play/workspace/page.tsx` にも同じ検証関数による提出前の確認を追加した。
  再現は `scripts/int1/reproJsonNullBypass.ts`、テストは INT1-IP-13〜18 と
  E2E INT1-BLANK-4。
- **詳細**: `docs/int1/zero_value_handling.md`（§6b が JSON 送信時の漏れ）。

### (9) 認証切れ（HTTP 403）時の表示と復旧 — 確認済み（製品変更なし）
- **実測方法**: 管理セッション Cookie（`shrimpx_company_lab_ui_session`）をブラウザから削除して実際に 403 を発生させた（テスト用の分岐を製品へ入れていない）。
- **結果**:
  - 保存成功と誤表示しない: `persistence-blocked-banner` が「サーバー保存（正本）が失敗しました」「この状態のままTurnを進めると、進行状況が保存されずに失われます」「Turnを進めるボタンを無効化しています」を表示し、`run-1` が無効化される。
  - 再ログイン導線: `persistence-relogin-link` は同一オリジンの相対リンクで `returnTo` を持ち、ログイン後に同じ Run へ戻る。
  - 確定済み提出は維持される: 再ログイン後、保存済み正本（Turn 0）から再開でき、再確定せずに Turn を進められた（`Saved: 1` まで確認）。
- **実測した仕様の注意**: `live-vs-saved` 診断は Console 側の保存が一度でも成功した後にのみ描画される（`lastPersisted` が成功時のみ設定されるため）。最初の Console 保存が 403 で失敗したケースでは出ない。上記 banner が保存失敗を明言しているため誤表示ではなく、製品は変更していない。
- **テスト**: `int1AuthExpiryAndInput.e2e.ts` INT1-AUTH-1/2/3。

### (10) 未確定入力が失われることの明示 — 修正済み
- Console内PLAYER 画面がこのタブで Run 状態を持っていない場合のパネルへ、
  「未確定の入力（確定を押す前の下書き）は失われています／今回のTurnの入力をもう一度行ってください／確定済みの意思決定はサーバに保存されているため失われません」を追記した。
- 新しい下書き永続化機構は追加していない。
- **テスト**: `int1AuthExpiryAndInput.e2e.ts` INT1-AUTH-4。

## 2. 今回は直していない課題（§10分類）

| # | 課題 | 分類 | 影響 | 回避手順 | 研修前に必須か |
| --- | --- | --- | --- | --- | --- |
| 1 | 借入申請額と実行額がPLAYER画面で区別できない | VERIFIED STILL PRESENT（PLAYER画面）/ VERIFIED FIXED（Company Labテストプレイ画面） | 実行額を申請額と誤認して資金計画を誤る | GM が Console 側で確認し参加者へ伝える | **必須候補（Release Critical）** |
| 2 | 緊急融資の実行有無・承認額がPLAYER画面に出ない | 同上 | 資金判断を誤る | 同上 | **必須候補（Release Critical）** |
| 3 | 商品別（HOSO/PD/VAP）受注残がPLAYER画面に無い | VERIFIED STILL PRESENT | 商品別の販売・生産判断の材料が欠ける | 監査Excel／GM画面で確認 | 必須候補（影響は1・2より小さい） |
| 4 | 輸入代金の支払時期が1画面にまとまっていない | UNVERIFIED | 資金繰りの読みにくさ | 到着予定四半期は輸入発注セクション、買掛金決済サイトは Decision→情報 画面で確認 | 延期可能 |
| 5 | 工場別入力と会社合計の混同 | UNVERIFIED（見出しでは区別されている） | 入力対象の誤認 | 「会社合計」「工場別」の見出しを確認する運用 | 延期可能 |
| 6 | 無効入力時の無言の0丸め | **VERIFIED FIXED**（上記1-(8)。入力欄・提出前検証の両方。実ブラウザと負の対照で確認） | — | — | — |
| 6b | Company Lab テストプレイ画面の提出前検証 | 今回の対象（Console内PLAYER / Independent Player）外。共通入力セルは共有するため空欄は0にならないが、この経路の提出前検証は未追加。空欄のまま進めた場合は engine 直前のサニタイズで 0 となり計算結果は従来と同じ | 研修本番の経路ではない | — | 延期可能（残件） |
| 7 | 未確定の下書きが再読み込みで消える | VERIFIED STILL PRESENT | 入力のやり直し | 入力途中で再読み込みしない。確定を分割する | 延期可能（重大側はO1で解消済み） |
| 8 | Console内PLAYER画面を開いたままの古いTurn表示 | 上記1-(4)参照 | 表示のみ | 開き直す | 延期可能 |
| 9 | 営業人員採用上限超過がGMのTurn進行時に拒否される | VERIFIED STILL PRESENT | その会社の提出をPLAYER自身で直せず、GMが代理確定する必要がある | GM が「この会社を操作」で代理確定 | 必須候補（運用で回避可能） |
| 10 | 管理者再ログイン導線 | VERIFIED FIXED | — | — | — |
| 11 | 新工場の人員配置 | VERIFIED FIXED（`key={revision}` によるremountの除去済み。NEWF-W-1〜10がPASS） | — | — | — |
