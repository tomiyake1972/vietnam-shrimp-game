# Standard AI Target Sales Force 設計文書（2026-08-05・Target Scale統合版）

作成: Cowork #05（AI設定）
実装ファイル: `app/lib/v2/companyLab/standardAi/decision/salesForceHiring.ts`

本文書は`STANDARD_AI_SALESFORCE_HIRING_DESIGN.md`（初版・複利成長修正版）の続きとして、Target Scale導入による設計変更を記録する。初版からの残す要素（marginal sales・marginal contribution・salesperson salary・production feasibility・raw feasibility・liquidity gate・inventory-aware economics）は変更していない（三宅さんご指示§21）。

## 1. 変更の中心: 採用人数の決定主体

**旧方式**: marginal-positive loop（限界利益が正な間は増員）。
**新方式**: まず「Target Scaleに必要な営業能力に対して何人不足しているか」を求め、その範囲内でmarginal economicsを確認する。

```
Target Sales Volume（Target Scale帯とproduction-supported scaleの小さい方）
  ↓
required sales capacity（realisticSalesAtHeadcountがTarget Sales Volumeへ到達するまでのheadcount）
  ↓
required salesperson headcount（自然停止条件A/D/E/G/Hのいずれかに到達するまで、+1ずつ評価）
  ↓
current/next-quarter effective salesperson headcountとの差（targetGap）
  ↓
hire/layoff candidate（1四半期あたりのガバナーでキャップ）
```

順序を逆にしない（三宅さんご指示§21「まず『何人必要か』→その範囲内でmarginal economicsを確認、逆順にしない」）よう、ループの各反復の先頭でTarget Sales Volumeへの到達をチェックしてから、通過した場合のみ経済性・生産・原料・資金のゲートを評価する実装にした。

## 2. Target Sales Volume（§12「Sales CapacityとMarket Opportunityの区別」）

```ts
const productionSupportedScaleTons = hasNearTermCapexUnderConstruction
  ? targetScaleBand.max
  : totalEffectiveCapacityByProduct合計;
const targetSalesVolumeTons = min(targetScaleBand.max, productionSupportedScaleTons);
```

- **Sales Capacity**（自社営業組織が処理できる能力）: `realisticSalesAtHeadcount`（既存の`sales/marketEffort.ts`）がheadcountから導出する値。
- **Market Opportunity**（市場側で現実に獲得可能な数量）: `realisticSalesAtHeadcount`が希望量（wish）で自然に飽和するため、別途キャップしていない。市場配分上限（35%キャップ等）は#04の`allocation.ts`が既に適用済みの値をベースにしており、#05側でシェア上限の数値をhard-codeしていない（三宅さんご指示§11）。
- **Production-supported scale**: 設備投資が進行中でなければ現在の実効生産能力、進行中ならTarget Scale（max）まで許容（三宅さんご指示§14。実際の過剰先行の歯止めは既存の当期生産余力ゲートが担う。`STANDARD_AI_CAPACITY_PLANNING_4Q.md`§4参照）。

`min(strategic target scale, realistic obtainable market opportunity, production-supported sales scale)`のうち、market opportunity項は既存のwish飽和メカニズムがそのまま担うため、明示的な3項min計算にはせず、2項（Target Scale・production-supported）のminとwish飽和の組み合わせで実質的に同じ効果を得ている。

## 3. Target Sales Forceの上限（三宅さんご指示§10）

`max(5, currentHeadcount × 50%)`を採用人数決定の**中心には使わない**よう変更済み（前回セッションで対応、`STANDARD_AI_SALESFORCE_HIRING_DESIGN.md`§4参照）。採用人数は`targetGap = targetSalesForceHeadcount − currentHeadcount`から求め、安全上限（ガバナー）は会社の**静的な基準規模**（`fixture.salesForceHeadcountTotal`）に対する相対値とし、複利成長する`currentHeadcount`比率を使わない。

## 4. Sales Layoff（三宅さんご指示§22）

減員候補の判定自体（末尾1人のmarginal contributionが給与以下・在庫がボトルネックでない・退職金を考慮しても節約効果が上回る）は変更していない。今回、Target Scaleとの整合として、`SALES_CAPACITY_ABOVE_TARGET_SCALE`診断（§6参照）が「営業能力がTarget Scaleを大幅に超えている」ことを別途示すが、**この診断自体が自動的に減員を発生させるわけではない**（既存の減員判定ロジックはそのまま独立して動作する）。Target headcountぴったりまで毎期削減する設計にはしておらず、`targetScaleWithinBandTolerance`（±5%）が実質的なcapacity bufferとして機能する（三宅さんご指示§23）。

## 5. Production/Worker/Raw/Financeとの整合（変更なし部分の再確認）

初版（`STANDARD_AI_SALESFORCE_HIRING_DESIGN.md`§7）の非接続方針は維持している。Target Scale導入によって新たにこれらの本番ロジックへ書き込みを行う経路は追加していない。`targetCapability.ts`のWorker/Raw診断はいずれも「診断専用」であり、`salesForceHiring.ts`からも一切参照していない（`policy.ts`のdiagnostics entriesへ並行して追加されるのみ）。

## 6. Reason Codes（新規、三宅さんご指示§28）

| コード | 発火条件 |
|---|---|
| `STRATEGIC_TARGET_SCALE_SET` | policy.tsが毎ターンTarget Scale Bandを算定した際に発火（診断のみ） |
| `SALES_CAPACITY_BELOW_TARGET_SCALE` | 現在の実効営業能力（realistic sales相当）がTarget Scale帯のminを下回る |
| `SALES_CAPACITY_WITHIN_TARGET_BAND` | 帯の範囲内（許容乖離±5%込み） |
| `SALES_CAPACITY_ABOVE_TARGET_SCALE` | 帯のmaxを上回る |
| `PRODUCTION_CAPACITY_BELOW_TARGET_SCALE` | 生産能力がTarget Scale（preferred）を下回り、設備投資も進行していない |
| `FUTURE_CAPEX_SUPPORTS_TARGET_SCALE` | 生産能力は不足しているが設備投資が進行中 |
| `SALES_HIRING_LIMITED_BY_TARGET_SCALE` | Target Sales Volumeの上限（Target Scale側が制約）に到達し、限界利益が正でも採用を止めた |
| `SALES_HIRING_DEFERRED_UNTIL_CAPACITY_EXPANSION` | Target Sales Volumeの上限（生産能力側が制約、設備投資も未進行）に到達し、採用を止めた |
| `FINANCEABLE_SCALE_BELOW_STRATEGIC_TARGET` | Target Scale自体は維持しつつ、資金体力から見た現実的規模がそれを下回る |

## 7. 既知の限界

- Target Sales Volumeのproduction-supported scale判定は会社全体合計での近似（商品別ではない。初版からの既知の限界を継続）。
- `targetScaleWithinBandTolerance`（±5%）は初期値であり、校正対象。
- Target Scale帯自体の粘着性は「実効生産能力ベースで算定する」ことで構造的に確保しているが、複数四半期の移動平均等によるさらなる粘着性の強化は未実装。
