# 提案：Dynamic Scenario 1 を Player UI 改装ブランチへ取り込む

- 起票: Dynamic Scenario 1 担当（`claude/v2-dynamic-scenario-1-v4bx8v`）
- 日付: 2026-08-16
- 宛先: Player UI 改装担当 / ChatGPT #04
- 対象 staging: `feature/v2-ui-procurement-planning`
  （`.../v2/company-lab/play/lab-6wtfxh` のデプロイ元）

---

## 1. 結論

**Dynamic Scenario 1 が staging に出ていないのは不具合ではなく、想定どおりの状態です。**
原因は独立した2つで、どちらも意図的なものです。

| # | 原因 | 状態 |
|---|---|---|
| **A** | UI 改装ブランチに DS1 のコミットが入っていない | 未マージ（両者とも `8006fb6` から分岐した別系統） |
| **B** | DS1 は開発中シナリオ扱いで、ラボ作成のシナリオ選択肢に出さない設定 | #04 指示（前回§12「まだ正式Scenario一覧へ追加しないでください」）に従った実装 |

**A だけを解消しても、staging のシナリオ選択肢には DS1 は現れません。**
Testplay を始めるには A と B の両方が必要です。

---

## 2. 事実確認（実測）

```
共通の base            : 8006fb6（feature/v2-32q-management-console）
UI 改装ブランチ独自     : 21 commits
DS1 側の未取込          : 7 commits
UI 改装ブランチに DS1 : 含まれていない
```

**両ブランチが触った共通ファイルは1つだけです。**

| ファイル | DS1 側 | UI 側 |
|---|---|---|
| `app/v2/company-lab/play/[labId]/PlayerScreenClient.tsx` | **+2行**（import 1行 + パネル1行） | +7 / −2行 |

DS1 側のこのファイルへの変更は以下の2行だけで、機械的に解決できます。

```diff
-import { ..., OpeningMarketInfoPanel } from "../../components/OpeningInfoPanels";
+import { ..., OpeningMarketInfoPanel, ScenarioNewsPanel } from "../../components/OpeningInfoPanels";

             <ObservedMarketDemandPanel observed={viewModel.openingInfo.observedMarketDemand} />
+            <ScenarioNewsPanel news={viewModel.openingInfo.scenarioNews} turn={viewModel.openingInfo.turn} />
```

他の19本の production ファイルは UI 側が一切触っておらず、衝突しません。

---

## 3. お願いしたいこと

### ステップ1: DS1 のコミットを取り込む

```
git checkout feature/v2-ui-procurement-planning
git merge origin/claude/v2-dynamic-scenario-1-v4bx8v
```

衝突するのは `PlayerScreenClient.tsx` の1ファイルのみです。
**UI 改装後の画面構成に合わせて、`ScenarioNewsPanel` の配置は自由に変えてください。**
現状は期初情報パネル群の末尾に置いていますが、改装後のレイアウトに合う場所へ移して構いません。
パネル自体は `viewModel.openingInfo.scenarioNews` を受け取って描画するだけの部品です。

DS1 側が触った production ファイル（参考・すべて追加のみ、既存挙動は不変）:

```
app/lib/v2/scenario/**                      … シナリオ定義・上書き機構
app/lib/v2/market/productLifecycle.ts       … 上書き解決（未指定時は同一参照を返す）
app/lib/v2/market/consumerInventory.ts      … 構造需要アンカー（opt-in）
app/lib/v2/companyLab/runner.ts             … 必要機能の宣言をマージ
app/lib/v2/companyLab/salesBase.ts, marketDemandObservation.ts
app/v2/company-lab/components/OpeningInfoPanels.tsx  … ScenarioNewsPanel 追加
app/v2/company-lab/play/_lib/viewModel.ts, openingInfoViewModel.ts
app/v2/management/**                        … Console 側の News セクション
```

### ステップ2: DS1 を選択肢に出す（3ファイル・小さな変更）

現在 DS1 は「開発中シナリオ」として、プレイヤー向け一覧から意図的に外してあります。
Testplay を始める判断が出たら、以下を変更してください。

**① `app/lib/v2/scenario/definitions/index.ts`**

```diff
 export const ALL_SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [
   BASELINE_SCENARIO,
   ECUADOR_EARLY_EXPANSION_SCENARIO,
   ECUADOR_DELAYED_EXPANSION_SCENARIO,
   GLOBAL_DISEASE_CRISIS_SCENARIO,
   GLOBAL_DEMAND_BOOM_SCENARIO,
+  DYNAMIC_SCENARIO_1,
 ];

-export const DEVELOPMENT_SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [DYNAMIC_SCENARIO_1];
+export const DEVELOPMENT_SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [];
```

これだけでラボ作成フォームに出ます。`newLabFormModel.ts` は
`ALL_SCENARIO_DEFINITIONS` を唯一のデータ源にしているため、**UI 側の変更は不要**です。

**② 併せて更新が必要なテスト（実測済み）**

この1箇所を変えると、意図的に置いた「まだ公開していないこと」を守るガードが3件落ちます。
**バグではなく、公開判断とセットで外すためのガードです。**

| テスト | ファイル | 対応 |
|---|---|---|
| `listScenarioAliases: 5シナリオすべてを列挙する` | `app/lib/v2/industryLab/cli/__tests__/scenarioAliases.test.ts` | 5 → 6 |
| `DS1: プレイヤー向けシナリオ一覧には含まれない` | `app/lib/v2/scenario/__tests__/dynamicScenario1.test.ts` | 公開後の期待へ反転 |
| `DS1: 既存5シナリオは productLifecycleOverrides も structuralDemandAnchor も持たない` | 同上 | DS1 を対象から除外 |

**この3件以外は何も壊れません**（実測: 3157 pass / 3 fail、失敗は上記3件のみ）。

### ステップ3: 新しいラボを作る

**既存のラボ（`lab-6wtfxh`）のシナリオは後から変わりません。**
`scenarioId` はラボ作成時に保存され、その後のターン処理はその定義で動くためです。
DS1 を試すには **新しいラボを作成し、シナリオとして Dynamic Scenario 1 を選んでください。**

---

## 4. 取り込むと何が動くか

| 機能 | 動作 |
|---|---|
| 32ターンのシナリオ | 疾病・需要ショック・再開ブーム・中国高付加価値化・季節変動 |
| News | 全32ターンに72記事（本文つき）。噂と確報を区別して表示 |
| 必要機能の自動有効化 | DS1 を選んだ時点で商品ライフサイクル等が有効になる（呼び出し側の設定不要） |
| Management Console | シナリオNewsセクションで GM 側からも同じ記事を読める |

**他シナリオの挙動は変わりません。** DS1 が使う3つの機構
（`productLifecycleOverrides` / `structuralDemandAnchor` / `requiredCapabilities`）は
すべて opt-in で、宣言を持たないシナリオには同一参照の設定がそのまま返ります。

---

## 5. 検証済みの状態（DS1 ブランチ単体）

| 項目 | 結果 |
|---|---|
| `npm test` | 3160 pass / 0 fail |
| `tsc --noEmit` | clean |
| `eslint` | clean |
| `next build` | 成功 |
| 32Q 実行 | `completed=32/32` |

マージ後は UI 側で同じ4点を再実行してください。

---

## 6. 判断が必要な点

**ステップ2（DS1 を選択肢へ出す）は #04 の公開判断待ちです。**
前回の指示で「まず architecture / scenario modifier / News / deterministic benchmark が
完成してから追加」とされており、現在その4つは完了しています
（`DYNAMIC_SCENARIO_1_FINAL_REPORT.md` 参照）。

残っているリスクは3点で、いずれも Testplay で確認したい内容です。

1. 5社のうち2社（MASS / VAP）が T6〜T7 以降ゼロ生産になる
   → Standard AI 側の課題として `HANDOFF_05_ZERO_PRODUCTION_TRAP.md` で #05 へ引き渡し済み。
     Testplay では稼働している競合が実質3社になります。
2. Standard AI が global 調達への転換を実演しない（世界側では価格が反転する）
3. T1–4 の収益が収支均衡水準で、「序盤は楽に儲かる」という体感には届いていない可能性

いずれも**世界の設計ではなく AI 側・校正の論点**であり、
DS1 を出さない理由にはならないと考えています。

---

## 7. まとめ（依頼事項）

1. `claude/v2-dynamic-scenario-1-v4bx8v` を UI 改装ブランチへマージ（衝突1ファイル・2行）
2. `ScenarioNewsPanel` の配置を改装後のレイアウトに合わせて調整
3. #04 の公開判断が出たら `ALL_SCENARIO_DEFINITIONS` へ1行追加 + テスト3件を更新
4. 新しいラボを Dynamic Scenario 1 で作成して Testplay 開始

こちらでマージ作業を行うことも可能ですが、
UI 改装ブランチは別担当の作業中のため、**勝手には触っていません**。
ご指示いただければ対応します。
