# Test14 Turn2 — Shadow Sales Allocation Engine 比較（Phase D）

2026-08-03 Cowork #05（AI設定）実施

**注記**: Test14-equivalent fixture / reconstructed case（`baseline`シナリオ、BAL社、turn2、営業人員18人）。実際のTest14保存データではない。

## 1. Current（本番Standard AI） vs Shadow-volume-max vs Shadow-contribution-max

| 市場 | 現在人数 | 現在販売(t) | Volume-shadow人数 | Volume-shadow販売(t) | Contribution-shadow人数 | Contribution-shadow販売(t) | Contribution-shadow$ |
|---|---|---|---|---|---|---|---|
| CN | 3 | 834.7 | 4 | 1,371.4 | 3 | 923.1 | $1,616,558 |
| US | 2 | 638.3 | 3 | 1,107.7 | 4 | 1,142.9 | $2,120,751 |
| EU | 2 | 638.3 | 4 | 1,371.4 | 4 | 1,142.9 | $2,230,663 |
| JP | 9 | 1,578.9 | 4 | 1,371.4 | 4 | 1,142.9 | $2,280,561 |
| OTHER | 2 | 638.3 | 3 | 1,107.7 | 3 | 923.1 | $1,603,871 |
| **合計** | **18** | **4,328.5** | **18** | **6,329.6** | **18** | **5,274.9** | **$9,852,404** |

（会社全体の商品別理論上限ceiling=desiredByProduct: HOSO 8,000t / PD 6,400t / VAP 4,800t。いずれのshadowも人員18人を使い切っている＝`unassignedHeadcount=0`。）

## 2. なぜ差が出るか

**Current（本番）**: 前期参照価格が最高位の市場（JP）へ希望量の50%を配分し、その希望量に比例して人員そのものを配分する。市場の実需要規模・営業人員の飽和特性・貢献利益は一切見ていない。結果、JPだけが9人（会社全体の50%）を得て、他の4市場が2〜3人ずつしか得られない。

**Volume-shadow / Contribution-shadow**: 1人ずつ、営業容量関数の飽和特性（Michaelis-Menten型、`capacity(h)=200+4800h/(h+10)`）をそのまま使って評価する。JPに9人目を割いても、追加1人あたりの容量増分（限界効果容量）はごく小さい（h=8→9では約51t/人程度まで低下している）。一方、CN/US/EU/OTHERはまだ低人数域（2〜3人）にあり、次の1人を割いたときの限界効果容量がJPより大きい（h=2→3で約264t/人程度）。したがって、どちらのshadowも「JPに追加するより、他市場へ回した方が総量・総貢献利益ともに増える」と判定し、JPへの配分を9人→4人へ減らし、他の4市場へ再配分する。

Volume-shadowとContribution-shadowの間でも配分は完全には一致しない（CNは4人vs3人、USは3人vs4人）。これはVAPのCM%が最高（44〜50%）だが同時にeffort係数も最大（3.0）であるため、「トン数最大化」と「$最大化」で最適な商品ミックスの重みが変わるためである（VAPを増やすとトン数は伸びにくいが$は伸びやすい）。

## 3. Volume-oriented vs Contribution-oriented

Volume-shadowは合計6,329.6t、Contribution-shadowは合計5,274.9t（$9,852,404）。Volume-shadowの方が総量は多いが、Contribution-shadowは同じ18人でより高い$を生む商品ミックス（VAP比率が高い）を選んでいる。三宅さんの指示どおり、どちらか一方だけを「正解」とせず、両方を保持して比較できる形にしている。

## 4. 本番との差異の分類

現在の本番Standard AIの配分（JP9人・他4市場2〜3人）は、Volume-shadow・Contribution-shadowのいずれとも一致しない。差異は**Standard AI意思決定ロジックの問題**（4分類③）である。ゲームルール変更・observation配線ギャップ・戦略的判断の違いのいずれにも該当しない（本番ロジックが需要規模も採算性も見ずに前期価格順位だけで配分しているという、ロジック自体の設計限界）。

**注意**: 本番との差が大きいことをもって「Shadowの方が正しい」と機械的に断定してはいない。Shadow自身も市場別絶対需要が観測不能という同じ限界を抱えており（会社全体のdesiredByProductという単一ceilingしか尊重していない）、真の需要ベースでの検証はできていない。ここで言えるのは、「本番の配分は、営業容量の飽和特性・貢献利益のいずれの観点からも合理化できない」という限定的な結論である。
