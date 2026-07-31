# SAI-5 Fable事後監査報告（§15）

対象ブランチ: `feature/v2-sai5-market-evolution`（分岐元 `2195ae7` = SAI-4完了時点、監査時HEAD `3c94627`）
実施: 2系統の独立監査エージェントを並列実行（それぞれOpus・高推論、READ-ONLY）。
- 監査A: 二重計上・単位・時間順序・情報リーク・契約単価遡及・決定論（§15の1〜7）
- 監査B: 状態の二重効果・設備完成前能力・capex会計整合・異質preset会計・persistence後方互換・reasonと計算の一致（§15の8〜17）

両監査とも、コード精読に加えて`npx tsx`による**実行検証**（一時プローブは削除済み、リポジトリは無変更）を行っている。
指摘のうち主要なものは、報告受領後にClaude自身が該当コードを再確認し、妥当性を判定した（後述「Claudeによる採否判定」）。

---

## 0. 総括

**新規テスト64件・全1918件が成功しているにもかかわらず、SAI-5DとSAI-5Eの中核因果が意図どおり動いていない**ことが判明した。
いずれもテストが「状態が蓄積されること」「値が範囲内であること」しか検証しておらず、
**「その状態が実際に結果を変えること」を検証していなかった**ために素通りしていた。

| # | 分類 | 概要 | 位置 |
|---|---|---|---|
| A | **Blocker** | 成約配分が営業基盤の寄与を合計に入れていない → SAI-5Dは成約に無効、かつ0.08が消滅し外部オプションへ需要流出 | `sales/allocation.ts:216-221` |
| B | **Blocker** | 供給圧力の分子（5社のみ）と分母（ベトナム全体需要）のスケール不一致 → PD圧力≈0.28で倍率が上限へ片道上昇、設計と逆方向 | `companyLab/runner.ts:987-999` |
| C | Important | `realizedRatio`（品質・稼働率込み）と`referencePremiumRatios`（ベース比率のみ）の定義非対称 → 恒常的な割高バイアス | `marketEvolution.ts:132-137` |
| D | Important | 営業基盤が全社上限へ飽和（成約強化項にヘッドルーム欠如）→ SAI-5Bの初期差がT16頃に消滅 | `salesBase.ts:194` |
| E | Important | `config.sai5`がpersistence検証で脱落 → セーブ/ロードでSAI-5が全無効化、状態だけ凍結して残る | `persistence/schema.ts:864-876` |
| F | Important | `buildPublicMarketInfo`が`history.length`をturnの代理に使用 → 永続化経路でトレンドが恒久的にゼロ | `runner.ts:435-446` |
| G | Important | `SALES_BASE_ADVANTAGE`がウェイト0の構成でも「第6項として反映される」と主張（実測16回） | `runner.ts:421` / `heterogeneousPreset.ts:111` |
| H | Important | `PD_CAPACITY_MAINTAINED`が3箇所に定義されているのに発行箇所ゼロ | `reasonCodes.ts`ほか（発行元なし） |
| I | Important | `salesBaseScore`の注入がStandard AI経路のみ（autoPolicy・プレイヤー入力は中立50固定） | `autoPolicy.ts:374-376` |
| J | Important | 重大品質事故が営業基盤・customerTrust・qualityScoreの三重計上（モジュール自身の設計原則に反する） | `salesBase.ts:205-207` ↔ `quality/trustObservation.ts:72` |
| K | Calibration | SAI-5F capex拡張が代表シナリオで完全不活性（`noExcess`が常にfalse）→ 発火0回 | `decision/capex.ts:76,150` |
| L | Calibration | 供給ドライバが3経路（能力→稼働率／供給圧力→倍率／実現比率→普及）で重複作用 | 設計横断 |
| M | Calibration | 異質presetの固定資産調整が期初自己資本を最大4.1M USDずらす／傾斜が共通工程に阻まれ実効差が小さい | `heterogeneousPreset.ts:86-87,133` |
| N | Future | 主工場の選び方がAI観測（factoryIdソート順）とエンジン（配列出現順）で異なる（複数工場化で顕在化） | `observation.ts:83` ↔ `capex/capacityEffect.ts:176` |
| O | Future | 異質presetの「傾斜前fixture逆算」方式（現行値では誤差0だが基礎値変更で破綻） | `heterogeneousPreset.ts:120-135` |

**明確にOKと確認された項目**（監査が検証し問題なしと判定）:
需要の二重計上なし（総需要保存を数式展開と実測の両方で確認）／単位系の一貫性（HOSO換算トン・比率の混同なし）／
当期情報の先読みリークなし（インメモリ経路）／契約単価の遡及変更経路なし／決定論・再現性／
ウェイト合計1.0の検算／既定パラメータでのビット単位後方互換／設備完成前能力の観測非混入／
capex会計経路の非迂回・resumeRequests実処理経路の存在・借入承認前提の不在／
異質presetのBSバランス（丸め誤差0を数値で確認）／persistence v1〜v3受理・キー非包含・復元の決定論性／
reason code 4箇所同期（30件、欠落0）。

---

## 1. Blocker A: 成約配分が営業基盤の寄与を落としている

### 事実（Claudeが再確認済み）

`app/lib/v2/sales/allocation.ts:215-221`（エンジンが実際に通る`allocateMarketProduct`内）:

```ts
const breakdown = computeCompetitivenessBreakdown(entry, askPrice, basePrice, coverage, params);
const weight =
  breakdown.priceContribution +
  breakdown.coverageContribution +
  breakdown.relationshipContribution +
  breakdown.qualityContribution +
  breakdown.deliveryReliabilityContribution;   // ← salesBaseContribution が無い
```

SAI-5Dでは、公開ヘルパー`computeCompetitivenessWeight`（同`104-112`）にだけ第6項を追加したが、
**エンジンはこのヘルパーを呼ばず自前でインライン合計している**。
`grep`で確認したところ、`computeCompetitivenessWeight`の呼び出しは**テストファイルのみ**（16箇所すべて`__tests__`配下）。

### 影響（監査Aによる実測、5社・salesBaseScore=100/75/50/25/0・targetDemand=2000）

```
V1(weight 0)       | A=361.1 B=361.1 C=361.1 D=361.1 E=361.1 | 5社計 1805.4 | 外部 194.6
SAI5(weight 0.08)  | A=357.7 B=357.7 C=357.7 D=357.7 E=357.7 | 5社計 1788.7 | 外部 211.3
```

1. **営業基盤100の会社と0の会社の成約量が完全に同一** → SAI-5Dは成約に対して完全に無効。
   蓄積・観測・診断（`SALES_BASE_ADVANTAGE`）・CSVトレースだけが動いている。
2. `SALES_PARAMETERS_SAI5_SALES_BASE_V1`はcoverage/relationship/qualityから計0.08を切り出して`salesBase`へ移したが、
   その0.08が**どこにも足されず消滅**する。5社の競争力ウェイト合計が0.589→0.542（−8.0%）となり、
   固定ウェイト0.35の外部オプションへ需要が流出（5社計−0.93%、外部+8.6%）。
   `sales/parameters.ts:148-152`の「合計を1.0に保つのは外部オプションとの相対バランスを変えないため」という
   設計意図が**実装で守られていない**。

### 推奨修正

`allocateMarketProduct`の`weight`に`breakdown.salesBaseContribution`を加算する
（または`computeCompetitivenessWeight(...)`を呼ぶ形へ一本化する）。
併せて「営業基盤が高い会社の成約量が実際に多くなる」ことを検証するテストを追加する
（現行のSAI-5D統合テストは状態の蓄積しか見ておらず、この欠落を素通りした）。

---

## 2. Blocker B: 供給圧力の分子・分母のスケール不一致

### 事実（Claudeが自身のA/B実測データで確認済み）

`companyLab/runner.ts:987-999`:
- **分子** = `decisions[].salesPlans[].desiredQuantity` の合計 = **ラボ5社のみ**の希望販売量
- **分母** = `turnResult.salesRecord.allocations[].targetDemand` の合計 = **ベトナム産全体**がその市場×商品で
  獲得する需要（`hosoPrices.VN.allocatedDemand`由来＝国家規模）

加えて`maximumSupplierShare=0.35`・`externalOptionWeight=0.35`により、
5社が`targetDemand`を埋め切る構造にそもそもなっていない。

### 実測（`artifacts/sai5/ab-comparison/summary.json`、median、turn1→8）

| config | 指標 | t1 | t2 | t3 | t4 | t5 | t6 | t7 | t8 |
|---|---|---|---|---|---|---|---|---|---|
| feedbackOnly | 供給圧力PD | 0.290 | 0.223 | 0.236 | 0.226 | 0.222 | 0.191 | 0.254 | 0.240 |
| feedbackOnly | プレミアム倍率PD | 1.000 | 1.120 | 1.241 | 1.297 | 1.334 | 1.356 | 1.375 | 1.375 |
| allOn8q | 供給圧力VAP | 1.661 | 1.008 | 0.994 | 0.890 | 0.945 | 0.811 | 0.740 | 0.679 |
| allOn8q | プレミアム倍率VAP | 1.000 | 0.880 | 0.919 | 0.952 | 0.993 | 1.009 | 1.041 | 1.076 |

PDの供給圧力は**構造的に0.2〜0.3**（＝需要の3〜5倍の余地がある状態）。
目標倍率 = `1 − (0.28−1)×0.5 = 1.36` となり、**上限1.4へ向かう片道ラチェット**になる。
VAPは初期のみ1を超えるため一度は低下（0.88）するが、圧力が1を下回った後は同様に上昇へ転じる。

つまり「5社が供給を増やすと翌期プレミアムが下がる」という設計意図に対し、
実装は**恒常的にプレミアムを押し上げるだけの定数バイアス**として作用している
（監査Aの独立実測では、フィードバックON/OFFでPDプレミアムが16Q時点で+28.4%）。

### 派生影響

`capexOversupplyPressureThreshold=1.15`・`supplyPressureRetreatThreshold=1.2`は
実測圧力0.2〜0.5に対して**永久に発火しない**。SAI-5Fの「過剰供給リトリート」
（`decision/capex.ts:76-96`、`decision/sales.ts:190-208`）は実質デッドコードであり、
`SUPPLY_PRESSURE_RETREAT`・`CAPEX_DEFERRED_OVERSUPPLY`・`VAP_OVERSUPPLY_RETREAT`の
発火回数が代表16Q実行で**すべて0回**である事実と整合する。

### 推奨修正（いずれか）

1. 分母を「5社に帰属する需要」に揃える（`targetDemand ×（1 − externalOptionの期待取り分）`等）
2. 分子を「ベトナム全体の供給」に揃える
3. 圧力を自身の初期ベースラインで正規化する（`pressure / pressure_baseline`）

修正後は`capexOversupplyPressureThreshold`等のしきい値も再校正が必要。

---

## 3. その他のImportant（要点のみ。詳細は上表の位置参照）

- **C** `realizedRatio = premium/hosoPrice` には`utilizationMultiplier`と品質プレミアム（全国qualityScore=60により恒常+0.03）が
  含まれるのに、比較対象の`referencePremiumRatios`はベース比率のみ。需給が完全中立でも「PDは16.7%割高」と誤判定され、
  PD普及が恒久的に約1.33四半期後ろ倒しされる。さらにBのラチェットが「PDが割高になった」と誤読され自己増幅する。
- **D** `salesBase.ts:194`の成約強化項に`(1 − score/100)`のヘッドルーム係数が無いため、活動中セルの不動点がcap=100になる。
  20Q実測で全社平均が97〜99へ飽和し、SAI-5Bが仕込んだ初期差（55〜65）はT16頃に完全に洗い流される。
- **E** `persistence/schema.ts:864-876`の`validateCompanyLabConfig`が`{scenarioId, mode, seed, turns}`のみを再構築するため
  `config.sai5`が脱落。状態（`salesBaseState`/`marketEvolutionState`）はv4で往復するのに、それを意味づけるフラグだけが
  失われ、セーブ/ロード後は「機能OFFだが状態は凍結して残る」不整合になる。現時点ではApplication Service層が
  `sai5`を設定していないため未顕在だが、UI配線と同時に必須。
- **F** `runner.ts:435`の`nextTurn = state.history.length + 1`は、永続化経路
  （`companyLabQuarterFlowService.ts:374`が意図的に直近1件のみ注入）では常に1になり、`nextTurn >= 3`が永久にfalse。
  結果`quarterlyTrendByMarket`が恒久ゼロとなり、SAI-5Fの成長エントリ・販売前傾が実ゲームでは一切発火しない。
  `state.scenarioState.currentTurn`基準へ変更すべき。
- **G/H/I/J** は上表のとおり。特にHは「PD能力維持の判断」自体が未実装であり、
  SAI-5E（PD⇔VAP代替）に対するAI側の片側だけが接続されている状態。

---

## 4. Claudeによる採否判定

監査指摘を無条件には採用せず、コードと仕様に照らして以下のとおり判定した。

**採用（実コードで再確認済み）**: A（`allocation.ts:215-221`のインライン合計に第6項が無いこと、
`computeCompetitivenessWeight`の呼び出しがテストのみであることを`grep`で確認）、
B（自身のA/B実測データで供給圧力0.2〜0.3と倍率の単調上昇を確認）。

**採用（監査の実測を妥当と判断）**: C・D・E・F・G・H・I・J。
いずれも指摘位置のコードが実在し、論理が追える。

**Calibrationとして記録（今回は係数調整せず）**: K・L・M。
§14「今回の目的は最終ゲームバランスの完成ではない」に従い、A・Bの修正後に再測定してから扱う。
特にLは、A・Bを直さないまま係数を触ると誤った方向へ校正してしまうため、**修正前の調整は行わない**。

**Future（次工程）**: N・O。現行の全社1工場・現行テンプレート値では顕在化しないことを確認済み。

**不採用**: なし（明確に誤りと判断できる指摘は無かった）。

なお監査Aは、既存テスト`sai5MarketEvolution.test.ts`の「契約単価は遡及変更されない」テストが
同一配列同士の比較で**恒真**になっていると指摘した。契約単価の不変性自体はコード読解で確認済み
（`sales/contracts.ts:88`でスナップショット、変更経路なし）だが、テストとしては保証になっていないため、
修正時に併せて実効的な検証へ差し替える。

---

## 5. テスト網羅の穴（今回の学び）

本監査で最も重要な発見は、個々の不具合そのものよりも**テスト設計の穴**である。

| 穴 | 素通りしたBlocker |
|---|---|
| SAI-5D統合テストが「状態が蓄積される」「観測できる」しか検証せず、**成約配分を変えることを一度も検証していない** | A |
| SAI-5E統合テストが「有限であること」「0.6〜1.4に収まること」のみで、**倍率が意図した向きに動くことを検証していない** | B |
| 永続化往復テストに`config.sai5`の往復ケースが無い | E |
| 代表シナリオでの各reason codeの**発火実績**を検証していない | H・K |

修正時には、各機能について「状態が変わる」ではなく
**「その状態が実際に結果（成約量・価格・投資判断）を変える」**ことを検証するテストを追加する。

---

## 6. 修正優先順位（推奨）

1. **A**（`allocation.ts`に`salesBaseContribution`を加算）— 影響が明確。併せて成約差の実効テストを追加。
2. **B**（供給圧力の分子・分母のスケール整合）— 係数調整では直らない定義バグ。修正後にしきい値を再校正。
3. **C**（`referencePremiumRatios`側に稼働率倍率・品質加算を含める、または`realizedRatio`から品質加算を除く）
4. **D**（成約強化項にヘッドルーム係数を掛ける）、**G**（観測注入と初期営業基盤をフラグでゲート）
5. **E**（`validateCompanyLabConfig`に`sai5`のoptional検証を追加）、**F**（`scenarioState.currentTurn`基準へ）
6. **H**（`PD_CAPACITY_MAINTAINED`の判断を実装するか、コード定義を削除して整合させる）、**I**、**J**
7. **K・L・M**（A〜Cの修正後に再測定してから校正）

**重要**: A・Bの修正はA/B比較の全数値を変える。`scripts/sai5Analysis.ts`による再実行と、
本ブランチの完了報告書の数値差し替えが必要になる。
