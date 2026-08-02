# Test15前 VAP商品開発投資（vapProductDevelopmentSpendUsd）プリフライト校正報告（Phase7）

- 対象ブランチ: `feature/v2-test15-preflight-calibration`（作業ツリー `/tmp/test15_integration`）。
  **本サンドボックスにはpush権限が無いため、コーディネーター指示に基づき
  `develop/v2` への統合作業の代替として本ブランチ上で完結させている。**
- 生成物:
  - 診断専用スクリプト: `scripts/test15VapProductDevelopmentPreflightCalibration.ts`
  - 回帰テスト: `app/lib/v2/companyLab/__tests__/test15VapProductDevelopmentPreflightCalibration.test.ts`（VDC-1〜VDC-8、全パス）
  - CSV/JSON: `artifacts/test15/preflight-calibration/test15-vap-product-development-preflight.{csv,json}`（`.gitignore`対象。再生成は `npx tsx scripts/test15VapProductDevelopmentPreflightCalibration.ts`）
- 対象会社: BAL。seed=3種（`test15-vapdev-seed-1/2/3`）。
- スペンド4段階: $0 / $100,000 / $250,000 / $500,000（四半期あたり一定額、`VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD`と一致）。
- 追跡期間: 各水準・各seedとも12四半期、同一初期状態・同一市場条件で一定spendを維持。

**本報告は診断専用スクリプトの結果である。`production/parameters.ts`・`capex/parameters.ts`・
`finance/parameters.ts`・`companyLab/productDevelopmentState.ts`の
`PRODUCT_DEVELOPMENT_PARAMETERS_V1`・`companyLab/premiumPolicy.ts`の
`VAP_CAPABILITY_WEIGHTS_V1`等の共有デフォルトパラメータは一切変更していない
（回帰テストVDC-5で、診断スクリプト実行前後のJSONスナップショット一致を機械的に確認済み）。**

---

## 1. 結論（先に要点）

**VAP商品開発スコアは投資額に応じてヘッドルーム式どおり確実に上昇し、それが
「VAP能力合成係数（vapCapabilityScore）」へも実際に反映される（設計どおりの動作）。
しかし、3seed・4スペンド水準・12四半期の全組み合わせで、BALのVAP成約量（新規契約数量）
は完全に不変（全ケースで累計10,817トン、1グラムも動かない）だった。** 原因を実測で
追跡した結果、真の制約は「VAP市場需要」でも「BAL自身のVAP生産能力」でもなく、
**BALの市場別営業工数換算能力（sales force effort capacity）が全商品（HOSO/PD/VAP合算）の
販売計画をスケールダウンさせている**ことだった（`sales/marketEffort.ts`の
`applyMarketSalesEffortCapacity`、理由コード`SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY`が
発生する経路。詳細は5節）。VAP商品開発スコアが競争力ウェイトへどれだけ効いても、
そもそも「販売提案として出せる数量」自体が営業人員のボトルネックで頭打ちになっている
ため、より高い競争力スコアを持つ余地が実質的に使われないまま終わっている。

**現行の共有デフォルトパラメータでは、営業人員（salesForceHeadcount）を同時に増強しない
限り、VAP商品開発投資は増分の成約・売上を一切生まず、追加spend分だけ純利益を悪化させる
（下表）。**

| spend/四半期 | 最終VAP開発スコア | 最終vapCapabilityScore | 累計VAP成約量 | 累計VAP出荷数量 | 累計純利益（3seed平均） |
|---|---|---|---|---|---|
| $0 | 50.0 | 57.5 | 10,817トン | 9,304トン | $-84,570,544 |
| $100,000 | 58.1 | 60.7 | 10,817トン | 9,287トン | $-86,633,733 |
| $250,000 | 68.1 | 64.7 | 10,817トン | 9,251トン | $-89,680,709 |
| $500,000 | 80.0 | 69.5 | 10,817トン | 9,251トン | $-95,709,249 |

（3seed平均。3seedとも成約量・出荷数量はほぼ同一に近く、ばらつきは軽微。累計純利益は
spendが高いほど単調に悪化＝投資額そのものが純粋なコストとして積み上がっているだけ。）

---

## 2. メカニズム（コード読解で確認）

`companyLab/productDevelopmentState.ts`の`updateProductDevelopmentState`が、
ヘッドルーム付きの式でVAP商品開発スコアを更新する:

```
spend > 0: score += gainCoefficient(4.0) × min(spend/standardBudgetUsd(250,000), investmentRatioCap(2.0)) × headroom(=1-score/100)
spend = 0: score = neutral(50) + (score - neutral) × (1 - idleDecayRatioPerQuarter(0.06))
```

このスコアは`companyLab/premiumPolicy.ts`の`calculateCompanyCapabilityCoefficient`
（重み: productDevelopment=0.4・salesBase=0.3・quality=0.2・deliveryReliability=0.1）を
経由し、「VAP能力合成係数（vapCapabilityScore）」として`sales/allocation.ts`の
`vapCapability`競争力ウェイトへ渡る。この経路自体は実装どおり正しく機能している
（3節・4節で確認）。**したがって本Phaseで確認された「成約量が動かない」という結果は、
このメカニズム自体のバグではなく、別の制約（5節）がより手前で効いているためである。**

---

## 3. スコアの上昇パターン（headroom＝逓減効果の確認）

3seed共通（初期状態・市場条件が同一のため、四半期ごとのスコア軌跡は3seedでほぼ一致）。
以下はseed=`test15-vapdev-seed-1`、spend=$500,000/四半期の場合の実測値:

| 四半期 | スコア | 増分 |
|---|---|---|
| 1 | 50.00 | — |
| 2 | 54.00 | +4.00 |
| 3 | 57.68 | +3.68 |
| 4 | 61.07 | +3.39 |
| 5 | 64.18 | +3.11 |
| 6 | 67.05 | +2.87 |
| 7 | 69.68 | +2.64 |
| 8 | 72.11 | +2.43 |
| 9 | 74.34 | +2.23 |
| 10 | 76.39 | +2.05 |
| 11 | 78.28 | +1.89 |
| 12 | 80.02 | +1.74 |

**headroom式どおり、増分は四半期を追うごとに単調に縮小している（+4.00→+1.74）。**
これは「スコアが100に近いほど、同じ投資額での増分が縮む」という設計意図（`headroom = 1 - score/100`）
が実際に機能していることを、実測で確認したものである（回帰テストVDC-2で機械的にも確認済み）。
100段階のうち80まで到達しても頭打ちにはなっていない（investmentRatioCap=2.0×gainCoefficient=4.0
の理論上限である「四半期あたり最大+8.0×headroom」に対し、実測+1.74@score=80は理論値
(8.0×(1-80/100)=1.6)に近い水準で、式どおりの挙動）。

spend=$0の対照ケースでは、スコアは中立値50から一切動かない（回帰テストVDC-1で確認）。

---

## 4. VAP能力合成係数（vapCapabilityScore）への反映確認

seed=`test15-vapdev-seed-1`、12四半期時点でのvapCapabilityScore:

| spend/四半期 | 最終VAP開発スコア | 最終vapCapabilityScore |
|---|---|---|
| $0 | 50.0 | 57.48 |
| $100,000 | 58.1 | 60.74 |
| $250,000 | 68.1 | 64.72 |
| $500,000 | 80.0 | 69.49 |

VAP開発スコアが上昇するにつれ、vapCapabilityScoreも一貫して上昇している（重み0.4を
反映した水準）。**この合成経路自体は正しく機能している。** 問題はこの先、実際の
成約量へどうつながるか（5節）。

---

## 5. 【最重要】ボトルネック分析: なぜ成約量が動かないのか

### 5-1 実測結果

3seed・4スペンド水準の全12組み合わせで、BALのVAP新規成約量（`newContracts`のvap商品ぶん
合計）は**累計10,817トンで完全に一致**した（1トンの差もない）。個別四半期でも、
成約量は901.41トン/四半期でほぼ固定されており、スコア・vapCapabilityScoreが上昇しても
一切反応しない（CSVの生データで確認可能）。

### 5-2 原因の特定

`salesRecord.salesEffortAdjustments`（市場別営業工数換算能力による販売計画縮小の記録、
理由コード`SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY`、`sales/marketEffort.ts`の
`applyMarketSalesEffortCapacity`）を実測で確認したところ、**BALは3市場（CN/EU/US）すべてで
毎四半期、営業工数換算能力の不足により販売計画が縮小（scaleFactor 0.17〜0.25程度）されて
いた**（VAP開発投資額に関わらず、全spend水準で同一のscaleFactorが発生）。

```
例（spend=$500,000ケース、turn1〜3すべて同一）:
  市場CN: 営業人員9人・能力換算2,473.68トン、希望量14,590トン → scaleFactor=0.1695
  市場EU: 営業人員5人・能力換算1,800トン、希望量7,295トン → scaleFactor=0.2467
  市場US: 営業人員4人・能力換算1,571.43トン、希望量7,295トン → scaleFactor=0.2154
```

この縮小は**HOSO/PD/VAPを合算した市場別の販売計画全体**に対して発生する（商品別ではなく
市場単位の営業人員配分に基づく制約）。つまり、VAP単体の競争力（vapCapabilityScore）が
どれだけ上昇しても、そもそも「営業人員の能力換算枠」自体がBALの総販売計画（VAP込み）を
大きく縮小させているため、**VAP開発投資による競争力上昇分が使われる前に、営業人員不足
という、より手前のボトルネックで頭打ちになっている。**

### 5-3 結論

VAP商品開発投資が実際の成約量・売上へ反映されるためには、**営業人員（`salesForceHeadcount`）
を同時に増強する必要がある**。現行の共有デフォルトパラメータ・本診断のシナリオ構築
（営業人員は自動方針の既定値のまま、一切変更していない）のもとでは、VAP開発投資単独では
市場需要にもBAL自身の生産能力にも到達する前に、営業人員のボトルネックで頭打ちになる。

これはPhase6の6-3節で確認した失敗モード（「能力・ワーカーを増やしても、営業側を同時に
増強しなければ売上に反映されない」）と対をなす、もう一つの「単独では成立しない投資」の
実例である。

---

## 6. 財務への影響

VAP開発投資は成約量に一切反映されないため、投資額そのものが純粋なコスト（SG&Aとして
四半期ごとに全額費用計上、`finance/quarterClose.ts`の`vapProductDevelopmentSpendUsd`経由）
として純利益を押し下げる。3seed平均の累計純利益（12四半期）は、$0の$-84,570,544から
$500,000/四半期の$-95,709,249まで、spendが高いほど単調に悪化している（差額最大
約$1,113万、ほぼ投資累計額$600万の1.9倍相当。営業CF圧迫による追加の資金調達コスト等が
上乗せされているため単純な投資額以上の悪化になっている）。

**「baselineを上回った最初の四半期」は、3seedいずれの水準でも一度も発生しなかった
（`findFirstQuarterOutperformingBaseline`が全ケースでnullを返すことを回帰テストVDC-7で確認）。**

---

## 7. 7-3 必須分析: ボトルネックの明示

コーディネーターが明示的に要求した分析観点（「VAP市場需要または自社生産能力が、
開発スコアの高さに関わらず販売を制限しているケースを明示的に確認・報告する」）について:

- **VAP市場需要が制約になっているケースは確認されなかった**（市場全体の総需要データは
  本診断のスコープでは直接検証していないが、BAL自身の営業人員制約がより手前で効いている
  ため、市場需要側の余地の有無を検証する前の段階でボトルネックに達している）。
- **BAL自身のVAP生産能力が制約になっているケースも、少なくとも今回の12四半期では
  明確には確認されなかった**（vapProducedTonsは初期数四半期で成約量を上回る水準まで
  生産されており、後半で生産量が落ち込む場面もあったが、これはPhase5・Phase6と同じ
  共有原料プールの制約の影響である可能性が高く、VAP開発投資固有の限界ではない）。
- **実際に確認された制約は「営業人員（市場別営業工数換算能力）」であり、これはVAP開発
  スコアともVAP市場需要とも独立した、会社全体の販売計画全体（HOSO/PD/VAP合算）に効く
  制約だった。** これが本Phaseの最も重要な発見であり、5節で詳述したとおりである。

---

## 8. Test15開始前ブリーフィングへの追記事項

- VAP商品開発投資（vapProductDevelopmentSpendUsd）のスコア更新式・vapCapabilityScoreへの
  合成経路は設計どおり正しく機能している（バグは検出されなかった）。
- **しかし現行の共有デフォルトパラメータ・BALの初期営業人員配置のもとでは、VAP開発投資
  単独では一切の増分売上を生まない。** 営業人員（市場別の`salesForceHeadcount`）を同時に
  増強しない限り、より高いVAP開発スコアは「使われない競争力」のまま純粋なコストで終わる。
- プレイヤー向けの説明・チュートリアルでは、「VAP開発投資は営業人員の増強とセットで
  行わなければ、開発スコアが上がっても売上には反映されない」という点を明示することが
  望ましい（Phase6の新工場建設と同じ教訓「能力・ワーカー・原料・営業・現金は連動させる
  必要がある」の一部として、VAP開発投資にも当てはまることが本Phaseで確認された）。

---

## 9. 制約・今後の課題（時間的制約による判断）

- **営業人員を連動して増強した場合のシナリオは本Phaseでは未検証**。VAP開発投資と
  同時に営業人員（salesForceHeadcount）を増強した場合に、より高いVAP開発スコアが
  実際に成約量・売上へ反映されるかどうかは、今後の校正課題として残る。
- **VAP商品別の厳密な売上高・粗利益は、会計エンジンの現状の出力粒度（会社全体のP&Lのみ、
  商品別の売上原価内訳は無い）では直接抽出できなかった**。本報告のVAP売上関連指標は、
  新規契約の数量×単価（概算金額。厳密な当期認識収益ではない）・実際の出荷履行数量
  （`fulfillmentPlan.finishedGoodsConsumption`）・生産量（`vapProduced`）で代用しており、
  正確な「VAP粗利益」は算出していない（並行計算式を新たに作らないという制約を優先した
  結果の限界であり、報告数値としては明示的にラベル分けしている）。
- 市場全体のVAP総需要（他4社を含めた真の需要飽和点）は本Phaseのスコープでは未検証。
