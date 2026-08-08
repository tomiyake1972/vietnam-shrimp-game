# Standard AI 営業採用ガバナー（「1Q最大9人」）監査

作成日: 2026-08-08
対象: `app/lib/v2/companyLab/standardAi/decision/salesForceHiring.ts`
状態: **調査完了 / 変更は未実施**（指示B11「勝手に削除せず、根拠を報告」に従う）

---

## B11-1. 「9人」はどの式で出るか

```ts
const MAX_HIRE_PER_QUARTER_ABSOLUTE_FLOOR = 5;
const MAX_HIRE_PER_QUARTER_RELATIVE_RATIO = 0.5;

function quarterlyGovernorCap(staticBaselineHeadcount: number): number {
  return Math.max(MAX_HIRE_PER_QUARTER_ABSOLUTE_FLOOR,
                  Math.round(staticBaselineHeadcount * MAX_HIRE_PER_QUARTER_RELATIVE_RATIO));
}
```

基準は `fixture.salesForceHeadcountTotal`（会社設立時の静的な基準規模。ターンをまたいでも変わらない）。

BAL は `fixtures.ts:166` で `salesForceHeadcountTotal: 18`。

> **9 = max(5, round(18 × 0.5))**

つまり「9人」という数値はどこにも直接書かれていない。**会社規模18人の50%として導出されている。**
会社ごとに異なる（MASS=22→11人、他2社=14→7人、1社=10→5人）。

## B11-2. game rule か Standard AI internal heuristic か

**Standard AI の内部ヒューリスティックである。ゲームルールではない。**

- 定義位置は `standardAi/decision/` 配下であり、ゲームエンジン（sales/production/labor/finance）側ではない。
- プレイヤーが手入力する場合、この上限は一切適用されない。
- したがって「1四半期に9人までしか採用できないゲーム」ではない。
  **人間プレイヤーは何人でも採用できる。** Standard AI が自分に課している自制である。

三宅さんが「そのようなゲームルールを設定した認識がない」とおっしゃるのは正しく、
実際にゲームルールとしては存在しない。UI上の説明文
「Static company-size-based hiring governor: 9人/四半期が上限」が
ゲームルールのように読めてしまうことが問題であり、これは表現の欠陥である（後述）。

## B11-3 / B11-4. いつ・なぜ導入されたか

コード内コメント（`salesForceHiring.ts:106-124`）に経緯が残っている。

> 【2026-08-05修正・三宅さんレビュー反映】旧設計では「1回の判断で極端な人数を動かさない」ための
> 安全上限を「現在の（既に増員済みの）営業人員数」に対する相対値としていた。これは実際には
> 安全上限として機能せず、採用が起きるたびに次の四半期の上限自体も膨張する複利成長の式に
> なっていた（8Qシミュレーションで **18→27→41→62→93→140人** という指数的増加が実際に発生し、
> 三宅さんより「バグというより設計通り暴走した」とご指摘を受けた）。

**導入日: 2026-08-05。導入理由: 三宅さんご自身のレビュー指摘への対応。**
「暴走採用防止の暫定策か」への回答は **はい。ただし場当たりではなく、
複利成長を構造的に排除するという明確な設計意図がある**。

基準を「現在人数」から「静的な会社規模」へ変えた点が本質である。
現在人数基準だと採用のたびに上限も増えて発散するが、静的基準なら発散しない。

## B12. すでに marginal economics は実装されている（重要）

指示B12は「固定会社規模ガバナーではなく、追加1人の限界価値で採用数を決める方向を検討」とあるが、
**その限界価値評価はすでに実装済みである。**

同ファイルのコメント（三宅さんご指示として記録されているもの）:

> 1) まず生産・原料・資金いずれの制約にも達しないマージナル経済性の自然停止点まで評価し、
>    「必要な将来営業能力（Target Sales Force）」を先に計算する。
> 2) 必要人数 − 現在人数 = 採用必要数（不足分）を求める。
> 3) 1四半期に実際へ反映する人数の上限（ガバナー）は…静的な基準規模に対する相対値とする。

`MarginalSalespersonEvaluation` は1人ごとに次を評価している。

- `incrementalSalesTonsByProduct` … その1人による商品別の受注増
- `incrementalSalesCoveredByExistingFgTons` … 既存完成品在庫で賄える分
- `incrementalSalesRequiringNewProductionTons` … 追加生産が必要な分
- `incrementalContributionMarginUsd`
- `salespersonQuarterlySalaryUsd`
- `marginalContributionAfterSalesSalaryUsd` … **限界貢献 − 人件費**
- `productionHeadroomSufficient` / `rawMaterialPathUncertain` / `liquidityOk`

停止理由コードも整備されている。

```
SALES_HIRING_NOT_ECONOMIC
SALES_HIRING_BLOCKED_BY_PRODUCTION
SALES_HIRING_BLOCKED_BY_LIQUIDITY
SALES_HIRING_BLOCKED_BY_RAW_SUPPLY_UNCERTAINTY
SALES_HIRING_LIMITED_BY_TARGET_SCALE
SALES_HIRING_DEFERRED_UNTIL_CAPACITY_EXPANSION
```

指示B13（供給制約との接続）も `productionHeadroomSufficient` /
`rawMaterialPathUncertain` として既に入っている。

**したがってガバナーは「経済合理性の代わり」ではなく、
経済合理性で決めた目標へ近づける速度制限（ペース配分）である。**
超過分は捨てられず `deferredByQuarterlyGovernor` として次四半期へ繰り越される。

## B11-5. 現在も必要か / B12への回答

### 削除を推奨しない

削除すると 2026-08-05 以前の状態に戻る。当時の暴走は「限界経済性が無かったから」ではなく、
**限界経済性の停止点そのものが高すぎた**ために起きた可能性がある
（8Qで140人まで伸びた事実は、限界貢献がその人数まで正だと評価されていたことを示唆する）。
限界経済性ロジックの精度を確認せずにガバナーを外すのは危険である。

### ただし2つの改善余地がある

**(1) 表現の問題（今すぐ直すべき）**

UI/診断メッセージが「静的な会社規模基準の9人」と出るため、ゲームルールに見える。
実態は「会社規模18人の50%を1四半期の採用ペース上限としている（Standard AIの自制であり、
人間プレイヤーには適用されない）」である。B9/A8の趣旨に沿って言い換えるべき。

**(2) ガバナーが実際に効いているかの実測（未実施）**

`SALES_HIRING_LIMITED_BY_TARGET_SCALE` や `deferredCount > 0` が
Test15のBALで実際に出ているかを確認していない。
- **出ていない**なら、9人は名目上の上限であり日本偏重とも無関係。触る必要はない。
- **毎期出ている**なら、限界経済性の停止点が常にガバナーより上にあることになり、
  その場合は指示B12の方向（停止点側の見直し）を検討する価値がある。

**この実測をせずにガバナーを変更すべきではない。** 今回は変更していない。

### B14 の遵守

新しい根拠のない固定上限（最大10人・総人数の10%など）は**一切追加していない**。

## 「9人採用問題」と「日本偏重問題」は別事象である

指示B10のとおり、両者は別ロジックであり、原因も別である。

| 問題 | 場所 | 原因 |
|---|---|---|
| 日本へ偏る | `decision/sales.ts` | 前期価格首位に固定50%。市場規模を見ていない |
| 1Q9人まで | `decision/salesForceHiring.ts` | 静的会社規模18人 × 50% のペース上限 |

日本偏重を直しても9人は変わらず、9人を変えても日本偏重は直らない。
