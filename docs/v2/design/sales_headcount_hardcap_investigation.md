# 営業人員ハードキャップ調査報告（Part B・読み取り専用調査）

三宅さんovernight指示（Part B）に基づく、営業人員(headcount)→販売成果の
経路の全体調査。本ドキュメント・本ブランチ`feature/v2-sales-effect-diminishing-returns`
（`origin/develop/v2` HEAD `90d67bc`から新規作成）には、**調査結果のみを記録し、
本番コードへの変更は一切含まない**（Part Bは読み取り専用調査であり、Part C
[実装]は「B-1で真のハードキャップが見つかった場合のみ」実施する契約になっている）。

## B-1. 全経路のコード調査・10種類のリミッター分類

### 調査対象ファイル

- `app/lib/v2/sales/salesForce.ts`（営業人員→カバレッジ・処理能力）
- `app/lib/v2/sales/marketEffort.ts`（市場別営業配置・商品別営業工数）
- `app/lib/v2/sales/allocation.ts`（成約配分・水位法）
- `app/lib/v2/sales/parameters.ts`（全パラメータ）
- `app/lib/v2/sales/types.ts`
- `app/lib/v2/companyLab/salesForceHiring.ts`（採用・減員の状態管理）
- `app/lib/v2/companyLab/autoPolicy.ts`（旧auto-policy、営業人員決定部分）
- `app/lib/v2/companyLab/standardAi/decision/sales.ts`（Standard AIの販売計画決定）
- `app/lib/v2/companyLab/standardAi/policy.ts`ほかstandardAi配下
- `app/lib/v2/companyLab/fixtures.ts`（5社の初期営業人員）
- `app/v2/company-lab/components/DecisionEditor.tsx`（人間プレイヤー向けUI）
- `app/v2/company-lab/decisionDraft.ts`（UI→意思決定への変換・sanitize）
- `app/lib/v2/companyLab/types.ts`・`persistence/schema.ts`（スキーマ）

### 中核の計算式（`sales/salesForce.ts`）

```
salesCoverageScore(headcount) = baseline + (1 - baseline) * headcount / (headcount + coverageSaturationHeadcount)
processingCapacity(headcount) = baselineCapacityTons + capacityMaxIncrementTons * headcount / (headcount + capacitySaturationHeadcount)
```

現行パラメータ（`SALES_PARAMETERS_V1`）:
- `baselineCoverageAtZeroHeadcount = 0.15`
- `coverageSaturationHeadcount = 6`
- `baselineCapacityTons = 200`
- `capacityMaxIncrementTons = 4800`
- `capacitySaturationHeadcount = 10`

これはMichaelis-Menten型飽和曲線（`x/(x+k)`）であり、**headcountがどれだけ
大きくなっても数式上は真の上限に到達しない（漸近するのみ）**。B-2で数値的に
確認したとおり、単調増加・逓減する限界効果・不連続な打ち切りなしという、
今回の三宅さんの business direction（「diminishing returnsは維持しつつ、
完全に頭打ちになるhard capは撤去する」）を**既に満たしている**。

### 10種類のリミッター分類結果

| # | 分類 | 発見箇所 | 内容 | 完全停止か逓減か | 撤去対象か |
| --- | --- | --- | --- | --- | --- |
| 1 | ハードキャップ（効果→0） | **発見なし** | `sales/`配下・`companyLab/standardAi/decision/sales.ts`・`autoPolicy.ts`のいずれにも、headcountが閾値を超えると販売効果が完全にゼロ・完全に頭打ちになるコードは見つからなかった。 | — | — |
| 2 | min/max/clamp | `allocation.ts:72`（`clampedPriceScore`）、`allocation.ts:259`（`cap = Math.min(desiredQuantity, capacity, shareCap, approvedCap)`） | 価格競争力スコアの上下限クランプ、成約量の複数上限のうち最小値を採用。 | 逓減（クランプ後も他の要因は機能） | **不要**（価格スコアのクランプは「値下げすればするほど際限なく有利になる抜け道」を防ぐ設計上の安全装置。成約capは複数の自然な制約[希望量・処理能力・市場シェア上限・承認済み枠]のうちの最小値であり、headcount単独のハードキャップではない） |
| 3 | headcount入力自体の上限 | `salesForceHiring.ts`（採用数）、`DecisionEditor.tsx:531`（UI入力） | **発見なし**。`sanitizeNonNegativeCount`は0以上への丸めのみ（下限のみ、上限なし）。UI側`onChange`も`Math.round(Math.max(0, n))`で下限のみ。スキーマ（`persistence/schema.ts`・`companyLab/types.ts`）にも`salesForceHireCount`の上限バリデーションは存在しない。 | — | — |
| 4 | 市場別配分の上限 | `sales/salesForce.ts`の`validateSalesForceHeadcountBudget`、`marketEffort.ts`の`applyMarketSalesEffortCapacity` | 「実在する営業人員総数」を超えて市場に配分できないという予算制約（同一市場内の複数商品は人員を共有）。 | — | **不要**（これは「存在しない人員を配分できない」という自明な予算制約であり、販売効果の上限そのものではない） |
| 5 | 正当な逓減リターン | `salesCoverageScore`・`processingCapacity`自体 | Michaelis-Menten型飽和曲線。 | 逓減（維持） | **維持**（三宅さんの指示が明示的に「keep diminishing marginal returns」と要求している） |
| 6 | 自然な市場需要限界 | `allocation.ts`の`targetDemand`（水位法の予算総額）、`shareCap = targetDemand * maximumSupplierShare` | 市場全体の需要規模、および1社が独占できる上限比率。 | 自然な限界（headcountとは独立） | **維持**（headcount起因のキャップではなく、市場規模由来の自然な制約） |
| 7 | 自然な顧客・成約数限界 | 未発見 | 本モデルには「商談数・案件数」という離散カウントの概念は無く、`allocatedQuantity`（数量ベース）で成約が表現されている。 | — | 該当なし（設計としてカウントベースの案件モデルを採用していない） |
| 8 | Standard AI専用の探索・打ち切り | `companyLab/standardAi/decision/sales.ts`・`autoPolicy.ts` | **重要な発見**: `salesForceHireCount`／`salesForceLayoffCount`を検索したところ、**`companyLab/standardAi/*`配下のどのファイルにも一切出現しない**。また旧`autoPolicy.ts`は`salesForceHireCount: 0`・`salesForceLayoffCount: 0`を常に固定で返している（643〜646行目）。**つまりStandard AI・旧auto-policyのいずれも、8四半期を通じて一度も営業人員の採用意思決定を行わない**（初期fixtureの人数のまま固定され続ける）。 | 完全停止（AIの意思決定として） | **これはコード上の数式ハードキャップではないが、実質的に「AI主導プレイでは営業人員が初期値から一度も増えない」という、業務的には最も強い意味でのハードキャップとして機能している**。三宅さんが疑っていた「一定人数を超えると販売効果が伸びなくなる」という現象の実態は、数式の打ち切りではなく、**AIがそもそも増員という選択肢を検討していないこと**である可能性が高い。 |
| 9 | UI専用の上限 | `DecisionEditor.tsx` | 発見なし（上記#3のとおり）。 | — | — |
| 10 | 安全装置（性能・異常値対策） | `salesForceHiring.ts`の`sanitizeNonNegativeCount`（NaN/Infinity/負の値→0）、`waterFillAllocate`の`safetyLimit = participants.length + 5`（無限ループ防止） | 入力の異常値サニタイズ、配分アルゴリズムの安全弁。 | — | **維持**（headcountの効果そのものを制限するものではなく、防御的プログラミング）。 |

### B-1の結論

**販売効果の計算式自体（`salesCoverageScore`・`processingCapacity`）には、
三宅さんが懸念していた「一定閾値を超えると完全に頭打ちになるハードキャップ」
は存在しない。** 既にMichaelis-Menten型の滑らかな逓減曲線であり、
monotonic・no discontinuity・diminishing marginal returnsという要件を
数式として満たしている（B-2で数値的に確認）。

一方、**Standard AI（および旧auto-policy）が営業人員の採用意思決定を
一切行わない**という、数式とは別種の構造的な制約を新たに発見した。
これは「販売効果計算のハードキャップ」ではなく「AIの意思決定ロジックの
欠落」であり、三宅さんの指示Part Cが前提とする「B-1で真のハードキャップが
見つかった場合のみ実装へ進む」の対象には**厳密には該当しない**
（撤去すべき数式上のハードキャップという意味では見つからなかった）。

**したがってPart C（新しい販売効果曲線の設計・実装）は、本ラウンドでは
実施しない。** 理由: Part Cは「B-1で見つかった真のハードキャップの撤去」を
前提としており、B-1はその意味でのハードキャップを発見できなかったため。
現行のMichaelis-Menten曲線をpower-law・log等の別形式に置き換える必要性は
コード調査からは確認できなかった（既存の設計が要件を満たしている）。

ただし、**「AIが営業人員を増やすという選択肢を一度も検討しない」という
発見は、三宅さんが体感している『営業人員を増やしても効果が伸びない』という
問題の実質的な原因である可能性が高い**（数式は伸びるがAIがそもそも
人数を変えないため、プレイヤーが実際に目にする挙動としては「伸びない」
ように見える）。これは今回のPart C（数式の再設計）の対象ではなく、
**Standard AIの営業人員採用ロジックの新規実装**という別種の課題であるため、
次回作業として三宅さんへ選択肢を提示する（下記「次回への申し送り」参照）。

## B-2. 数値再現（`scripts/b2SalesHeadcountReproduction.ts`）

代表値: headcount = 0 / 1 / 5 / 18(現行初期値相当) / 27(1.5x) / 36(2x) /
54(3x) / 50 / 100 / 1000 / 10000 / 1,000,000 で`salesCoverageScore`・
`processingCapacity`を実測。

| headcount | coverageScore | Δcoverage | processingCapacity(t) | Δcapacity(t) |
| --- | --- | --- | --- | --- |
| 0 | 0.150000 | - | 200.0 | - |
| 1 | 0.271429 | 0.121429 | 636.4 | 436.4 |
| 5 | 0.536364 | 0.264935 | 1800.0 | 1163.6 |
| 18（現行初期値相当） | 0.787500 | 0.251136 | 3285.7 | 1485.7 |
| 27（1.5x） | 0.845455 | 0.057955 | 3702.7 | 417.0 |
| 36（2x） | 0.878571 | 0.033117 | 3956.5 | 253.8 |
| 54（3x） | 0.915000 | 0.036429 | 4250.0 | 293.5 |
| 100 | 0.951887 | 0.042958 | 4563.6 | 363.6 |
| 1000 | 0.994930 | 0.043044 | 4952.5 | 388.8 |
| 10000 | 0.999490 | 0.004560 | 4995.2 | 42.7 |
| 1,000,000 | 0.999995 | 0.000505 | 4999.9 | 4.8 |

限界効果（headcount→headcount+1の差分）:

| 区間 | Δcoverage | Δcapacity(t) |
| --- | --- | --- |
| 0→1 | 0.12142857 | 436.36 |
| 17→18 | 0.00923913 | 63.49 |
| 18→19 | 0.00850000 | 59.12 |
| 36→37 | 0.00282392 | 22.20 |
| 54→55 | 0.00139344 | 11.54 |
| 99→100 | 0.00045822 | 4.01 |
| 999→1000 | 0.00000504 | 0.05 |
| 9999→10000 | 0.00000005 | 0.00（丸め精度以下） |

**観測事実**:
1. **不連続な打ち切りは一度も発生しない**——headcountを1→1,000,000まで
   段階的に増やしても、coverageScore・processingCapacityは常に単調増加
   （厳密に真に増加し続ける。負の値・NaN・Infinityは一度も出現しない）。
2. **限界効果は滑らかに逓減する**——1人目の増員（0→1）ではcoverage
   +0.121、capacity+436t という大きな効果があるが、現行初期値近傍
   （17→18）では+0.009／+63t、2倍・3倍（36→37、54→55）ではさらに
   小さくなる、という滑らかな逓減が確認できる。
3. **headcount=9999→10000のcapacity増分は表示上0.00になる**——これは
   `processingCapacity`が`roundHosoEqTons`で整数トンに丸めているためで
   あり、コード上の打ち切りではなく丸め精度の限界（この規模のheadcountは
   本モデルの現実的な運用レンジを大幅に超えており、実務上問題にならない）。
4. **`processingCapacity`の理論上限は`baselineCapacityTons +
   capacityMaxIncrementTons = 200 + 4800 = 5000t`** に漸近するが、
   1,000,000人でも4999.9tにとどまり厳密には5000tへ到達しない
   （数式として真のasymptoteであることの確認）。

**「営業効果計算式自体の天井」と「最終的な販売結果の自然な天井」の分離**:
上記のとおり販売効果計算式（coverage・capacity）自体には人為的な打ち切りは
ないが、実際の成約量は`allocation.ts`の`cap = min(desiredQuantity, capacity,
shareCap, approvedCap)`で複数の制約の最小値を取るため、**headcountを
極端に増やしても、市場需要（`targetDemand`由来の`shareCap`）や販売希望量
（`desiredQuantity`）が先に効いてしまえば、それ以上headcountを増やしても
最終的な成約量は増えない**——ただしこれは自然な市場制約（分類#6）であり、
販売効果計算式そのものの人為的なハードキャップとは別物である。

## 次回への申し送り（本ラウンドでは未着手）

1. **Standard AIの営業人員採用ロジックの新規実装**（本調査の最大の発見）:
   `companyLab/standardAi/decision/sales.ts`または`autoPolicy.ts`に、
   営業人員の採用・減員を実際に意思決定するロジックを追加するかどうかは
   三宅さんの判断事項。追加する場合の設計観点（増収見込み・人件費・
   市場余力・生産能力余力・原材料余力・運転資金余力等）は元の指示のC-4に
   列挙されている内容がそのまま使える。**これはPart C（曲線の再設計）とは
   別の実装であり、新しいissueとして切り出すことを推奨する。**
2. **「営業人員を増やしても効果が伸びない」という体感の真因の切り分け**:
   AIプレイでは上記1の理由でそもそも増員が起きないため、体感自体は
   曲線の形とは無関係である可能性が高い。人間プレイヤーが手動でUIから
   増員した場合の挙動（B-2で確認したとおり、曲線自体は滑らかに伸びる）
   と、AI主導プレイの挙動を三宅さんへ切り分けて説明する必要がある。
3. **本調査ではB-1のコード調査を`sales/`・`companyLab/standardAi/`・
   `companyLab/autoPolicy.ts`・UI層に絞った**。生産能力・原材料・
   運転資金といった「販売以外の自然な制約」がheadcount増加時に
   どのタイミングで先に効き始めるかの定量比較（B-2最後の段落で定性的に
   言及したのみ）は、次回、生産・原材料・運転資金モジュールとの
   結合トレースとして実施する必要がある。
