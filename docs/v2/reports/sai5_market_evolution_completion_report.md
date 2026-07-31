# SAI-5 市場進化モデル 完了報告

- 対象ブランチ: `feature/v2-sai5-market-evolution`
- 作成日: 2026-07-31（JST）
- 状態: **develop/v2・main へはマージしていない。Preview・production へのdeployも行っていない。**

本報告の数値は、事後監査の指摘（Blocker A/B、重要指摘 C〜J）をすべて修正したうえで
**全面的に取り直したもの**である。監査前のサマリ数値は受入判定には使用していない。

---

## 1. 実装した機能

| Phase | 内容 | 機能フラグ | 主なファイル |
|---|---|---|---|
| SAI-5A | 市場・商品志向プロファイル（会社ごとの市場/商品の魅力度倍率） | `marketProductOrientationEnabled`（AI側） | `standardAi/orientationProfile.ts` |
| SAI-5B | 異質5社preset（設備ミックス・技能・初期営業基盤の小幅な差） | `heterogeneousInitialConditionsEnabled`（AI側） | `standardAi/report/heterogeneousPreset.ts` |
| SAI-5C | 市場別の商品ライフサイクル需要（S字普及曲線） | `sai5.productLifecycle`（エンジン側） | `market/productLifecycle.ts` |
| SAI-5D | 会社×市場×商品の営業基盤ストック | `sai5.salesBaseAccumulation`（エンジン側） | `companyLab/salesBase.ts` |
| SAI-5E | 供給圧力→翌期プレミアム／遅行需要／PD⇔VAP代替 | `sai5.supplyPremiumFeedback`（エンジン側） | `companyLab/marketEvolution.ts` |
| SAI-5F | Standard AI の拡張設備投資判断（成長エントリ・過剰供給リトリート・resume提案） | `standardAiCapexEnabled`（AI側） | `standardAi/decision/capex.ts` |
| SAI-5G | A/B比較・因果トレースの生成基盤 | — | `scripts/sai5Analysis.ts`, `scripts/sai5SupplyPressureStudy.ts` |

すべて opt-in。フラグ未指定・全false では既存挙動とビット単位で一致する
（10四半期の全結果一致を `sai5CausalOutcomes.test.ts` 因果(9) で検証）。

---

## 2. 事後監査の指摘への対応（要約）

各指摘の詳細な判断は `docs/v2/reports/sai5_fable_audit.md` 第2部（§7〜§9）に記録した。

| 分類 | 件数 | 内訳 |
|---|---:|---|
| **修正済み** | 12 | A, B, C, D, E, F, G, H, I, J, K, L, N |
| **Calibrationとして残す** | 5 | M（ライフサイクルのdefault率）, R-1（圧力スケールの商品・時間依存）, R-2（片側フィードバック）, R-3（割安シグナルの支配項）, R-4（営業基盤の収束） |
| **Futureとして残す** | 3 | F-1（旧スナップショットの移行期）, F-2（分子と能力上限の関係）, HOSO⇔VAP直接代替 |
| **不採用（理由付き）** | 5 | §8.5 参照 |

### 特に重要な2件

**Blocker A（営業基盤が実際の成約に効いていない）**
競争力の合計処理が2箇所に分岐し、実エンジン側だけ `salesBaseContribution` が
抜けていた。合計処理を `sumCompetitivenessContributions` へ一本化し、係数キー→
内訳キーの対応表をマップ型で定義して、係数を1つ足すと合計にも入れるまで
コンパイルが通らない構造にした。

**Blocker B（供給圧力の分子・分母のスケール不一致）**
係数を触る前に分子・分母の意味をそろえた。候補4種を実装して 4seed×32Q で
実測比較した結果は次のとおり。

| 定義 | PD 圧力中央値 | VAP 圧力中央値 | PD 倍率中央値 | VAP 倍率中央値 | 1.0中心 |
|---|---:|---:|---:|---:|:-:|
| raw_target_demand（旧実装） | 0.268 | 0.492 | **1.361** | **1.251** | × |
| addressable_demand 候補(i) | 0.299 | 0.545 | 1.345 | 1.223 | × |
| neutral_baseline 候補(ii) | 0.830 | 0.658 | 1.078 | 1.153 | △ |
| **completed_supply 候補(iii)【採用】** | **1.026** | **1.102** | **0.991** | **0.948** | **○** |

旧実装は圧力が構造的に1.0を大きく下回るため、`target = 1 − (pressure−1)×感度` が
常に1を超え、**供給フィードバックが設計意図と逆の「恒久的なプレミアム引き上げ」**
として働いていた（PD倍率の中央値1.361）。採用した `completed_supply` は代数的に
`1 + (提示量 − 成約量)/対象需要` と等しく、「売りたかったのに売れ残った量が市場需要の
何％か」という意味の明確な指標になる。棄却理由は設計書 §2.3-R に実測値つきで記録した。

---

## 3. §5 指定項目の最終数値（全面再取得）

生成物: `artifacts/sai5/`（`.gitignore` 対象。生成スクリプトのみGit管理）
- `ab-comparison/{summary.json, summary.md}` — 10 config
- `supply-pressure-study/{summary.json, summary.md, trace.csv}` — 定義4種×4seed×32Q
- `smoke/` — CLI生成物（CSV 6種 + JSONL + JSON + xlsx）

### 3.1 default率と経営指標

| config | seeds×Q | **default率** | 平均累計売上 | 平均累計営業利益 | 平均期末現金 | 分岐開始turn |
|---|---|---:|---:|---:|---:|---:|
| control（全機能OFF） | 8×8 | 42.5% | 368.1M | 8.2M | 11.0M | 6 |
| profilesOnly（SAI-4） | 8×8 | 42.5% | 357.6M | 3.4M | 7.6M | 1 |
| orientationOnly（5A） | 8×8 | 37.5% | 357.3M | 5.4M | 6.6M | 1 |
| lifecycleOnly（5C） | 8×8 | **97.5%** | 271.6M | -31.8M | 0.0M | 5 |
| salesBaseOnly（5D） | 8×8 | **35.0%** | 357.1M | 5.3M | 6.6M | 1 |
| feedbackOnly（5E） | 8×8 | 42.5% | 365.9M | 7.0M | 10.4M | 6 |
| heterogeneousInitOnly（5B） | 8×8 | 40.0% | 356.9M | 4.6M | 5.4M | 1 |
| aiCapexStack（5F+志向+5C+5E） | 8×8 | 90.0% | 279.3M | -30.2M | -2.9M | 1 |
| allOn8q（全機能ON） | 12×8 | 85.0% | 278.8M | -31.3M | -2.8M | 1 |
| allOn32q（全機能ON・長期） | 4×32 | 100.0% | 337.9M | -262.0M | -149.4M | 1 |

全ケース完走・エラー0件。

### 3.2 PD/VAP 供給圧力の四半期推移（allOn32q、中央値）

```
PD  圧力EWMA : 1.000 1.000 1.002 1.006 1.004 1.002 1.001 1.001 … 1.035 1.035
VAP 圧力EWMA : 1.318 1.314 1.309 1.268 1.230 1.191 1.164 1.150 … 1.083 1.078
```

PD は 1.000〜1.044、VAP は 1.070〜1.318。修正前（PD 0.19〜0.39）と異なり、
どちらも 1.0 を中心とした解釈可能なレンジに収まっている。

### 3.3 PD/VAP プレミアムの四半期推移（allOn32q、中央値）

```
PD  倍率        : 1.000 1.000 1.000 0.999 0.997 … 0.982 0.982（最終）
VAP 倍率        : 1.000 0.880 0.843 0.845 0.866 … 0.956 0.958（最終）
PD  VNプレミアム: 0.752 0.679 0.666 0.649 0.658 … 0.908 0.929
VAP VNプレミアム: 1.463 1.273 1.207 1.264 1.320 … 3.097 3.174
```

VAP 倍率は序盤の供給過剰で 1.000→0.843 まで下がり、過剰が解消するにつれて
0.958 まで回復する。**修正前のような単調な上昇（1.0→1.375）は解消した。**

### 3.4 供給増減に対するプレミアムの反応方向

制御条件（他をすべて同一にしてVAPの提示供給だけを変える）での実測：

- **供給を増やす** → 供給圧力EWMAが上昇 → **翌期**のプレミアム倍率とVN市場プレミアムが低下。
  当期の市場プレミアムは変化しない（遡及なし）。効果は持続する。
- **供給過剰を解消する** → 圧力が低下 → 倍率が底から回復し、過剰を続けた対照より高くなる。

いずれも `sai5CausalOutcomes.test.ts` 因果(2)(3) で自動検証している
（符号だけでなく最低効果量の assert つき）。

### 3.5 営業基盤の会社差と成約差

| config | BAL | MASS | JPQ | VAP | CONSV | 最大差 |
|---|---:|---:|---:|---:|---:|---:|
| control | 50.00 | 50.00 | 50.00 | 50.00 | 50.00 | 0.00 |
| salesBaseOnly | 66.67 | 67.01 | 67.00 | 67.06 | 66.46 | 0.60 |
| allOn8q | 63.55 | 64.32 | 64.42 | 64.55 | 64.11 | 1.00 |
| allOn32q | 89.95 | 90.12 | 90.00 | 89.96 | 90.09 | 0.18 |

（全市場×全商品の平均。セル単位では最大3.1ポイントの差が残る）

**成約差**: 他条件が完全に同一なら、営業基盤100の会社は営業基盤0の会社より
**13.6%多く成約**する（`salesBaseAllocation.test.ts` (a)、最低効果量5%を課している）。
実エンジンでは、内訳の `salesBaseContribution` が会社間で分かれ、その差が会社間の
競争力差の最小値を上回ることを検証している。

**セル単位の差の向きは志向どおり**（32Q最終期）: JP×VAP は JPQ が最高（92.1）、
US×PD/VAP は VAP社が最高（94.0 / 92.3）、EU×PD は CONSV が最高（93.8）。
機構は正しく機能しているが、平均としては全社90前後へ収束する（→ Calibration R-4）。

### 3.6 主要 reason code の発火回数

| reason code | allOn8q（12seed×8Q） | allOn32q（4seed×32Q） |
|---|---:|---:|
| SALES_BASE_ADVANTAGE | 456 | 632 |
| SUPPLY_PRESSURE_RETREAT | 420 | 170 |
| VAP_OVERSUPPLY_RETREAT | 60 | 18 |
| PD_CAPACITY_MAINTAINED | 248 | 82 |
| LIFECYCLE_GROWTH_PURSUED | 660 | 1180 |
| MARKET_ORIENTATION_APPLIED | 384 | 512 |
| PRODUCT_ORIENTATION_APPLIED | 384 | 512 |

代表シナリオで発火しないもの（**正直な報告**）:
`CAPEX_DEFERRED_OVERSUPPLY`（PD供給圧力の実測上限1.048 < しきい値1.20）、
`VAP_GROWTH_ENTRY` / `CAPEX_RESUME_PROPOSED`（財務安全条件を満たす局面が現れない）。
発火させるための本体条件の緩和は行わず、専用fixture（`sai5fCapex.test.ts`）で
経路の健全性のみ確認した。

### 3.7 5社が同質化しないか

分岐開始 turn は全機能ONで **1**（control は 6）。市場・商品構成、設備投資提案、
営業基盤のセル単位の値がいずれも会社ごとに分かれる。ただし営業基盤の平均値は
32Qで収束する（→ Calibration R-4）。

### 3.8 32Qで上下限へ一方向に張り付かないか

プレミアム倍率の**床(0.6) 0.0% / 天井(1.4) 0.0%**（allOn32q 256サンプル、
allOn8q 192サンプル）。VAP 倍率は 1.000→0.843→0.958 と底を打って回復しており、
一方向の張り付きはない。

---

## 4. 構造バグと Calibration の切り分け

ご指示に従い、default率が高い件については構造バグかどうかを数値で判定した。

### 構造は正しく動いている（実測で確認）

- **需要保存**: ライフサイクルON/OFFで対象需要の合計が8四半期すべて完全一致（差 0.000000）。
  総需要の増減・二重計上はない。
- **供給圧力の恒等式**: `(5社提示量 + 外部供給量) = 対象需要` が実運転で成立。
- **合計の一貫性**: 内訳6項目の合計と実配分に使われたウェイトが 1,200セルすべてで厳密一致。
- **時間順序**: 当期の決定・結果が当期の価格・需要へ遡及する経路はない。
- **因果の連鎖**: 供給増→圧力上昇→翌期プレミアム低下→数四半期後の商品構成変化、が
  実エンジンの制御実験で確認できる。

### 残るのは Calibration（校正）

- **control（全機能OFF）の時点で default率 42.5%** — SAI-5 以前からの
  ベースライン balance の課題であり、SAI-5 が持ち込んだものではない。
- **lifecycleOnly で 97.5%** — 需要が低採算のHOSOへ寄る一方、5社の設備構成が
  現状のライフサイクル曲線に合っていないことによる採算悪化。設備構成・
  ライフサイクル係数（`accelStartTurn` / `matureShare`）の校正課題。
- **allOn32q で 100%** — 32四半期の累積で上記が効いてくる。

いずれも「状態・判断→結果」の因果が壊れていることによるものではないため、
**最終的なバランス調整は Calibration として残す**。

---

## 5. 検証結果

| 項目 | 結果 |
|---|---|
| `npx tsc --noEmit` | エラー0 |
| `npx eslint .` | **エラー0**、警告4（いずれもSAI-5と無関係の既存警告） |
| `npm run build` | 成功 |
| `npm test` | **1975件すべて成功**（監査前1918 → +57） |
| 8四半期 A/B（10 config） | 全ケース完走・エラー0 |
| 32四半期（4seed） | 完走・エラー0 |
| 複数seed（8〜12seed） | 完走・エラー0 |
| 供給圧力の定義比較（4定義×4seed×32Q） | 完走・エラー0 |
| CSV/JSONL/JSON 生成 | CLI で6種のCSV + decision-trace.jsonl + manifest.json + run-summary.json |
| Excel生成 | `sai3bExcel.ts` で 5.6MB の xlsx を生成成功 |

### 追加したテスト（+57件）

| ファイル | 件数 | 目的 |
|---|---:|---|
| `sales/__tests__/salesBaseAllocation.test.ts` | 8 | Blocker A（§1必須テスト(a)〜(e)） |
| `companyLab/__tests__/supplyPressureDefinition.test.ts` | 11 | Blocker B（§2採用条件[1]〜[8]、棄却候補の再現） |
| `companyLab/__tests__/sai5CausalOutcomes.test.ts` | 13 | §4 結果水準の因果テスト |
| `companyLab/__tests__/qualityIncidentPropagation.test.ts` | 6 | 指摘J（3経路の数値検証・成約量への到達） |
| `companyLab/persistence/__tests__/sai5ConfigRoundtrip.test.ts` | 4 | 指摘E（永続化ラウンドトリップ） |
| `standardAi/__tests__/sai5fCapex.test.ts`（追加分） | 7 | 指摘H（PD_CAPACITY_MAINTAINED の5条件） |
| `companyLab/__tests__/salesBase.test.ts`（追加分） | 2 | 指摘D（飽和防止・順位可変性） |
| `standardAi/autoplay/__tests__/sai5MarketEvolution.test.ts`（追加分） | 2 | reason code の発火確認 |
| `standardAi/__tests__/salesEffort.test.ts`（追加分） | 1 | 指摘G（ウェイト0では発火しない） |
| `companyLab/__tests__/marketEvolution.test.ts`（追加分） | 3 | 指摘C（品質プレミアムの対称性） |

### テストの検出力（リグレッション注入による実測）

既存1918件が Blocker A/B を1件も検出できなかったことを踏まえ、再監査で
実際にリグレッションを注入して検出力を測定した。

| 注入したリグレッション | 検出件数 |
|---|---:|
| Blocker A 再現（合計から salesBase を除く） | 6 |
| Blocker B 再現（定義を旧実装へ戻す） | 9 |
| 指摘D 再現（ヘッドルーム除去） | 1 |
| 指摘E 再現（sai5 復元を外す） | 3 |
| 指摘I 再現（正典上書きを素通し） | 1 |
| config の供給圧力定義を無視 | 1 |
| 指摘B（分子が営業工数スケールを無視） | 1 |
| 指摘F（recentAppliedMixes 素通し / turn を history由来へ） | 各1 |
| 指摘G のウェイト条件を外す | 1 |

このうち「config の定義を無視」と「指摘G のウェイト条件を外す」の2件は、
**再監査時点では0件しか落ちなかった**。原因（交絡・前提不成立）を特定して
テストを修正し、上記の検出力を得ている。

---

## 6. コミット

```
2301b1b fix(v2): address SAI-5 re-audit findings on test effectiveness
f343bc9 chore(v2): regenerate SAI-5 analysis with audit-fixed engine
bd4b073 chore(v2): remove unused test helper (ESLint warning)
d642cf1 test(v2): add outcome-level SAI-5 causal tests
3b7f4c4 fix(v2): address SAI-5 audit findings C-J
bf75858 fix(v2): normalize supply pressure and premium feedback
7e3f220 fix(v2): connect sales base to actual allocation
1b16933 docs(v2): SAI-5 Fable事後監査報告（修正前の起点）
```

---

## 7. 今回の学び（テスト設計）

既存1918件が2件の Blocker を検出できなかった原因は、テストが
**「状態が蓄積される」「値が有限で範囲内に収まる」しか見ていなかった**ことにある。
今回はさらに、修正のために追加したテスト自身にも同種の弱さが2件見つかった。

再発防止として次を実践した。

1. **結果水準で検証する** — 状態の存在・範囲ではなく、成約量・価格・投資判断・
   財務結果が変わることを見る。
2. **単一変数にする** — 機能フラグのON/OFFは複数のパラメータを同時に変えることがある。
   何を変えたのかを1つに絞れないなら、その比較は因果の証拠にならない。
3. **テスト側の計算を実装と別経路にする** — 内訳の合計を実装の関数で検証すると、
   実装から項を落としたとき両辺が同時に変わって検出できない。
4. **前提は guard ではなく assert にする** — `if (前提) { assert }` は前提が崩れた
   瞬間に無検証になる。前提そのものを assert する。
5. **リグレッションを注入して検出力を測る** — 「テストが通る」ではなく
   「バグを入れたら落ちる」ことを確認する。

---

## 8. 次の作業への引き継ぎ

- **マージは未実施**。`develop/v2`（`2195ae7`）・`main`（`3ae9485`）はいずれも未変更。
- Preview・production への deploy は行っていない。
- Calibration 5件・Future 3件を `sai5_fable_audit.md` §8.3 / §8.4 に、
  それぞれ実測値と推奨対応つきで記録した。優先度は **R-1 ＞ R-3 ＞ M ＞ R-4 ＞ R-2**。
- 供給圧力の定義は `SupplyPressureDefinition` として4種すべてを実装に残しており、
  `scripts/sai5SupplyPressureStudy.ts` でいつでも再測定・再検証できる。
