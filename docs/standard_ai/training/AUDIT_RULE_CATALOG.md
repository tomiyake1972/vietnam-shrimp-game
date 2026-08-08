# Standard AI 監査ルールカタログ v1

実装: `app/lib/v2/companyLab/standardAi/training/audit.ts`

各ルールは記録済みの `decision` / `result` に対して機械的に適用される。すべての finding は
`findingId / severity / seed / company / quarter / rule / observation / decision / result / counterfactual / suspectedRootCause / relevantFiles / confidence / classification` を持つ。

`classification` は次の3値であり、Claude Code が自分で修正してよいのは **AI_LOGIC_DEFECT のみ**である。

| classification | 意味 | 対応 |
|---|---|---|
| `AI_LOGIC_DEFECT` | AI 側の実装欠陥 | Standard AI を修正してよい |
| `MANAGEMENT_JUDGMENT_REVIEW` | 経営哲学に属する判断（攻める/守る等） | 判断を仰ぐ。自分で決めない |
| `ENVIRONMENT_ISSUE_CANDIDATE` | ゲーム環境側の疑い | 報告のみ。修正しない |

## Level A（機械的に判定できる論理欠陥）

| ID | 検出する事象 | severity |
|---|---|---|
| A01 | ある市場へ営業人員シェア30%以上を投入しているが、その市場の現実的機会シェア（対象需要×最大供給者シェア）が投入シェアの半分以下で、かつ他市場に1,000t超の未充足機会がある | P1 |
| A02 | 35%の最大供給者シェア上限に到達済みの市場へ、さらに営業人員を追加している | P1 |
| A03 | 完成品在庫が目標を大きく超えている商品を、さらに増産している | P2 |
| A04 | 完成品在庫が3四半期以上連続で単調増加している（売れないものを作り続けている） | P2 |
| A05 | 生産必要量が無い（または在庫過剰）にもかかわらず原料を買い増している | P2 |
| A06 | 原料不足が発生している状態で、原料制約を織り込まない生産計画を立てている | P1 |
| A07 | 納品能力（生産＋完成品在庫）を大きく超える量を新規成約している | P1 |
| A08 | 労働不足が発生しているのに、残業・臨時・採用のいずれの手当もしていない | P1 |
| A09 | 遊休労務費が発生し続けているのに人員を縮小していない | P2 |
| A10 | 同じ対象への設備投資を重複提案している | P2 |
| A11 | 能力逼迫が無いのに設備投資を提案している | P2 |
| A12 | 財務的窮境（現金枯渇・債務超過）下で成長投資を提案している | P1 |
| A13 | 同一市場×商品で契約不履行・延滞を繰り返している | P1 |
| A14 | 営業人員の限界貢献が給与を下回っている（増員が経済的でない）のに配置を維持している | P2 |

## Level B（経営判断に属する。自動修正しない）

| ID | 検出する事象 | 扱い |
|---|---|---|
| B_STRATEGIC_MARKET_CONCENTRATION | 特定市場への営業集中が継続している | `MANAGEMENT_JUDGMENT_REVIEW`。集中戦略は誤りとは限らないため、事実として提示するに留める |

Level B は毎四半期・全社に対して発火するため件数が大きくなる（baseline で1,600件 = 全 company-quarter）。これは「問題が1,600件ある」という意味ではなく、「経営判断としてレビューすべき事象が全期間で継続している」という意味である。**severity は P3 に固定**し、Level A の集計を汚染しないようにしている。

## severity の意味

| severity | 意味 |
|---|---|
| P0 | 会社が破綻・停止に至る致命的欠陥 |
| P1 | 経営成績に有意な損失を与える論理欠陥 |
| P2 | 非効率だが致命的ではない |
| P3 | 情報提示・経営判断レビュー対象 |

## 監査ルールの限界（明示）

A01 が使う「市場別の対象需要」は、**ハーネスがシミュレーション結果から直接読んだ値**であり、Standard AI が観測できる情報ではない。現行の `PublicMarketInfo` / `StandardAiObservation` には市場別の絶対需要量が一切存在しない（`diagnosis/marketOpportunity.ts` の冒頭コメント参照）。

したがって A01 は「AIが見えていたのに間違えた」ではなく「AIには構造的に見えていない」ことを検出している。この区別は `TEST15_JP19_ROOT_CAUSE.md` に詳述する。
