# Test14 Turn1を起点としたStandard AI中核改善 調査・設計報告

- 作成: Cowork #05（AI設定）
- 対象branch: `feature/v2-standard-ai-turn1-redesign-analysis`（`develop/v2` HEAD `083425a`から作成。本reportおよび分析用の一時スクリプトのみを扱い、production codeは変更していない）
- 位置づけ: 本報告は既存ロードマップの **Phase SAI-6「Standard AI 意思決定強化（設備投資／供給過剰対応／価格戦略強化）」**（`docs/development_diary_2026-07-31.md` §8で予約済み）と衝突しないよう、SAI-6の内容そのもの（当初想定より対象が広がった版）として位置づける。以下の実装計画（§18）はSAI-6の内部ステップとして`SAI-6.1`〜`SAI-6.8`の番号を用いる。

---

## 1. 使用したTest14資料

ShrimpX共同作業用Google Driveフォルダ（`https://drive.google.com/drive/folders/1gxIj9aJEeSe_r7XPli6zSBh_qQFg0mzs`）を検索し、Test14（BAL・2015Q1・turn1）に該当する資料は以下の6件のみだった（同名・類似名の重複はxlsxには無く、判断ログのスクリーンショット／PDF系には後述の注意点がある）。

| 用途 | ファイル名 | 更新日時 | 採用理由 |
|---|---|---|---|
| Turn1決定データ（本報告の数値の主典拠） | `20260801 Testplay1.xlsx` | 2026-08-01T12:19:26Z | Test14/BAL/2015Q1/turn1に合致する唯一のxlsx。他のxlsxは`Test12_...`/`Test13_...`と明示的に別シナリオ名。 |
| Standard AI判断ログ／Turn1ブリーフィング相当 | `0263bca3-0793-430d-9ca4-b47cbefa62ee.pdf` | 2026-08-01T11:55:36Z | 4件のPDF／PNGスクリーンショットのうち最も後発かつ最も網羅的（自社の状態・AIが見ている市場情報・Standard AIの提案・判断理由・AIによる説明文まで含む）。 |
| （参考・注意喚起用）判断ログの早期キャプチャ | `9e0f63bc-...pdf` / `3140aac4-...pdf` / PNG2件 | 2026-08-01T03:27〜03:34 | turn1revision0時点の早期キャプチャで、OCR起因のノイズ（VAP既存契約が「200トン」「300トン」など内部不整合）があり、数値の典拠としては不採用。参考情報としてのみ扱った。 |

**独立したTest14 Turn1ブリーフィング文書は存在しない**（Test13にある`Test13_Turn1_初期情報ブック.xlsx`等の専用ファイルに相当するものがTest14にはまだ無い）。

### 1.1 数値の主典拠（xlsxより、四捨五入なしの実値）

| 商品 | 既存契約 | 新規販売 | 既存契約込み販売予定 | 生産予定 | 設備能力（表示値） | 期末想定約定残 | 期末想定製品在庫 |
|---|---|---|---|---|---|---|---|
| HOSO | 2,200t | 4,607t | 6,807t | 6,800t | 8,550t | 7t | 0t |
| PD | 600t | 2,207t | 2,807t | 3,000t | 6,840t | 0t | 193t |
| VAP | 600t※ | 653t | 1,253t | 1,300t | 5,130t | 0t | 47t |
| **TTL** | **3,400t※** | **7,467t** | **10,867t** | **11,100t** | **20,520t** | **7t** | **240t** |

※ VAP既存契約はxlsxの生値600tだが、三宅さんに確認済みの通り**入力ミスであり正解は300t**（合計は300t少ない**3,100t**）。以降の全セクションの分析・数式は300t／3,100tを正として計算している。

冷凍能力 17,100t。営業人員配分（新規販売のみ、市場別）：China 2,500t（5人配置／必要5.17人）、US 1,500t（4人／4.00人）、EU 2,700t（7人／6.83人）、JP 300t（1人／1.00人）、Other 450t（1人／1.25人）、TTL 18人。原料：国内買付8,500t、輸入なし、養殖投入1,000t。設備投資なし。Worker：6,000人→(1,000人)→5,000人。

### 1.2 資料間の差異（確定事項として修正済み）

判断ログPDF（11:55時点）の「自社の状態（turn開始時点）」パネルに表示された受注残（未履行契約）合計は3,100t（CN/HOSO 1,200t・US/HOSO 1,000t・EU/PD 600t・JP/VAP **300t**）だが、xlsxの既存契約列の合計は3,400t（HOSO 2,200t・PD 600t・VAP **600t**）で、VAPが300t食い違っていた。

三宅さんに確認済み：**VAP既存契約の正解は300t（PDF側）。Excel側の600tは三宅さんの入力ミス**である。本報告では以降、Test14 Turn1のVAP既存契約を**300t、既存契約合計3,100t**として扱う（§1.1の表の「既存契約」列600tはxlsxの生値としてそのまま残すが、脚注で入力ミスであることを明記し、以降の分析（§2以降）はすべて300t／3,100tを正としている）。この差自体は今回のStandard AI構造設計の本質ではないため、以降のセクションでは主要論点として扱わない。

---

## 2. Test14 Turn1初期状態（AI判断に関係する主要state）

- 会社: BAL（バランス型水産）、シナリオ`baseline`相当、2015Q1、turn1。
- 工場設備（`fixtures.ts`実測値）: 単一工場`BAL-F1`。ノミナル能力 HOSO 10,000t／PD 8,000t／VAP 6,000t（HOSO-eq）、共通処理能力22,000t、冷凍包装能力20,000t、養殖能力15,000t。表示上の「設備能力」欄（8,550／6,840／5,130）は、ノミナル能力へ労務起因の実効係数0.855を掛けた**実効能力**であり、ノミナル値そのものではない（`docs/kb/ShrimpX_03_パラメータ仕様書.md` §11.3準拠。この0.855は本来生産エンジン側の実効スループット計算に使われる値で、Standard AIの内部capacity認識には現状反映されていない。§9で詳述）。
- 営業人員: 静的fixture値18人（`fixture.salesForceHeadcountTotal`）。動的な現在人数（`ownState.salesForceHiringState.headcount`）もturn1開始時点では同じ18人（本フォーク前の状態のため）。
- 既存契約（fixtures初期契約）: HOSO 2,200t（CN 1,200t・US 1,000t）、PD 600t（EU）、VAP **300t**（JP。§1.2で確定）。既存契約合計 **3,100t**。
- 初期原料ロット: 3,000t（VN産、$4.2/kg相当）。
- Worker基準人数: 6,000人（工場スキル水準 hoso0.85／pd0.80／vap0.75）。
- 調達人員: 12人（`procurementHeadcountTotal`）。

---

## 3. 三宅さんの意思決定（Excel実値）

§1.1の表がそのまま実値。要点を意思決定の言葉で言い換えると：

- 新規販売希望は市場別・商品別に個別に決め、既存契約(3,400t)を含めた販売予定は10,867t（≒10,850t）。
- 生産予定11,100tは、販売予定10,867tと期末想定製品在庫の目標(HOSO0・PD193・VAP47)、期首在庫(0)から逆算した値に一致する（§6で定式化）。
- 原料は国内買付8,500t＋養殖新規投入1,000tのみで、輸入は使わない。
- Workerは理論必要人数（HOSO1,401＋PD789＋VAP913＝3,102人相当）を大幅に下回るにもかかわらず、6,000人から一気に3,102人相当まで減らさず、5,000人（1,000人減）に留めている。
- 設備投資は行わない。

---

## 4. 現行Standard AI案（同じ項目で比較）

`app/lib/v2/companyLab/standardAi/`のコードをターン1のBAL開始状態に対して手計算で再現した結果（§6のPolicy実行結果と同一の値）。

| 項目 | Standard AI案 |
|---|---|
| 新規販売（sales.tsの`desiredByProduct`、生産へ渡る値） | HOSO 8,000t／PD 6,400t／VAP 4,800t（合計19,200t） |
| 実際に提出される販売計画（`salesResult.salesPlans`、営業人員配分後） | 合計約7,700t台（三宅さんの報告値と整合） |
| 生産計画 | HOSO 10,000t（能力上限で頭打ち）／PD 7,000t／VAP 5,100t（**合計22,100t**） |
| 原料調達計画 | 養殖新規投入 約8,594t／輸入 約3,315t／国内買付 約13,970t（**合計約25,880t**） |
| 営業人員配分 | 静的fixture値18人を市場別に配分（動的な現在人数を見ない。turn1では偶然一致） |
| Worker | 別途調査対象（§13） |
| 設備投資 | 常に新規提案なし（`autoPolicy.ts`のcapex決定は空。Standard AI側も同様） |

---

## 5. 人間案 vs Standard AI比較表

| 項目 | 三宅さん（人間案） | Standard AI案 | 差 |
|---|---|---|---|
| 販売予定（既存契約込み） | 10,867t | 約7,700t台 | AIの方が**少ない**（営業人員配分後の実効販売力の見積りが人間より厳しい） |
| 生産 | 11,100t | 22,100t | AIの方が**約2倍**多い |
| 原料調達（国内＋輸入＋養殖投入） | 8,500+0+1,000=9,500t | 約25,880t | AIの方が**約2.7倍**多い |
| 養殖新規投入 | 1,000t | 約8,594t | AIの方が**約8.6倍**多い |
| Worker（次期人数） | 5,000人（6,000→1,000減） | 別途調査（§13）。現行ロジックは営業人員と同様、静的値ベースの可能性が高い | — |
| 設備投資 | なし | なし（新規提案ロジック自体が未実装） | 一致（ただし両者とも「意図的に無し」ではなく前者は「今回は不要と判断」、後者は「機能が無い」） |

**最も重大な差**: AIは「販売予定（7,700t）」より生産（22,100t）・原料調達（25,880t）が大幅に大きい、すなわち**売れる量を大きく超えて作り、その分の原料まで買う**という、三宅さんの「市場→営業能力→現実的に売れる数量→…→必要生産→必要原料」という因果順序と全く逆の「工場能力を埋めるために作り、その分の原料を買う」という供給起点の判断になっている。

---

## 6. 22,100t生産案の根本原因（関数・数式・中間値）

`app/lib/v2/companyLab/standardAi/policy.ts`の`generateStandardAiDecisionWithDiagnostics`内の呼び出し順序（150行目付近）：

```
observation = buildStandardAiObservation(fixture, ownState, publicInfo, period, turn)
pressures   = computePressureScores(observation, fixture, params)
salesResult      = buildStandardAiSalesPlans(fixture, observation, pressures, params)
productionResult = buildStandardAiProductionPlans(fixture, observation, pressures, salesResult.desiredByProduct)  ← 生成箇所
```

**核心となる配線ミス（デザイン上の欠陥。単純な係数調整ではない）**: `buildStandardAiProductionPlans`へ渡されるのは、営業人員配分後の「実際に売れる/売る量」である`salesResult.salesPlans`（≒7,700t台）ではなく、その手前の「工場能力×稼働率目標」だけで決まる中間値`salesResult.desiredByProduct`（≒19,200t）である。

`decision/sales.ts`内の`desiredByProduct`の定式化（要旨）：

```
potentialByProduct[product] = totalCapacityByProduct[product] * salesUtilizationTarget   // 稼働率目標0.8（parameters.ts）
desiredByProduct[product]   = potentialByProduct[product] * orderFactor[product]          // turn1はorderFactor=1（前期市場結果が無いため）
```

BALのノミナル能力（HOSO10,000／PD8,000／VAP6,000）×0.8＝HOSO8,000／PD6,400／VAP4,800（合計19,200t）。この値は**市場規模・価格・営業人員のいずれにも依存しない**、工場サイズだけで決まる「希望量」。

`decision/production.ts`の定式化：

```
neededByProduct[product] = max(0, desiredByProduct[product] + 既存契約残高[product] - 期首製品在庫[product])
desired[product] = min(工場ノミナル能力[product], neededByProduct[product] * 工場配分シェア)  // BALは単一工場のためシェア=1
```

BAL turn1（期首製品在庫=0、既存契約残高は§1.2で確定した正しい値: HOSO2,200／PD600／VAP300）：

- HOSO: `min(10,000, 8,000+2,200-0=10,200) = 10,000t`（能力上限で頭打ち。診断ログにも`CAPACITY_CONSTRAINT`が出る）
- PD: `min(8,000, 6,400+600-0=7,000) = 7,000t`
- VAP: `min(6,000, 4,800+300-0=5,100) = 5,100t`
- 合計 `10,000+7,000+5,100 = 22,100t`（三宅さんとの会話上の概算「約22,100t」と完全一致）

**結論**: 22,100t前後という数字は「生産量係数が少し高かった」のではなく、**生産計画の入力そのものが、営業人員による販売制約を一度も経由していない**という、意思決定の因果順序（データフローの配線）の問題である。

---

## 7. 過剰原料調達の根本原因（生産量からどう連鎖したか）

`decision/procurement.ts`の`buildStandardAiProcurementPlan`は、`requiredRawMaterial`（歩留まり1.0基準＝生産計画の合計そのもの、22,100t前後）を唯一の入力として、以下の3経路へ配分するだけで、**生産計画がすでに過大であることを検知・補正する仕組みを持たない**：

```
養殖新規投入: targetHarvest = min(requiredRawMaterial×0.35, 養殖能力×0.9) = min(7,735, 13,500) = 7,735
             stocking       = targetHarvest / 0.9 ≒ 8,594t
輸入        : requiredRawMaterial×0.15 ≒ 3,315t
国内買付    : mixBase = requiredRawMaterial - 輸入 - 養殖収穫実績 ≒ 11,050
              目標在庫 = requiredRawMaterial×0.4 ≒ 8,840
              補正 = 0.5×(目標在庫 - 現有在庫3,000) ≒ 2,920
              国内買付 = mixBase + 補正 ≒ 13,970t（下限・上限内）
合計 ≒ 8,594 + 3,315 + 13,970 = 25,880t
```

生産計画が22,100t→過大であるにもかかわらず、そこから機械的に原料調達計画（25,880t）が導かれる。個々の配分ロジック自体（養殖35%上限・輸入15%・在庫補正）に明確な誤りはなく、**入力（22,100t）が過大であることが唯一かつ最大の原因**。なお、`pressures.rawMaterialInventoryPosition`は`available + pipeline×0.5`であり、`growingAquaculture`（養殖中で当期未収穫の在庫）や`inTransitImport`（未到着輸入）を無条件に「当期利用可能」として数えてはいない（半分の重みで「将来の見込み」として部分的に反映するのみ）ため、**この点に関する二重計上バグは無い**ことを確認した。

---

## 8. 現行Standard AIの意思決定依存関係図

```
fixture（静的） ─┬─▶ observation.capacityByProduct（ノミナル能力そのまま、実効係数0.855は未適用）
                 └─▶ observation.salesForceHeadcountTotal（静的18人。動的headcountは無視）
                              │
                              ▼
              sales.ts: desiredByProduct = capacity × 0.8 × orderFactor（市場・価格・営業人員と無関係）
                              │（★ここで営業人員制約が一度も適用されないまま次工程へ）
                              ▼
          production.ts: neededByProduct = desiredByProduct + 既存契約 − 期首在庫 → min(ノミナル能力, …)
                              │
                              ▼
          procurement.ts: requiredRawMaterial = Σ production → 養殖35%・輸入15%・国内買付(残差+在庫補正)

（別経路・並行）
       sales.ts: allocateHeadcountAcrossMarkets(fixture.salesForceHeadcountTotal=静的18人, …)
                → computeMarketSalesEffort(効果係数 hoso1.0/pd1.2/vap3.0) → salesResult.salesPlans（≒7,700t台、実際の提出値）
                （★このsalesPlansの方が実勢に近いが、生産計画にはこちら側の値が使われない）
```

図から明らかなように、生産・原料調達は「営業人員で制約された現実的な販売可能量」（下段の`salesPlans`）を一度も参照せず、「工場を埋める希望量」（上段の`desiredByProduct`）だけを見ている。これが唯一の構造的欠陥であり、他のモジュール（procurement.ts自体の配分ロジック、worker関連）には今回の調査で構造的な誤りは見つからなかった。

---

## 9. 現行設計の問題点（個別バグと構造問題を分ける）

### 9.1 構造問題（今回の主題。優先度：高）

- **生産計画が「販売可能量」ではなく「工場能力×稼働率目標」を起点にしている**（§6・§8）。これは係数のチューニングでは直らない、意思決定の因果順序そのものの誤り。
- **Standard AIには「今期の主要制約が何か」を診断する層が存在しない**。営業力がボトルネックであるBALのケースでも、AIは常に「工場をどれだけ埋められるか」から出発しており、状況に応じてボトルネックの起点を切り替える仕組みがない。

### 9.2 個別バグ・データ鮮度の問題（優先度：中。今回は修正しない。SAI-6の別ステップ候補）

- **営業人員配分が静的fixture値を参照する**（`observation.ts:176`・`decision/sales.ts:342,369-370`・`autoPolicy.ts:356`）。動的な`ownState.salesForceHiringState.headcount`は既に関数の引数として渡ってきているにもかかわらず読まれていない（§13で詳述）。turn1では静的値と動的値が一致するため症状が出ないが、減員後は`validateSalesForceHeadcountBudget`が拒否する形で表面化することが、既存の`runner.test.ts`の回避コード（コメント付き）から確認できる。
- **Standard AIのcapacity認識がノミナル値のまま、実効係数0.855が反映されていない**（§2・§6）。これは§6の主要な因果とは独立した副次的な過大要因であり、仮に生産をsalesPlans起点に直しても、工場能力を上限として使う場面（例：需要が能力を上回るケース）では依然としてノミナル値を使うため、能力判断そのものが実際より甘くなる可能性がある。

### 9.3 明確なバグではないが再検討が必要な設計判断

- turn1では前期市場結果が存在しないため`orderFactor=1`（縮小なし）になる。これは「情報が無い時は中立」という妥当な設計だが、結果的に「turn1の生産wishが最も大きくなる」という副作用を生んでいる。
- 価格戦略は完成品在庫過剰時の値引きのみで、供給圧力・営業基盤・ライフサイクル局面と接続されていない（`development_diary_2026-07-31.md` §8で既に指摘済みの既知の制約。SAI-6のスコープに含まれる別項目）。

---

## 10. 新しいボトルネック診断案（改訂版：算出式の具体化＋不足型／過剰型の分離）

三宅さんの指示（§B-8、および今回の追加指示4・5）どおり、「0〜1 pressure model」を安易に前提化せず、現行ゲームから取得可能な数値とTest14実例だけで説明可能な、最小限の診断構造を提案する。今回の改訂では、6カテゴリそれぞれに**方向が揃った比率**を定義し、さらに「不足」と「過剰」を明確に分離する。

### 10.1 6カテゴリの診断式（方向を統一）

| カテゴリ | 指標名 | 定式 | 解釈 |
|---|---|---|---|
| 営業 | `Sales Fulfillment Ratio` | `現実的販売可能量（salesResult.salesPlans合計） / 市場販売機会または営業希望量（desiredByProduct合計、または将来的には市場需要ベースの理論販売機会）` | **低いほど**営業が制約。Test14 Turn1: 約7,700t台 / 約19,200t ≒ 0.40 |
| 生産 | `Production Load Ratio` | `必要生産量（§12の基本当期生産必要量） / 実効生産能力（将来的にはノミナル能力×0.855、現行は暫定的にノミナル能力）` | **高いほど**生産が制約（>0.9で能力制約が近い） |
| Worker | `Worker Load Ratio` | `理論必要Worker（§13のRequired Worker） / 現在Worker` | **高いほど**Worker制約。逆に極端に低い場合（例: <0.6）は「Worker過剰」を示す |
| 原料 | `Raw Material Coverage Ratio` | `(当期利用可能原料 + 当期確実に取得可能な原料) / 必要原料`。当期利用可能原料は現有ロットの在庫のみ。`growingAquaculture`（未収穫の養殖投入）は**含めない**。`inTransitImport`（未到着輸入）は到着期を確認し、当期到着分のみ「確実に取得可能」に含める | **1未満**なら原料不足 |
| 在庫 | `Inventory Excess Ratio` | `期首完成品在庫（通常在庫扱いの分のみ。戦略在庫として保有している分は別枠で扱い、この比率には含めない） / 通常在庫目標（finishedGoodsTargetQuarters）` | **高すぎる**（例: >1.5）場合に在庫過多 |
| 資金 | `Liquidity Coverage Ratio` | `(現金 + 実行可能借入余力) / (営業・生産・調達・投資を実行するための今期必要資金の見積り)` | **低い**（例: <1.0〜1.2）ほど資金制約が強い |

各比率は既存コードがすでに個別に計算している値（`salesResult`、`observation`、`pressures`、`financing`ドメインの出力）の再利用が中心であり、複雑な合成スコアを新設する必要はない。

### 10.2 不足型／過剰型の分離

6比率を単一の0〜1 pressureへ押し込まず、方向性のある2グループとして扱う。

- **不足型**（対応：抑制・優先順位付け・調達強化・採用検討）
  - 営業不足（`Sales Fulfillment Ratio`が低い）
  - 生産能力不足（`Production Load Ratio`が高い）
  - Worker不足（`Worker Load Ratio`が高い）
  - 原料不足（`Raw Material Coverage Ratio`が1未満）
  - 資金不足（`Liquidity Coverage Ratio`が低い）
- **過剰型**（対応：段階的縮小・在庫活用・投資延期）
  - Worker過剰（`Worker Load Ratio`が極端に低い）
  - 生産能力余剰（`Production Load Ratio`が低い）
  - 在庫過多（`Inventory Excess Ratio`が高い）

Standard AIは「何が足りないか」だけでなく「何が余っているか」も診断できる必要がある。両グループは排他ではなく、同時に複数成立しうる（Test14 Turn1がその典型例）。

### 10.3 Test14 Turn1の診断結果（設計値としての期待）

Test14 Turn1は、**営業不足＋生産能力余剰＋Worker余剰**という不足型1件・過剰型2件の組み合わせであり、支配的な制約（診断層が最優先で提示すべき項目）は「営業不足」1件である。この組み合わせを診断層が正しく出力できることを、§16のゴールデンケースの中心的な検証項目とする。

---

## 11. 新しい意思決定フロー案（改訂版：3層構造＋当期納品需要という中間概念）

### 11.1 営業活動の時間軸の見直し（前提の変更）

三宅さんの指示どおり、「`salesPlans`をそのまま当期生産必要量に入れる」形に設計を固定しない。ShrimpXが将来目指す姿は、通常の営業活動は「今期営業して、次期納品分を受注する」という時間軸であり、当期中の即納は急な需要増・消費国在庫不足・スポット需要・緊急補充など例外的な場合に限られる。現行ゲームには「当期納品分」と「次期納品分」を区別する機能が無いため、営業希望量（`salesPlans`）が実質的に当期納品量として扱われてしまっている。

この将来仕様を見据え、生産計画の入力に**中間概念`currentPeriodDeliveryDemand`（当期納品需要）**を新設する。

- **完成形の定義**（将来、営業希望量の当期／次期区分機能が実装された後）:
  `currentPeriodDeliveryDemand = 当期履行期限の既存契約 + 新規営業のうち当期即納分 + 当期スポット・緊急需要`
  次期納品分の通常新規受注は、原則として当期生産へ全量加えない。次期納品分は、次期需要予測・Worker目標保有数・原料先行調達・設備能力判断・戦略在庫など、将来判断（Layer 3）にのみ使用する。
- **現行仕様での暫定値**（当期／次期区分機能が未実装のため）:
  `currentPeriodDeliveryDemand ≒ salesResult.salesPlans`（商品別合計。営業人員配分後の現実的販売可能量）
  ただし内部的には「暫定値である」ことをフラグ（例: `deliveryDemandSource: "provisional-all-current"`）として保持し、将来の当期／次期区分機能が入った時点で計算式を差し替えられる構造にする。`salesPlans`を生産計画に直接ハードコードで結線せず、必ず`currentPeriodDeliveryDemand`という中間層を経由させることが今回の設計変更の要点である。

### 11.2 3層構造（三宅さん提示案の評価）

三宅さんが提示した3層構造は、現行コードの実態（§8の依存関係図）と矛盾なく対応付けられる。

- **Layer 1：当期オペレーション必要量** — 「今期に何を納品しなければならないか」（`currentPeriodDeliveryDemand`）から当期の生産・原料必要量を決める（§12の生産必要量の概念式）。現行コードの`sales.ts`→`production.ts`→`procurement.ts`の直線フローに相当するが、**入力を`desiredByProduct`から`currentPeriodDeliveryDemand`へ差し替える**のが唯一の構造修正点。
- **Layer 2：ボトルネック診断** — §10の6カテゴリ（不足型／過剰型）を診断する。現行コードには対応する層が存在せず新設が必要。
- **Layer 3：将来を見た戦略調整** — 次期需要・原料相場・設備・Worker・営業体制を見て、戦略在庫（§12）・先行調達・採用・減員抑制・設備投資を上乗せする。現行コードは`autoPolicy.ts`のcapex決定が常に空、Workerロジックも次期見通しを見ていないため、この層は実質的に未実装。

評価: 3層構造はLayer 1の内部に既存の5段階フロー（Commercial Plan / Inventory & Production Plan / Supply Plan / Capacity & Labor Plan / Financial Plan の一部）を格納する形で無理なく統合できる。Layer 2（診断）はLayer 1と並行して計算され、Layer 1の結果（特に生産計画が販売可能量をどれだけ超えるか）とLayer 3への入力の両方に使われる。

### 11.3 Layer 1内部の段階別input/output（旧6段階案を統合）

1. **Situation Diagnosis**（Layer 2と同時並行で計算。Layer 1の各段階が参照する）
   - input: `observation`一式、前期`companySummaries`。
   - output: §10の6カテゴリの比率、不足型／過剰型の分類、「今期の主要制約」上位1〜2件（reason code形式）。

2. **Commercial Plan**（`decision/sales.ts`ベース、出力の意味を修正）
   - input: `observation`、動的な現在営業人員数（`ownState.salesForceHiringState.headcount`。§14）。
   - output: 市場×商品別の現実的販売可能量（`salesPlans`）、価格調整、営業人員配分。`desiredByProduct`は「営業人員が無制限だった場合の理論上限」という診断専用の参考値に格下げする（生産計画の入力には使わない）。

3. **Current Period Delivery Demand層**（新設。§11.1）
   - input: Commercial Planの`salesPlans`、当期履行期限の既存契約、（将来）当期即納フラグ付きのスポット需要。
   - output: `currentPeriodDeliveryDemand`（商品別合計）。現行仕様では`salesPlans`とほぼ同値だが、将来の当期／次期区分の受け皿として独立した層に切り出す。

4. **Inventory & Production Plan**
   - input: `currentPeriodDeliveryDemand`、期首製品在庫、通常安全在庫目標（`finishedGoodsTargetQuarters`）、Layer 3からの戦略在庫指示（§12）。
   - output: §12の概念式による生産計画。

5. **Supply Plan**（procurement.tsの内部ロジックは維持）
   - input: 生産計画、商品別歩留まり。
   - output: 国内買付・輸入・養殖投入。

6. **Capacity & Labor Plan**
   - input: 生産計画、現在Worker数、Situation DiagnosisのWorker比率。
   - output: Required Worker／Target Worker（§13）、常用／臨時・残業・採用・減員判断。

7. **Financial & Strategic Plan**
   - input: 上記全段階の結果、資金制約比率。
   - output: 資金調達希望、設備投資判断。

### 11.4 ボトルネック診断が意思決定順序へ与える影響（優先順位の反映方式）

§10の診断結果は「表示専用」ではなく、Layer 1・Layer 3の計算順序・優先順位付けに反映する。具体的な反映方法は、支配的制約の種類によって以下のように変える。

| 支配的制約 | 反映方法 |
|---|---|
| 営業制約型 | Commercial Planの`salesPlans`を基準に生産（Layer 1）を抑える（Test14 Turn1がこのケース。現行の主要バグの修正そのもの） |
| 生産能力制約型 | 売れる量が能力を超えるため、Commercial Plan段階で商品別粗利・市場別収益性・既存契約優先度による**供給先の優先順位付け**を行い、`salesPlans`自体を能力内に収める |
| 原料制約型 | Supply Plan段階で原料不足が判明した場合、高採算商品・契約義務・戦略市場を優先してInventory & Production Planへ**縮小フィードバック**をかける（現行は生産→調達の一方向のみで、このフィードバック経路が存在しない。新設が必要） |
| 資金制約型 | Financial & Strategic Plan段階で、利益最大化より現金防衛を優先し、在庫削減・調達抑制・設備投資延期・借入をLayer 1・Layer 3の決定へ**上書き的に**反映する |

**固定モードか複合制約か**: 完全に別モードへ分岐させる（if-elseで排他的に切り替える）方式は実装は単純だが、Test14 Turn1のように複数カテゴリが同時に成立するケース（営業不足＋生産能力余剰＋Worker余剰）を表現できない。逆に汎用的な合成スコアで一本化する方式は説明可能性を損なう。折衷案として、**支配的制約の上位1〜2件を「反映すべき調整ルール」として選び、それぞれのルールを独立した補正関数として順に適用する**方式（複合制約・上位数件方式）を提案する。各ルールは単独でテスト可能であり、Test14 Turn1では「営業制約型ルールのみ」が適用され、他のルールは「今回は適用条件に該当しない」として説明文に含める（§15）。この方式は実装しやすさ（ルールごとに独立したテストが書ける）と説明可能性（適用されたルールをそのままreason codeにできる）の両方を満たす。

---

## 12. 生産必要量の概念式・通常在庫と戦略在庫（改訂版）

### 12.1 生産必要量の概念式

三宅さんの指示に基づき、生産必要量を「基本」と「戦略先行生産」の別枠2階建てに再設計する。

```
基本当期生産必要量[product] = 当期納品必要量[product]（§11.1の currentPeriodDeliveryDemand）
                            + 通常安全在庫目標[product]（finishedGoodsTargetQuarters）
                            − 利用可能な期首完成品在庫[product]
                            （下限0。工場ノミナル能力／将来は実効能力で上限）

最終生産計画[product] = 基本当期生産必要量[product] + 戦略先行生産[product]
```

現行の§6の定式（`neededByProduct = desiredByProduct + 既存契約残高 − 期首在庫`）との対応関係: `当期納品必要量`が`desiredByProduct`（工場起点の希望量）を置き換え、`currentPeriodDeliveryDemand`（≒`salesPlans`＋当期履行の既存契約）が入る点が唯一かつ本質的な差である。「既存契約残高」は`currentPeriodDeliveryDemand`の内訳（§11.1）に統合されるため、二重に加算しない。

**将来の拡張**: `currentPeriodDeliveryDemand`が「次期納品分」を含まなくなった時点で、この式は自動的に「当期に本当に必要な量だけを作る」計算になる。式自体を将来変更する必要はなく、`currentPeriodDeliveryDemand`の計算方法（§11.1）だけを差し替えれば良い設計になっている。

### 12.2 通常在庫と戦略在庫

- **通常在庫**: 通常の納品変動・製造リードタイム・販売変動に備える在庫。既存の`finishedGoodsTargetQuarters`ロジックをそのまま`通常安全在庫目標`として維持する。
- **戦略在庫**: 将来情報を根拠に意図的に増やす在庫。診断層（Layer 2／§10）またはLayer 3が、次のいずれかのシグナルを検知した場合にのみ`strategicStockTarget`（商品別・数量）を計算し、`戦略先行生産`として最終生産計画へ加算する。
  - 次期需要急増シグナル（SAI-5の`productLifecycleOutlook`を再利用）
  - 原料価格上昇予測シグナル（`productSupplyPressureOutlook`を再利用）
  - 次期大口販売機会（契約見込み情報。現行ゲームでの取得元は未確認、§19）
  - 今期原料が割安（原料相場の現状値と移動平均等の比較。具体的な検知式は未確定、§19）
  - 将来生産能力逼迫予測（`Production Load Ratio`の将来期予測値。現行は当期スナップショットのみのため、予測系列の追加が必要）
- **説明可能性の要件**: 戦略在庫を持つ場合は必ず、`strategicStockReason`（reason code）・数量・対象商品・何期先を見ているか、の4点を構造化して保持する。この4点はAI提案文面（§15）で必ず言及する。
- **Test14 Turn1での扱い**: 次期需要急増等のシグナルが観測されていないため、`戦略先行生産=0`（通常安全在庫のみ）で三宅さんの人間案（生産11,100t）に近い値になることが期待される（完全一致は目指さない。§16参照）。

---

## 13. Worker判断（Required Worker / Target Workerの二層構造、改訂版）

### 13.1 二層の定義

- **Required Worker**（理論必要人数）: 当期生産計画（§12の最終生産計画）を実行するための理論最低人数。既存の`decision/labor.ts`の「トン当たり必要Worker数」ロジックをそのまま使い、生産計画が§12の修正により現実的な値になれば、Required Workerも自動的に現実的な値になる（Test14 Turn1では約3,102人相当）。
- **Target Worker**（目標保有人数）: 将来需要・削減上限・再採用難度・習熟度・退職コスト・能力余裕を考慮した経営上の保有人数。Required Workerへ一括収束させない。

### 13.2 目標保有人数への段階的接近ロジック（構造のみ設計。具体的閾値は未確定）

三宅さんの人間判断（Test14 Turn1: 理論必要約3,102人に対し現在6,000人、しかし5,000人へ1,000人減のみ）から読み取れる要件は、「一気に必要人数まで減らさない」という段階的接近である。今回は具体的な削減率上限を固定せず、以下の構造のみを設計する。

```
targetWorker[t] = currentWorker[t-1] − min(
                     reductionCap（1四半期あたりの削減率上限 × currentWorker[t-1]、具体値は今後のテストプレイ複数ケースで校正）,
                     max(0, currentWorker[t-1] − requiredWorker[t]の将来数期分の見通しを踏まえた下限値)
                   )
```

- `reductionCap`は今回固定しない（三宅さんの明示指示）。将来のテストプレイ複数ケース（Test14以降、§17の教師ケース群）から校正するパラメータとして、`STANDARD_AI_PARAMETERS`に追加する想定の枠だけを用意する。
- 「将来数期分の見通しを踏まえた下限値」は、当期のRequired Workerだけでなく、次期以降の需要見通し（Layer 3）・戦略在庫のための増産予定を考慮し、Required Workerより高い水準に置かれることを許容する（三宅さんの5,000人という判断は、当期Required Worker3,102人よりかなり高い水準にある）。
- 採用（Worker不足時）についても同じ二層構造を適用する：`targetWorker`が`currentWorker`を上回る場合は、採用コスト・再採用難度・習熟期間を考慮した**採用ペースの上限**を設ける（現行Standard AIは常に採用数0のため、これは新規ロジック）。

### 13.3 退職金・再検討事項

- 営業人員の退職金ロジック（`SALES_FORCE_SEVERANCE_QUARTERS`、`salesForceHiring.ts`・`quarterClose.ts`に実装済み）と同様の「四半期給与の複数倍」パターンをWorker側にも流用できる可能性がある。
- ただし**Workerの退職金制度自体が現行ゲームに実装されているかは未確認**（今回のスコープでは確認していない）。これは§19の未確定事項として引き続き記録する。
- 生産計画修正（§12）後、Required Workerの値自体も現実的になるため、Worker関連ロジックの静的値参照懸念（§9.2で「深追いしていない」とした点）は、生産計画修正（SAI-6.4以降）後に再検証が必要。

---

## 14. 営業人員の動的state参照（fixture依存解消方針）

§9.2・調査結果（B-5相当）の要約：

- 修正対象: `observation.ts:176`（`salesForceHeadcountTotal: fixture.salesForceHeadcountTotal`）、`decision/sales.ts:342,369-370`（`allocateHeadcountAcrossMarkets(fixture.salesForceHeadcountTotal, ...)`）、`autoPolicy.ts:356`（同様の静的参照）。
- 正しい参照先: `ownState.salesForceHiringState.headcount`（`CompanyOwnState`に既に存在し、両方の関数に`ownState`自体は既にパラメータとして渡っている。**新しいstateの追加は不要**、読み替えだけで解消できる）。
- 影響範囲: turn1では静的値と動的値が一致するため無症状。減員後のturnで`validateSalesForceHeadcountBudget`が拒否するケースが既存の`runner.test.ts`のコメント付き回避コードから確認できる（Standard AI自身の回帰テストにはこのケースが存在せず、未検証のまま本番相当の挙動になっている）。
- 今回は修正しない（三宅さんの明示指示）。SAI-6実装計画（§18）の候補ステップとして記録する。

---

## 15. AI提案文面案（Test14 Turn1の具体的な完成イメージ）

内部的に`diagnosis`・`decision`・`key metrics`・`reason codes`を持ち、それを説明文へ変換する構造を維持する（ハードコードはしない。既存の`StandardAiQuarterDiagnostics`・`StandardAiDiagnosticEntry`の型をそのまま拡張して使う）。Claude生成の説明を使う場合も、事実となる判断値は必ずdeterministicなStandard AIエンジン側から渡し、Claudeはその言い換えのみを担当する（既存の`aiExplanation`モジュールの分離方針を維持）。

修正後のロジック（§11の3層構造・§12の生産必要量概念式）を前提とした、Test14 Turn1相当のケースでの完成イメージ：

```
【経営診断】
今期は営業力が主な制約です（現実的な販売可能量 約7,700t台 に対し、工場能力には
約2倍の余力があります）。一方、生産能力とWorkerには大きな余力があります。

【当期納品】
当期に納品する必要がある数量（新規営業のうち当期分＋当期履行の既存契約）を基準に
生産計画を組み立てます。今期の当期納品需要は 約Z t です。

【生産】
工場能力を埋めること自体を目的にせず、当期納品需要と通常在庫目標に必要な量だけ
生産します（生産計画 約○t、工場能力に対する使用率: △%）。追加で先行生産している
分はありません（戦略在庫の発動条件に該当するシグナルが今期は観測されていません）。

【原料】
必要生産量から歩留まりを考慮した原料必要量を逆算し、既存の利用可能な原料在庫を
差し引いた不足分だけを、国内買付・養殖投入・輸入へ配分して調達します。

【労務】
Workerは当期必要人数（理論上は約3,100人相当）を大きく上回っていますが、将来需要と
再採用コストを考慮し、一気に理論必要人数まで削減せず、段階的な削減を提案します。

【設備・財務】
現時点で追加設備投資は不要と判断しました（工場稼働率に十分な余力があるため）。
```

`Z/○/△`は、修正後のロジック（§11・§12）が実際に算出する値をそのまま埋め込む。reason codeの例: `SALES_FORCE_BINDING_CONSTRAINT`（営業制約が支配的）、`PRODUCTION_GATED_BY_CURRENT_PERIOD_DELIVERY_DEMAND`（生産が当期納品需要でゲートされた）、`CAPACITY_HEADROOM_AVAILABLE`（生産能力余剰）、`WORKER_SURPLUS_GRADUAL_REDUCTION`（Worker過剰・段階的削減）、`STRATEGIC_STOCK_NOT_TRIGGERED`（戦略在庫の非発動、明示的に「無し」を説明する）。

### 15.1 将来の【次期営業】セクション（当期／次期区分機能実装後）

将来、営業希望数量を当期納品分と次期納品分に分ける機能（§11.1）が実装された際は、以下のセクションを追加できる構造にしておく。

```
【次期営業】
次期納品分として ○t の受注獲得を目指します。これは今期の生産必要量には全量加えず、
次期の生産・Worker・原料計画へ反映します。
```

このセクションは、内部データ構造（`diagnosis`/`decision`/`key metrics`/`reason codes`）に「次期納品分の受注計画」というフィールドを追加するだけで対応可能であり、文面テンプレート自体の骨格（診断→当期納品→生産→原料→労務→設備財務、という順序）を変更する必要はない設計にしている。

---

## 16. ゴールデンケーステスト案（完全一致ではなく何を保証するか）

三宅さんの指示どおり、11,100t（人間案）への完全一致や、11,000〜12,000tのような狭い許容レンジは採用しない。代わりに、**構成要素別のinvariant（不変条件）**を保証するテスト方針を提案する（Test14 Turn1をベースの回帰ケースとしつつ、他のシナリオでも成立する一般則として定義する）。

| # | Invariant | 検証方法（概念） |
|---|---|---|
| 1 | 生産計画（商品別合計）は、当期納品需要（`currentPeriodDeliveryDemand`）＋通常安全在庫目標－期首在庫（＋戦略先行生産、発動している場合のみ）、を大きく超えない（§12.1の式） | `戦略先行生産=0`の通常ケースで、生産計画が「基本当期生産必要量」の一定範囲内（例: ±15%、工場配分の丸め誤差を許容する程度）に収まることを確認 |
| 2 | 22,100tのような、工場ノミナル能力にほぼ全商品が頭打ちする過剰生産が発生しない（通常ケース） | 生産計画のいずれの商品も「工場能力での頭打ち」の`CAPACITY_CONSTRAINT`診断が、`戦略先行生産=0`かつ営業制約が支配的なケースで発生しないことを確認 |
| 3 | 原料調達量は生産計画から歩留まりで機械的に導出された必要量に対応する（現行procurement.tsの内部ロジックは維持されるため、入力である生産計画が妥当なら自動的に満たされる） | 生産計画修正後、`requiredRawMaterial`と実際の調達合計の関係式（§7）が変わっていないことを確認する回帰テスト |
| 4 | 期首利用可能在庫を無視しない | 期首製品在庫・原料在庫を意図的にゼロ以外の値にしたケースで、必要量計算にその値が反映されることを確認 |
| 5 | `growingAquaculture`（養殖中で未収穫）を当期利用可能原料に数えない | 既存の`pressures.rawMaterialInventoryPosition`ロジック（§7で確認済み、二重計上なし）に対する既存テストの維持・強化 |
| 6 | `inTransitImport`（未到着輸入）の到着時期を無視しない | 同上、既存の`pipeline×0.5`という部分計上ロジックの妥当性を再確認するテストの追加 |
| 7 | 余剰Workerを認識する（Required Worker / Target Workerの分離、§13） | Worker関連ロジック修正後、Required Workerを大幅に上回るTarget Workerのケースで、AIが一括削減ではなく段階的削減を提案することを確認 |
| 8 | 静的fixture営業人数ではなく現在人数を使う（§14） | 減員後のturnで、AIの営業人員配分合計が動的な現在人数を超えないことを確認する新規テスト（`runner.test.ts`の既存回避コードが不要になることも合わせて確認） |
| 9 | 資金・設備投資判断が前工程と矛盾しない | 生産計画修正により資金需要（原料調達費・SG&A）も変わるため、財務モジュールとの結合テスト（既存の`quarterClose.ts`テストの延長）で整合性を確認 |
| 10（新規） | Situation Diagnosis（Layer 2）が、Test14 Turn1に対して「営業不足」を不足型の支配的制約として、「生産能力余剰」「Worker余剰」を過剰型として、それぞれ正しく分類する（§10.3） | 診断層のユニットテストで、6カテゴリの比率が§10.1の期待値レンジ（`Sales Fulfillment Ratio`≒0.4、`Production Load Ratio`<1、`Worker Load Ratio`<0.6）を満たすことを確認 |
| 11（新規） | `currentPeriodDeliveryDemand`が暫定計算（`≒salesPlans`）であることを示すフラグ（`deliveryDemandSource`）が常に設定される | 当期／次期区分機能が未実装の間、生成される全ての`StandardAiQuarterDiagnostics`でこのフラグが暫定値を示すことを確認する新規テスト |

Test14 Turn1は、上記のうち特に#1・#2・#8・#10（営業制約が支配的なケースの代表）の回帰ケースとして採用する。将来的に他のボトルネックパターン（§17）が追加された際は、それぞれに対応するinvariantのサブセットで検証する。

---

## 17. Test14 Turn1以外に想定すべき次の教師ケース

| ケース | 何を観察すべきか | Standard AIに何を学ばせるか |
|---|---|---|
| 営業力不足（Test14 Turn1で確認済み） | 販売可能量が工場能力を大きく下回る状況での生産・原料判断 | 生産を販売可能量でゲートする（本報告の主題） |
| 生産能力不足 | 販売機会が工場能力を上回る状況（他社比較・市場拡大シナリオ）での商品優先度・市場優先度の判断 | ボトルネック診断層（§10）が「生産能力制約」を正しく検知し、商品・市場の優先順位付けロジックへ接続できるか |
| 原料不足 | 国内原料相場高騰・養殖能力の限界時の調達行動 | 原料制約が支配的な場合に生産計画自体を縮小する判断（現行は生産→調達の一方向のみ。フィードバックが無い） |
| 在庫過多 | 需要急減後の減産・値引き判断 | 既存の値引きロジックとの整合、過剰在庫時の生産縮小 |
| 次期需要急増シグナル | SAI-5の`productLifecycleOutlook`・`productSupplyPressureOutlook`が強い上昇を示すケース | 戦略在庫（§12）の発動条件・規模の校正 |
| 原料価格高騰シグナル | 原料相場の先高観測時の前倒し調達 | 戦略在庫（原料側）の発動条件 |
| 資金逼迫 | 借入余力が乏しい状況での生産・調達規模の抑制 | 資金制約（§10のカテゴリ6）が生産・調達計画へフィードバックする経路の新設 |
| Worker過剰 | 生産縮小後、必要人数が現在人数を大きく下回るケース（Test14 Turn1のWorker側も一部該当） | 必要人数と目標保有人数の分離（§13）の校正 |
| Worker不足 | 生産拡大時に理論必要人数が現在人数を上回るケース | 採用判断ロジックの新設（現行Standard AIは常に採用数0） |
| 設備余剰 | 工場稼働率が長期的に低いケース | 設備投資判断への接続（SAI-6の当初スコープ「供給過剰対応」） |
| 設備増強が必要な成長局面 | 需要拡大が続き稼働率が高止まりするケース | 拡張設備投資判断（SAI-6の当初スコープ「設備投資」） |

---

## 18. 実装計画（改訂版：Current Period Delivery Demand層を明示的なステップに分離）

前回案（SAI-6.3で`salesPlans`をそのままproductionへ渡す）を、当期／次期区分の将来拡張を前提とした恒久的な構造にするため、Current Period Delivery Demand層の新設を独立したステップとして切り出す。既存ロードマップとの整合のため、SAI-6の内部ステップとして番号付けする。

| ステップ | 内容 | 主な変更範囲 | リスク |
|---|---|---|---|
| SAI-6.1 | Situation Diagnosis（§10の6カテゴリ・不足型/過剰型の比率算出のみ。既存の意思決定へは接続しない） | 新設モジュール（読み取り専用、既存フローに影響なし） | 低（既存出力への副作用なし） |
| SAI-6.2 | Commercial Plan整理（`salesResult`に、生産へ渡すべき「商品別合計販売可能量」を明示的なフィールドとして追加。既存の`desiredByProduct`はそのまま「参考値」として残す。営業人員配分の動的headcount参照化§14もここで実施） | `decision/sales.ts`・`observation.ts`・`autoPolicy.ts` | 低〜中（fixture依存解消は既存回避コード除去を含む） |
| SAI-6.3 | **Current Period Delivery Demand層**（§11.1の新設。`currentPeriodDeliveryDemand`という中間概念を新設し、暫定計算式（`≒salesPlans`＋当期履行の既存契約）と`deliveryDemandSource`フラグを実装。将来の当期／次期区分機能の受け皿を作る） | 新設モジュール。`policy.ts`の配線をこの層経由に変更 | **中**（本報告の核心の修正の土台。既存のゴールデンケーステスト§16の整備が前提） |
| SAI-6.4 | Inventory & Production Plan（§12.1の生産必要量概念式へ切替。`policy.ts`の配線を`salesResult.desiredByProduct`からSAI-6.3の`currentPeriodDeliveryDemand`ベースの値へ切り替え。戦略先行生産の別枠加算構造もここで実装、Test14 Turn1では常に0） | `policy.ts`・`decision/production.ts`の入力元変更 | **中〜高**（既存の全5社の生産結果を変える唯一の変更） |
| SAI-6.5 | Supply Plan連動（procurement.ts自体は変更不要な想定だが、SAI-6.4後の数値で再検証） | 主にテスト追加 | 低〜中 |
| SAI-6.6 | Worker / Sales Force（Required Worker/Target Worker二層§13の構造実装。削減率上限・採用ペース上限は§19で校正予定のパラメータ枠として実装、初期値は保守的な値を暫定設定） | `decision/labor.ts` | 中 |
| SAI-6.7 | Financial / Capex / Strategic Adjustment（Layer 3：戦略在庫のシグナル検知式・資金制約フィードバック・SAI-6当初スコープの設備投資判断） | `decision/finance.ts`・`decision/capex.ts`（新設ロジック） | 中〜高（当初スコープの本体） |
| SAI-6.8 | Diagnostics / Golden Cases（§15のAI提案文面の実装・reason code拡充、§16のinvariant群をテスト化、§17の教師ケースを順次追加） | `standardAi/reasonCodes.ts`・`aiExplanation/`・テスト | 低 |

（三宅さんの指示にあった`SAI-X1`〜`SAI-X8`という仮称は、既存の予約済み名称`SAI-6`と衝突するため`SAI-6.1`〜`SAI-6.8`へ改めている。前回レポートからの変更点は、旧SAI-6.3「在庫起点生産計画」を「SAI-6.3 Current Period Delivery Demand層」と「SAI-6.4 Inventory & Production Plan」の2ステップへ分割したことである。）

**安全な順序の根拠**: SAI-6.1〜6.3は既存出力に影響しない準備段階（Current Period Delivery Demand層を新設しても、`policy.ts`側の配線を変えるまでは既存の生産計画には影響しない）。SAI-6.4が唯一「既存の全5社の生産・原料調達結果を変える」変更であるため、ここでゴールデンケーステスト（§16）を先に整備してから着手する。SAI-6.5以降は6.4の結果を前提とした検証・拡張であり、6.4単体でも独立した価値のある修正として先行リリース可能。

---

## 19. 未確定事項（三宅さんと議論すべき経営判断、改訂版）

（§1.2のVAP既存契約300t/600t問題は、三宅さんに確認済みのため確定事項として本報告全体へ反映済み。以下からは削除する。）

1. **Worker削減率上限・採用ペース上限の具体値**（§13.2）: 「一括収束を避け、目標保有人数へ段階的に近づける」という構造は確定したが、「1四半期あたり何%まで」という具体的な上限は、三宅さんの他のturnでの判断傾向も見ないと校正できない。
2. **Workerの退職金制度の有無**（§13.3）: 営業人員と同様の退職金ロジックをWorkerにも適用すべきか、現行ゲームにその制度が既にあるか未確認。
3. **戦略在庫（§12.2）のシグナル閾値**: SAI-5の`productSupplyPressureOutlook`等をどの閾値で「発動」とみなすかは、今回のTest14 Turn1データだけでは校正できない（発動条件が観測されていないケースのため）。「次期大口販売機会」「今期原料割安」の具体的な検知式（データ取得元）も未確定。
4. **Standard AIのcapacity認識にノミナル値ではなく実効係数0.855適用済みの値を使うべきか**（§9.2）: SAI-6.4の主目的（生産を当期納品需要でゲートする）とは独立した論点であり、別ステップとして扱うか、SAI-6.4に含めるかは三宅さんの優先度判断が必要。
5. **SAI-6の当初スコープ（設備投資／供給過剰対応／価格戦略強化）と、本報告が追加した範囲（生産・原料の因果順序修正、当期／次期区分の受け皿）の優先順位**: 本報告はCurrent Period Delivery Demand層＋Inventory & Production Plan（SAI-6.3〜6.4）を最優先にすべきという分析結果だが、当初スコープとの時間配分は三宅さんの判断による。
6. **優先順位判断の反映方式（§11.4）**: 「複合制約・上位1〜2件方式」を提案したが、固定モード方式（完全に別ロジックへ分岐）の方がテスト・説明が単純になる場面（例: 資金制約型が発生した場合は他のルールを一時停止する、等）もありうる。どこまで複合を許容するかは、実際に複数制約が同時発生する教師ケース（§17）が増えてから最終判断したい。
7. **`currentPeriodDeliveryDemand`の当期／次期区分機能そのものの実装スケジュール**（§11.1）: 今回はStandard AI側に「受け皿となる中間層」を用意するのみで、営業希望数量を当期／次期に分ける機能自体（ゲーム側の営業活動UI・データモデルの変更）は別のCoworkスコープ（おそらくCowork #04またはゲーム基盤側）になる可能性がある。実装順序・担当の切り分けを三宅さんと確認したい。

---

（本報告はGitHub上のドキュメントとして`docs/standard_ai/TEST14_TURN1_STANDARD_AI_REDESIGN_ANALYSIS.md`に配置。production codeの変更は一切含まない。）
