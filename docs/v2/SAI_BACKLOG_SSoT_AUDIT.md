# SAI-BKL-1 PRE-AUDIT — Backlog SSoT & Contract Ledger Reconciliation

**監査のみ。production code は1行も変更していない。**

| | |
|---|---|
| base | `feature/v2-sai-cap-1 @ 96f54d1` |
| branch | `audit/v2-sai-bkl-1` |
| 測定 | DS3 8seed（ds3-a〜h）× 32Turn × 5社 = **1,280 観測点**、engine 直接実行 |
| 参照（merge していない） | `origin/feature/v2-ds3-accounting-factory-recovery @ 3df1612`（#04） |

---

## 0. 結論（先に）

1. **contract ledger と summary は完全に一致する。** 1,280 観測点で不一致 **0件**、
   最大差 `1.455e-11`（浮動小数点誤差）。summary は canonical projection として扱ってよい。
2. **恒等式 `Total = Overdue + HealthyForward` は成立する**（最大差 `1.455e-11`）。
3. **AI が使う backlog も同一 semantics。** ただし観測タイミングが1四半期前
   （turn 開始時 = 前期末 ledger）であり、これは仕様どおりで不整合ではない。
4. **EXEC-1 / #04 audit / #04 counterfactual の3値は、field も formula も同一だった。**
   差の原因は backlog の定義ではなく **Standard AI の code version** である。
   #04 branch は `0400c4a` から分岐しており、SAI-GROW-3B-1 / 3B-1.1 / 3B-2 / 3B-3 /
   3C / 3C.1 を **一つも含んでいない**（`git merge-base --is-ancestor` で実測）。
5. **Stop Condition 該当なし。SAI-COMMIT-1 は開始可能。**
   ただし UI 1箇所に latent な非 canonical 集計がある（§9、現状は無害）。

---

## 1. Contract ledger SSoT の所在

| 役割 | module | 備考 |
|---|---|---|
| 契約データ型 | `app/lib/v2/sales/types.ts` `SalesContract` | 数量・納期・status を保持 |
| **lifecycle 遷移（唯一）** | `app/lib/v2/sales/backlog.ts` | 履行・キャンセル・overdue 判定の3関数のみ |
| ledger 保持 | `CompanyLabState.contracts`（`app/lib/v2/companyLab/types.ts:208`） | 会社横断の単一配列 |
| 期末書き戻し | `app/lib/v2/companyLab/runner.ts:1837` | `contracts: contractsAfterOverdue` |
| summary 射影 | `app/lib/v2/companyLab/runner.ts:849-852` | 下記 §6 |

`sales/backlog.ts` 以外に契約 status を書き換える箇所は存在しない
（`grep 'status: "overdue"|"fulfilled"|"partiallyFulfilled"|"cancelled"'` で確認済み。
`capex/projectLifecycle.ts:266` の `"cancelled"` は CAPEX 案件であり契約ではない）。

---

## 2. Contract lifecycle

| 段階 | 実装 | 内容 |
|---|---|---|
| creation / acceptance | `sales/contracts.ts`（成約時） | `originalQuantity = outstandingQuantity`、`status = "open"`、`dueDate` 確定 |
| partial fulfillment | `backlog.ts::applyQuantityToContract` | `outstanding -= q`、過剰履行は例外で拒否 |
| status 更新（履行後） | `backlog.ts::statusAfterFulfillment` | `outstanding <= 1e-6` → `"fulfilled"`、それ以外 → `"partiallyFulfilled"` |
| FIFO 配分 | `backlog.ts::applyFulfillments` | `contractedPeriod → dueDate → contractId` の決定論ソート |
| overdue 判定 | `backlog.ts::updateContractStatusesForQuarterEnd` | `dueDate < 引数period` かつ `outstanding > 1e-6` → `"overdue"` |
| cancellation | `backlog.ts::cancelContract` | **engine / UI から一度も呼ばれていない**（§3 参照） |
| 期末適用順 | `runner.ts:1371-1373` | `applyFulfillments` → `updateContractStatusesForQuarterEnd(…, nextPeriod)` |

### 2-1. overdue 判定の実効的な意味

`runner.ts:1373` は `nextPeriodValue` を渡す。したがって期末時点の overdue 条件は

```
dueDate < nextPeriod   ⇔   dueDate <= currentPeriod
```

＝**「納期が当期以前に到来しており、まだ残っている」**。当期納期の未履行は当期末に overdue になる。

### 2-2. 確認した semantics 上の注意点（欠陥ではない）

`overdue` の契約が部分履行されると `statusAfterFulfillment` が `"partiallyFulfilled"` を返し、
**その瞬間だけ overdue フラグが落ちる**。ただし同一 turn 内で直後に
`updateContractStatusesForQuarterEnd` が走り再び `"overdue"` になるため、
**期末に観測される限り不整合は生じない**（1,280 観測点で status 基準と dueDate 基準の
overdue が完全一致していることで実証済み。§5）。

---

## 3. backlog 関連 field の全列挙

| # | exact path | 意味 | timing | 商品集約 | 契約集約 | forward含む | overdue含む | 判定 |
|---|---|---|---|---|---|---|---|---|
| 1 | `CompanyLabState.contracts[]` `.outstandingQuantity` | 1契約の未履行量 | 期末 | 契約単位 | 個別 | — | — | **SSoT（原本）** |
| 2 | `CompanyQuarterSummary.outstandingQuantity`<br>`runner.ts:849` | Σ outstanding（status ∉ {fulfilled, cancelled}） | 期末 | 全商品合計 | 全契約 | ✔ | ✔ | canonical projection |
| 3 | `CompanyQuarterSummary.overdueQuantity`<br>`runner.ts:852` | Σ outstanding（status == "overdue"） | 期末 | 全商品合計 | 全契約 | ✘ | ✔ | canonical projection |
| 4 | `StandardAiObservation.overdueBacklogByProduct`<br>`observation.ts:119-131` | status ∈ {open, partiallyFulfilled, overdue} かつ<br>（status=="overdue" ∨ dueDate < 当期） | **turn 開始時**（= 前期末） | 商品別 | 全契約 | ✘ | ✔ | canonical（timing のみ 1Q 前） |
| 5 | `StandardAiObservation.healthyForwardBacklogByProduct`<br>同上 | 同 universe の残り | **turn 開始時** | 商品別 | 全契約 | ✔ | ✘ | canonical（同上） |
| 6 | `app/v2/management/player/backlogView.ts:39,43,44` | #2 / #3 をそのまま表示 | 期末 | 合計 | — | ✔ | ✔ | canonical |
| 7 | `app/v2/company-lab/components/ResultsPanel.tsx:38,39` | 同上（「未履行残高」「うち納期超過」） | 期末 | 合計 | — | ✔ | ✔ | canonical |
| 8 | `app/v2/company-lab/components/ComparisonPanel.tsx:21,71,76` | 同上 | 期末 | 合計 | — | ✔ | ✔ | canonical |
| 9 | `app/api/v2/exports/_lib/exportDto.ts:965,966` | #2 / #3 をそのまま export | 期末 | 合計 | — | ✔ | ✔ | canonical |
| 10 | `app/api/v2/exports/_lib/dto/contractDto.ts:182,185` | 契約別の期首/期末 outstanding | 期首・期末 | 契約単位 | 個別 | — | — | canonical（明細） |
| 11 | `app/v2/company-lab/decisionStudioViewModel.ts:58-60` | ledger 直読み、status ∈ {open, partiallyFulfilled, overdue} | turn 開始時 | 合計 | 全契約 | ✔ | ✔ | **canonical**（#2 と同式） |
| 12 | `app/v2/company-lab/components/OpeningCompanyStatePanel.tsx:54` | ledger 直読み、**status フィルタなし** | turn 開始時 | 合計 | 全契約 | ✔ | ✔ | **非 canonical（latent）** §9 |
| 13 | `app/lib/v2/rawMaterials/requirements.ts::summarizeRawMaterialRequirements` | status ∈ {open, partiallyFulfilled, overdue} を dueDate×商品で集計 | 当期 | 商品別 | 納期別 | ✔ | ✔ | canonical（用途が別） |
| 14 | `app/lib/v2/quality/deliveryObservation.ts:55` | 継続 overdue の市場別集計 | 当期 | 市場別 | 全契約 | ✘ | ✔ | canonical（用途が別） |
| 15 | **SAI-EXEC-1 が使った path** | `#2` `#3` そのもの | 期末 | 合計 | 全契約 | ✔ | ✔ | canonical |
| 16 | **#04 audit が使った path**<br>`dynamicScenario3Benchmark.ts:310` | `#2` そのもの（`summary.outstandingQuantity`） | 期末 | 合計 | 全契約 | ✔ | ✔ | canonical |

**#15 と #16 は同一 field・同一式である。** これが §4 の核心。

---

## 4. MASS 3値の再現と exact root cause

### 4-1. 実測（同一 field `summary.outstandingQuantity`、同一 seed 集合 ds3-a〜d、T32）

| 出所 | branch / code version | MASS T32 backlog | 再現 |
|---|---|---:|---|
| #04 capacity audit §2 | `feature/v2-ds3-accounting-factory-recovery @ 3df1612` | **195,556** | ✔ **完全一致で再現**（4seed 平均。ds3-a 単独では 192,041） |
| SAI-EXEC-1 / CAP-1 before | `997d0a9` + DS3 | **59,289** | ✔（本監査の再測でも同水準） |
| SAI-CAP-1 after（参考） | `96f54d1` + DS3 | **54,822** | ✔ |
| #04 counterfactual Base | #04 の未 commit harness | 96,326 | ✘ **再現不能**（下記 4-3） |

#04 branch 上でも **ledger 由来値と summary が完全一致**した
（T24 49,282 / T28 122,286 / T32 195,556 の全てで一致）。
つまり **backlog の定義は両 branch で同一**であり、差は定義由来ではない。

### 4-2. root cause（実測で確定）

```
$ git merge-base --is-ancestor <commit> origin/feature/v2-ds3-accounting-factory-recovery
  54e770b SAI-GROW-3B-1   （Liquidity SSoT）              → 含まない
  09e6a8f SAI-GROW-3B-1.1 （Growth Financing）            → 含まない
  798d044 SAI-GROW-3B-2   （Fundable Operations）          → 含まない
  0f07701 SAI-GROW-3B-3   （Deliverable Commitment）       → 含まない
  2e70d80 SAI-GROW-3C     （Deliverability Routing）       → 含まない
  2244f18 SAI-GROW-3C.1   （Executable Workforce Growth）  → 含まない
$ git merge-base <#04 branch> 997d0a9  →  0400c4a（integration HEAD）
```

**#04 branch は integration HEAD から分岐しており、Standard AI の成長・納品規律
6 Phase をまったく含んでいない。** とりわけ SAI-GROW-3B-3（Deliverable Commitment）は
「納品できない量を受注しない」ための Phase であり、それが無い状態では
成約（約71kt/期）と生産（約53kt/期）の差が毎期そのまま積み上がる。

```
195,556（#04 / 3B-3 なし） − 59,289（#05 / 3B-3 あり） = 136,267t
≒ 差分 18kt/期 × 未消化四半期数
```

**したがって「3値の不一致」は backlog SSoT の問題ではなく、比較対象の code version が
揃っていなかったことによる。** field の統一は不要（既に統一されている）。

### 4-3. #04 counterfactual 96,326 について

再現できなかった。理由を推測ではなく事実として記す:

- #04 の counterfactual harness は **commit されていない**
  （`git diff 0400c4a <#04 branch>` に該当 script は無い。`52a9acd` は
  `dynamicScenario3Benchmark.ts` のみの変更）。
- #04 audit の counterfactual 表の Base 行は、同 audit の §2 表（同 branch・同 seed）と
  **生産・販売も食い違っている**（生産 55,183 vs 53,100、販売 61,160 vs 71,322、
  受注残 96,326 vs 195,556）。私が #04 branch で ds3-a を素直に実行した値は 192,041。
- つまり counterfactual の "Base" は素の run ではなく、その harness 固有の
  設定（能力倍率の適用方法等）を含んでいる。**backlog の field が違うのではない。**

この値は **#04 に harness の共有を依頼しない限り確定できない**。現時点では
「同一条件の Base ではない」ことまでが確定事実である。

---

## 5. Canonical ledger-derived metrics（shadow 純粋関数）

```
対象契約 = ledger のうち status ∉ { "fulfilled", "cancelled" }
          （＝ status ∈ { "open", "partiallyFulfilled", "overdue" }）

totalOutstanding          = Σ outstandingQuantity
overdueOutstanding        = Σ outstandingQuantity  where dueDate <= asOfPeriod
healthyForwardOutstanding = Σ outstandingQuantity  where dueDate >  asOfPeriod
```

除外規則:

| status | 扱い | 理由 |
|---|---|---|
| `fulfilled` | 除外 | outstanding は定義上 0 |
| `cancelled` | **除外** | 履行義務が消滅している。outstanding が残っていても数えない |
| `open` / `partiallyFulfilled` / `overdue` | 算入 | いずれも「まだ納品が必要」 |

商品別・市場別も同一規則で導出可能（本監査で実装・検証済み）。

### 検証結果（DS3 8seed × 32Turn × 5社 = 1,280 観測点）

| 検証項目 | 不一致件数 | 最大差 |
|---|---:|---:|
| `totalOutstanding` == `summary.outstandingQuantity` | **0** | 1.455e-11 |
| status 基準 overdue == `summary.overdueQuantity` | **0** | 1.091e-11 |
| **恒等式** `total == overdue + healthyForward` | **0** | 1.455e-11 |
| dueDate 基準 overdue == status 基準 overdue | **0** | — |

`cancelled` 契約の outstanding は全観測点で **0**。
`cancelContract` は engine / UI のどこからも呼ばれていない
（export のみ。`grep` で確認）ため、cancelled 契約は現行ゲームで発生しない。

---

## 6. Summary field との照合

```
runner.ts:849  outstandingQuantity = afterCompany
                 .filter(c => c.status !== "fulfilled" && c.status !== "cancelled")
                 .reduce((s, c) => s + unwrapUnit(c.outstandingQuantity), 0)
runner.ts:852  overdueQuantity     = afterCompany
                 .filter(c => c.status === "overdue")
                 .reduce((s, c) => s + unwrapUnit(c.outstandingQuantity), 0)
```

`afterCompany` の元は `contractsAfterOverdue`（`runner.ts:1515`）であり、
これは `state.contracts` へ書き戻される値そのもの（`runner.ts:1837`）。
**summary は ledger の期末状態を同一 turn で射影しただけ**である。
`Math.round(x*100)/100` の丸めのみが差の原因になりうるが、実測の最大差は 1.5e-11。

→ **判定: canonical projection。bug / timing difference / semantic difference のいずれにも該当しない。**

### 8seed 平均の並置（抜粋。全表は §7）

| 会社 | T | ledgerTotal | ledgerOverdue | ledgerFwd | summaryOut | summaryOvd |
|---|---|---:|---:|---:|---:|---:|
| MASS | T32 | 54,766.5 | 18,430.3 | 36,336.2 | 54,766.5 | 18,430.3 |
| BAL | T32 | 0 | 0 | 0 | 0 | 0 |
| JPQ | T32 | 35,708.7 | 14,478.3 | 21,230.4 | 35,708.7 | 14,478.3 |
| VAP | T32 | 30,872.4 | 12,825.0 | 18,047.4 | 30,872.4 | 12,825.0 |
| CONSV | T32 | 12,170.2 | 162.0 | 12,008.2 | 12,170.2 | 162.0 |

---

## 7. 32Turn reconciliation（DS3 8seed 平均）

| 会社 | T | ledgerTotal | ledgerOverdue | ledgerFwd | summaryOut | summaryOvd | AI total（前期末） | AI overdue |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| MASS | T8 | 15,515.6 | 1,750.2 | 13,765.4 | 15,515.6 | 1,750.2 | 13,551.7 | 589.3 |
| MASS | T16 | 17,842.8 | 5,656.0 | 12,186.8 | 17,842.8 | 5,656.0 | 19,222.1 | 5,337.2 |
| MASS | T24 | 14,946.5 | 0 | 14,946.5 | 14,946.5 | 0 | 7,761.7 | 0 |
| MASS | T28 | 37,142.5 | 2,446.1 | 34,696.4 | 37,142.5 | 2,446.1 | 30,536.5 | 386.9 |
| MASS | T32 | 54,766.5 | 18,430.3 | 36,336.2 | 54,766.5 | 18,430.3 | 54,099.2 | 19,436.0 |
| BAL | T8 | 8,022.0 | 0 | 8,022.0 | 8,022.0 | 0 | 7,131.6 | 0 |
| BAL | T16 | 18,294.3 | 1,023.3 | 17,271.0 | 18,294.3 | 1,023.3 | 16,214.4 | 612.5 |
| BAL | T24 | 1,018.3 | 0 | 1,018.3 | 1,018.3 | 0 | 1,243.9 | 0 |
| BAL | T28 | 464.4 | 0 | 464.4 | 464.4 | 0 | 131.7 | 0 |
| BAL | T32 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| JPQ | T8 | 10,486.9 | 1,482.6 | 9,004.2 | 10,486.9 | 1,482.6 | 9,520.3 | 891.3 |
| JPQ | T16 | 14,854.7 | 5,905.3 | 8,949.4 | 14,854.7 | 5,905.3 | 14,720.7 | 4,442.4 |
| JPQ | T24 | 10,494.5 | 0 | 10,494.5 | 10,494.5 | 0 | 7,244.8 | 0 |
| JPQ | T28 | 22,846.8 | 1,535.6 | 21,311.2 | 22,846.8 | 1,535.6 | 18,986.0 | 229.2 |
| JPQ | T32 | 35,708.7 | 14,478.3 | 21,230.4 | 35,708.7 | 14,478.3 | 34,880.1 | 11,699.1 |
| VAP | T8 | 14,122.5 | 4,182.4 | 9,940.2 | 14,122.5 | 4,182.4 | 9,473.3 | 3,258.5 |
| VAP | T16 | 13,308.8 | 7,762.9 | 5,545.9 | 13,308.8 | 7,762.9 | 14,729.0 | 8,716.9 |
| VAP | T24 | 17,833.2 | 2,117.2 | 15,716.0 | 17,833.2 | 2,117.2 | 15,966.1 | 1,986.3 |
| VAP | T28 | 16,888.2 | 556.3 | 16,331.9 | 16,888.2 | 556.3 | 14,902.0 | 677.9 |
| VAP | T32 | 30,872.4 | 12,825.0 | 18,047.4 | 30,872.4 | 12,825.0 | 31,222.9 | 8,859.0 |
| CONSV | T8 | 8,711.4 | 565.8 | 8,145.6 | 8,711.4 | 565.8 | 7,755.4 | 448.4 |
| CONSV | T16 | 13,871.5 | 5,391.6 | 8,479.8 | 13,871.5 | 5,391.6 | 12,748.0 | 4,479.8 |
| CONSV | T24 | 3,432.2 | 0 | 3,432.2 | 3,432.2 | 0 | 4,617.5 | 62.1 |
| CONSV | T28 | 5,260.3 | 0 | 5,260.3 | 5,260.3 | 0 | 4,065.4 | 0 |
| CONSV | T32 | 12,170.2 | 162.0 | 12,008.2 | 12,170.2 | 162.0 | 10,234.7 | 0 |

**不一致件数 0 / 1,280 観測点。最大差 1.455e-11。**

AI 列が ledger 列とずれているのは **1四半期のタイミング差**（AI は turn 開始時 =
前期末の ledger を見る）であり、semantics の差ではない。

---

## 8. Commercial Commitment への接続確認（§8）

SAI-GROW-3B-3 / Deliverable Commitment が使う 2 field の出所:

```
policy.ts → computeDeliverableCommitment({
    overdueBacklogByProduct:       observation.overdueBacklogByProduct,
    healthyForwardBacklogByProduct: observation.healthyForwardBacklogByProduct,
})
          ↑
observation.ts:119-131  backlogByProductSplit(ownState, period)
          ↑
ownState.contracts   ← runner.ts:555  state.contracts.filter(c => c.companyId === …)
          ↑
state.contracts      ← runner.ts:1837  contractsAfterOverdue（= ledger 期末状態）
```

**ledger を直接読んでおり、途中に別の集計層は無い。**

canonical 定義との比較:

| 項目 | canonical（§5） | AI（`backlogByProductSplit`） | 一致 |
|---|---|---|---|
| 対象 status | open / partiallyFulfilled / overdue | 同一（`c.status !== 3種` で除外） | ✔ |
| 数量 | `outstandingQuantity` | 同一 | ✔ |
| overdue 条件 | `dueDate <= asOfPeriod` | `status === "overdue" \|\| dueDate < period` | ✔（下記） |
| 集約 | 会社合計 | **商品別**（合計すれば同値） | ✔ |
| timing | 期末 | **turn 開始時（前期末）** | 1Q 差（仕様） |

overdue 条件が形式上異なる点について: AI は turn 開始時に観測するため `period` は当期。
前期末に `dueDate < period` の契約は既に `status === "overdue"` へ更新済みなので
第1項で捕捉される。第2項 `dueDate < period` は §2-2 の
「overdue → 部分履行で status が落ちる」ケースを補う冗長条件であり、
**実測（1,280 観測点）で status 基準と dueDate 基準の overdue が完全一致**している。

→ **判定: AI field は canonical。SAI-COMMIT-1 の blocking issue には該当しない。**

---

## 9. UI / Databook との関係

| 参照元 | 参照先 | 判定 |
|---|---|---|
| Player 画面「受注残」`backlogView.ts` | summary #2 / #3 | canonical |
| Company Lab `ResultsPanel` / `ComparisonPanel` | summary #2 / #3 | canonical |
| Excel / API export `exportDto.ts` | summary #2 / #3 | canonical |
| 契約明細 export `contractDto.ts` | ledger 契約別 | canonical |
| Decision Studio `decisionStudioViewModel.ts:58-60` | ledger 直読み・status 3種フィルタ | **canonical**（#2 と同式） |
| **Opening 画面 `OpeningCompanyStatePanel.tsx:54`** | ledger 直読み・**status フィルタなし** | **非 canonical（latent）** |

### OpeningCompanyStatePanel の問題（現状は無害）

```ts
const backlogTons = ownState.contracts.reduce((sum, c) => sum + (c.outstandingQuantity as number), 0);
```

status を見ずに全契約を合計している。`fulfilled` は outstanding = 0 なので影響しないが、
**`cancelled` 契約の outstanding も加算してしまう**。

現状で不一致が出ない理由: `cancelContract` は engine / UI から**一度も呼ばれておらず**
（`sales/index.ts` で export されているだけ）、cancelled 契約は発生しない。
実測でも全 1,280 観測点で `cancelledOutstanding = 0`。

→ 「画面では受注残があるが意思決定資料では 0」型の不一致とは**構造が異なる**
（あちらは参照先の欠落、こちらは除外規則の欠落）。将来キャンセルを導入した時点で
画面だけ過大表示になる **latent bug** であり、SAI-COMMIT-1 の blocking ではない。

---

## 10. Canonical proposal

```
Backlog SSoT:
  CompanyLabState.contracts[]（app/lib/v2/companyLab/types.ts:208）
  lifecycle の唯一の変更点は app/lib/v2/sales/backlog.ts

Total Outstanding:
  Σ contract.outstandingQuantity
    where contract.status ∈ { "open", "partiallyFulfilled", "overdue" }
    （= status ∉ { "fulfilled", "cancelled" }）

Overdue:
  Σ contract.outstandingQuantity
    where status ∈ 上記 3種 AND contract.dueDate <= asOfPeriod

Healthy Forward:
  Σ contract.outstandingQuantity
    where status ∈ 上記 3種 AND contract.dueDate >  asOfPeriod

  恒等式 Total = Overdue + HealthyForward は 1,280 観測点で成立（最大差 1.455e-11）

Quarter timing:
  期末（turn end）。runner.ts:1371-1373 の
  applyFulfillments → updateContractStatusesForQuarterEnd(…, nextPeriod) 適用後。
  asOfPeriod = その turn の period。
  Standard AI は turn 開始時に観測するため、AI が見る値は「前期末」の同一定義値。
  比較時は必ず turn を揃えること。

Summary fields:
  CompanyQuarterSummary.outstandingQuantity → canonical projection
  CompanyQuarterSummary.overdueQuantity     → canonical projection
  （追加の healthyForward field は現状存在しない。必要なら outstanding − overdue で導出可能）

AI fields:
  overdueBacklogByProduct / healthyForwardBacklogByProduct → canonical
  （timing が 1Q 前であることのみ明示すればよい。修正不要）

UI:
  backlogView / ResultsPanel / ComparisonPanel / exportDto / contractDto /
  decisionStudioViewModel → canonical
  OpeningCompanyStatePanel.tsx:54 → needs correction（latent。status フィルタ追加）
```

---

## 11. Stop Conditions の判定

| 条件 | 判定 | 根拠 |
|---|---|---|
| ledger 自体に二重計上がある | **該当なし** | 契約単位で outstanding は1箇所のみ保持。過剰履行は例外で拒否 |
| partial fulfillment semantics が壊れている | **該当なし** | `applyQuantityToContract` が上限を検証。恒等式が全観測点で成立 |
| summary と ledger が大きく不一致 | **該当なし** | 1,280 観測点で不一致 0、最大差 1.455e-11 |
| overdue + forward != total | **該当なし** | 最大差 1.455e-11 |
| AI が別 semantic の backlog を使っている | **該当なし** | 同一 ledger・同一除外規則。timing 1Q 差のみ（仕様） |
| UI と Engine の定義が異なる | **該当なし（1件 latent）** | 主要経路は全て canonical。OpeningCompanyStatePanel のみ除外規則欠落だが、cancelled が発生しないため現状差は 0 |

**→ SAI-COMMIT-1 開始可能。**

---

## 12. 付録: SAI-CAP-1 §3 の前提が正しかったことの確認

本監査の過程で #04 branch を参照したところ、ENG-FAC-1（`capex/factoryLifecycle.ts`）が
存在した。SAI-CAP-1 で「ENG-FAC-1 が merge されても bindingCapacity 側の変更なしに
追従する」と述べた前提を実物で検証した結果、**成立していた**。

```
factoryConstruction.ts（#04 branch）
  MOTHBALLED   → FactoryStatus = "idle"      → calculateFactoryEffectiveCapacity が能力0
  SALE_PENDING → FactoryStatus = "suspended" → 同上
  SOLD         → Factory[] から除去
  適用点はコメントで「ENG-FAC-1・実装指示§2 canonical point」と明示
```

`FactoryStatus` 型自体は `"active" | "idle" | "suspended"` のまま拡張されておらず、
lifecycle は既存の canonical 経路へ写像される設計。
CAP-1 の物理能力 SSoT は `calculateFactoryEffectiveCapacity` に委譲しているため、
**ENG-FAC-1 merge 時に SAI-CAP-1 側の変更は不要**（推測ではなく #04 実装の実読による確認）。
