# Standard AI Capability Expansion — Phase CE-3 Quality Mechanics Audit

Branch: `feature/v2-32q-management-console`
HEAD at audit time: `bf5f63fbb3b3f2888c38d6b8ced93ae370b6c318` (audit only — no code changed)

This is an audit-only deliverable. Per explicit instruction, **no Quality effect
implementation, no Standard AI candidate connection, and no parameter tuning
were performed this phase.** Only this document is committed/pushed.

---

## 1. Is `qualityControlEquipment` connected to any state / score / formula?

**No.** `qualityControlEquipment` is a real `CapitalProjectType`
(`app/lib/v2/capex/types.ts`) with a full cost/payment-schedule/asset-category
template (`app/lib/v2/capex/parameters.ts`) and a factory-space footprint
(`app/lib/v2/production/factorySpace.ts`, 600 units). It goes through the
entire generic CAPEX lifecycle (`proposed → approved → underConstruction →
completed`) exactly like `hosoLineExpansion`/`pdMechanization`/etc., and its
cost is real (depreciation + maintenance flow into SG&A/cashflow like any
other completed CAPEX project).

Grepping the whole codebase (`capex/factoryConstruction.ts`,
`production/capacity.ts`, every file under `app/lib/v2/quality/`,
`companyLab/premiumPolicy.ts`, `sales/allocation.ts`) for any reference from
`qualityControlEquipment` (or its `CapitalProject` records) to the quality
module returns **zero matches**. There is no code path anywhere that reads a
`qualityControlEquipment` project's existence, budget, or completion status
and feeds it into any quality-related calculation.

**This is explicitly, deliberately documented as intentional**, not an
oversight. The inline comment at the template definition
(`capex/parameters.ts`, `qualityControlEquipment` entry) states:

> 【実装指示§7】品質・環境設備は今回、生産能力を増加させない（targetProduct省略・
> capacityIncreaseTonsPerQuarter=0）。固定資産振替・減価償却・固定保守費は他の
> 案件種別と同様に適用される。**品質・環境面の実際の効果（品質スコア・事故率・
> 規制遵守等への接続）は対象外であり、現時点ではコスト（減価償却＋保守費）のみ
> が発生し操業上の便益が無い。**通常のプレイヤー向け提案候補として安易に推奨
> される投資ではないことに留意（`docs/v2/CAPITAL_INVESTMENT_ARCHITECTURE_v0.1.md`参照）。

The referenced architecture document (`docs/v2/CAPITAL_INVESTMENT_ARCHITECTURE_v0.1.md`,
§10 "Phase 8B-2Bとの境界") confirms this was scoped out of the original CAPEX
module build (Phase 8B-2A) as a deliberate, explicitly-listed exclusion —
capacity/effect calibration for these two project types was left as a
placeholder (`futureCapacityEffect`はプレースホルダのみ) pending a later phase
that, per this audit, was never subsequently implemented anywhere in the
codebase.

## 2. Does Quality Score have a direct or indirect effect on anything?

**Yes — Quality Score itself is a real, wired mechanic**, just not one that
any investment feeds into. The chain is:

- `quality/operationalRisk.ts` computes a 0–1 operational-risk composite from
  six purely *operational* stress factors: equipment/labor utilization,
  overtime rate, temporary-worker share, product-mix complexity, raw-material
  age, and production-ramp speed. None of these six inputs is an investment
  or spend decision.
- `quality/qualityOutcome.ts` converts that risk (+ a random major-incident
  draw) into `nonConformanceRatio` → `downgradeRatio`/`reworkRatio`/
  `discardRatio`, and an `observedQualityScore` = `baselineOperationalQuality`
  (a **fixed constant, 85**, from `QUALITY_PARAMETERS_V1`) minus risk/incident
  penalties. No company or investment ever changes this baseline constant.
- `quality/scoreUpdates.ts` applies an asymmetric EWMA (fast-down, slow-up)
  to turn the per-quarter observed score into the persisted Quality Score
  per company × product (`ownState.qualityScoreByProduct` /
  `observation.qualityScoreByProduct`, `companyLab/types.ts`).

That persisted Quality Score **is** consumed downstream:
- `sales/allocation.ts`'s `computeCompetitivenessBreakdown()` reads
  `entry.qualityReputation` (populated directly from
  `qualityScoreByProduct[product]` — confirmed in
  `standardAi/decision/sales.ts`, `standardAi/diagnosis/marketOpportunity.ts`,
  `companyLab/autoPolicy.ts`) and weights it via
  `competitivenessWeights.quality` into the contract-allocation
  water-filling algorithm, for **all three products** (HOSO/PD/VAP), not
  just VAP.
- `companyLab/premiumPolicy.ts`'s `calculateCompanyCapabilityCoefficient()`
  (the VAP-only composite CE-2 audited) also reads a quality score input at
  20% weight, feeding `vapCapabilityContribution` in the same allocation
  algorithm for VAP specifically.
- `quality/scoreUpdates.ts`'s `updateCustomerTrustScore()` also folds the
  observed quality score into the Customer Trust score.

So Quality Score has real, wired, materially-significant downstream effects
— but the *only* levers that move it are operational (utilization, overtime,
temp-worker mix, complexity, raw-material freshness, production ramp), which
already exist as production/labor/procurement decisions elsewhere in the
game, not as a dedicated "quality investment."

## 3. Is there any effect on "CTS-Q"?

**"CTS-Q" does not exist anywhere in the codebase.** Grepped
`app/lib/v2/quality/*.ts`, `companyLab/qualitySummary.ts`, and the broader
codebase for the literal string "CTS" — zero matches. This term from the
instruction does not correspond to any implemented metric. The closest real
analogs are `operationalRisk` (0–1 composite) and the persisted Quality Score
(0–100) described in §2 above.

## 4. Is there any effect on "QRP" / downgrade / rework / disposal / quality incidents?

**"QRP" (Quality Risk Point) does not exist as a named term** — the closest
real analog is `operationalRisk` (§2). **Downgrade/rework/disposal ARE real,
wired mechanics**: `quality/qualityOutcome.ts`'s `calculateQualityOutcome()`
produces `downgradeRatio`, `reworkRatio`, and `discardRatio` every quarter
from `operationalRisk` + a random `majorIncident` draw
(`quality/majorIncident.ts`). `discardRatio` has a *real quantity effect*
(reduces `saleableRecoveryRatio`, i.e., actual product is lost); downgrade/
rework are recorded but (per Phase 7A's own documented scope,
`qualityOutcome.ts` header comment) do not reduce saleable quantity this
phase.

`qualityControlEquipment` has **zero connection** to any of
`calculateNonConformanceRatio`, `calculateQualityOutcome`,
`calculateMajorIncidentDiscardRatio`, or `calculateMajorIncidentProbability`
— confirmed by the same exhaustive grep as §1.

## 5. Effect on sales competitiveness / price premium / contract allocation?

**Quality Score (the outcome-driven state, §2) — yes, real and wired**, via
`sales/allocation.ts`'s competitiveness weighting for all three products and
`premiumPolicy.ts`'s VAP capability composite. **`qualityControlEquipment`
itself — no**, it has no path into either of those functions.

## 6. Are there other PLAYER-selectable Quality-related investments/spend?

Searched `CompanyDecisionInput` (`companyLab/types.ts`) and the PLAYER
decision UI (`app/v2/company-lab/components/DecisionEditor.tsx`) for any
quality-labeled spend field or control. **None exists.** The only
PLAYER-controllable field that is quality-*adjacent* is
`vapProductDevelopmentSpendUsd` (already connected to Standard AI in CE-2),
which feeds `premiumPolicy.ts`'s VAP capability composite at 40% weight
alongside the 20%-weighted quality-score input described in §2 — but that
composite is explicitly a *product-development/competitiveness* score, not a
quality-safety/defect-reduction lever, and CE-2 did not touch the quality
module at all. No certification, training, or R&D-labeled spend field exists
anywhere (grepped `quality/*.ts` and `companyLab/types.ts` for these terms —
zero matches).

## 7. Which of the above are actually wired to game outcomes?

| Mechanic | Wired to game outcomes? |
|---|---|
| Quality Score (outcome-driven, `quality/scoreUpdates.ts`) | **Yes** — feeds sales competitiveness (all products) + VAP capability composite + Customer Trust |
| `operationalRisk` (six operational stress factors) | **Yes** — the sole driver of Quality Score/downgrade/rework/disposal/major-incident probability |
| `downgradeRatio`/`reworkRatio`/`discardRatio` | **Yes** — `discardRatio` reduces saleable quantity; downgrade/rework are recorded (no quantity effect yet, per Phase 7A's documented scope) |
| `vapProductDevelopmentSpendUsd` (CE-2) | **Yes** — but feeds VAP capability composite, not the quality module |
| `qualityControlEquipment` (CAPEX) | **No** — cost/schedule/space only, zero connection to any quality metric (deliberately scoped out at Phase 8B-2A, per §1) |
| "CTS-Q" | Does not exist |
| "QRP" | Does not exist as a named term (closest real analog: `operationalRisk`) |

## 8. Is `qualityControlEquipment` an "unfinished mechanic" or a "different-purpose investment"?

Based on the primary-source documentation found (§1), it is best described as
**an intentionally cost-only placeholder whose effect-wiring was explicitly
deferred at Phase 8B-2A** ("品質・環境面の実際の効果...は対象外") — not an
accidental gap, and not a deliberately different-purpose investment (e.g.,
it is not framed as a compliance-only or cosmetic project; the same comment
explicitly names "品質スコア・事故率・規制遵守等への接続" as the intended
future effect surface). No later phase in this codebase (Phase 8C onward,
including Test15's PD Mechanization/VAP Product Development builds, or this
CE-1/CE-1.1/CE-2 arc) picked up that deferred work. So: **unfinished, by the
codebase's own documented intent, and still unfinished today.**

## 9. Can the originally-intended effect be reconstructed from spec/comments/tests?

**Partially, at the level of intent, but not at the level of a concrete
formula.** The comment names the intended effect *surface* precisely
("品質スコア・事故率・規制遵守等への接続" — connection to quality score,
incident rate, regulatory compliance) but specifies no magnitude, elasticity,
or functional form (e.g., "$1.2M reduces operationalRisk by X%" or "reduces
majorIncident probability by Y"). No test file anywhere asserts an expected
quality effect for `qualityControlEquipment` — grepped
`capex/__tests__/*.test.ts` and `companyLab/__tests__/*quality*.test.ts` for
any such assertion; none exists, confirming the effect was never even
speculatively coded and then tested. `docs/v2/CAPITAL_INVESTMENT_ARCHITECTURE_v0.1.md`
confirms this was a known, explicit, listed exclusion at the time (§10) —
not a lost design. **Reconstructing a concrete formula would require new
game-design decisions (what magnitude, what functional form, which of
operationalRisk/majorIncident/baselineOperationalQuality it should move),
not code archaeology.** This is exactly the kind of fabrication §5 of this
phase's instructions forbids Claude Code from doing unilaterally.

---

## Summary

Quality Score, `operationalRisk`, and downgrade/rework/disposal are all real,
wired, outcome-driven mechanics with genuine effects on sales competitiveness
and product yield — but nothing in the current codebase lets a company invest
to move them. `qualityControlEquipment` is the only quality-labeled
investment vehicle that exists, and it is cost/schedule real but effect-free
by explicit, documented design choice at Phase 8B-2A, never completed since.
No other PLAYER-selectable quality-related spend exists. CE-3 as originally
scoped ("connect Standard AI to an existing, fully-implemented Quality
investment") cannot proceed without first designing and building the missing
effect — a game-mechanics decision, not an engineering connection, and
therefore outside what this audit or Claude Code should decide unilaterally.

No code was changed. No tests were added or modified. No benchmark was run.
STANDARD_AI_PROPOSABLE_CAPEX_TYPES, reasonCodes.ts, parameters.ts, and every
other Standard AI file remain exactly as they were at the front HEAD of this
phase.
