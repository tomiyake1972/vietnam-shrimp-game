# market-aware sales allocation 5社×8Q ベンチマーク

実施日: 2026-08-08
before: `origin/feature/v2-test15-integration`
after: `feature/v2-standard-ai-market-aware-sales`
scenario `baseline` / mode `canonical` / seed `market-aware-sales-benchmark-20260808` / 8 turns
実行: `npx tsx scripts/marketAwareSalesBenchmark.ts <label>`
生データ: `artifacts/market-aware-sales-benchmark.json` / `.csv`

ゲーム環境・初期営業人数・30%上限ルールは一切変更していない。before/afterの差は
**Standard AIの営業配置ロジックと採用ガバナーの置換のみ**である。

---

## 1. 要約表（指示20）

| Company | JP share before(T2-T8平均) | JP share after | Avg hires B→A | Ramp-limit hit | Contracts B→A | SG&A B→A ($M) | OpProfit B→A ($M) | End FG B→A | End backlog B→A | Next bottleneck |
|---|---|---|---|---|---|---|---|---|---|---|
| BAL | 49.9% | **7.2%** | 5.6→6.8 | 5/8Q | 56,555→**67,118** | 15.6→16.8 | 12.4→**26.0** | 2,862→3,651 | 0→0 | WORKER |
| MASS | 50.0% | **6.5%** | 0→0 | 0/8Q | 55,505→56,198 | 14.1→14.2 | -37.0→**-36.6** | 0→0 | 7,249→7,195 | （SALESのまま） |
| JPQ | 49.9% | **7.1%** | 3.5→3.6 | 4/8Q | 45,961→**54,721** | 13.7→14.5 | 7.9→**20.0** | 1,723→3,297 | 0→0 | WORKER |
| VAP | 49.9% | **8.1%** | 3.5→3.6 | 4/8Q | 27,632→**34,381** | 11.8→12.4 | -2.8→**+9.9** | 1,684→1,537 | 10→0 | WORKER |
| CONSV | 50.0% | **7.1%** | 3.8→5.1 | 6/8Q | 40,981→**45,290** | 12.6→13.1 | 3.5→**8.1** | 2,795→1,295 | 0→0 | WORKER |

---

## 2. 日本偏重 before / after（指示3・22-1）

Japan営業比率（%）。T2以降が本質。

| Co | T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 |
|---|---|---|---|---|---|---|---|---|
| BAL | 11.1→11.1 | **50.0→11.1** | 51.9→8.3 | 50.0→6.2 | 48.9→7.1 | 50.0→5.5 | 49.2→6.9 | 49.2→5.6 |
| MASS | 13.6→9.1 | **50.0→9.1** | 50.0→9.1 | 50.0→4.5 | 50.0→9.1 | 50.0→4.5 | 50.0→4.5 | 50.0→4.5 |
| JPQ | 14.3→14.3 | **50.0→14.3** | 47.6→5.3 | 50.0→8.0 | 51.4→6.1 | 50.0→4.7 | 50.0→7.0 | 50.0→4.7 |
| VAP | 14.3→14.3 | **50.0→21.4** | 47.6→5.3 | 50.0→8.0 | 51.4→6.1 | 50.0→4.7 | 50.0→7.0 | 50.0→4.7 |
| CONSV | 10.0→10.0 | **50.0→10.0** | 46.7→7.7 | 50.0→5.9 | 52.0→8.7 | 50.0→6.7 | 51.4→5.1 | 50.0→5.9 |

**beforeはT2以降、5社すべてが例外なく約50%**である。会社の性格（massMarket / japanQuality /
vapSpecialist / conservative）にも市場規模にも一切関係なく50%になっている。
これは「日本が魅力的だから選ばれた」のではなく、**固定重みがそのまま出ていた**ことの
直接的な証拠である。

afterは4.5〜21.4%に分散し、会社ごと・Turnごとに違う値になった。

allocationMode診断: before = `legacy_price_rank` （全40行）、after = `observed_opportunity` （全40行）。

---

## 3. 配分の合理性（指示4・22-2）

### BAL T5 の実データ

| | before | after | after機会スコア重み |
|---|---|---|---|
| JP | **22人** (3,441t) | 3人 (745t) | 0.067 |
| CN | 6人 (1,214t) | **13人** (2,553t) | 0.327 |
| US | 5人 (1,043t) | **12人** (2,362t) | 0.283 |
| EU | 6人 (1,214t) | 9人 (1,851t) | 0.197 |
| OTHER | 6人 (1,214t) | 5人 (1,159t) | 0.126 |

配置人数は機会スコア重みの順位と一致している（CN > US > EU > OTHER > JP）。
重みは「観測需要 × 取得可能シェア × 採算性」から決まっており、
**単純な需要比例ではない**（JPは単価が高いが観測需要が小さく、重み0.067）。

### 単純需要比例になっていないことの確認

JPは重み6.7%に対して**人数3人＝7.1%**、OTHERは重み12.6%に対して**5人＝11.9%**。
配分は重みにほぼ比例するが、整数丸めにより小市場でも0人にはならず最低1〜3人が残っている。
「小市場でも一定人数を置く」という挙動は出ている。

**ただし正直に記す**: 「大市場でも低採算なら抑える」という逆方向の挙動は、
このシナリオでは明確な事例を確認できなかった。観測された5市場では
需要規模と採算性の順位が概ね一致しており、両者が対立するケースが出なかった。

---

## 4. 成約・在庫・backlog・利益（指示22-7〜9）

成約量は5社すべてで増加（+1.2%〜+24.4%）。とくにVAP +24.4%、JPQ +19.1%、BAL +18.7%。

**営業給与だけ増えて利益が悪化した会社は無い。** SG&Aの増加は+0.7%〜+5.8%に対し、
営業利益は全社改善。VAPは -2.8 → +9.9 M$ と赤字から黒字へ転換した。

完成品在庫はBAL(+789t)・JPQ(+1,574t)で増加、CONSV(-1,500t)・VAP(-147t)で減少。
BAL/JPQの増加は成約増に伴うものであり、**backlog(outstanding)は0のまま**なので
「売れないのに作った」形にはなっていない。

MASSだけはbacklogが7,249→7,195とほぼ変わらず高止まりしている（後述）。

---

## 5. 採用判断（指示5・22-3〜5）

`economicallyDesiredHireCount / organizationalHireLimit / actualHireCount / deferred`

| Co | T2 | T3 | T4 | T5 | T6 | T7 | T8 |
|---|---|---|---|---|---|---|---|
| BAL | 84/6/6/78 | 109/8/8/101 | 86/10/10/76 | 49/13/13/36 | 40/17/17/23 | — | — |
| MASS | — | — | — | — | — | — | — |
| JPQ | 55/5/5/50 | 57/6/6/51 | 46/8/8/38 | 31/10/10/21 | — | — | — |
| VAP | 160/5/5/155 | 156/6/6/150 | 150/8/8/142 | 87/10/10/77 | — | — | — |
| CONSV | 66/3/3/63 | 63/4/4/59 | 59/6/6/53 | 52/7/7/45 | 43/9/9/34 | 32/12/12/20 | — |

「—」は当該Turnに採用診断が出ていない（＝追加採用を望んでいない）。

### 上限張り付き（指示6）

| Co | 8Q中の張り付き | 最大連続 |
|---|---|---|
| BAL | 5Q | 5Q |
| MASS | 0Q | 0Q |
| JPQ | 4Q | 4Q |
| VAP | 4Q | 4Q |
| CONSV | 6Q | 6Q |

### **これが今回いちばん重要な発見である**

`economicallyDesiredHireCount` が **14人の会社で160人** (VAP T2)、
18人の会社で109人 (BAL T3) という値を出している。
現有人員の**8〜11倍**を「経済合理的に必要」と評価している。

指示7の切り分けでは **B（economicallyDesiredHireCountの計算が過大）** と判断する。
根拠:

- A（初期人数が低すぎる）だけでは160という値を説明できない。
  仮に初期40人でも、160は4倍であり依然として異常である。
- C（営業能力計算が厳しすぎる）なら、増員後に成約が伸びないはずだが、
  実際には成約が18〜24%伸びている。営業能力の計算自体は機能している。
- D（市場機会の過大評価）も一部寄与している可能性はあるが、
  市場配分の重みは妥当な値（合計1.0、順位も合理的）を出しており、
  過大評価が起きているとすれば配分側ではなく「未充足需要の総量」側である。

つまり **marginal評価の停止点が遠すぎる**。各社とも「あと1人増やせば利益が増える」が
100人以上続くと評価している。30%上限が無ければ1四半期で人員が数倍になる。

**なお、これは今回の変更で発生したものではない。** 旧ガバナー（BAL 9人固定）でも
同じ計算が走っており、単に上限で見えなくなっていただけである。

---

## 6. ボトルネック遷移（指示8・13・22-10）

`primaryConstraint` の時系列（after）:

| Co | T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 |
|---|---|---|---|---|---|---|---|---|
| BAL | sales | sales | prod_capacity_surplus | sales | **worker** | worker | worker | worker |
| MASS | sales | sales | sales | sales | sales | sales | sales | sales |
| JPQ | sales | sales | prod_capacity_surplus | sales | **worker** | worker | worker | worker |
| VAP | sales | worker_surplus | inventory_excess | sales | **worker** | worker | worker | sales |
| CONSV | sales | sales | inventory_excess | sales | sales | **worker** | worker | worker |

**判断の切り替えは機能している。** BAL/JPQ/VAP/CONSVはT5〜T6でworker_shortageへ移り、
その時点で採用診断が消える（＝営業採用を止めている）。
BALはT7・T8で `economicallyDesiredHireCount` が出ておらず、
**「営業は十分なのに採用し続ける」現象は起きていない**（指示8の合格条件を満たす）。

### MASSだけ挙動が異なる（要注意）

MASSは8Q通してprimaryConstraintが `sales_shortage` のままで、
**一度も採用を望んでいない**（採用診断が0件、人員22人のまま）。
同時にbacklogが7,195tと高止まりし、営業利益は-36.6M$の赤字である。

「営業が足りない」と診断しながら営業を増やさない、という**内部矛盾**である。
資金制約（MASSは期末cashが0）でmarginal評価が
`SALES_HIRING_BLOCKED_BY_LIQUIDITY` により止まっている可能性が高いが、
本ベンチマークではblockedReasonCodeを収集していないため**未確認**である。

---

## 7. diagnostics completeness（指示15・22-13）

| 項目 | 取得可否 |
|---|---|
| 市場別 allocatedHeadcount | ✅ `decision.salesPlans[].salesForceHeadcount` |
| 市場別 opportunityScore | ⚠️ 重み（正規化後）のみ `weight_<market>` |
| 市場別 observedDemand | ❌ **診断に出ていない** |
| 市場別 attainableDemand | ❌ **診断に出ていない** |
| 市場別 expectedContribution | ❌ **診断に出ていない** |
| 市場別 salesEffort | ❌ **診断に出ていない** |
| economicallyDesiredHireCount | ✅ |
| organizationalHireLimit | ✅ |
| actualHireCount | ✅ |
| deferredByOrganizationalRamp | ✅ |
| marginalContributionAfterSalesSalaryUsd | ⚠️ 評価配列には存在するが診断へ出ていない |
| unusedSalesCapacity | ❌ **現行diagnosticsでは取得できない** |

### 不足していた診断を追加した（指示15・19）

上記の❌のうち、市場配分の説明に必須な4項目を
`MARKET_OPPORTUNITY_COMPONENTS` として追加した（計算式は一切変更していない。
重みを構成した決定論的な計算値をそのまま外へ出しただけである）。

追加後、BAL T5 は次のように**実数で説明できる**。

```
JP市場:    観測需要  8,606t × 取得可能シェア35% = 獲得可能需要  3,012t、期待貢献 3.43 USD/kg → 重み  6.7%
EU市場:    観測需要 25,501t × 取得可能シェア35% = 獲得可能需要  8,925t、期待貢献 3.41 USD/kg → 重み 19.7%
US市場:    観測需要 36,943t × 取得可能シェア35% = 獲得可能需要 12,930t、期待貢献 3.37 USD/kg → 重み 28.3%
CN市場:    観測需要 43,221t × 取得可能シェア35% = 獲得可能需要 15,127t、期待貢献 3.33 USD/kg → 重み 32.7%
OTHER市場: 観測需要 16,765t × 取得可能シェア35% = 獲得可能需要  5,868t、期待貢献 3.31 USD/kg → 重み 12.6%
```

**これで「なぜ日本が少ないのか」が明確になった。**
日本は期待貢献3.43 USD/kgで5市場中**最も採算が良い**が、
観測需要は8,606tで**中国の1/5**しかない。
採算の差は3%（3.43 vs 3.33）に対し、市場規模の差は5倍である。
したがって規模の差が支配的になり、日本の重みは6.7%になる。

旧ロジックはこの8,606tという数字を一切見ずに、
「単価が高いから首位」という理由だけで50%を割り当てていた。

なお `salesEffort` と `unusedSalesCapacity` は今回追加していない。
前者は配分重みの計算に入っておらず（人数配分は重みに比例するのみ）、
後者は営業能力の総量を診断に持っていないためである。
実装するとStandard AIの計算自体に手を入れることになるため、
今回の範囲（説明可能性の付与）を超えると判断した。

---

## 8. 未取得の項目（正直な記載）

指示2で挙げられた項目のうち、以下は**現行diagnosticsでは取得できない**ため
このベンチマークに含めていない。値を推定で埋めることはしていない。

- `totalSalesCapacity` / `unusedSalesCapacity`
- 市場別 `contractedVolume`（成約は会社合計でのみ記録される）
- `cashConstraint` / `borrowingConstraint` の明示フラグ
- `marginalContributionAfterSalesSalaryUsd`
- 採用が止まった理由コード（`blockedReasonCode`）

とくに `unusedSalesCapacity` が無いため、指示9（営業能力の未使用量が増えていないか）は
**検証できていない**。成約量が全社で増えていることから深刻な遊休は考えにくいが、
これは推論であって実測ではない。

---

## 9. 環境候補（GAME_ENVIRONMENT_CANDIDATE）

- **MASS の構造的赤字**: 8Q累計 -36.6M$、backlog 7,195t が解消しない。
  営業配分の改善（+693t）ではほとんど動かなかった。
  Standard AIのロジックではなくMASSのfixture条件（massMarket archetype）側の
  問題である可能性がある。今回は変更していない。
