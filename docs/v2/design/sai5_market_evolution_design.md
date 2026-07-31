# SAI-5 設計メモ — 市場進化モデル（Fable事前監査の結果と採用設計）

対象ブランチ: `feature/v2-sai5-market-evolution`（`develop/v2` = `2195ae7` から分岐）
本メモは実装指示§2「Fableによる実装前監査」の成果物であり、コード変更前に
4系統の並列監査（市場エンジン／営業・信頼モデル／設備投資モデル／AI入出力・
persistence・分析基盤）を実施した結果の要約と、採用した設計判断を記録する。

---

## 1. 事前監査で確認した既存構造（要点のみ。行番号は監査時点）

### 1.1 市場価格形成の二段階処理
- 1四半期は `advanceCompanyLabQuarter`（companyLab/runner.ts:572）が実行。
  AIの意思決定材料は `buildCompanyOwnState`（前期末状態のみ）と
  `buildPublicMarketInfo`（**前期のMarketQuarterResultのみ**）で構築され、
  当期のシナリオ入力はAIへ渡らない（=「市場見通し」は前期実績そのもの）。
- 市場精算は `runTurn`→`calculateMarketQuarter`（世界需要→HOSO清算→
  `calculateProductPremium`×2）→`advanceSalesQuarter`（成約配分）の順。
- 次四半期への繰り越しは history・consumerMarketState・
  lastQuarterActualProduction 経由。「当期実績→翌期価格」の片方向規約が
  consumerInventory.ts に明文化されている。

### 1.2 市場・商品ID
- `DemandMarketId = "CN"|"US"|"EU"|"JP"|"OTHER"`（market/types.ts:39-40）。
  **中国(CN)は既に正式な販売市場**であり、成約配分・消費国在庫・仕向価格係数の
  全経路で他市場と同格。新しい市場IDの追加は一切不要。
- `CountryId = "EC"|"IN"|"ID"|"VN"` は原産国（供給側）の別軸。

### 1.3 PD/VAPプレミアム計算（productPremium.ts）
- `世界稼働率 = 世界PD(VAP)需要 ÷ 4か国加工能力` → 倍率（clamp付き）→
  `国別HOSO価格 × basePremiumRatio × 倍率 + 品質調整`。
- 世界PD/VAP需要は **世界合計消費×固定シェア（0.28/0.12、全市場一律）**
  （scenarioEngine.ts:425-430）。市場別の商品構成比・ライフサイクル概念は無い。
- 5社の**当期計画**供給はVN能力の上書きとして当期プレミアムに反映済み
  （supplySignal.ts）。**5社実績→翌期プレミアムへのフィードバック経路は未配線**
  （useActual=true経路が設計済み・未使用）。
- 消費国在庫はプレミアム本体には非接続（仕向係数のみ）。
- 外部競合はシナリオ外生（EC/IN/IDの能力・供給）＋成約配分の外部オプション
  （weight=0.35固定）＋VN国内の外部加工業者。

### 1.4 需要の二層構造（二重計上防止の要）
- 層A: 原産国側の世界需要（国際価格形成用。シナリオ外生）。
- 層B: 消費国在庫循環（consumerInventory.ts。市場別の消費→在庫→購買、
  季節性・遅行/即時価格弾力性・割安積み増しを既に持つ）。
- 層Bの結果は層Aへ戻らないことで分離が保たれている。**価格→需要の弾力性は
  既に3系統存在**するため、新しい「安値遅行需要」を総需要へ入れると
  三重計上になる（→§2.4の採用設計で回避）。

### 1.5 営業効果・信頼・品質
- 蓄積状態の粒度: 品質=会社×商品、顧客信頼・納期信頼=会社×市場。
  **会社×市場×商品の蓄積状態は存在しない**（フローのみ）。
- 成約配分の競争力 = 価格0.35 + 営業カバレッジ0.25 + 顧客関係0.15 +
  品質0.15 + 納期0.10（allocation.ts:61-91、重み合計1.0規約）。
- 「前期末値のみを当期成約に使う」規約はqualityIntegration.test.tsで固定。

### 1.6 設備投資モデル
- 提案→承認（与信ゲート）→分割払い（現金一括、10Mフロア）→完成→
  翌期+readinessで稼働（能力増・減価償却・保守費開始）まで**完全に配線済み**。
  Standard AIの提案はrunnerで実際に建設・完成まで処理される。
- **重大ギャップ（監査で発見）**: `buildFactoryObservations` が静的
  `fixture.factories` の能力を使うため、**完成した能力増加がAIの観測に
  反映されない**（→同じボトルネックを恒久再提案）。alreadyPlanned判定にも
  「完成〜稼働開始」「suspended」の窓がある。suspended案件のresume提案が
  無く資金難後にデッドロックし得る。
- 他社の設備投資は観測不可（PublicMarketInfoは前期市場結果のみ）。

### 1.7 AI入出力・persistence・分析基盤
- 新しい公開情報の唯一の正しい注入経路: `PublicMarketInfo` へoptional追加→
  `buildPublicMarketInfo`（前期レコード由来のみ）→ Observation。
- SAI-4のmanagementProfileはresolveParams注入。**既存ManagementProfile型へ
  フィールドを足すとテスト（deepEqual・バイアス件数断言）が壊れる**ため、
  志向は別型+リゾルバ合成で追加する。
- ログはoptionalフィールド/任意CSVで拡張しschema version 1.0.0据え置きが規約。
  market-allocation-trace.csvはヘッダ完全一致テストがあるため列追加禁止。
  新しいトレースは新しい任意CSVとして追加する。
- persistenceはversion 3（キー欠落→安全な既定値のフォールバック方式）。
- 異質5社preset: 「5社初期条件完全同一」テストはmanagementProfilesEnabled
  下で走るため、**初期差は別フラグで有効化**しないと既存テストが壊れる。

---

## 2. 採用した設計

### 2.0 機能フラグ（A/B比較の基盤）
`CompanyLabConfig` に optional `sai5?: Sai5FeatureFlags` を追加する:

```
Sai5FeatureFlags {
  productLifecycle?: boolean;        // SAI-5C+代替+遅行需要
  salesBaseAccumulation?: boolean;   // SAI-5D
  supplyPremiumFeedback?: boolean;   // SAI-5E
  standardAiCapex?: boolean;         // SAI-5F（AI側の投資積極化）
}
```
未指定＝全OFF＝既存挙動とビット単位一致（各挿入点でフラグ未設定時は
既存コードパスを一切変更しない）。AI側の市場・商品志向（SAI-5A）は
エンジンではなくAIパラメータのため、autoplay側の
`marketProductOrientationEnabled` フラグ（SAI-4のmanagementProfilesEnabled
と同型）で独立に有効化する。§13Eの5軸A/Bはこれらの組で表現する。

### 2.1 SAI-5A: 市場・商品志向（新ファイル orientationProfile.ts）
- `CompanyOrientationProfile`（市場倍率・商品倍率・成長参入/過熱逆張り等の
  戦略特性）を **ManagementProfileとは別型** で定義し、
  `MANAGEMENT_PROFILE_BY_COMPANY_ID` と同様の一箇所対応表を持つ。
- 注入は `StandardAiParameters` に中立既定値の新フィールド
  （`marketOrientationMultipliers: {}` / `productOrientationMultipliers: {}`等）
  を追加し、SAI-4リゾルバと**合成**（既存プロファイルテストを壊さない）。
- 反映方法（decision/sales.ts）:
  - 商品志向: 商品別希望総量 `capacity×salesUtilizationTarget` に商品倍率
    （0.85〜1.20）を乗じる。上限1.20×0.8=0.96稼働で能力超過なし。
  - 市場志向: 既存の市場按分重み（首位50%・残り均等）に
    `clamp(市場倍率×商品倍率, 0.70, 1.35)` を乗じて**商品ごとに再正規化**
    （＝総量保存の再配分。倍率が全て1なら再正規化をスキップしビット一致）。
  - 市況応答: 按分の基礎は従来どおり前期価格ランキング（首位市場の交代で
    50%重みが移る）ため、得意市場の市況悪化時は志向倍率(≤1.25)より
    ランキング変動の方が支配的＝他市場へ自然に移る。
  - 需要ゼロ市場・プレミアム下限割れ(LOW_ORDER_BOOK_PREMIUM_FLOOR)の
    既存ガードは志向より優先（0×倍率=0）。
- 初期値は受入済みSAI-5A指示の倍率表（BAL全て1.0、MASS中国1.25/HOSO1.20、
  JPQ日本1.25/VAP1.20、VAP社米国1.25/PD1.20、CONSV欧州1.25/PD1.15等）。
- 戦略特性（SAI-5F等で消費）: `vapCapexEntryBias`・`pdCapexEntryBias`・
  `oversupplyRetreatSensitivity`・`growthTrendResponsiveness` を数値で持つ。

### 2.2 SAI-5C: 市場別商品ライフサイクル（新ファイル market/productLifecycle.ts）
- **状態を持たない決定論的関数** `lifecycleShare(market, product, turn)` を核と
  する（S字: 初期シェア→加速開始turn→加速期間→成熟シェア。市場別時間差:
  JP最速→US→EU/OTHER→CN最遅）。パラメータは
  `PRODUCT_LIFECYCLE_PARAMETERS_V1` に一箇所集約（§14の係数規約）。
- 挿入点は2箇所のみ（市場モジュール内部は無変更）:
  1. **世界PD/VAP需要**: runnerで `toMarketQuarterInput` 後に
     `pdVapDemand.pdDemand/vapDemand` を
     `Σ_market 市場消費 × pdShare_m(turn)` で置換（同じ消費データから導出、
     固定シェア0.28/0.12の市場別・時変版）。
  2. **市場×商品の対象需要**: `deriveTargetDemand` に optionalの
     市場×商品構成比行列を渡し、従来の「世界構成比×市場ウェイト」
     （分離形）を「市場ウェイト×市場別構成比」（結合形）へ置換。
     行列の行和=1を保証し総需要を保存（二重計上なし）。
- 両挿入点は**同一のlifecycleShare関数**から導出（プレミアム側と成約上限側の
  構成比食い違いを防ぐ）。
- ゲーム開始時点: HOSO最大・PDは意味ある規模・VAP極小、JP>US>EU/OTHER>CN
  の普及順を初期シェアと加速開始turnの両方で表現。
- AIへの公開: `PublicMarketInfo` にoptionalで「前期時点の市場別構成比と
  前期差分」を追加（f(turn-1)とf(turn-1)−f(turn-2)。決定論的な公開市場
  調査に相当。当期の実現需要そのものは渡さない=既存の情報境界を維持）。

### 2.3 SAI-5E: 5社供給→プレミアムフィードバック
- 新carry state `marketEvolutionState`（CompanyLabState optional）に
  商品別の供給圧力EWMAと前期プレミアム倍率を保持。
- **供給圧力 = 当期に成約配分へ提示された5社合計の最終販売計画量 ÷
  当期の商品別対象需要（deriveTargetDemandの商品合計）**。
  採用理由: 両者とも成約配分と同一時点・同一定義の量であり、
  「販売可能量」（在庫依存）より意図的な供給行動を直接表す。allocationの
  実成約量ではなく提示量を使うのは、需要不足で成約できなかった過剰供給分
  こそが価格圧力の本体であるため。
- 翌期の適用: `pdVapDemand.basePremiumRatio`（市場入力）へ倍率を乗じる。
  倍率は `clamp(smooth(前期倍率, 目標(圧力EWMA)), 前期±12%/四半期, 下限0.6, 上限1.4)`。
  市場モジュール内部は無変更・既存クランプと最低プレミアム床は維持。
  当期の契約単価には影響しない（unitPriceは成約時スナップショット）。
- 二重計上の回避: 既存の「5社計画供給→当期稼働率→当期プレミアム」経路は
  そのまま（当期の即時効果）。新経路は「実際に提示された過剰供給の持続が
  翌期以降の基調プレミアムを押し下げる」持続効果であり、時点が異なる。
  消費国在庫係数（仕向価格±8%）とは対象が異なる（国際プレミアム本体 vs
  VN向け参照価格）ことを明記して分離。

### 2.3-R 【事後監査 Blocker B 対応】供給圧力の定義の構造修正（2026-07-31）

上の 2.3 で採用した定義は**誤りだった**。分子は「5社の提示量」（5社だけ）、
分母は「全ベトナム対象需要」（市場全体）で母集団が一致しておらず、圧力は
構造的に 1.0 を中心にできない。実測では PD 0.28 / VAP 0.50 前後に留まり、
`target = 1 − (pressure − 1) × sensitivity` が常に 1 より大きくなるため、
**供給フィードバックが恒久的なプレミアム「引き上げ」として働いていた**
（PD倍率の中央値 1.358 = 設計意図と逆方向）。

三宅さんのご指示に従い、係数を調整する前に分子・分母の意味をそろえた。
候補は `scripts/sai5SupplyPressureStudy.ts`（4 seed × 32Q、SAI-5全機能ON、
定義以外の条件は完全に同一）で実測比較した。生成物は
`artifacts/sai5/supply-pressure-study/{summary.json,summary.md,trace.csv}`。

#### 実測結果（生の供給圧力／適用プレミアム倍率）

| 定義 | 商品 | 圧力 中央値 | 最小 | 最大 | 倍率中央値 | 中立1.0中心 |
|---|---|---:|---:|---:|---:|:-:|
| raw_target_demand（旧） | pd | 0.278 | 0.171 | 0.393 | 1.358 | × |
| raw_target_demand（旧） | vap | 0.500 | 0.297 | 1.661 | 1.249 | × |
| addressable_demand 候補(i) | pd | 0.309 | 0.191 | 0.436 | 1.342 | × |
| addressable_demand 候補(i) | vap | 0.551 | 0.332 | 1.845 | 1.221 | × |
| neutral_baseline 候補(ii) | pd | 0.834 | 0.720 | 1.000 | 1.071 | ○ |
| neutral_baseline 候補(ii) | vap | 0.653 | 0.501 | 1.000 | 1.150 | × |
| **completed_supply 候補(iii)** | **pd** | **1.026** | 1.000 | 1.049 | 0.991 | **○** |
| **completed_supply 候補(iii)** | **vap** | **1.103** | 1.058 | 1.796 | 0.947 | **○** |

#### 採用: `completed_supply`（候補(iii) 分子を全ベトナム供給で補完）

```
pressure = (5社の提示量 + 外部選択肢が埋めた量) / 対象需要
         = 1 + (5社の提示量 − 5社の成約量) / 対象需要
```

外部選択肢が埋めた量は水位法の残差（対象需要 − 5社成約量）なので、この式は
代数的に「**売りたかったのに売れ残った量が、市場需要の何％にあたるか**」と
等しい（`supplyPressureDefinition.test.ts` [7] で恒等式を検証）。

- 分子・分母がどちらも同じ市場×商品のHOSO換算トンで、母集団が一致する。
- 提示した分がすべて成約する中立状態で**厳密に 1.0**（規模不変。テスト[1]）。
- 提示だけ増やすと上昇、減らすと 1.0 へ低下（テスト[2][3]）。
- 圧力↑→翌期プレミアム倍率↓、過剰解消→倍率が回復（テスト[4][5]）。
- 需要が季節変動するだけ（売れ残りなし）では倍率が動かず、上下限にも
  張り付かない（テスト[6]、32Q実測でも床0.0%・天井0.0%）。
- 外部選択肢の数量は「市場全体の供給量を数える」1つの役割でのみ使われ、
  プレミアムへ別経路で足されることはない（二重計上なし。テスト[7]）。
- 入力は市場×商品の集計量のみで、会社別の補正項も、A/B結果に合わせて
  当てはめた定数も持たない（テスト[8]）。

**1.0 が下限になることの扱い（意図的な制約として受け入れる）**:
本モデルの外部選択肢は上限なし（完全弾力的）と定義されているため、市場が
構造的に供給不足になることは起こり得ない。したがってこの指標は 1.0 を
下回らず、プレミアム倍率は中立 1.0 以下の範囲で動く（供給過剰で下がり、
過剰が解消すると 1.0 へ回復する）。対称な上振れを作るには根拠のない基準
定数を導入するしかなく、ご指示の「A/B結果に当てはめた定数を置かない」に
反するため採らない。プレミアムの上方向の変動は、既存の世界需給・稼働率
経路（market モジュール内部）が引き続き担当する。

#### 棄却した候補と理由

- **候補(i) `addressable_demand`（5社addressable需要を分母）** — 棄却。
  水位法の均衡シェア `Σᵢwᵢ/(Σᵢwᵢ + w_ext)` を分母に掛けたが、外部選択肢の
  重み 0.35 に対し5社の競争力合計は約 3.1 のため均衡シェアは約 90%、
  つまり分母がほとんど変わらない。実測でも中央値 PD 0.309 / VAP 0.551 と
  1.0 に全く届かない。**5社が全ベトナム需要に対して能力上小さい**という
  構造的事実が原因で、分母の掛け直しでは解消しない。
  （ヘルパー `computeAddressableDemand` は再現用に残置。）
- **候補(ii) `neutral_baseline`（生比率をその長期EWMAで正規化）** — 棄却。
  定常状態なら定義上 1.0 に収束するが、実測では市場成長に伴って生比率が
  単調低下するトレンドがあり、遅れて追随するEWMAに対して恒常的な下方バイアス
  （PD 0.834 / VAP 0.653）が残った。バイアスを消すには平滑化係数を実測に
  合わせて当てはめる必要があり、ご指示の禁止事項に触れる。また「絶対水準の
  供給過剰」を表現できない（十分に長く続けば必ず 1.0 へ戻る）。
- **旧 `raw_target_demand`** — 棄却。上記のとおり分子・分母の母集団が
  一致せず、フィードバックの符号が設計意図と逆になっていた。

いずれも `SupplyPressureDefinition` として実装に残してあり、
`scripts/sai5SupplyPressureStudy.ts` でいつでも再測定・再検証できる
（既定は採用済みの `completed_supply`）。

#### 構造修正後に測り直した係数

供給圧力EWMAの実測分布（4 seed × 32Q、採用定義）:
PD 1.000〜1.044（中央値 1.021、p90 1.039）、
VAP 1.070〜1.318（中央値 1.106、p75 1.141、p90 1.279）。

| パラメータ | 旧 | 新 | 根拠 |
|---|---:|---:|---|
| `supplyPressureRetreatThreshold` | 1.2 | **1.14** | VAPのp75（1.141）付近から販売抑制が効き始める |
| `capexOversupplyPressureThreshold` | 1.15 | **1.20** | 設備投資見送りは販売抑制より重い判断のため、VAPの上位2割弱に限定 |
| `supplyPressureEwmaAlpha` | 0.4 | 0.4（据置） | 実測レンジ内で6期程度の持続を捉えられている |
| `premiumTargetSensitivity` | 0.5 | 0.5（据置） | VAP p90（1.279）で倍率 −14% 程度。急変せず、かつ意味のある大きさ |
| `supplyPressureRetreatFloor` | 0.85 | 0.85（据置） | 抑制の下限 −15% は据置 |

PD側は実測レンジの上限が 1.044 のため、通常運転では供給圧力リトリートも
設備投資見送りも発火しない。これは「本シナリオでPDは供給過剰にならない」
という測定結果であり、発火させるための本体ロジックの追加は行わない
（ご指示§4に従い、専用fixtureのテストで経路の健全性のみ確認する）。

### 2.4 安値による遅行需要（§9）
- **総需要への安値効果は追加しない**（既存の消費遅行弾力性・購買即時弾力性・
  割安積み増しと三重計上になるため。監査結論）。
- 代わりに「相対価格→**商品構成比の普及速度**」として実装:
  `adoptionAffordabilityState`（市場×商品のEWMA、2〜4四半期遅行、上下限付き）
  が、PD/VAPの実現プレミアムが基準より低い状態の持続に応じて
  lifecycleShareの進行を加速（前倒し）・高価格持続で減速する。
  HOSOの安値→市場全体需要の増加は、既存のconsumerInventory弾力性が
  既にこの役割を担っていることを確認したため**意図的に追加しない**
  （重複計上防止。完了報告に明記）。
- これにより「供給増→価格低下→数四半期遅れて普及加速→需給が締まれば
  価格回復（ただし供給がさらに増えれば回復しない）」の循環が、
  プレミアムフィードバック（2.3）との組で成立する。

### 2.5 商品間代替（PD⇔VAP、限定的）
- lifecycleShare適用後の市場別構成比行列に対する後処理として実装
  （需要行列という一箇所でのみ需要を動かし、二重計上を構造的に防ぐ）。
- 前期の実現プレミアム差（VAP−PD）が基準差より縮小した度合いに応じ、
  PD構成比の一部（**最大10%**）をVAPへ移す（逆方向はVAP→PDへ同様）。
  移動は元商品から減らして加える（総和保存）。HOSO⇔VAPの直接代替は
  実装しない（PD⇔VAPより弱いという指示を「0」として保守的に開始し、
  係数を外部化して将来調整可能にする）。

### 2.6 SAI-5D: 営業基盤（新ファイル companyLab/salesBase.ts）
- `SalesBaseState`: 会社×市場×商品の0〜100スコア（Score0to100、中立50）。
- 更新式（毎四半期末、品質・信頼と同じ位置=成約・履行確定後）:
  `next = clamp(prev + 活動獲得 + 成約強化 − 放置減衰 − 事故毀損, floor, cap)`
  - 活動獲得: 当期その市場×商品へ人員>0かつ希望量>0で計画を出した場合、
    `acquisitionPerQuarter × (1 − prev/100) × 市場成熟度係数`
    （成熟度係数 = clamp(当該市場×商品の構成比 ÷ 成熟構成比, 0.25, 1)。
    小さい初期市場では形成速度を抑える）。
  - 成約強化: `contractBoost × min(1, 成約量/希望量)`。
  - 放置減衰: 活動なしの四半期は `prev × decayRatio`（既定6%/四半期。
    1四半期でゼロにならず数四半期で低下）。
  - 毀損: 当期の重大品質事故で減点（既存majorIncidentの結果を参照）。
- 成約への影響: allocation.tsの競争力に第6項 `salesBase` を追加。
  **既定重み0**（数値上完全無影響=既存テストのビット一致維持）。有効時は
  重み合計1.0を保って再配分（価格0.35/カバレッジ0.21/顧客関係0.13/
  品質0.13/納期0.10/営業基盤0.08）。顧客信頼（履行体験の蓄積）と観測系列を
  分離（営業基盤は「計画提示・人員配置・成約」由来、信頼は「履行品質・納期」
  由来）し二重加算を抑える。外部オプション重みとの相対バランス変化は
  калибровка課題として記録。
- persistence: version 3→4。キー欠落時は「全社中立50の空状態」へ
  決定論的フォールバック（workforce/consumerMarketの前例踏襲）。

### 2.7 SAI-5B: 異質初期条件preset
- identical-standardは完全維持。新フラグ
  `heterogeneousInitialConditionsEnabled`（autoplay側）で、統一テンプレート
  複製後に会社別の小幅overrideを適用する薄い初期化を追加。
- 差を付ける対象（会計整合が構造的に保てるものに限定）:
  - 商品別設備能力の構成（総量ほぼ同一で商品ミックスを±15%以内で傾斜。
    MASS=HOSO寄り、JPQ/VAP社=PD/VAP寄り、CONSV=PD寄り）
  - fixedAssetsGrossを能力総量比で微調整（純資産は残差計算のためBS自動整合）
  - 営業人員の市場配置志向はSAI-5A側で表現（初期headcount総数は同一）
  - 初期営業基盤（会社×市場×商品。JPQ×JP×VAP高、MASS×CN×HOSO高等）
    ※BS非接続のため最も安全な初期差
  - ワーカー技能の商品別傾斜（±5%）
- 変えないもの（説明可能な整合を保てないため）: 初期契約・初期在庫・
  現金/借入・品質/信頼初期値（→完了報告の次工程候補に記載）。

### 2.8 SAI-5F: Standard AI設備投資
- **無条件のバグ修正**（機能フラグ外。監査で確認した正しさの問題）:
  1. Observationの商品別能力へ完成済みcapex能力増を反映
     （ownState.capexStateから導出。完成後の恒久再提案ループを解消）
  2. alreadyPlanned判定へ「完成〜稼働開始前」「suspended」を含める
- AI側の新判断（orientation有効時のみ）:
  - suspended案件の resume 提案（現金がバッファ×capexCashSafetyMultipleを
    回復した場合）
  - ライフサイクル成長エントリ: 公開構成比トレンド（前期差分）が正で、
    プレミアムが十分、既存の安全条件（sustained稼働・在庫・現金・借入）を
    満たす場合に、志向バイアス付きしきい値でPD/VAPライン増設を提案
  - 過剰供給リトリート: 供給圧力（公開の前期供給/需要比）が高いときは
    投資を見送り `CAPEX_DEFERRED_OVERSUPPLY` を記録
- 使用情報は前期末・公開情報のみ（将来の需要曲線・他社未提出決定・将来乱数
  へのアクセス経路は存在しないことを監査で確認済み）。
- 借入前提を置かない（現状の現金一括払いモデルのまま。既存の
  capexCashSafetyMultiple=1.75ゲートを維持）。設備転用・売却は次工程。

### 2.9 reason code
`STANDARD_AI_REASON_CODES` へ追加（union/配列/taxonomy/カタログの4点同期）:
`MARKET_ORIENTATION_APPLIED` / `PRODUCT_ORIENTATION_APPLIED` /
`LIFECYCLE_GROWTH_PURSUED` / `SALES_BASE_ADVANTAGE` /
`SUPPLY_PRESSURE_RETREAT` / `CAPEX_DEFERRED_OVERSUPPLY` /
`CAPEX_RESUME_PROPOSED` / `VAP_GROWTH_ENTRY` / `VAP_OVERSUPPLY_RETREAT` /
`PD_CAPACITY_MAINTAINED`。
（指示例のうちCOMPETITOR_CAPACITY_PIPELINEは、他社設備投資の公開情報
チャネルが存在しないため今回は対象外＝次工程。CAPEX_DEFERRED_CASH/CREDITは
既存のCAPEX_DEFERREDのkeyValues(safe等)で既に区別可能なため、コード分裂は
せずkeyValuesへ理由フラグを追加する。）

### 2.10 ログ・分析
- 新しい任意CSV `market-evolution-trace.csv`（四半期×市場×商品:
  ライフサイクル構成比・調整前後需要・代替移動量・供給圧力・プレミアム倍率・
  adoption状態）と `sales-base-trace.csv`（四半期×会社×市場×商品:
  期首・獲得・強化・減衰・期末）を追加し、`SAI3A_OPTIONAL_RUN_FILES` 方式で
  SAI-3Bの後方互換を維持。market-allocation-trace.csvは変更しない
  （ヘッダ完全一致テストのため）。
- schema version 1.0.0 据え置き（optional追加のみ）。
- A/B比較はartifacts/sai5へ機械可読(JSON/CSV)+人間可読(md)で出力。

---

## 3. 採用しなかった監査提案と理由

| 提案 | 不採用の理由 |
|---|---|
| ライフサイクルをシナリオbase variable（keyframeトレンド）として実装 | 型追加・全シナリオ定義への波及が大きい。決定論的関数+パラメータ一箇所集約で同じ表現力を確保し、シナリオ変数化は将来のリファクタ候補として記録 |
| affordabilityをConsumerMarketCarryStateへ追加 | 既存の3系統の価格弾力性と同居させると三重計上リスク。商品構成比の普及速度への限定作用として新しい層に分離 |
| 供給フィードバックにsupplySignalのuseActual=true経路を使用 | actual生産量は「供給意図」より在庫・歩留まりのノイズを含む。成約配分への提示量/需要比の方が指示（§8）の「供給圧力」定義に合致。useActual経路は将来の追加チャネル候補として温存 |
| HOSO安値→市場全体エビ需要の増加 | consumerInventoryの消費遅行弾力性が既に同じ因果を実装済み。追加すると二重計上（§9の「重複計上しない」要件を優先） |
| 営業基盤をmaximumSupplierShare(cap側)へ接続 | cap側は効果が二値的（拘束時のみ）で方向テストが不安定。競争力ウェイト第6項の方が連続的で検証容易。cap側接続は将来拡張点として温存 |
| 他社設備投資の公開情報チャネル新設 | PublicMarketInfoの情報境界設計の変更を伴い今回の範囲では過大。供給圧力（実際の提示量ベース）が代替シグナルとして機能する。次工程候補 |
| CAPEX_DEFERRED_CASH/CREDITの独立コード化 | 既存CAPEX_DEFERREDのkeyValuesで判別可能。コード分裂はSAI-3B集計の連続性を損なう |

## 4. 二重計上・リーク・単位の防衛線（実装時チェックリスト)

1. 需要はlifecycle行列という一箇所でのみ市場×商品へ分配（行和=1、総和保存）
2. 代替は行列内の移動のみ（元から減らし先へ足す）
3. affordabilityは構成比の速度のみ（総需要不変）
4. プレミアムフィードバックは翌期basePremiumRatioのみ（当期契約へ遡及しない）
5. AIが観測するのは常に前期値（PublicMarketInfo経由、f(turn-1)まで）
6. 全数量はHOSO換算トン（physicalYieldRatioを新計算へ混入させない）
7. 市場乱数ストリームからの追加消費禁止（新機能は全て決定論的）
8. 新状態の反復順は companyId→market→product の固定ソート
9. persistenceはキー欠落→決定論的フォールバック+version 4
10. フラグOFF時は既存コードパス不変（浮動小数点の再正規化もスキップ）
