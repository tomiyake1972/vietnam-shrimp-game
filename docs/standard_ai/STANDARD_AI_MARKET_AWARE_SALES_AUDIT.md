# Standard AI 営業市場配分 監査（PART B・調査フェーズ）

作成日: 2026-08-08
調査時点のTest15系HEAD: `feature/v2-test15-integration` = `1bd8db6`
状態: **調査完了 / 実装は未着手**（理由は最終節）

---

## 結論（先に3行）

1. **旧「上位市場50%・残り均等」ルールはTest15で今も生きている**（legacyでもfallbackでもなく、通常経路）。
2. 順位付けは**前期価格**であり、**市場規模を一切見ていない**。日本は価格が高いので首位になり、規模と無関係に50%を得る。これが「日本偏重」の直接原因。
3. **市場規模を見る実装はすでに存在する**（`feature/v2-standard-ai-training-harness` の `5f1332a`）。Test15系へ**ポートされていないだけ**。今回は再実装せず移植すべき。

---

## B2. branch topology（実測）

`git rev-list --count` による実測値（基準 = 相談役AIブランチ `feature/v2-management-advisor-ai-mvp`）。

| branch | HEADに無いcommit | HEADが持つcommit |
|---|---|---|
| `origin/develop/v2` | 0 | 102 |
| `origin/feature/v2-test15-integration` | 0 | 17 |
| `origin/feature/v2-standard-ai-training-harness` | **2** | 22 |

`marketDemandObservation.ts` の有無（`git ls-tree -r --name-only`）:

| branch | 有無 |
|---|---|
| `feature/v2-management-advisor-ai-mvp`（=Test15系＋相談役） | **無** |
| `feature/v2-test15-integration`（**Test15が動いているbranch**） | **無** |
| `feature/v2-standard-ai-training-harness` | **有** |
| `develop/v2` | **無** |

→ 市場規模を観測して営業配置へ使う実装は、**Training Harnessブランチにだけ存在する**。

## B23. 既存の market-aware 実装

`5f1332a feat(v2): 市場需要の2四半期遅行公開とJP19の解消（Batch 002）`

commit本文より（要旨）:

> `decision/sales.ts`: 「前期価格首位の市場へ50%、残り均等」という規模非依存の按分を廃止し、
> **観測需要 × maximumSupplierShare（共有パラメータ参照。AI側に0.35を直書きしない）× 期待貢献利益**
> による機会スコア按分へ変更。hard capなし。

同commitが触った営業関連ファイルは4つだけである。

```
app/lib/v2/companyLab/marketDemandObservation.ts          （新規）
app/lib/v2/companyLab/standardAi/decision/sales.ts        （配分式の置換）
app/lib/v2/companyLab/standardAi/observation.ts           （観測需要の受け渡し）
app/lib/v2/companyLab/__tests__/marketInformationLag.test.ts （新規テスト）
```

この内容は、今回の指示 B5（Observed Demand × Obtainable Share × Economic Attractiveness）と
B7（hidden true demandを使わず lagged observed demand を使う）に**そのまま合致している**。

## B3 / B4. 現行Test15の配分式（コード実測）

`app/lib/v2/companyLab/standardAi/decision/sales.ts`

```
281:  // 従来と同じ「上位市場50%・残りを均等割り」の重みでまず商品別に按分する
293:        const weight = idx === 0 ? 0.5 : 0.5 / (markets.length - 1 || 1);
300:  // 【SAI-5A】市場志向: 既存の按分重み（前期価格ランキング首位50%・残り均等）に
304:  //     大幅に悪化して首位が交代すれば、志向倍率(≤1.25)より首位重み(50%)の
308:  const baseWeights = markets.map((_, idx) => (idx === 0 ? 0.5 : 0.5 / (markets.length - 1 || 1)));
```

**B4への回答: legacy code path でも fallback でも snapshot互換処理でもない。通常の本経路である。**

### なぜ日本が多くなるか（計算例）

市場が5つの場合、重みは首位 0.500、他4市場 各 0.125。

- 順位は **前期価格** で決まる（`idx === 0` が前期価格首位）。
- 日本は単価が高いため首位になりやすい。
- 首位になった瞬間、**市場の大きさに関係なく 50%** を取る。
- SAI-5Aの市場志向倍率は上限1.25倍であり、コメント自身が
  「志向倍率(≤1.25)より首位重み(50%)の方が支配的」と明記している。

つまり「日本の需要が大きいから」ではなく、**「日本の価格が高いから首位になり、首位だから50%」**。
指示B8の言う「市場規模と無関係に固定比率で日本へ寄る」に該当する。

## B7. 観測需要の可用性

Test15系には `observedMarketDemand` が**存在しない**（`marketDemandObservation.ts` が無い）。
したがって現行では、市場規模を見ようにも**見るための入力が配線されていない**。

`5f1332a` はこれを、市場エンジンを変更せずに解決している。
per market × product の真の需要は既に `SalesQuarterRecord.MarketProductAllocationResult.targetDemand`
として履歴へ保存されており、`marketDemandObservation.ts` は**履歴を2四半期遅れで読むだけ**である。
新しい需要値を発明していない。B7（hidden true demandを使わない）を満たす。

## B10. Hiring と Allocation の分離（確認結果）

両者は既に**別ロジック**である。混同していない。

| | ファイル | 役割 |
|---|---|---|
| Total Sales Force Decision | `decision/salesForceHiring.ts` | 会社全体で何人持つか |
| Market Allocation Decision | `decision/sales.ts` | その人員を市場別にどう配るか |

**日本偏重は Allocation 側の問題であり、Hiring 側（9人問題）とは別事象である。**
詳細は `STANDARD_AI_SALES_HIRING_GOVERNOR_AUDIT.md`。

## B6 への留意（実装時）

`5f1332a` の式は「観測需要 × 取得可能シェア × 期待貢献利益」であり、
単純な需要比例ではない（採算が式に入っている）。
ただし指示B6が挙げる要素のうち **販売工数（Sales Effort）** と **供給可能性（production/raw feasibility）**
がこの式に入っているかは未確認である。移植時に確認し、欠けていれば追加する必要がある。
**未確認のものを「入っている」と書かないため、ここでは確認済みの範囲だけを記す。**

## 推奨する実装手順

1. `feature/v2-test15-integration` から `feature/v2-standard-ai-market-aware-sales` を作る。
2. `5f1332a` を **cherry-pick せず、営業関連4ファイルだけを移植する**。
   実測: `git cherry-pick -n 5f1332a` は Training Harness 側のファイル
   （`training/audit.ts` / `training/benchmark.ts` / `training/fingerprint.ts` /
   `scripts/standardAiTraining.ts` / `docs/standard_ai/training/*`）で
   modify/delete コンフリクトを7件起こす。これらは**営業ロジックと無関係**であり、
   Test15系には存在しないファイルである。混ぜて持ち込むべきではない。
3. B6（販売工数・供給可能性）の不足分を追加する。
4. B9 のdiagnostic（市場別 Observed Demand / Attainable Demand / Expected Margin /
   Sales Effort / Opportunity Score / Allocated Headcount）を追加する。
5. B15（BAL Turn1〜5 before/after）と B16（5社ベンチマーク）を実施する。

## この文書の限界

- **実装・ベンチマーク・回帰テストは未実施**である。上記はすべてコードとgit履歴の読み取りに基づく。
- `5f1332a` の新式に販売工数・供給可能性が含まれるかは**未確認**。
- BAL Turn1〜5の実際の市場別人数は**未計測**。「日本が多い」の定量的裏付けは
  ユーザー観察とコード上の構造的説明であり、こちらでの実測値ではない。
