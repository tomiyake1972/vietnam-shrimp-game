# Phase SAI-2 レポート — 標準初期条件の設計と基準テスト

対象: `feature/v2-sai2-standard-baseline`（`develop/v2`の`83324eb`起点。SAI-1/1.5マージ後）
実装コミット: 本レポートと同時にcommitする本ブランチのコミット（§8「commit・push」参照）
本Markdown自体は`docs/v2/reports/sai2_standard_baseline_report.md`としてgit管理下にあります。
再現コマンド・出力の得方は§7を参照してください。

---

## 1. 目的とスコープ

SAI-1では、既存5社（BAL/MASS/JPQ/VAP/CONSV）の条件差がstandard AIの経営結果を大きく左右することを確認しました（§9参照）。これらは統合テスト・GM確認用に意図的に作り込まれたアーキタイプ別フィクスチャであり（`fixtures.ts`冒頭コメント参照）、本番会社設定ではありません。

SAI-2では、既存5社のどれかをそのまま標準とするのではなく、**経営実験の出発点として使える中立的で一貫した共通初期条件（標準初期条件・standard baseline）を独立に設計**します。この標準初期条件を5社すべてに複製し、

- 同じ初期条件
- 同じstandard AI
- 同じ公開情報
- 同じseed
- 会社IDだけは維持

という条件でTest B相当の構造（`decomposeHarness.ts`）を使い、8Q・32Qを実行して、今後の一項目ずつの感度分析（SAI-3以降）で使う基準ケースを確立することが目的です。

**変更していないもの**: ゲームルール・standard AIの判断ロジック（`companyLab/standardAi/`配下）・既存5社の会社特性（`fixtures.ts`）。本フェーズの変更は、既存5社とは独立な「標準会社」を定義する追加モジュールと、それを比較・テストするための分析コードのみです。

## 2. 既存5社の初期条件比較表

既存5社のfixture（`companyLab/fixtures.ts`）・初期財務（`finance/initialState.ts`）・初期契約（`companyLab/initialContracts.ts`）を読み取った実際の値です。

### 2.1 生産・工場・人員

| 項目 | BAL | MASS | JPQ | VAP | CONSV |
|---|---|---|---|---|---|
| commonProcessingCapacity (t/Q) | 22,000 | 36,000 | 16,000 | 18,000 | 15,000 |
| HOSO能力 (t/Q) | 10,000 | 30,000 | 4,000 | 3,000 | 8,000 |
| PD能力 (t/Q) | 8,000 | 6,000 | 11,000 | 4,000 | 6,000 |
| VAP能力 (t/Q) | 6,000 | 2,000 | 3,000 | 12,000 | 4,000 |
| 3商品能力合計 (t/Q) | 24,000 | 38,000 | 18,000 | 19,000 | 18,000 |
| freezingPackagingCapacity (t/Q) | 20,000 | 34,000 | 15,000 | 17,000 | 14,000 |
| 常用ワーカー数 | 6,000 | 9,000 | 5,500 | 6,500 | 4,500 |
| ワーカー技能(HOSO/PD/VAP) | 0.85/0.80/0.75 | 0.90/0.60/0.50 | 0.60/0.95/0.70 | 0.50/0.65/0.95 | 0.80/0.75/0.70 |
| attendanceRate | 0.95 | 0.95 | 0.95 | 0.95 | 0.97 |
| 養殖能力 (t/Q) | 15,000 | 18,000 | 9,000 | 10,000 | 10,000 |
| 営業人員 | 18 | 22 | 14 | 14 | 10 |
| 調達人員 | 12 | 20 | 10 | 10 | 8 |
| 初期原料ロット (t / USD/kg) | 3,000 / 4.20 | 5,000 / 4.00 | 2,500 / 4.30 | 2,500 / 4.30 | 3,000 / 4.10 |

### 2.2 商品経済性（USD/HOSO換算kg）

| 項目 | BAL | MASS | JPQ | VAP | CONSV |
|---|---|---|---|---|---|
| 加工コスト HOSO/PD/VAP | 0.50/0.75/1.20 | 0.45/0.85/1.60 | 0.60/0.68/1.25 | 0.62/0.78/1.00 | 0.52/0.80/1.30 |
| PDプレミアム 目標/最低受注* | 0.52/0.25 | 0.57/0.30 | 0.51/0.23 | 0.53/0.26 | 0.56/0.28 |
| VAPプレミアム 目標/最低受注* | 1.18/0.59 | 1.58/0.94 | 1.28/0.66 | 0.99/0.47 | 1.33/0.70 |

*目標＝変動費+固定費配賦+販売物流費+目標マージンの合計、最低受注＝回避可能変動費+増分販売物流費+最低貢献利益の合計（`fixtures.ts`のコメントに記載された値をそのまま転記）。

### 2.3 財務

| 項目(USD) | BAL | MASS | JPQ | VAP | CONSV |
|---|---|---|---|---|---|
| 現金 | 30,000,000 | 30,000,000 | 25,000,000 | 22,000,000 | 35,000,000 |
| 初期売掛金 | 70,000,000 | 45,000,000 | 40,000,000 | 45,000,000 | 28,000,000 |
| その他流動資産 | 5,000,000 | 4,000,000 | 3,000,000 | 3,000,000 | 2,000,000 |
| 固定資産（取得原価） | 90,000,000 | 110,000,000 | 70,000,000 | 85,000,000 | 45,000,000 |
| 短期借入金 | 20,000,000 | 35,000,000 | 10,000,000 | 15,000,000 | 0 |
| 長期借入金 | 30,000,000 | 45,000,000 | 20,000,000 | 30,000,000 | 8,000,000 |
| その他負債 | 5,000,000 | 6,000,000 | 3,000,000 | 4,000,000 | 2,000,000 |
| 資本金 | 50,000,000 | 40,000,000 | 45,000,000 | 40,000,000 | 50,000,000 |
| 買掛金（開始時） | 0（共通） | 0 | 0 | 0 | 0 |
| 仕掛品 | 未実装（原料在庫→完成品在庫の間にWIP概念自体が存在しない。全社共通） | | | | |

初期借入は`financing/initialPortfolio.ts`により、短期＝満期一括返済4Q・長期＝元金均等返済20Q・信用区分Cの単一利率で自動的に融資ポートフォリオへ変換される（全社共通の変換ロジック、会社別の特別扱いなし）。

### 2.4 品質・信頼・operational risk・市場初期状態（全社共通、fixtureに依存しない）

| 項目 | 値 | 備考 |
|---|---|---|
| 品質スコア（全社×全商品） | 85 | `quality/parameters.ts` `baselineOperationalQuality` |
| 顧客信頼・納期信頼性（全社×全市場） | 50 | `neutralScore`。全社均一のため初期競争力差はここから生じない |
| turn1のoperational risk入力 | 稼働率neutral fallback 0.70 | `hadPriorQuarterUtilization=false`のため |
| turn1の在庫（原料以外） | 完成品在庫0・売掛金は初期契約のみ・買掛金0 | 全社共通の会計方針（ゲーム開始前取引履歴なし） |
| 養殖・輸入の初期状態 | 養殖中バッチ・輸送中輸入ロットともになし | 初期原料は全社ともdomestic status="available"のみ |

### 2.5 初期契約（成約済み・未履行分）

| 会社 | 契約合計数量(t) | 契約合計額(USD) | 市場構成 |
|---|---|---|---|
| BAL | 3,100 | 18,325,000 | CN/US(hoso), EU(pd), JP(vap) |
| MASS | 3,600 | 18,590,000 | CN/US/EU(hoso) |
| JPQ | 1,900 | 13,310,000 | JP/EU/US(pd) |
| VAP | 1,650 | 13,817,500 | JP/EU(vap), US(pd) |
| CONSV | 1,400 | 7,815,000 | CN(hoso), JP(pd), OTHER(hoso) |

## 3. 標準初期条件の候補設計（2〜3案）

単純な平均値の機械的な採用ではなく、各項目が相互に整合する「一つの会社」として成立しているかを重視しました。設計コードは`app/lib/v2/companyLab/standardAi/report/standardBaseline.ts`。

### 候補1: balanced-trimmed（BALの操業条件＋財務余力を調整）

BAL（バランス型）は、HOSO/PD/VAPの処理能力配分に極端な偏りがなく（10,000/8,000/6,000）、ワーカー技能も3商品でほぼ均等（0.85/0.80/0.75）であり、単独の会社として最も内部整合性が高い、既存5社中唯一SAI-1/1.5のいずれのテストでも32Qを通して支払不能に陥らなかった会社です。操業条件（工場能力・ワーカー・養殖能力・商品経済性）はBALをそのまま踏襲し、財務のみ現金を3,000万→2,000万USD、短期借入を2,000万→2,500万USDへ調整しました。

### 候補2: five-company-blend（既存5社の単純平均＋整合性確認）

既存5社の各項目（工場能力・ワーカー・養殖能力・商品経済性・財務6項目・初期契約）の単純平均を基礎とします。この方式には**5社すべてをこの値へ統一しても、業界全体の供給量・資金規模の合計が既存5社合計とほぼ変わらない**という利点があります（5×平均＝既存5社合計。実際、3商品能力合計の平均23,400t/Q×5社＝117,000t/Qは、既存5社合計117,000t/Qと完全に一致することを確認済み。初期契約合計数量も同様に2,330t×5＝11,650tで、既存5社合計11,650tと完全に一致することを確認済み）。これはSAI-1で校正済みの需要規模（シナリオの国内原料供給・trailing平均購入量とのバランス）を崩さずに標準会社を導入できることを意味します。採用前に、(a)工場能力配分が単一商品への極端な偏りを持たない（11,000/7,000/5,400）、(b)ワーカー技能が能力配分と整合する（0.73/0.75/0.72）、(c)財務が貸借一致する、ことを確認しました。

### 候補3: moderate-pressure（候補2の操業条件＋財務を厳格化）

候補2の操業条件をそのまま踏襲し、財務のみをやや厳しくします。初期現金2,840万→1,800万USD、短期借入1,600万→2,600万USD、長期借入2,660万→3,500万USDへ変更（担保価値となる原料在庫・売掛金等は候補2から変えていません）。狙いは、standard AIの資金繰り・調達縮小判断が開始直後から実際に必要となる水準まで財務の緩みを減らすことです。

### 候補設計の内部整合性チェック（会社規模推定式による検証）

`standardAi/parameters.ts`の`estimateQuarterlyScaleUsd`／`estimateTargetMinimumCashUsd`（想定原料単価2.5USD/kg）で、各候補の「1四半期あたり典型支出」に対する初期現金の比率を確認しました。

| 候補 | 四半期支出規模(scale) | 目安最低現金バッファ(target) | 初期現金 | 現金/target比 |
|---|---|---|---|
| 候補1 balanced-trimmed | $51,720,000 | $31,032,000 | $20,000,000 | 0.64 |
| 候補2 five-company-blend | $50,931,000 | $30,558,600 | $28,400,000 | 0.93 |
| 候補3 moderate-pressure | $50,931,000 | $30,558,600 | $18,000,000 | 0.59 |

参考: 既存5社ではBAL 0.97・MASS 0.61・JPQ 1.04・VAP 0.85・CONSV 1.50。ただし本比率だけでは実際の帰結を予測できないことも確認済みです（例: CONSVはこの比率が既存5社中最高（1.50）にもかかわらずSAI-1.5では最も早く支払不能に陥っており、借入水準・担保価値・調達構成など他の要因との複合効果が支配的であることが示唆されます）。そのため選定は次節の実際のシミュレーション結果を基準にしました。

## 4. 候補別の8Q・32Q・12seed比較結果

`report/decompose.ts`の`runStandardBaselineTest`（Test B相当の構造）・`runStandardBaselineMultiSeed`で実行しました。

### 4.1 単一seedでの8Q・32Q結果（seed=`sai2-8q-001`/`sai2-32q-001`）

| 候補 | 8Q paymentDefault | 8Q 終了時現金(5社共通) | 32Q paymentDefault | 32Q 終了時現金(5社共通) |
|---|---|---|---|---|
| 候補1 balanced-trimmed | なし（5社健全） | 約$25.4-28.2M | なし（5社健全） | 約$51.7-55.6M |
| 候補2 five-company-blend | なし（5社健全） | 約$17.2-18.9M | なし（5社健全） | 約$53.9-57.6M |
| 候補3 moderate-pressure | なし（5社健全、このseedでは） | 約$15.2-17.9M | なし（5社健全、このseedでは） | 約$28.3-29.4M |

（注: 会社間の若干の差は、5社が同一初期条件であっても`quality/majorIncident.ts`が会社ID単位で独立した乱数ストリームを持つ設計に由来する既知の残差。SAI-1.5§9.3で原因確認済み。）

### 4.2 12seedでのpaymentDefault発生率（8Q・32Q、seed=`sai2-multiseed-001`〜`012`）

| 候補 | 8Q発生率(会社別) | 32Q発生率(会社別) |
|---|---|---|
| 候補1 balanced-trimmed | 0/12（全社） | 0/12（全社） |
| 候補2 five-company-blend | 0/12（全社） | 0/12（全社） |
| 候補3 moderate-pressure | BAL 1/12（8.3%）・MASS/JPQ/VAP/CONSV 各2/12（16.7%） | BAL/MASS/JPQ/CONSV 各5/12（41.7%）・VAP 6/12（50.0%） |

候補1・候補2は12seedすべて・8Q/32Qいずれでも一度もpaymentDefaultが発生しませんでした。候補3は8Qでは大半のseedで健全に推移しつつ一部seedで支払不能が発生し、32Qでは約4割のseedで支払不能に至るという、**seedによって結果が分かれる**分布になりました。

32Q時点のBAL現金分布（候補3、12seed）: 平均$26,855,265・標準偏差$3,221,676・最小$22,796,746・最大$32,768,961。paymentDefaultが発生したケースでも最終的に現金がマイナスへ発散するのではなく、正の水準へ回復していることを確認しました（後述§4.3）。

会社間の発生率の差（VAP 6/12 vs 他社5/12）は1seed分のみで、SAI-1.5で確認済みの品質事故システムの会社ID単位の独立乱数に起因する既知の残差の範囲内であり、理由を説明できない大きな格差ではないと判断しました。

### 4.3 standard AIが受けた圧力・下した判断（候補3、seed=`sai2-multiseed-001`、8Q、BAL代表）

候補3で実際にpaymentDefaultが発生したケース（turn7に発生）の診断ログを確認しました。

| turn | cashPressure | borrowingPressure | 主な発火reason code |
|---|---|---|---|
| 1 | 0.41 | 0.80 | CONTRACT_FULFILLMENT_PRIORITY, RAW_MATERIAL_SHORTAGE, CASH_BUFFER_SHORTAGE |
| 2 | 0.00 | 0.70 | CAPACITY_CONSTRAINT, RAW_MATERIAL_SHORTAGE, HEADCOUNT_REDUCED_FOR_SUSTAINED_EXCESS |
| 3 | 0.66 | 0.75 | RAW_MATERIAL_SHORTAGE, HEADCOUNT_REDUCED_FOR_SUSTAINED_EXCESS, CASH_BUFFER_SHORTAGE |
| 4 | 0.77 | 0.77 | CAPACITY_CONSTRAINT, PROCUREMENT_CASH_CONSTRAINED, CASH_BUFFER_SHORTAGE |
| 5 | 0.37 | 0.77 | CAPACITY_CONSTRAINT, RAW_MATERIAL_SHORTAGE, CASH_BUFFER_SHORTAGE |
| 6 | **1.00** | 0.59 | PROCUREMENT_CASH_CONSTRAINED, RAW_MATERIAL_SHORTAGE, CASH_BUFFER_SHORTAGE |
| 7 | 0.43 | 0.59 | CAPACITY_CONSTRAINT, RAW_MATERIAL_SHORTAGE, CASH_BUFFER_SHORTAGE（この四半期にpaymentDefault発生） |
| 8 | **1.00** | 0.51 | PROCUREMENT_CASH_CONSTRAINED, RAW_MATERIAL_SHORTAGE, CASH_BUFFER_SHORTAGE |

原料在庫不足（RAW_MATERIAL_SHORTAGE）・現金バッファ不足（CASH_BUFFER_SHORTAGE）がほぼ全turnで発火し、cashPressureが最大値1.0に達する四半期が2回、finishedGoodsExcessRatioも turn4/6にPD・VAPで一時的に0.68・0.46まで上昇するなど、**在庫・資金・能力の複数の圧力が同時並行で発生し、standard AIの調達縮小（PROCUREMENT_CASH_CONSTRAINED）・人員調整（HEADCOUNT_REDUCED_FOR_SUSTAINED_EXCESS）が実際に機能する必要がある**状況が再現されました。CAPEX判断は全turnで`CAPEX_DEFERRED`（見送り）が正常な既定結果として続いています。

## 5. 選定結果

### 5.1 採用した標準初期条件

**候補3「moderate-pressure」を採用しました。** 選定理由は以下のとおりです（§選定基準ごとに整理）。

- **開始直後に構造的な支払不能へ陥らない**: 8Qでは大半のseed（12中10-11）で健全に推移する。
- **放置しても必ず成功するほど安全すぎない**: 候補1・候補2は12seedすべて・8Q/32Qのいずれでも一度もpaymentDefaultが発生せず、この基準を満たさなかった。候補3は32Qで約4割のseedが支払不能に至り、standard AIの判断が結果を左右する状況になっている。
- **standard AIの調達・販売・生産・財務判断が実際に必要**: §4.3で確認したとおり、原料在庫・現金バッファ・完成品在庫超過の複数の圧力が同時に発生し、調達縮小・人員調整・値引き判断が実際に機能している。
- **8Qでは経営の因果関係を観察できる**: §4.3の診断ログのとおり、8Q以内でも圧力の推移・reason codeの発火・paymentDefaultへ至る経路を観察できる。
- **32Qでも極端な発散や全社一律破綻だけにならない**: paymentDefaultが発生したケースでも現金は正の水準（平均$26.9M）へ回復しており、既存5社のTest A（MASS -$198M、VAP -$61M等）のような深い負の発散は見られない。
- **現金・能力・在庫・需要の各圧力が一定程度発生する**: §4.3のとおり、資金・原料・在庫・能力の圧力がいずれも観測された。
- **今後、一項目だけを変える感度分析の基準として使いやすい**: 候補2（blend）の操業条件をそのまま踏襲しているため、既存5社合計の供給規模と整合する土台の上に、財務条件だけを変えた案として位置づけられる。SAI-3以降で財務条件を基準（候補2）へ戻す、あるいは操業条件側を1項目ずつ動かす、といった対照実験がしやすい。
- **数値設定の理由を人間が理解・説明できる**: §3のとおり、操業条件は既存5社平均、財務条件は候補2からの明示的な調整幅として説明可能。

全seed・全会社で完全に同じ結果になることは求めておらず、§4.2・§4.3で確認したとおり、結果の違いは品質事故・原料調達・現金繰りの圧力といった、standard AI・ゲームルールの通常の挙動で説明できるものです。

### 5.2 不採用とした候補の問題点

- **候補1 balanced-trimmed**: BALの操業条件が優秀すぎるため、財務を切り詰めても12seed中一度もpaymentDefaultが発生しなかった。「standard AIの判断が実際に必要」「放置しても必ず成功するほど安全すぎない」という基準を満たさない。
- **候補2 five-company-blend**: 既存5社合計の供給規模と厳密に整合する（§3参照）という利点はあるが、財務条件も含めた平均値では、候補1と同様に12seed中一度もpaymentDefaultが発生しなかった。今後の財務系パラメータの感度分析における「基準」としては有用だが、今回選定する「経営実験の出発点」としての基準ケースには圧力が不足している。

候補がすべて不適切だった場合の対応方針（実装指示§6）に従い、まず候補2の操業条件をそのまま踏襲しつつ財務条件のみを調整する候補3を追加設計し、これが選定基準を満たすことを確認したため、ゲームルールまたはstandard AI本体側の変更は不要と判断しました。

## 6. 選定した標準初期条件の全設定値

`app/lib/v2/companyLab/standardAi/report/standardBaseline.ts`の`CANDIDATE_3`（`id: "moderate-pressure"`）参照。

### 6.1 操業条件（候補2 five-company-blendを踏襲）

| 項目 | 値 |
|---|---|
| commonProcessingCapacity | 21,400 t/Q |
| HOSO/PD/VAP能力 | 11,000 / 7,000 / 5,400 t/Q |
| freezingPackagingCapacity | 20,000 t/Q |
| 常用ワーカー数 | 6,300 |
| ワーカー技能(HOSO/PD/VAP) | 0.73 / 0.75 / 0.72 |
| attendanceRate | 0.95 |
| 養殖能力 | 12,400 t/Q |
| 営業人員 | 16 |
| 調達人員 | 12 |
| 初期原料ロット | 3,200 t @ $4.18/kg |
| 加工コスト HOSO/PD/VAP | 0.538 / 0.772 / 1.27 USD/kg |
| PDプレミアム(変動/固定/販売/目標/増分/最低貢献) | 0.178/0.154/0.052/0.154/0.03/0.056 |
| VAPプレミアム(同上) | 0.506/0.364/0.1/0.302/0.058/0.108 |

### 6.2 財務条件（候補2から調整）

| 項目(USD) | 値 |
|---|---|
| 現金 | 18,000,000 |
| 初期売掛金 | 45,600,000 |
| その他流動資産 | 3,400,000 |
| 固定資産（取得原価） | 80,000,000 |
| 短期借入金 | 26,000,000 |
| 長期借入金 | 35,000,000 |
| その他負債 | 4,000,000 |
| 資本金 | 45,000,000 |

### 6.3 初期契約（候補2と同一）

| 市場 | 商品 | 数量(t) | 単価(USD/kg) | 納期目安 |
|---|---|---|---|---|
| CN | hoso | 550 | 5.20 | 2015Q2 |
| US | hoso | 550 | 5.30 | 2015Q2 |
| EU | pd | 400 | 6.90 | 2015Q3 |
| JP | pd | 300 | 7.00 | 2015Q3 |
| JP | vap | 300 | 8.90 | 2015Q3 |
| EU | vap | 230 | 8.85 | 2015Q3 |

## 7. コード・テスト・再現方法

### 7.1 再利用可能なコード

- `app/lib/v2/companyLab/standardAi/report/standardBaseline.ts`: 3候補の定義（`STANDARD_BASELINE_CANDIDATES`）、選定結果（`SELECTED_STANDARD_BASELINE_CANDIDATE_ID`）、選定済み標準初期条件を返す再利用可能なbuilder（`buildStandardBaselineFixture`・`standardBaselineFinanceFixtureTemplate`・`standardBaselineContractDefs`）。既存5社のfixture構築ヘルパー（`companyLab/fixtures.ts`の`factory`/`workerBaseline`/`premiumEconomics`/`productEconomics`/`initialLot`、export化のみで数値は変更なし）を再利用している。
- `app/lib/v2/companyLab/standardAi/report/decomposeHarness.ts`: 既存Test B用ハーネス（`initializeUnifiedCompanyLab`等、companyIdで既存5社を引く版）に加えて、既存5社に紐づかない任意のfixtureテンプレートを扱える汎用版（`buildUnifiedFixturesFromTemplate`・`initializeUnifiedCompanyLabFromTemplate`）を追加。既存Test Bの挙動は一切変更していない。
- `app/lib/v2/companyLab/standardAi/report/decompose.ts`: `runStandardBaselineTest`（Test B相当の単一seed実行）・`runStandardBaselineMultiSeed`（複数seed分布集計、既存`runMultiSeed`と同じ集計ロジックを再利用）。

### 7.2 自動テスト

`app/lib/v2/companyLab/standardAi/report/__tests__/standardBaseline.test.ts`（新規7件）:
- 選定済み候補IDの実在確認
- 5社複製後の内部整合性（会社ID/工場IDのみ異なり、その他全項目が完全一致）
- 全候補共通の複製整合性
- 選定済み候補のfinance/contracts参照の正しさ
- 決定論性（同一seedで完全一致）
- moderate pressureという設計意図の恒久的な保証（12seedで全社が必ずpaymentDefaultするわけではない）
- 候補間の財務厳しさの相対関係（候補3が候補1・候補2より厳しい）

### 7.3 再現方法

```
cd <リポジトリルート>
npx tsx --test app/lib/v2/companyLab/standardAi/report/__tests__/standardBaseline.test.ts
```

候補別の8Q/32Q/12seed比較結果（§4）を再現する場合は、`runStandardBaselineTest`・`runStandardBaselineMultiSeed`を`STANDARD_BASELINE_CANDIDATES`の各候補に対して呼び出せばよい（本レポート作成時に使用したseed: 単一seed実行=`sai2-8q-001`/`sai2-32q-001`、12seed集計=`sai2-multiseed-001`〜`012`）。生成物のJSON/CSV/HTMLは本フェーズでは作成していない（SAI-1.5のレポート生成基盤`scripts/generateSai1Report.ts`は既存5社専用のため、SAI-2の標準初期条件比較を機械可読ファイルへ出力する統合は今後のSAI-3以降の課題とする）。

## 8. 検証・commit・push

- SAI-2関連テスト（`standardBaseline.test.ts`新規7件）: 全件成功。
- 既存の`report.test.ts`（10件）を含む全テスト・`npx tsc --noEmit`・`npm run lint`・`npx next build`: §開発日誌参照。
- `feature/v2-sai2-standard-baseline`ブランチへcommit・push済み。**develop/v2へはまだマージしていません**（実装指示どおり）。

## 9. 今後の課題・SAI-3以降への申し送り

1. SAI-3以降の一項目ずつの感度分析（現金、能力、固定費、在庫、市場方針など）は、本レポートで確立した標準初期条件（moderate-pressure）を基準ケースとして、`standardBaseline.ts`の該当フィールドだけを差し替える形で実施できる。
2. 候補2（five-company-blend）は、既存5社合計の供給規模と厳密に整合する（§3）という性質を持つため、「操業条件を変えたときの純粋な感度」を見たい場合の別基準としても保持しておく価値がある（`STANDARD_BASELINE_CANDIDATES`に残置済み）。
3. SAI-1.5で確認済みの品質事故システム（会社ID単位の独立乱数）に起因する会社間の残差は、標準初期条件でも同様に観測される（§4.2のVAP 6/12 vs 他社5/12）。感度分析の際は、この既知の残差を「説明できない格差」と誤認しないよう注意する。
4. SAI-1.5のレポート生成基盤（JSON/CSV/HTML出力）をSAI-2の標準初期条件比較にも接続するかどうかは、三宅さんのご判断を仰いだうえで、必要であればSAI-3以降で対応する。
