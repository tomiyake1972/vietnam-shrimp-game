# Quality Control Equipment — Game Mechanics Design (Phase QI-D1)

Branch: `feature/v2-32q-management-console`
HEAD at design time: `f344a68` (design only — no code changed this phase)

This is a **design document only**. No game-effect code, no parameter values,
no Standard AI connection were implemented this phase, per explicit
instruction. All formulas below reuse existing code paths; where a new
parameter is proposed, it is marked as a *suggested range*, not a
production value.

---

## 2. Quality Score — complete trace (SSoT)

- **SSoT**: `CompanyProductQualityState[]` inside `QualityReliabilityState`
  (`app/lib/v2/quality/types.ts`), keyed by `companyId × product`. Persisted
  as part of `CompanyLabState` and read out via
  `CompanyOwnState.qualityScoreByProduct` (`companyLab/types.ts:211`).
- **Initial value**: `params.qualityOutcome.baselineOperationalQuality` = 85
  for every company × product at game start
  (`quality/stateUpdate.ts::initializeQualityReliabilityState`).
- **Quarter update formula**: two-step.
  1. **Aggregation across factories** (`stateUpdate.ts::updateQualityByCompanyProduct`):
     for each company × product, take that quarter's per-batch
     `observedQualityScore` values (one per factory that produced that
     product) and combine them as a **production-quantity-weighted average**
     (weight = `originalFinishedGoodsQuantity` of each batch). Company ×
     product combinations with zero production that quarter are left
     unchanged ("据え置く").
  2. **Asymmetric EWMA** (`scoreUpdates.ts::updateQualityScore` →
     `updateScoreAsymmetric`): `next = prev + alpha × (observed − prev)`,
     where `alpha = alphaDown` (0.20) if `observed < prev` (quality worsened,
     fast reaction) or `alpha = alphaUp` (0.08) if `observed ≥ prev` (quality
     improved, slow reaction) — deliberately asymmetric, "falls fast,
     recovers slowly."
- **Input signal** (per batch, i.e., per company × factory × product):
  `observedQualityScore = clamp(baselineOperationalQuality −
  qualityRiskPenaltyPerUnitRisk(30) × operationalRisk − majorIncidentPenalty,
  0, 100)` (`qualityOutcome.ts::calculateObservedQualityScore`).
- **Bounds**: `Score0to100`, hard-clamped [0, 100] at every step.
- **Smoothing/lag**: the EWMA alpha *is* the smoothing; there is no separate
  lag — the previous quarter's persisted score is the sole "memory," updated
  once per quarter.
- **Scope**: company × product (HOSO/PD/VAP each have their own Quality
  Score for each company). **Not factory-specific at the persisted-state
  level** — but the *input* to that state (batch-level
  `observedQualityScore`) **is** company × factory × product, and is
  aggregated up via the production-weighted average described above. This
  is the single most important structural fact for this design (see §9).
- **Downstream connections** (all confirmed by direct grep, no assumption):
  - **Sales**: `sales/allocation.ts::computeCompetitivenessBreakdown` reads
    `entry.qualityReputation` (populated from `qualityScoreByProduct[product]`
    in `standardAi/decision/sales.ts`, `standardAi/diagnosis/marketOpportunity.ts`,
    `companyLab/autoPolicy.ts`), weighted by
    `SalesParameters.competitivenessWeights.quality` into the
    water-filling contract-allocation algorithm, for **all three products**.
  - **Customer Trust**: `quality/scoreUpdates.ts::updateCustomerTrustScore`
    folds the *delivered* quality score (a separate per-market observation,
    not the raw company×product score) into Customer Trust at 50% weight
    (`customerTrustUpdate.qualityWeight`).
  - **VAP capability composite**: `companyLab/premiumPolicy.ts::
    calculateCompanyCapabilityCoefficient` reads a quality-score input at
    20% weight (`VAP_CAPABILITY_WEIGHTS_V1.quality`), feeding
    `vapCapabilityContribution` in the same sales-allocation algorithm,
    **VAP only**.

## Downgrade / rework / disposal formulas (§5)

All from `quality/qualityOutcome.ts`, computed once per batch (company ×
factory × product), fully deterministic given `operationalRisk` +
`majorIncident` draw:

- `nonConformanceRatio = maximumNonConformanceRatio(0.08) ×
  operationalRisk ^ nonConformanceExponent(1.5)`
- `downgradeRatio = nonConformanceRatio × downgradeShare(0.45)` — recorded,
  no saleable-quantity effect this phase (Phase 7A documented scope).
- `reworkRatio = nonConformanceRatio × reworkShare(0.25)` — recorded, no
  saleable-quantity effect this phase.
- `discardRatio = max(0, nonConformanceRatio × discardShare(0.30) +
  majorIncidentDiscardRatio)` — **real quantity effect**:
  `saleableRecoveryRatio = clamp(1 − discardRatio,
  minimumSaleableRecoveryRatio(0.90), 1)`, i.e. discard directly reduces
  saleable output, floored so a single quarter's discard can never exceed
  10% even under maximum risk + a major incident.
- **Major incident** (`quality/majorIncident.ts`):
  `probability = clamp(baseIncidentProbability(0.002) +
  maximumRiskIncidentProbability(0.08) × operationalRisk^riskExponent(2),
  0, maximumIncidentProbability(0.1))`, drawn via a seeded, deterministic
  RNG (`deriveQualityIncidentSeed(gameSeed, turn, companyId, factoryId, product)`
  — reproducible per (seed, turn, company, factory, product) tuple). When it
  occurs, `severity` (0–1, also seeded) scales additional discard/quality-
  penalty/trust-penalty via three linear coefficients
  (`severityToAdditionalDiscardRatio=0.5`, `severityToQualityPenalty=40`,
  `severityToTrustPenalty=25`).
- **All of the above is driven by `operationalRisk`, itself driven purely
  by 6 operational stress factors** (utilization/overtime/temp-worker-share/
  product-mix-complexity/raw-material-age/production-ramp,
  `quality/operationalRisk.ts`, weights sum to 1.0: 0.35/0.20/0.15/0.10/
  0.10/0.10). None of these six factors is influenced by any capital
  investment today.

## 6. `qualityControlEquipment` — existing structure

- **Cost**: $1.2M standard budget, payment schedule [0.6, 0.4] over 2
  quarters (`capex/parameters.ts`).
- **Asset category**: `"qualityEquipment"`, 0% building / 100% machinery,
  1.25%/quarter maintenance rate (5%/year).
- **Lead time**: 2 payment quarters, `readinessQuartersAfterCompletion: 0`
  (usable immediately upon completion, no separate ramp-up period defined
  at the CAPEX layer).
- **`targetFactoryId`**: **optional** (unlike `pdMechanization`, which
  requires it). Per `capex/types.ts:244`, an omitted `targetFactoryId`
  defaults to "primary factory" at approval time. A PLAYER (or a future
  Standard AI) *can* supply an explicit `targetFactoryId` to target a
  specific factory — the type system already supports factory-specific
  investment; it's just not required.
- **Space use**: 600 units (`production/factorySpace.ts`), same generic
  space-gate mechanics as every other CAPEX type.
- **Depreciation/maintenance**: flows through the generic CAPEX →
  finance/quarterClose.ts pipeline like any completed project — real cost,
  regardless of effect.
- **Completion timing**: standard generic CAPEX lifecycle
  (`proposed → approved → underConstruction → completed`), no special-cased
  logic anywhere (confirmed — `projectLifecycle.ts` only has bespoke checks
  for `pdMechanization` and `newFactoryConstruction`).
- **Duplicate rule**: **none exists today** beyond the generic
  `maxConcurrentActiveProjectsPerCompany` (3) cap — there is no
  `qualityControlEquipment`-specific "one per factory" guard analogous to
  `hasActiveProjectForSameFactory` for `pdMechanization`. If effects are
  wired, this gap should be closed at the same time (see §9/§26).
- **PLAYER investment path**: the *generic* investment-card grid in
  `DecisionEditor.tsx` (same path as `hosoLineExpansion` etc.) — not a
  bespoke factory-picker like `pdMechanization`'s.
- **Persistence**: generic `CompanyCapexState`/`CapitalProjectPortfolio`,
  same as every other CAPEX type — no special persistence exists or would
  be needed.

## 3/7/8. Effect insertion point — three candidates compared

**A dormant, unused hook already exists and is highly relevant**:
`quality/batchAdjustment.ts::applyQualityToBatches` accepts an optional
`baselineQualityOverride?: ReadonlyMap<string, number>` keyed by
`` `${companyId}::${product}` `` (line 62/131), read as
`input.baselineQualityOverride?.get(...) ?? baselineOperationalQuality`.
**It is never populated anywhere in the codebase today** (`companyLab/runner.ts`
never passes it). This strongly suggests a prior author anticipated exactly
this kind of "quality capability investment" feature and left a hook — but
because it is keyed by `companyId::product` (no `factoryId`), it **cannot**
express a factory-specific effect for a multi-factory company. This is a
real design tension, addressed below.

### Candidate A — reduce a quality-risk multiplier (upstream, on `operationalRisk`)

Multiply the computed `operationalRisk` (or a dedicated risk-reduction
factor applied just before it's consumed) by `(1 − reduction)` for batches
produced at an equipped factory, **before** it feeds
`calculateNonConformanceRatio` and `calculateMajorIncidentProbability`.

- Realism: high — equipment reduces the *chance* of quality problems, not
  a fixed downstream score; this matches real-world quality-control
  equipment (inspection/calibration gear reduces defect *rate*, doesn't
  guarantee zero defects).
- Code locality: excellent — one multiplication inside
  `applyQualityToBatches`, immediately before the existing
  `calculateOperationalRisk`/`calculateQualityOutcome` calls. No new
  aggregation code needed (see below).
- Double-counting risk: low — this is the *only* insertion point that sits
  upstream of both `nonConformanceRatio` (downgrade/rework/disposal) **and**
  `majorIncidentProbability` simultaneously, so one parameter naturally
  affects both outcome families without needing two separate coefficients.
- Explainability: high — "this factory's operational risk is reduced by
  X% because of its quality equipment" is a one-sentence, auditable
  explanation, directly traceable in diagnostics.
- AI observability: clean — Standard AI would only need to know "does this
  factory have completed quality equipment," mirroring
  `FactoryObservation.pdMechanization.hasActiveOrCompletedProject` exactly.
- Balance risk: moderate — a risk-reduction *percentage* is bounded and
  self-limiting (can't overshoot into negative risk); still needs a
  sensible suggested range (§16).
- Testability: high — `calculateOperationalRisk`/`calculateQualityOutcome`
  are pure functions; a reduced-risk input produces a mechanically
  predictable, easily-asserted output.

### Candidate B — reduce downgrade/rework/disposal probability or quantity directly

Apply the reduction to `nonConformanceRatio` (or its three shares) directly,
bypassing `operationalRisk`.

- Realism: acceptable, but weaker than A — real quality equipment mostly
  works by reducing the *conditions* that cause defects (i.e., risk),
  rather than filtering out defects after the fact.
- Code locality: good, but requires touching `calculateQualityOutcome`
  (adds a parameter to an already-parameter-rich pure function) rather than
  the risk composite alone.
- Double-counting risk: **higher** — `nonConformanceRatio` already feeds
  `calculateMajorIncidentDiscardRatio`'s conceptual sibling
  (`majorIncidentProbability`, which is a *separate* function of raw
  `operationalRisk`, not of `nonConformanceRatio`). Reducing only
  `nonConformanceRatio` would leave major-incident probability completely
  unaffected by quality equipment, which is inconsistent with "quality
  control equipment reduces the risk of quality events" as a general
  concept — a design gap Candidate A avoids for free.
- Explainability: moderate.
- AI observability: same as A.
- Balance risk: moderate, same considerations as A.
- Testability: high, similar to A.

### Candidate C — indirect correction at the Quarterly Quality Score calculation

Populate the existing (dormant) `baselineQualityOverride` map, raising
`baselineOperationalQuality` for a company × product when *any* of that
company's factories has completed quality equipment.

- Realism: weaker — this raises the *ceiling* quality score outcome
  regardless of that quarter's actual operational conditions, which is
  closer to "buy equipment → quality floor goes up" than "buy equipment →
  fewer things go wrong this quarter." It does NOT reduce
  `majorIncidentProbability` or `discardRatio`'s real quantity effect at
  all — it only shifts the *score* ceiling, leaving physical yield loss
  from major incidents/discard completely untouched by the investment.
- Code locality: technically the easiest (the hook already exists,
  `runner.ts` would just need to populate the map) — but this ease is
  deceptive because of the scope mismatch below.
- **Double-counting / scope-mismatch risk: highest of the three.** The
  hook is keyed `companyId::product`, i.e. **company-wide, not
  factory-specific**. Since `qualityControlEquipment` is (optionally)
  factory-targeted, using this hook would either (a) force a
  company-wide effect regardless of which factory has the equipment
  (contradicting the factory-specific nature of the investment, and
  making a 2-factory company's second, un-equipped factory get the same
  benefit for free), or (b) require extending the hook's key format to
  include `factoryId` and rewriting how it's consumed — a larger, riskier
  change than Candidates A/B for equivalent benefit.
- Explainability: lower — "quality is better because the baseline moved"
  is less concrete than "this factory's risk of a bad batch went down."
- AI observability: same underlying signal availability as A/B, but the
  effect itself is harder for a future Standard AI (or a human) to
  attribute to operational cause and effect, since it decouples score from
  observed operational risk this quarter.
- Testability: fine mechanically, but the *design* is testing a
  disconnected relationship (investment → score, bypassing the
  risk/incident chain that everything else in the module respects).

### Comparison verdict

**Candidate A is recommended.** It is the only option that (1) naturally
affects both the nonConformance family (downgrade/rework/disposal) and
major-incident probability from one parameter, (2) requires zero new
company-level aggregation logic (the existing production-weighted average
in `updateQualityByCompanyProduct` already correctly handles a
multi-factory company with equipment at only one factory — see §9), and
(3) keeps Quality Score's meaning intact: "an outcome-weighted reflection of
actual operational performance," not "a number that goes up because you
bought something," directly satisfying this phase's stated design principle
(§3) and success condition.

## 8. Direct Quality Score bonus — why not recommended

A flat "+X to Quality Score on completion" was explicitly required to be
considered and is rejected for the following reasons:

1. It severs Quality Score from `operationalRisk`, the sole mechanism that
   currently makes quality *mean* anything in this codebase (utilization/
   overtime/complexity/raw-material-freshness/ramp — all real operational
   choices already visible to PLAYER and Standard AI). A flat bonus would
   make Quality Score partially arbitrary rather than fully
   operations-derived, undermining the EWMA's entire "reacts to what
   actually happened" design (`scoreUpdates.ts`'s own header comment: "急落
   しやすく、回復は遅い" — designed around *observed* performance, not
   static ownership).
2. It has no natural saturation/decay behavior — a fixed bonus stacks
   awkwardly with the existing asymmetric EWMA (does the bonus apply once,
   every quarter, decay if the equipment is later "unused"? none of these
   map cleanly onto the existing state machine without new special-case
   code).
3. It cannot be de-duplicated for a multi-factory company without new,
   bespoke company-level bookkeeping (which factory's bonus counts, does a
   second unit stack?) — exactly the "double counting" risk item §3 asked
   to be evaluated against, and exactly the gap that makes Candidate A
   superior (its effect is naturally, automatically weighted by each
   factory's actual production share).
4. It directly contradicts this phase's own explicit stated preference
   (§3): "「設備購入 → Quality Scoreへ固定加点」よりも、「設備購入 →
   adverse quality outcomesの発生率を低減」を優先して検討する."

## 9. Factory-specificity

**Recommended: yes, factory-specific, using the existing per-batch
computation — no new aggregation formula needed.** `applyQualityToBatches`
already computes `operationalRisk`/`calculateQualityOutcome` once per
(company, factory, product) batch, and `updateQualityByCompanyProduct`
already aggregates those batch-level outcomes into the company × product
persisted score via a **production-quantity-weighted average**
(`weight = originalFinishedGoodsQuantity`). This is precisely the
"production-weighted aggregation" §9 asked to investigate, and it already
exists — the recommended design (Candidate A) only needs to know, per
batch, "does *this batch's* `factoryId` have a completed quality-equipment
project," and the existing aggregation does the rest automatically. A
two-factory company with equipment at Factory 1 only will see Factory 1's
batches contribute lower-risk `observedQualityScore` values, Factory 2's
batches contribute unchanged ones, and the weighted average will reflect
Factory 1's larger or smaller production share correctly — with zero new
formula.

## 10. Product sensitivity

**Recommended: no product differentiation — uniform effect across
HOSO/PD/VAP at the equipped factory.** `qualityControlEquipment` is
described in the codebase as general "品質管理設備" (quality control
equipment), not a product-specific device, and batches already carry
`product` independently — applying the same risk-reduction percentage to
every batch produced at the equipped factory (regardless of product)
requires no product-keyed parameter and avoids inventing a "VAP gets a
bigger bonus" rule the instructions explicitly forbid (§10 of this
instruction: "勝手にVAPだけ強くするなどの新仕様は作らない").

## 11. Operational overload interaction

Candidate A's multiplicative form naturally satisfies this requirement
without extra code: `effectiveOperationalRisk = operationalRisk × (1 −
reduction)`. If `operationalRisk` is already high (severe overtime, extreme
utilization, poor raw-material freshness), a bounded percentage reduction
(e.g., 15–30%, see §16) still leaves meaningful residual risk — the
equipment reduces risk, it does not zero it out. A factory can still have
quality problems under equipment + severe overload; it will simply have
fewer than the same factory without equipment under the same overload.
This is a structural property of the multiplicative form, not something
that needs a separate cap/rule.

## 12. Economic effect path (existing code only)

```
qualityControlEquipment (completed, targets Factory F)
        │
        ▼
operationalRisk for batches produced at Factory F  ──(reduced)──┐
        │                                                        │
        ▼                                                        ▼
nonConformanceRatio → downgradeRatio/reworkRatio/discardRatio   majorIncidentProbability
        │                                                        │
        ▼                                                        ▼
observedQualityScore (per batch)  ◄───────────────────  majorIncident severity (if drawn)
        │
        ▼ (production-weighted average across factories, existing code)
Quality Score (company × product, EWMA, existing code)
        │
        ├──────────────► sales/allocation.ts qualityContribution (all products, existing)
        │
        ├──────────────► premiumPolicy.ts VAP capability composite (VAP only, existing)
        │
        └──────────────► Customer Trust (via delivered-quality observation, existing)
                                │
                                ▼
                    sales competitiveness / contract allocation (existing water-filling)
                                │
                                ▼
                          revenue / margin (existing finance pipeline)
```
Every arrow above is an already-existing, already-wired code path; nothing
new is introduced except the risk-reduction multiplication at the top.

## 13. AI-observable signals (for a future CE-3, not implemented now)

Already observable today (no new hidden information needed):
- `StandardAiObservation.qualityScoreByProduct` (company × product,
  `observation.ts:409` — already wired).
- Factory utilization, VAP/PD production share, market exposure — all
  already part of `StandardAiObservation`/`FactoryObservation`.
- Existing CAPEX portfolio (whether a `qualityControlEquipment` project is
  active/completed for a given factory) — same data shape already used by
  `pdMechanization`'s `hasActiveOrCompletedProject` check
  (`ownState.capexState.portfolio.projects`).

**Not yet observable, would need a small additive extension in a future
CE-3** (not this phase): per-factory downgrade/rework/disposal ratios and
per-factory quality-equipment status are not currently exposed on
`FactoryObservation` (only company × product `qualityScoreByProduct`
exists). This would mirror the exact pattern already used for
`FactoryObservation.pdMechanization` (CE-1) — additive, optional,
non-breaking. Flagged here only as a forward-looking note; no such change
is made in this design-only phase.

## 14. Recommended candidate game design

**Effect location**: inside `quality/batchAdjustment.ts::applyQualityToBatches`,
immediately before `calculateOperationalRisk` is called for each batch.

**Formula structure**:
```
qualityEquipmentAdoptionRamp(quartersSinceCompletion) =
    min(1, quartersSinceCompletion / qualityEquipmentRampQuarters)   // linear ramp, mirrors PD Mechanization's existing 2Q ramp pattern

riskReductionFactor(batch) =
    hasCompletedQualityEquipment(batch.factoryId)
      ? qualityRiskReductionAtFullEffect × qualityEquipmentAdoptionRamp(...)
      : 0

effectiveOperationalRisk = calculateOperationalRisk(...).operationalRisk × (1 − riskReductionFactor(batch))
```
`effectiveOperationalRisk` then flows, unchanged in every other respect,
into the existing `calculateQualityOutcome`/`calculateMajorIncidentProbability`
calls exactly as `operationalRisk` does today.

**Parameter count**: 2 (see §15) — both additions to `QualityParameters`
(`quality/parameters.ts`), following the exact pattern already used for
`PD_MECHANIZATION_PARAMETERS_V1` and `pdMechanizationMaxPaybackQuarters`.

**Effect timing**: mirrors PD Mechanization exactly — a completed project
ramps in linearly over `qualityEquipmentRampQuarters`, reaching full effect
at maturity, computed strictly from prior-quarter-completed-project state
(no look-ahead), the same no-look-ahead invariant already enforced for PD
Mechanization.

**Factory/company aggregation**: factory-specific at the input (§9), company
× product aggregation via the existing production-weighted average — no new
aggregation code.

**Saturation**: the ramp itself is the saturation curve (0 → full effect
over N quarters, then flat) — no additional saturation formula needed since,
unlike VAP Product Development's headroom-based score, this is a bounded
percentage reduction with a hard ceiling (`qualityRiskReductionAtFullEffect`),
not an unbounded cumulative score.

**Limits**: `riskReductionFactor` should be capped well below 1.0 (see §16)
so equipment can meaningfully reduce but never eliminate quality risk,
directly satisfying §11.

## 15. Parameter philosophy — 2 new parameters

1. `qualityRiskReductionAtFullEffect` (ratio, 0–1): the maximum fraction by
   which `operationalRisk` is reduced for batches at a fully-ramped equipped
   factory.
2. `qualityEquipmentAdoptionRampQuarters` (integer quarters): how long full
   effect takes to reach after completion.

Both mirror existing, already-battle-tested parameter shapes
(`PD_MECHANIZATION_PARAMETERS_V1.adoptionRampQuarters` is a direct
precedent for #2; #1 is structurally identical to
`PD_MECHANIZATION_PARAMETERS_V1`'s coefficient-reduction ratio, just
applied to `operationalRisk` instead of a labor-intensity coefficient). No
third parameter is needed — `baselineOperationalQuality`,
`qualityRiskPenaltyPerUnitRisk`, all `qualityOutcome`/`majorIncident`
coefficients, and the EWMA alphas remain completely untouched (§41
compliance).

## 16. Balance examples (qualitative/illustrative only — NOT calibration)

Using illustrative suggested-range values
(`qualityRiskReductionAtFullEffect = 0.20`,
`qualityEquipmentAdoptionRampQuarters = 2`, matching PD Mechanization's
ramp length for consistency):

- **Normal factory** (utilization ~75%, no overtime stress,
  `operationalRisk ≈ 0.05–0.10`): risk is already low; a 20% reduction
  moves it to ~0.04–0.08. `nonConformanceRatio` (∝ risk^1.5) drops
  proportionally more than risk itself, but the absolute Quality Score
  change is small — equipment provides modest, unexciting benefit when
  operations are already healthy. This matches real-world intuition
  (quality equipment matters most when things are already stressed).
- **Overloaded factory** (heavy overtime + high utilization,
  `operationalRisk ≈ 0.6–0.8`): a 20% reduction moves risk to ~0.48–0.64 —
  a meaningfully lower `nonConformanceRatio` and `majorIncidentProbability`,
  translating into fewer discards and a materially better observed quality
  score that quarter, without eliminating the underlying overload problem
  (the factory is still stressed; it just handles that stress somewhat
  better). This is exactly the "equipment helps but doesn't replace fixing
  the overload" property requested in §11.
- **High-VAP factory**: no special treatment (§10) — same risk reduction
  as any other factory; VAP's outsized exposure to quality (via the
  capability composite) means the *same* risk reduction has a *larger
  downstream revenue effect* for a VAP-heavy company, purely as an emergent
  consequence of VAP's existing higher weighting in
  `premiumPolicy.ts`/`sales/allocation.ts` — not because the equipment
  itself treats VAP specially.
- **Two-factory company, equipment at Factory 1 only**: Factory 1's batches
  get the reduction, Factory 2's don't. The company × product Quality Score
  (production-weighted average) improves by roughly
  `(Factory 1's production share) × (the quality improvement at Factory 1)`
  — i.e., a company that concentrates production at its equipped factory
  benefits more than one that splits production evenly, which is a
  sensible, self-consistent incentive with no new code.

## 17. Compatibility with existing docs

- `docs/v2/CAPITAL_INVESTMENT_ARCHITECTURE_v0.1.md` §10 explicitly lists
  "能力効果の校正（`futureCapacityEffect`はプレースホルダのみ）" as excluded
  from Phase 8B-2A's scope — this design does **not** touch
  `futureCapacityEffect`/`capacityIncreaseTonsPerQuarter` at all (still 0
  for `qualityControlEquipment`, consistent with that document and with
  §116 of `capex/types.ts`'s Phase 8B-2B production-capacity mapping table,
  which explicitly excludes quality/environmental equipment from capacity
  effects). Fully compatible — this design adds a *quality* effect, not a
  *capacity* effect, so it doesn't reopen anything that document scoped out.
- The `capex/parameters.ts` comment on the `qualityControlEquipment`
  template ("品質・環境面の実際の効果...は対象外") is the exact gap this
  design proposes to close — for `qualityControlEquipment` specifically.
  `environmentalEquipment` is explicitly out of scope for this design (not
  requested, and its intended effect — presumably regulatory-compliance/
  incident-avoidance-adjacent but distinct — was not audited this phase).

## 18/19. No implementation this phase

Confirmed: `STANDARD_AI_PROPOSABLE_CAPEX_TYPES`, `decision/capex.ts`,
`reasonCodes.ts`, `aiPack/*`, `quality/*.ts`, `quality/parameters.ts`, and
every other production file are unmodified. Only this document and (if
applicable) a matching audit doc were added.

---

## Final Report

1. **Branch/HEAD**: `feature/v2-32q-management-console` @ `f344a68` (unchanged this phase).
2. **Quality Score SSoT**: `CompanyProductQualityState[]` (company × product), §2 above.
3. **Quality Score update formula**: production-weighted batch aggregation → asymmetric EWMA (alphaDown=0.20, alphaUp=0.08), §2.
4. **Downgrade formula**: `nonConformanceRatio × downgradeShare(0.45)`, §5.
5. **Rework formula**: `nonConformanceRatio × reworkShare(0.25)`, §5.
6. **Disposal formula**: `nonConformanceRatio × discardShare(0.30) + majorIncidentDiscardRatio`, clamped by `minimumSaleableRecoveryRatio(0.90)`, §5 — the only outcome with a real saleable-quantity effect today.
7. **Other quality outcomes**: major-incident probability/severity (seeded, deterministic), Customer Trust, Delivery Reliability — all outcome-driven, §2/§5.
8. **`qualityControlEquipment` current structure**: real CAPEX cost/schedule/space, optional `targetFactoryId`, no product/factory-specific duplicate guard, generic PLAYER path and persistence, §6.
9. **Best effect insertion point**: Candidate A — multiplicative reduction of `operationalRisk` per batch, inside `applyQualityToBatches`, §3/§7/§14.
10. **Alternative A**: reduce `operationalRisk` upstream — recommended (§7).
11. **Alternative B**: reduce `nonConformanceRatio`/shares directly — rejected (misses major-incident-probability effect, higher double-counting risk vs A), §7.
12. **Alternative C**: populate `baselineQualityOverride` (existing dormant hook) — rejected (company-wide only, cannot express factory-specificity without extending the hook; decouples score from actual quarterly operations), §7.
13. **Recommended design**: Candidate A, 2Q linear adoption ramp (mirrors PD Mechanization), 2 new parameters, §14.
14. **Why direct score bonus is not recommended**: severs Quality Score from operational reality, no natural saturation/decay fit, multi-factory double-counting risk, and directly contradicts this phase's own stated design preference, §8.
15. **Factory-specific handling**: yes, at the batch level — no new formula needed, existing production-weighted aggregation already does the company-level rollup, §9.
16. **Company aggregation**: automatic via existing `updateQualityByCompanyProduct`, §9.
17. **Overload interaction**: multiplicative form leaves meaningful residual risk under overload by construction, §11.
18. **Product interaction**: uniform across HOSO/PD/VAP, no product-specific rule, §10.
19. **Economic effect path**: diagrammed in §12, entirely existing code.
20. **AI-observable signals**: `qualityScoreByProduct` already observable; per-factory downgrade/incident/equipment-status would need a future, CE-1-pattern-mirroring additive extension (not this phase), §13.
21. **New parameters required**: 2 — `qualityRiskReductionAtFullEffect`, `qualityEquipmentAdoptionRampQuarters`, §15.
22. **Proposed parameter ranges** (suggested, not calibrated): `qualityRiskReductionAtFullEffect` ≈ 0.15–0.30; `qualityEquipmentAdoptionRampQuarters` = 2 (matching PD Mechanization for consistency, could reasonably be 1–3).
23. **Expected gameplay effect**: modest benefit for already-healthy factories, materially larger benefit for overloaded factories, larger downstream revenue effect for VAP-heavy companies as an emergent (not hardcoded) consequence, illustrated qualitatively in §16.
24. **Compatibility with existing docs**: fully compatible with `CAPITAL_INVESTMENT_ARCHITECTURE_v0.1.md` §10 and `capex/types.ts`'s capacity-effect exclusion table — this design fills exactly the gap those documents left open, without touching capacity effects, §17.
25. **Implementation complexity**: low-to-moderate — one new multiplication inside an existing pure-function call site, 2 new parameters, a duplicate-guard addition mirroring `pdMechanization`'s existing `hasActiveProjectForSameFactory` pattern (currently missing for `qualityControlEquipment`, §6), and persistence requires zero new fields (equipment status is already derivable from existing `CapexState`, exactly like PD Mechanization).
26. **Test requirements for next phase** (implementation, not this one): ramp timing (no-look-ahead), risk-reduction bounds, multi-factory aggregation correctness (equipped vs. unequipped factory batches), major-incident-probability reduction (not just nonConformance), zero-risk-elimination invariant (§11), and a duplicate-guard test mirroring `pdMechanization`'s CE1-7.
27. **Remaining unknowns**: (a) whether `qualityRiskReductionAtFullEffect` should itself receive a Strategy Profile soft-bias (analogous to CE-1/CE-2's pd/hoso and vap/hoso ratios) is a CE-3-Standard-AI-connection-phase question, not a game-mechanics question, and is out of scope here; (b) `environmentalEquipment`'s intended effect was not audited this phase and remains a fully separate, unresolved question; (c) whether downgrade/rework should ever gain a saleable-quantity effect (currently recorded but inert per Phase 7A's own documented scope) is a pre-existing open question this design does not attempt to resolve, since Candidate A's benefit (fewer/less severe nonconformance events) is meaningful even while downgrade/rework stay quantity-inert, via the discard and major-incident channels alone.

## Classification

**NEEDS #04 DECISION.**

The audit and design work is complete and, in Claude Code's assessment,
Candidate A is a clear, low-risk, well-fitting recommendation — but per this
phase's own explicit framing ("設計レビュー後にのみ、Quality Investment Game
Mechanics実装へ進む"), the actual parameter ranges (§22), the
`environmentalEquipment` question (§27b), and the decision to proceed to
implementation are product/game-design calls for #04, not engineering
determinations Claude Code should make unilaterally. No code was changed
this phase.
