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
