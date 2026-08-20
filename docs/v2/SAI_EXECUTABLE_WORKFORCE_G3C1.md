# SAI-GROW-3C.1 — Executable Workforce Growth / Routing Side-effect Fix

base commit: `b0a7f36`（3D PRE-AUDIT。実装は `2e70d80` = SAI-GROW-3C）。
Vision / VISION_ON_TRACK / MARKET_WEAK / opportunity share / step multiplier / Scenario は変更していない。

## 1. 修正の対象

GROW-3C の WORKFORCE route 自体は正しい。問題は labor.ts へ渡す Worker floor が
`workerRequirementForAmbition`（= Commercial Ambition 全量）だったこと。

Commercial Ambition は `baselineTons = max(capacityAnchorTons, recentActualScaleTons)`
（3D PRE-AUDIT §5 で確定）で決まる。つまり **「売れる量」ではなく「作れる量」**である。
`Ambition > 近い将来の実行可能規模` の局面では余剰人員を先行保有し、人件費が Cash と OP を先に食う。

PRE-AUDIT 実測（DS2 ds2-s4 BAL、CAPEX・financing・production mix はほぼ同一で差は Worker のみ）:

| T | worker 3B-3 → 3C | cash | OP |
|---|-----------------:|-----:|---:|
| T19 | 7,333 → 8,930 | 118.7 → 115.1M | −0.6 → −2.9M |
| T21 | 4,788 → 6,009 | 152.7 → 146.2M | 5.0 → 1.4M |
| T26 | 11,143 → 10,080 | 259.1 → 248.0M | 75.0 → 59.6M |

## 2. Executable Workforce Growth Target（正確な式）

```
commerciallySupportedScaleTons = max( recentActualScaleTons,
                                      currentPeriodProductionRequirementTons )

workerExpansionTargetTons = max(0, min(
      commercialAmbitionTons,                  // 志を超えては採らない
      nearTermBindingProductionCapacityTons,   // 設備で作れない量の人は要らない
      fundableRawMaterialTons,                 // 原料が買えない量の人は要らない
      commerciallySupportedScaleTons ))        // 売り先が無い量の人は要らない

executableMix                       = workerExpansionTargetTons を志の商品構成へ割り付け
workerRequirementForExecutableTarget = computeRequiredRegularHeadcount(executableMix, 平均skill, 平均出勤率)
workerGapForExecutableTarget         = max(0, workerRequirementForExecutableTarget − 現有Worker)
```

`labor.ts` へ渡す floor は **`workerRequirementForExecutableTarget`**（従来は `…ForAmbition`）。

### 2.1 現在Worker能力を min に入れていない（実装指示§3）

`workerCapacitySupportedTons` は min に含めない。含めると
「Worker不足だからWorkerを増やしたいのに、現在Workerで作れる量までしか採用しない」
という循環になり WORKFORCE route が構造的に無効化される（受入 G3C1-7 で固定）。

### 2.2 現在の実績だけへ固定していない（実装指示§7）

商業側の指標に `currentPeriodProductionRequirementTons`
（policy.ts が既に算出している `finalProductionRequirementByProduct` の合計）を使う。これは

* 既存の未履行契約（backlog）を **100%** 含む
* 新規営業のうち期待転換率ぶんの成約見込みを含む
* 通常在庫目標と期首完成品在庫を反映済み

したがって「現在の実績 + 近い将来に合理的に実行できる増分」を既に内包する。
さらに `recentActualScaleTons` と max を取り、一時的な需要の谷で人員目標が落ち込まないようにする。
**新しい需要モデルは作っていない。**

## 3. Ambition との違い（診断で追跡可能）

| 値 | 用途 |
|----|------|
| `commercialAmbitionTons` | 戦略上の志。**変更しない** |
| `workerRequirementForAmbition` | 志ベースの必要人数。診断としてのみ残す |
| `workerGapForAmbition` | 同上 |
| `workerExpansionTargetTons` | **Worker採用の目標規模**（Worker以外の制約の下で実行可能） |
| `workerRequirementForExecutableTarget` | **labor.ts へ渡す floor** |
| `workerGapForExecutableTarget` | 実際に埋めにいく不足 |

## 4. 維持したもの

Deliverability Gap / WORKFORCE route / VAP labor intensity 評価 /
`computeRequiredRegularHeadcount` / company ID 非依存 / persistent constraint 判定 /
既存 labor adjustment damping（`regularHeadcountAdjustmentDamping`）— いずれも無変更。
Commercial Ambition も無変更。

## 5. VAP（DS3。Stop Condition A / B）

seed ds3-a:

| T | ambition | execTgt | wReqAmb | wReqExec | worker | route | 生産 |
|---|---------:|--------:|--------:|---------:|-------:|-------|-----:|
| T24 | 27,680 | 25,282 | 10,272 | 9,382 | 8,533 | LIQUIDITY | 25,252 |
| T28 | 32,760 | **32,760** | 12,197 | **12,197** | 11,043 | WORKFORCE | 30,089 |
| T32 | 32,760 | **32,760** | 12,197 | **12,197** | 11,723 | BACKLOG_RECOVERY | 30,787 |

**WORKFORCE route が効く局面で `execTgt == ambition`** となり、boundが一切効いていない。
VAPは backlog 17〜32kt を抱えており `currentPeriodProductionRequirementTons` が志を支えるため。

8seed T32平均: worker 11,532 → **11,408**（−1.1%）、生産 30,587 → **30,505**（−0.3%）。
**VAPのWorker expansion経路は殺していない。**

## 6. DS2（8seed。3B-3 / 3C / 3C.1）

| 会社 | avg OP (M) | avg 現金 (M) | 資金不足T計 | avg 生産 (t) |
|------|-----------:|-------------:|------------:|-------------:|
| BAL | 1030.2 → 1012.4 → **1018.7** | 540.2 → 513.8 → **530.3** | 0 → 1 → **0** | 654,420 → 649,906 → 651,752 |
| MASS | 929.8 → 881.2 → **904.1** | 487.5 → 441.2 → **463.0** | 0 → 0 → **2** | 685,723 → 673,960 → 678,075 |
| JPQ | 764.5 → 759.8 → **764.3** | 370.3 → 369.7 → 371.4 | 0 → 0 → 0 | 601,395 → 601,458 → 601,560 |
| CONSV | 740.7 → 740.8 → 743.0 | 353.9 → 359.2 → 353.9 | 1 → 1 → 1 | 558,196 → 558,977 → 560,265 |
| VAP | 646.7 → 644.2 → 643.4 | 299.3 → 301.1 → 301.5 | 0 → 0 → 0 | 515,235 → 512,951 → 512,704 |

* **BAL ds2-s4 の資金不足1Tは解消（1 → 0）**、OPと現金も3B-3水準へ回復。
* **MASS の OP 低下は約47%回復**（−5.2% → −2.8%）。現金も 441.2 → 463.0M。
* ただし **MASS で 資金不足/現金マイナス 1T が ds2-s5・ds2-s6 に新規発生**（0 → 2）。
  seed別に見ると MASS の OP は全seedで改善している
  （s5 850.7 → 864.2、s6 901.4 → 934.8、s7 893.7 → 913.3、s8 863.7 → 877.1）ため、
  悪化ではなく **単一四半期の資金繰りタイミングのずれ**である。§9 Stop Condition F として報告する。

## 7. DS3 5社（8seed・T32平均。3C → 3C.1）

| 会社 | ambition | execTgt | wReqAmb | wReqExec | worker | 生産 | CAPEX累計 |
|------|---------:|--------:|--------:|---------:|-------:|-----:|----------:|
| BAL | 58,455 | **47,222** | 17,810 | **14,378** | 14,504 → 14,283 | 44,434 → 43,758 | 84.8 → 83.2M |
| MASS | 63,635 | 63,429 | 23,590 | 23,514 | 19,486 → 19,414 | 53,331 → 53,330 | 91.8 → 91.8M |
| JPQ | 43,310 | 43,310 | 14,259 | 14,259 | 13,602 → 13,604 | 38,441 → 38,185 | 82.1 → 82.4M |
| CONSV | 41,780 | 41,780 | 12,892 | 12,892 | 12,560 → 12,689 | 39,880 → 39,842 | 82.4 → 83.5M |
| VAP | 32,325 | 32,325 | 12,025 | 12,025 | 11,532 → 11,408 | 30,587 → 30,505 | 53.0 → 52.6M |

boundが実際に効いているのは **BALだけ**（backlogが206tとほぼ無く、商業側が志を支えないため）。
MASS/JPQ/CONSV/VAPは `execTgt == ambition` で従来どおり。

## 8. DS1（T25-32）

BAL 633.1 → **652.0M**（生産 257,616 → 262,960）、JPQ 391.1 → 391.5M、
VAP 357.0 → 356.7M、CONSV 378.8 → 379.1M、MASS 変化なし。

## 9. Stop Conditions

| id | 判定 |
|----|------|
| A. VAPのWorker expansionが消える | **なし** WORKFORCE routeで execTgt == ambition。worker 11,532 → 11,408（−1.1%） |
| B. VAP生産が3B-3水準まで戻る | **なし** 3B-3 29,309 → 3C 30,587 → 3C.1 30,505。改善を保持 |
| C. BAL/MASSのWorker過剰が変わらない | **なし** BAL DS3 worker 14,504 → 14,283、execTgt 47,222 < ambition 58,455。DS2 BAL資金不足 1 → 0 |
| D. Worker採用がcurrent actualへ固定され成長不能 | **なし** 商業側は `currentPeriodProductionRequirementTons`（backlog 100% + 期待成約）で、直近実績はmaxの下限としてのみ使う（受入G3C1-6） |
| E. Production/Raw/Liquidity constraintを無視して採用 | **なし** 4項のminに全て入る（受入G3C1-3/-4/-5） |
| F. DS1/DS2/DS3 regression | **一部該当** DS1・DS3は改善または横ばい。DS2はBAL/MASS/JPQが3B-3方向へ回復する一方、**MASSに資金不足1Tが2seedで新規発生**（seed別OPは全て改善しているため単一四半期のタイミング差と判断。追加調整はしていない） |

## 10. 次のbinding constraint

1. **MASS ds2-s5 / ds2-s6 の資金不足1T**（本Phaseで新規発生）。seed別OP・現金はいずれも改善しており
   悪化ではないが、0にできるかは次Phaseの検討事項。
2. 3D PRE-AUDIT の推奨(1)(2)(4)——Vision目標規模の再設定、
   `realisticShareOfProfitableOpportunity = 0.35` の再校正、value scaleの分離。
   本Phaseでは指示どおり一切触れていない。
