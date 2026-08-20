# SAI-GROW-3B-1 — Liquidity SSoT / Investment Discipline

対象branch: `claude/nifty-faraday-q3y7gs`（GROW-3A `a9f869d` / PRE-AUDIT `58b65cf` を保持）
前提: PRE-AUDIT `docs/v2/SAI_GROW3_PRE_AUDIT.md` 受入済み

## 1. 解決した問題

PRE-AUDITで特定したとおり、「投資に回してよい現金」の定義がStandard AIの中で4通りに分裂していた。

| id | 定義 | 使用箇所 |
|----|------|----------|
| L-1 | `targetMinimumCashUsd`（会社規模連動の最低バッファ） | 各所 |
| L-2 | `assessWorkingCapitalNeed`（原料+人件費+買掛+元利 vs 現金+AR） | finance決定のみ |
| L-3 | CAPEX cash gate（`targetMinimumCash + 案件費用 × 1.5`） | 増設CAPEX・案件単位・当期のみ |
| L-4 | 新工場 Gate L（`targetMinimumCash + 案件費用 × riskTolerance別係数`） | 新工場のみ |

分裂の結果、どの判断も「他の判断が同じ現金を既に使う前提であること」を知らなかった。
DS3のBALは開始現金49.2Mのうち26.3Mを3四半期でCAPEXへ投じ、T5に現金が尽き、
以後 調達縮小 → 生産0 → 回復不能 という崩壊を起こしていた。

## 2. 導入したもの — `decision/liquidity.ts`（pure resolver）

「今いくらまで投資に回してよいか」を1か所で決め、Finance決定・増設CAPEX・新工場が同じ評価を参照する。

```
AvailableLiquidity          = max(0, cash) + 当期回収予定AR + 現実的追加借入
ProtectedFundingRequirement = 最低運転資金 + 元利返済 + 確定投資支払(4Q) + 最低現金 + 危機buffer
LiquidityHeadroom           = AvailableLiquidity - ProtectedFundingRequirement
CashBasedHeadroom           = cash - (最低運転資金 + 元利返済 + 確定投資支払(当期) + 最低現金 + 危機buffer)
```

### 2.1 投資可否は2テストの同時充足

* **horizon test**（`LiquidityHeadroom`）: 借入・ARを含めた4四半期の資金繰りが破綻しないか
* **当期現金 test**（`CashBasedHeadroom`）: **借入もARも含めない**当期現金だけで払えるか

当期現金 testからARを外しているのは、engine側の `computeProcurementConstraint` が
国内調達を `max(0, prevCash) × domesticPurchaseCashAllocationRatio + approvedLoanDraw` で
制約しており、**ARは翌期の原料調達枠にならない**ため。ARを投資可能額に数えると、
翌期の原料調達を自ら枯らす（MASSの回帰で実測）。

### 2.2 「現実的追加借入」— facility残高の全額を資金に数えない

実装指示「将来確実に借りられる保証のない金額を100%cash-equivalentとして扱わないこと」に対応。

```
frozen（tier=paymentDefault/insolvent/paymentArrears/covenantBreach、SEVERE_DISTRESS、
        前期underwritingFrozen）           → 0
policyLimit      = (targetMinimumCash / cashBufferQuarters) × capexMaxLoanToSizeRatio
policyHeadroom   = max(0, policyLimit - 既存借入残高)
debtFundableShare= clamp(1 - upfrontCoverageRatioByRiskTolerance, 0, 1)   HIGH .40 / MEDIUM .15 / LOW 0
leverageHaircut  = (1 - borrowingPressure) ^ financialDisciplineExponent  HIGH^0 / MED^1 / LOW^2
現実的追加借入   = policyHeadroom × debtFundableShare × leverageHaircut
```

### 2.3 ポートフォリオの逐次控除

`LiquidityGateContext.commit()` により、同一Turn内で先に承認した案件の支払いが
後続案件の評価から差し引かれる（従来は各案件が同じ現金を独立に「使える」と判定していた）。
新工場（Gate L・戦略ルート双方）も同じcontextへcommitする。

### 2.4 新しいmagic numberを置いていない

構成要素はすべて既存の唯一の情報源の再利用:
`assessWorkingCapitalNeed` / `estimateTargetMinimumCashUsd` / `CapitalProject.paymentSchedule` /
`pressures.borrowingPressure` / `crisisGateByState` / `financialDisciplineExponentByRiskTolerance` /
`upfrontCoverageRatioByRiskTolerance` / `minDomesticPurchaseRatioOfBase` / `capexMaxLoanToSizeRatio` /
`cashBufferQuarters`。company IDのhardcodeも無い。

## 3. 実装ファイル

| ファイル | 変更 |
|----------|------|
| `decision/liquidity.ts` | 新規。SSoT本体（`LiquidityAssessment` / `evaluateInvestmentAffordability`） |
| `decision/newFactoryStrategyParameters.ts` | 新規。newFactory ↔ liquidity の循環importを断つためのparameter抽出 |
| `observation.ts` | `buildCommittedCapexPaymentSchedule`（4Q horizon）を追加 |
| `types.ts` | `committedCapexPaymentScheduleUsd` を追加 |
| `decision/capex.ts` | `LiquidityGateContext`・逐次控除・`CAPEX_DEFERRED_LIQUIDITY` 等の理由記録 |
| `decision/newFactory.ts` | Gate L・戦略ルート双方を `evaluateInvestmentAffordability` へ寄せる |
| `decision/finance.ts` | 借入必要額を `fundingBalanceBeforeBorrowingUsd + 承認済投資` から算出 |
| `policy.ts` | 順序変更（liquidity評価 → CAPEX → 新工場 → **finance**）・`LIQUIDITY_ASSESSED` 診断 |
| `reasonCodes.ts` | `CAPEX_DEFERRED_LIQUIDITY` / `CAPEX_DEFERRED_COMMITTED_PAYMENTS` / `LIQUIDITY_ASSESSED` |
| `__tests__/liquiditySSoTG3B1.test.ts` | 新規 G3B1-1〜14 |

## 4. 実測結果

### 4.1 DS3（`dynamic-scenario-3-v0.1`、seed ds3-a、検証用一時branchでmerge実測）

| | before (GROW-3A) | after (3B-1) |
|---|---|---|
| BAL T2–T4 CAPEX | 26.3M | 0.0M |
| BAL 初回投資 | T2 | T15（現金108M時点） |
| BAL T32 現金 | -45.5M | 583.4M |
| BAL T32 生産 | 0（T28以降0） | 44,190/四半期 |
| BAL T32 自己資本 | -52.6M | 正常 |
| MASS T32 生産 | 54,045 | 64,868 |
| MASS T32 能力 | 72,675 | 82,080 |

3seed × 5社: 生産0の四半期は全社・全seedで **0**。T32時点の借入も 0。

### 4.2 DS2（8seed × 5社）

| 会社 | 資金不足T計 before → after | avg OP before → after | avg 生産 before → after |
|------|---------------------------|----------------------|------------------------|
| BAL | **8 → 0** | 704.3M → 1053.7M | 598,051t → 656,042t |
| MASS | 0 → 0 | 926.3M → 951.8M | 683,579t → 685,428t |
| JPQ | 0 → 0 | 754.1M → 788.4M | 597,389t → 602,916t |
| CONSV | **0 → 1**（ds2-s8のみ） | 752.8M → 749.0M | 567,349t → 561,162t |
| VAP | 0 → 0 | 665.4M → 639.1M | 547,268t → 502,886t |

### 4.3 DS1（seed ds1-benchmark、T25-32フェーズ）

BAL 売上 396.4M → 632.6M・生産 219,590 → 260,562・末尾指標 15,934 → 0。
CONSV 369.9M → 385.8M。JPQ / VAP は約2%減。MASSのDS1崩壊は**変化なし**（既存事象・本phase範囲外）。

### 4.4 baseline（`management-console-32q`）— 投資の後ろ倒し

| | before | after |
|---|---|---|
| MASS 初回CAPEX | T17 | T22 |
| MASS 新工場承認 | T21（T24稼働） | T31（T32時点でまだ建設中） |
| MASS T32 現金 | 110.9M | 118.3M |
| MASS T32 工場数 | 3 | 1 |

baselineのMASSは全期間を通じて現金20〜40Mで推移し（T5・T7で0.0M）、
本phaseのdisciplineでは4Q horizonの保護必要額を満たせずT22まで投資を見送る。
BAL・JPQはbaselineでも新工場を稼働させている（T27・T32）。

## 5. Stop Conditions（勝手に調整せず報告する項目）

* **A. baselineでのMASS投資後ろ倒し（5〜10四半期）**: 崩壊はしておらず現金はむしろ増えるが、
  32Tの中で新工場が稼働しなくなった。「安全側だが成長が遅い」ことを許容するかは#05判断。
* **B. DS2 ds2-s8 CONSVの資金不足1T**: 全体では8T → 1Tへ減ったが0ではない。
* **C. MASSのDS3 backlog 131,740〜154,000t**: 本phaseでは解消していない（F-1・GROW-3B-2の範囲）。
* **D. 既存deadlock（本phaseで修正せず記録のみ）**: `standardAiCapexExtensionsEnabled: false` のため
  中断案件の再開経路が無効で、中断案件が3案件同時実行枠を恒久的に占有する。
* **E. `COMMITTED_CAPEX_HORIZON_QUARTERS = 4`**: 既存parameterに「投資コミットメントの見通し期間」に
  相当するものが無かったため新設した唯一の定数。新工場の建設期間（4Q）に合わせている。

## 6. 受入テスト

`app/lib/v2/companyLab/standardAi/__tests__/liquiditySSoTG3B1.test.ts` G3B1-1〜14。
全社suiteは 3,655 tests / 3,655 pass / 0 fail。

---

# SAI-GROW-3B-1.1 — Growth Financing Completion（限定修正）

base commit: `54e770b`（3B-1。中核設計は維持）

## 7. 修正理由

3B-1では当期の投資判定を **cash-only**（`cashBasedHeadroomUsd`）で行っていた。
一方 `AvailableLiquidity` には借入余力が入るため、
「現金単独では不足するが、健全な借入と組み合わせれば安全に実行可能な成長CAPEX」
を承認できなかった。兆候: DS3 3seed×5社でT32 debt=0、baseline MASSの新工場承認がT31。

## 8. engine borrowing timing の再確認（実測・推測なし）

`companyLab/runner.ts` の1Turn処理順:

1. `planQuarterFinancing`（L1165）… 銀行審査 → `plan.underwriting.approvedAmountUsd`
2. `computeProcurementConstraint`（L1185）… 原資 = `max(0,prevCash) × 配分比 + approvedNormalLoanDrawUsd`
   → **承認融資は当期の原料調達原資になる**
3. `closeQuarterWithFinancing`（`financing/liquidityClose.ts` L543・L573）
   … `loanDrawUsd: normalDrawUsd` として当期のcash flowへ入る
4. `closeQuarterWithCapex`（runner L1684）
   … `preCapexCashUsd = financeResultBeforeCapex.balanceSheet.cash`（`capex/capexClose.ts` L259）

したがって **承認された通常融資は同一Turnの設備投資支払原資として実際に使える**。
借入を当期判定から完全排除するのはengineの挙動より保守的すぎた。

## 9. 3層の分離（必須設計）

| 層 | 値 | AR | 借入 | 用途 |
|----|----|----|------|------|
| ① cash-only | `cashBasedHeadroomUsd` | 含めない | 含めない | 診断・借入依存額の算出 |
| ② current-turn fundable | `currentTurnFundableHeadroomUsd` | 含めない | 当期調達可能分のみ | **当期の投資判定** |
| ③ horizon | `liquidityHeadroomUsd` | 含める | 現実的借入余力 | 4Qの破綻判定 |

### 当期調達可能借入の式（exact）

```
borrowingAfterWorkingCapital = max(0, realisticallyAvailableBorrowing - financingNeed)
currentTurnFundableBorrowing = min(
    realisticallyAvailableBorrowing,
    borrowingAfterWorkingCapital × clamp(min(crisisGateByState[crisis], financeGateByTier[tier]), 0, 1)
)
currentTurnFundableHeadroom  = cashBasedHeadroom + currentTurnFundableBorrowing
```

* `- financingNeed`: **同じ承認融資が engine の `computeProcurementConstraint` で原料調達原資にもなる**ため、
  まず運転資金へ充当し、残りだけを成長投資へ回す。Cash/Debtの二重利用を構造的に防ぐ。
* gate: 既存の `crisisGateByState` / `financeGateByTier`（本ファイル内のcrisis buffer算出で既に使用）。
* **新しいparameterは1つも追加していない。** 定義上 `currentTurnFundableBorrowing <= realisticallyAvailableBorrowing`。

ARは②に含めない（engineの調達ゲートが当期AR回収を原料原資にしないため。3B-1の結論を維持）。

## 10. Financing decision ordering

順序は `liquidity → CAPEX → 新工場 → finance` のまま（大規模リファクタリングを避ける）。
ただし **投資判断が前提にした借入をFinance決定が必ず申請する**よう完結させた。

```
approvedInvestmentBorrowingThisQuarterUsd
  = max(0, 当期承認投資の当期支払合計 - max(0, cashBasedHeadroom))     … policy.ts
desiredAmountUsd = max(bufferShortfall, workingCapitalNeed, liquidityDrivenNeed,
                       min(approvedInvestmentBorrowingThisQuarter, currentTurnFundableBorrowing))  … finance.ts
```

既存の `fundingBalanceBeforeBorrowing + 承認投資` 経路だけでは、当期AR回収が資金に数えられるため
申請額が0へclampされ得た（テスト G3B11-C が実際に0であることを固定している）。
申請額の上限は投資判断が使ったのと同じ `currentTurnFundableBorrowing` であり、借入可能額を広げてはいない。

## 11. 受入テスト（G3B11-A〜H）

`app/lib/v2/companyLab/standardAi/__tests__/growthFinancingG3B11.test.ts`（9件）

| id | 内容 |
|----|------|
| A | Cash単独ではCAPEX不可 |
| B | 同じケースで healthy credit + 当期調達可能借入があればCAPEX可 |
| C | その投資が依存した借入がFinancing Requestへ必ず載る（旧経路では0だったことも同時に固定） |
| D | `underwritingFrozen` ではBが不可 |
| D2 | 重大な信用悪化tier・SEVERE_DISTRESSで当期調達可能借入=0 |
| E | LOW financialRiskTolerance ではDebt-funded growthが0（当期余力=cash-only） |
| F | HIGH > MEDIUM > LOW、かつ常に `<= realisticallyAvailableBorrowing` |
| G | 借入込みでもhorizonでprotected requirementを割る案件は不可 |
| H | 借入を使っても同一Turnの複数CAPEXがCash/Debtを二重利用しない |

既存 `G3B1-3` は境界を cash-only から当期実行可能余力へ更新（受入の趣旨は不変）。

## 12. 実測（DS3 seed ds3-a）

### BAL T1–T16（CAPEX / Cash / Debt / 当期調達可能借入 / liquidity headroom / 調達 / 生産）

```
T    CAPEX  Cash   Debt  新規借入  当期可能借入  liqHR   調達t   生産t
T1    0.0   49.2   48.5    —          0.1       63.5    9713   12621
T2    0.0   41.9   47.0   -1.5        1.2       59.1    9384   13999
T3    0.0   40.4   45.5   -1.5        0.5       60.4    8617   13999
T4    0.0   37.4   44.0   -1.5        0.5       56.6    7704   13997
T5    0.0   19.1   26.8  -17.2        0.0       15.5    7248   13997
T6    0.0   22.6   31.4    4.6        3.1       38.6    7020   13997
T7    0.0   30.9   34.1    2.7        2.8       44.4    6905   13997
T8    0.0   25.7   39.1    5.1        5.7       46.1    8172   13999
T9    0.0   31.1   51.8   12.7        0.0       42.0    7957   13999
T10   0.0   47.7   61.3    9.4        5.8       53.8    7374   13997
T11   0.0   72.0   55.6   -5.7        4.2       87.1    7083   13997
T12   1.2  104.8   48.7   -6.9        3.0      122.0    6937   13997
T13  11.1  107.9   28.7  -20.0        2.4      140.6    6864   13997
T14   9.9  108.4   10.2  -18.5        6.6      131.7    6828   13997
T15   9.2  107.0    8.7   -1.5        9.0      138.0   10401   16828
T16  16.6  108.6    6.0   -2.7        9.0      157.4   10218   17682
```

T2–T4のCAPEXは 0.0M のまま（3B-1で防いだ無謀な早期投資へ戻っていない）。
初回投資は T15 → **T12** へ3四半期前倒し。生産0の四半期は無し。

### MASS T8/16/24/32（before = 54e770b）

| | T8 | T16 | T24 | T32 |
|---|---|---|---|---|
| CAPEX累計 before → after | 0.0 → 0.0 | 2.7 → 12.3 | 66.3 → 74.0 | 96.0 → 104.0 |
| 生産 before → after | 14,728 → 14,728 | 16,542 → 16,542 | 38,797 → 38,530 | 64,868 → 53,400 |
| Cash before → after | 21.2 → 21.2 | 102.6 → 102.1 | 89.5 → 121.6 | 408.0 → 539.5 |
| Debt before → after | 55.2 → 55.2 | 18.8 → 28.0 | 21.5 → 43.4 | 0.0 → 0.0 |
| 当期調達可能借入 after | 2.5 | 14.8 | 38.6 | 33.6 |

**T32生産の差は能力喪失ではなくramp timingのsnapshot**（実測で確認）:

| 工場 | before 稼働開始 / T32 common能力 | after 稼働開始 / T32 common能力 |
|------|-------------------------------|-------------------------------|
| MASS-F1 | T1 / 30,000（hoso 20,000） | T1 / 30,000（hoso 20,000） |
| NEWF-CAPEX-4 | T21 / 22,000（hoso 10,000） | **T20** / 22,000（hoso **14,000**） |
| NEWF-CAPEX-7 | T26 / 22,000 | **T25** / 22,000 |
| NEWF-CAPEX-8 | T30 / 22,000（ramp完了） | **T32** / 11,000（ramp途中） |

1・2番目の新工場は1四半期**早く**、3番目だけが2四半期遅い。3番目はT32時点でramp半ばのため
T32のsnapshot能力が 96,000 → 85,000 に見える。T29/T30の生産は 54,378/56,110 → 56,322/55,444 でほぼ同等。
投資総額はむしろ増えている（96.0M → 104.0M、hosoLineExpansionが1件多い）。

### baseline（management-console-32q）

| 会社 | 初回CAPEX | 新工場承認 | 新工場稼働 | T32 cash | T32 debt | 工場数 |
|------|-----------|-----------|-----------|---------|---------|-------|
| MASS before(3B-1) | T22 | T31 | — | 118.3M | 0.0M | 1 |
| MASS **after(3B-1.1)** | **T20** | **T21** | **T24** | 109.1M | **8.7M** | **2** |
| BAL before → after | T9 → T9 | T23 → T26 | T26 → T29 | 275.0 → 292.0M | 0.0 | 2 → 2 |
| JPQ before → after | T10 → T10 | T29 → **—** | T32 → **—** | 288.1 → 307.5M | 0.0 | 2 → **1** |
| VAP before → after | T12 → T11 | — | — | 308.8 → 306.7M | 0.0 | 1 |
| CONSV before → after | T9 → T9 | — | — | 310.1 → 307.4M | 0.0 | 1 |

3B-1のStop Condition A（MASSの新工場承認T31）は解消した。承認は借入8.7Mを伴っており、
「安全性を維持した結果として自然に前倒しされた」形になっている。
一方でBALの新工場は3四半期後ろ倒し、JPQは32T内に新工場を建てなくなった（競合効果。§14 Stop Condition）。

## 13. Regression

### DS2（8seed × 5社）— before = 58b65cf / 3B-1 = 54e770b / 3B-1.1

| 会社 | 資金不足T計 | avg OP (M) | avg 生産 (t) |
|------|-------------|-----------|-------------|
| BAL | 8 → 0 → **0** | 704.3 → 1053.7 → 1031.8 | 598,051 → 656,042 → 654,062 |
| MASS | 0 → 0 → **0** | 926.3 → 951.8 → 951.5 | 683,579 → 685,428 → **690,805** |
| JPQ | 0 → 0 → **0** | 754.1 → 788.4 → 764.3 | 597,389 → 602,916 → 600,617 |
| CONSV | 0 → 1 → **1** | 752.8 → 749.0 → 745.0 | 567,349 → 561,162 → 559,511 |
| VAP | 0 → 0 → **0** | 665.4 → 639.1 → 644.8 | 547,268 → 502,886 → **512,280** |

* CONSV資金不足 0→1 は **変化なし**（ds2-s8の1四半期のみ）。CONSVはLOW risk toleranceのため
  Debt-funded growthの対象外であり、3B-1.1では動かない。
* VAP生産の約8%減は **一部回復**（502,886 → 512,280、対3B-1で+1.9%。対58b65cfでは依然 -6.4%）。
* 全seedで期末借入0・32T完走。

### DS1（seed ds1-benchmark、T25-32）

3B-1 と **bit-identical**（BAL 632.6M / 生産260,562、JPQ 391.3M、VAP 356.3M、CONSV 385.8M、MASSは既存崩壊のまま）。
DS1ではどの会社も「現金不足だが健全に借りられる」局面へ入らないため、3B-1.1の経路が発火しない。
JPQ/VAPのDS1約2%減は **変化なし**。

## 14. Debt usage by company（3B-1.1）

| シナリオ | 借入を成長に使った会社 | 使わなかった会社 |
|----------|----------------------|------------------|
| baseline | MASS（T32 debt 8.7M） | BAL / JPQ / VAP / CONSV（0.0M） |
| DS3 ds3-a | MASS（T24 43.4M、T26 105.7M。T32で完済0.0M）、BAL/JPQ/VAP（運転資金中心、T32 0.0M） | CONSV（当期調達可能借入 常に0.0M＝LOW） |
| DS2 8seed | 期末借入は全社0.0M（期中に使い、期末までに返済） | — |

CONSV（LOW financialRiskTolerance）は全シナリオで `currentTurnFundableBorrowing = 0.0M`。
profileによる差が設計どおり出ている（company IDのhardcodeは無い）。

## 15. 残るStop Conditions

* **B'. DS2 ds2-s8 CONSVの資金不足1T**: 未解消（LOWのため3B-1.1の対象外）。
* **C. MASSのDS3 backlog**: 未解消（F-1・GROW-3B-2の範囲）。
* **D. 既存deadlock**: `standardAiCapexExtensionsEnabled: false` により中断案件の再開経路が無効。
* **E. `COMMITTED_CAPEX_HORIZON_QUARTERS = 4`**: 指示どおり今回は変更していない。
  baseline MASSの極端な延期は解消したため、本phaseでは変更の必要が生じなかった。
* **F. DS1のMASS崩壊 / JPQ・VAPのDS1約2%減**: 3B-1から変化なし（範囲外として未調整）。
* **G'.（新規）baselineでBALの新工場が3四半期後ろ倒し、JPQが32T内に新工場を建てなくなった**:
  MASSが早く建てたことによる競合効果と考えられる。全社合計の生産・現金は悪化していないが、
  会社別には勝敗が入れ替わっている。silent tuningはしていない。
* **H'.（新規）DS3 MASSのT32生産 64,868 → 53,400**: 3番目の新工場の稼働がT30→T32へずれ、
  T32時点でramp途中であることによるsnapshotの差（§12に実測の内訳）。
  投資総額・1/2番目の工場の稼働時期はいずれも改善している。
