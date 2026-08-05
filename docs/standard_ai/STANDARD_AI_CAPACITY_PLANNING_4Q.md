# Standard AI 4Q Capacity Planning 設計文書

作成: Cowork #05（AI設定）／2026-08-05

## 1. 3層の時間軸分離（三宅さんご指示§7）

```
0〜2Q: operational decisions      — 既存の各decision/*.ts（sales/production/labor/procurement/finance/capex）
3〜4Q: capacity planning          — targetCapability.ts（本ドキュメント）
5〜8Q: strategic direction / target scale — strategicIntent.ts・targetScale.ts
```

**精密に見る未来は主として4Q程度**（三宅さんご指示）。5〜8Qについては、Target Scale Band（帯としての方向性）のみを保持し、四半期ごとの精密な数量計画は持たない。

## 2. 4Q Capacity Projectionの実装範囲（今回のスコープ）

三宅さんご指示§26は、Quarter+0〜+4について「sales headcount/effective sales capacity・production effective capacity・under-construction capex activation・Worker capability」を表示できることを求めている。

今回実装したのは、**単一時点（今四半期）の診断**である`targetCapability.ts`の`computeTargetCapability`まで。これは以下を診断する。

- 現在の実効生産能力とTarget Scale（preferred）の差分（`productionCapacityGapTons`）
- 稼働中の設備投資案件の有無（`hasNearTermCapexUnderConstruction`。数量・完成タイミングは含まない）
- Financeable Scale（簡易診断）
- Worker capability gap signal（粗い診断）

**未実装（次回優先）**: Quarter+0〜+4の**複数四半期にわたる**projectionテーブル自体（表形式の出力）は、今回のスコープでは実装していない。理由は、（a）稼働中の設備投資案件の完成予定四半期・完成後の容量増分を`StandardAiObservation`から正確に取得する配線が今回のセッション内で完結しなかったこと、（b）三宅さんご指示§32で変更禁止とされている生産エンジン本体・capexエンジン本体に触れずにこれを実装するには、既存の`capex.ts`・`observation.ts`側の追加配線（読み取り専用）が必要であり、今回の実装範囲（Strategic Intent/Target Scale/Target Capability/sales hiring・layoff/diagnosis/reason codes/tests/docs）を超えると判断したため。

このため、今回の「4Q capacity planning」は**「現在時点でTarget Scaleに対し生産能力ギャップがあるか、それを解消する設備投資が進行中か」の静的な診断**に留まる。複数四半期の表形式projection自体の実装は、#05引き続きの課題として次回への申し送り事項とする（§次項参照）。

## 3. 目的（実装した範囲でも満たしていること）

目的は「営業だけ先に膨らんでいないか」を見ること。今回実装した診断で、以下は確認できる。

- `PRODUCTION_CAPACITY_BELOW_TARGET_SCALE`: Target Scaleに対し生産能力が不足し、かつ設備投資も進行していない場合に発火。営業採用がTarget Scale方向へ向かうことを`SALES_HIRING_DEFERRED_UNTIL_CAPACITY_EXPANSION`で見送る根拠として使われる（`salesForceHiring.ts`参照）。
- `FUTURE_CAPEX_SUPPORTS_TARGET_SCALE`: 生産能力は不足しているが設備投資が進行中の場合に発火。この場合、営業採用はTarget Scale（max）まで先行することを許容する（三宅さんご指示§14）。

## 4. Capexとの連動（三宅さんご指示§14）

「設備完成は4Q後なのに営業100人を今すぐ採る」という過剰先行を避けるための実際の歯止めは、`salesForceHiring.ts`の**既存の当四半期生産余力ゲート**（`SALES_HIRING_BLOCKED_BY_PRODUCTION`）である。設備投資が進行中で`hasNearTermCapexUnderConstruction=true`の場合、Target Sales Volumeの上限をTarget Scale（max）まで緩めるが、当四半期の実際の生産余力（`totalEffectiveCapacityByProduct - finalProductionRequirementByProduct`）を超える増分は、この既存ゲートで引き続きブロックされる。つまり「将来の完成を見越した先行採用の許容」と「今すぐの過剰な一括採用の禁止」は、Target Scale側の上限緩和と、既存の当期生産余力ゲートの組み合わせで両立させている。

## 5. 既知の限界・次回への申し送り

- Quarter+0〜+4の表形式projection自体は未実装（§2参照）。次回、設備投資の完成予定四半期・完成後容量増分を`StandardAiObservation`へ読み取り専用で配線したうえで実装することを推奨する。
- LOW/BASE/HIGHの市場機会シナリオ（三宅さんご指示§27）も、上記projectionの実装後、必要であれば追加することを推奨する（今回はcapacity planningを優先し、market forecasting engineの拡張はしていない）。
