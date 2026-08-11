# Strategic Posture: AGGRESSIVE_EARLY_CAPACITY — Design Document

Status: Phase B design (pre-implementation). Branch `feature/v2-32q-management-console`.

## 1. Philosophy

Today's Standard AI new-factory pipeline (`evaluateNewFactoryDecision`,
`app/lib/v2/companyLab/standardAi/decision/newFactory.ts`) is fundamentally
**reactive**: every gate after the Vision/growth-pressure check (Gates D–L)
reads *current-quarter* state — last quarter's utilization, this quarter's
demand pull, this quarter's cash. A company only reaches `READY_TO_BUILD`
once capacity is *already* the binding constraint.

This document adds a second, **forward-looking** route: a company whose
Vision calls for scale it does not yet have, and whose finances can absorb
early construction, may start building *before* current utilization says it
must — because construction has a lead time, and by the time capacity is
visibly the bottleneck it is already too late to have avoided losing sales
to it.

The guiding principle (§14 of the instruction, preserved verbatim as the
design's north star):

> Capacity leads expected demand, not the other way around.

This is **not** "lower the reactive thresholds." The reactive route (Gates
D–L as they exist today) is untouched and remains available to every
company. The new route is a parallel path with its own gates, evaluated
independently, and a company only needs *one* of the two routes to say GO.

## 2. Observable inputs only — bounded rationality

Every input to the new route already exists on `StandardAiObservation`,
`CompanyVision`, or `StrategicGrowthState` — nothing in this document reads
`CompanyLabState.scenarioState.definition` or any TRUE-world/future field.
Concretely, the forward estimate is built from:

- `CompanyVision.referenceGrowthPath` / `referenceScaleAtTurn(...)` — the
  company's own stated growth intent, already a first-class citizen of the
  reactive route (`computeStrategicGrowthState`).
- `StrategicGrowthState.currentSustainableScaleTons` — the existing binding
  capacity SSoT (see §4 below), evaluated *now* to seed the trend.
  the AI never asks "what will demand actually be at turn T" — it only asks
  "what does *my own Vision path* say my scale should be at turn T, and does
  my capacity get there in time."
- `observation.lastQuarterActualProductionByProduct`,
  `observation.outstandingContractByProduct` (recent own contract growth) —
  same trailing-quarter data the reactive route already reads.
- `observation.observedMarketDemand` (2-quarter-lagged, market-level) — same
  field `buildPublicMarketInfo` already exposes; no change to its lag or
  computation.
- `CommercialAmbition` / `UnservedOpportunity` — already computed upstream
  in `policy.ts` and passed into `evaluateNewFactoryDecision` today.

No new field is added to `StandardAiObservation`, `PublicMarketInfo`, or any
other input type. This document adds **one new pure function** that
combines existing observable values into a scalar "forward gap"; it does
not add a new information channel.

## 3. Strategic Posture

Extend the *existing* per-company strategic-intent hook — not create a
parallel concept. `StrategicIntent.growthPosture` (`strategicIntent.ts`) is
already documented as "designed to become per-company"; today it is a
single global constant (`STANDARD_AI_STRATEGIC_INTENT_V1`) applied
uniformly. This document:

1. Adds a `StrategicPosture` union to `CompanyVision` as an **optional**
   field (`strategicPosture?: StrategicPosture`), so `COMPANY_VISION_SCHEMA_VERSION`
   does not need to bump and existing persisted/exported Vision documents
   remain valid (absence means "not specified" → treated as
   `DEMAND_CONFIRMED`, i.e. today's behavior, never silently upgraded to
   aggressive).
2. Defines:
   ```ts
   export type StrategicPosture = "AGGRESSIVE_EARLY_CAPACITY" | "DEMAND_CONFIRMED" | "VALUE_FIRST";
   ```
3. Does **not** duplicate `willingnessToBuildFactories` /
   `financialRiskTolerance` / `growthAmbition` — those remain the dials the
   reactive route and the financial gate already use. `strategicPosture`
   only decides *which route(s)* get evaluated:
   - `DEMAND_CONFIRMED` → reactive route only (today's exact behavior,
     locked by STRAT-1).
   - `AGGRESSIVE_EARLY_CAPACITY` → reactive route **and** the new strategic
     route; either can produce a proposal.
   - `VALUE_FIRST` → reactive route only, in this phase (§26 lists
     `commercialExpansionIntensity` etc. as a separate future dimension —
     out of scope here; VALUE_FIRST is a placeholder value that behaves
     identically to `DEMAND_CONFIRMED` for the new-factory gates until a
     later phase touches R&D/VAP investment).

No `if company === "BAL"` branching anywhere — the posture is read off
`vision.strategicPosture`, and defaults (`docs §27`) are assigned in
`vision/defaults.ts` per company, the same file that already hand-authors
each company's Vision.

## 4. Binding capacity SSoT — consolidation, not reimplementation

The audit found the `min(Σ product-line capacity, common processing
capacity)` computation duplicated verbatim in three places
(`targetScale.ts:84`, `newFactory.ts:420`, `policy.ts:456`). This document:

- Extracts a single exported helper,
  `computeBindingProductionCapacityTons(capacityByProduct, totalCommonProcessingCapacity)`,
  into `app/lib/v2/companyLab/standardAi/bindingCapacity.ts`.
- Replaces all three inline copies with calls to it (pure refactor, same
  arithmetic, covered by the existing NEWFAC-16 / Phase6D1 tests which
  assert `currentSustainableScaleTons === min(...)`).
- The Forward Capacity Gap module (§5) calls the *same* helper — it is
  structurally impossible for it to diverge from the reactive route's
  notion of capacity, closing the exact class of bug Phase 6D-1 fixed for
  sustainable scale.

## 5. Forward Capacity Gap — formula

New pure module: `app/lib/v2/companyLab/standardAi/forwardCapacityGap.ts`.

```ts
export interface ForwardCapacityGapInput {
  readonly turn: number;
  readonly vision: CompanyVision;
  readonly currentSustainableScaleTons: number;      // from computeStrategicGrowthState / targetScale.ts
  readonly constructionLeadTimeQuarters: number;      // from CAPEX_PARAMETERS_V1 template, not hard-coded
  readonly recentOwnContractGrowthRatio: number | null;   // observable, see §5.2
  readonly observedMarketGrowthRatio: number | null;      // observable, see §5.2
}

export interface ForwardCapacityGapResult {
  readonly forecastCompletionTurn: number;
  readonly visionReferenceScaleAtCompletion: number;
  readonly trendAdjustedScaleAtCompletion: number;
  readonly projectedCommercialScaleAtCompletion: number;
  readonly projectedRequiredProductionAtCompletion: number;
  readonly existingCapacityAtCompletion: number;
  readonly forwardCapacityGapTons: number;
  readonly forwardCapacityGapRatio: number;
}
```

### 5.1 completion turn

```
forecastCompletionTurn = turn + constructionLeadTimeQuarters
```

`constructionLeadTimeQuarters` is read from
`CAPEX_PARAMETERS_V1.templatesByType.newFactoryConstruction` — specifically
`standardConstructionQuarters + postCompletionReadinessQuarters` (3 + 1 = 4
today) — **not** a new hard-coded constant. If the template ever changes,
this module changes with it automatically (no duplicated "4").

### 5.2 projected scale at completion — two independent, bounded estimates, combined conservatively

Per §7 of the instruction ("bounded rationality... never read the future"),
the projection is built as the **minimum** of two independently-derived,
purely observable estimates, not their average or their max — a company
does not get to average an optimistic guess with a pessimistic one and call
it prudent; it must be supported by *both* signals to be believed:

**(a) Vision reference estimate** — `referenceScaleAtTurn(vision,
forecastCompletionTurn, currentSustainableScaleTons, 32)`. This is the
company's own long-declared intent; already exists, zero new logic.

**(b) Trend-adjusted estimate** — extrapolates the observable recent growth
rate forward:
```
observedGrowthRatioPerQuarter = max(0, min(recentOwnContractGrowthRatio ?? 0, observedMarketGrowthRatio ?? 0))
trendAdjustedScaleAtCompletion =
  currentSustainableScaleTons * (1 + observedGrowthRatioPerQuarter) ^ constructionLeadTimeQuarters
```
Both `recentOwnContractGrowthRatio` (own `outstandingContractByProduct` /
production trend over the trailing observable window) and
`observedMarketGrowthRatio` (from `observation.observedMarketDemand`,
already 2Q-lagged) are values the reactive route's neighbors
(`commercialHistory.ts`, `unservedOpportunity.ts`) already compute in
similar shapes — this phase reuses their existing outputs rather than
re-deriving trend detection from raw history. If either is unavailable
(`null`, e.g., turn 1 with no history), the trend estimate falls back to
`currentSustainableScaleTons` (zero growth assumed — never invents growth
from nothing).

```
projectedCommercialScaleAtCompletion = min(visionReferenceEstimate, trendAdjustedEstimate)
```

This directly implements §8's worked example (current 20kt, Vision
reference 27kt at completion, binding capacity 23kt) while adding the
requirement that the trend estimate must *corroborate* the Vision number,
not just cite it — preventing every HIGH-ambition company from proposing
early builds purely off an optimistic static Vision path regardless of
what is actually happening in the market (this is the mechanism that makes
STRAT-8, "observable market growth weak → suppressed," hold).

### 5.3 required production vs. existing capacity

```
projectedRequiredProductionAtCompletion = projectedCommercialScaleAtCompletion   // 1:1 today; no separate yield/mix model exists to refine this further without inventing one
existingCapacityAtCompletion = currentSustainableScaleTons   // no organic capacity growth assumed absent a second capex project — conservative, does not double-count any *other* pending project's future capacity
forwardCapacityGapTons = max(0, projectedRequiredProductionAtCompletion - existingCapacityAtCompletion)
forwardCapacityGapRatio = existingCapacityAtCompletion > 0 ? forwardCapacityGapTons / existingCapacityAtCompletion : 0
```

`existingCapacityAtCompletion` deliberately does **not** add the
would-be-new factory's own future capacity (that would be circular — "I
should build the factory because after I build the factory I'll have more
capacity" is not a gap, it is a tautology) and does not assume any *other*
factory completes in the interim (kept simple for this phase; a company
with two factories under construction simultaneously is already blocked by
`maxConcurrentActiveProjectsPerCompany`).

## 6. Forward Capacity Pressure (§21)

Reuses the exact `GrowthPressure` type and thresholds
(`STRATEGIC_GROWTH_PARAMETERS_V1`) already used for the Vision gap, applied
to `forwardCapacityGapRatio` instead of `strategicScaleGapRatio` — one
fewer parameter surface to calibrate, and consistent with the instruction's
"don't optimize thresholds this phase" caution (§22, §42 STRAT list).

## 7. Finance gate — same gate, higher tolerance parameter, not a bypass

The existing new-factory finance gate (`newFactory.ts:558–595`) already
keys its coverage ratio off `vision.financialRiskTolerance`
(`upfrontCoverageRatioByRiskTolerance: {HIGH:0.6, MEDIUM:0.85, LOW:1.1}`) —
lower ratio = more room to invest while less cash-safe. This document adds
**no new finance function**; instead:

- `AGGRESSIVE_EARLY_CAPACITY` posture is *expected* to be paired with
  `financialRiskTolerance: HIGH` in the profile assignment (§27), which
  already yields the loosest existing coverage ratio (0.6× project cost
  headroom instead of 1.1×) — exactly "financially a little tight is
  acceptable, insolvency is not" (§12/§13), using a dial that already
  exists and is already tested (Phase6D1 finance tests).
- The strategic route's own gate (§9 below) reuses `cashSafe` and
  `borrowingSafe` **verbatim** from the existing gate function — it does
  not lower them, relax them, or add a separate "aggressive" cash
  threshold. §13's hard "never insolvent" line is therefore structurally
  guaranteed by construction: the strategic route cannot pass finance where
  the reactive route would fail it, because they call the same function.

## 8. Shell-first / staged investment (§15–17)

No code change is required for §15/§16: the existing capex lifecycle
already allows a factory to complete with `workerBaseline: []` (confirmed
by `newFactoryVisibility.test.ts` AUDIT-3, "no workers come with it") and
Worker/line investment is already a fully separate quarterly decision made
after completion (this is exactly the bug fixed in the "新工場Worker入力不能"
work earlier in this branch — new factories are legitimately expected to
start at 0 workers and be staffed up over subsequent turns). Shell-first is
already mechanically possible; this document does not need to add anything
for §15/§16 beyond confirming it (a regression test, STRAT-12, makes this
explicit for the *new* code path specifically).

**§17 post-construction activation feasibility** is a genuine new check:
before proposing, the strategic route additionally verifies that, using
the *same* cash-safety gate evaluated once more against a rough post-
completion staffing cost estimate (`estimateQuarterlyScaleUsd`-style,
already exists in `parameters.ts`), the company is not proposing a shell it
foreseeably can never staff. If this secondary check fails, the assessment
records `NOT_CONSIDERED`/`DEFERRED` with a distinct reason code rather than
proposing — this is the mechanism that keeps §37's "downside scenarios
punish aggressive posture" true structurally (a company that overbuilds
into a shrinking market will fail this check in later turns even if it
passed once).

## 9. Strategic route — gate sequence

New function `evaluateStrategicForwardCapacityRoute`, called from
`evaluateNewFactoryDecision` **only when** `vision.strategicPosture ===
"AGGRESSIVE_EARLY_CAPACITY"` and the reactive route did not already reach
`READY_TO_BUILD` this quarter (no double-proposal). Gate order:

| Gate | Reuses | New? |
|---|---|---|
| Vision/growth-intent present | Gate A (existing) | no |
| `forwardCapacityGapTons > 0` (meaningful gap) | new §5 | yes |
| Construction lead time makes early start rational (`forecastCompletionTurn > turn`, i.e. always true, but the *ratio* must clear `STRATEGIC_GROWTH_PARAMETERS_V1` moderate threshold — reuses existing thresholds, §6) | new §6 | yes (formula), no (thresholds) |
| Finance feasible | existing `cashSafe && borrowingSafe` from Gate L | no |
| Post-construction activation feasible | new §8 | yes |
| Existing-expansion-alone insufficient (`forwardCapacityGapTons` still `> 0` after hypothetically applying the pending/possible existing-expansion capacity increment) | reuses `computeCandidateProjectSpaceUnits` / capacity delta already computed by `capex.ts` | no new formula, new comparison |
| Factory count / pending-project gates | Gates D/E (existing) | no |

If all pass: `status: "READY_TO_BUILD"`, `decisionRoute: "STRATEGIC_FORWARD_CAPACITY"`, proposal appended exactly as the reactive route's is today (§18: two routes, not two proposal mechanisms — the merge in `policy.ts:533–539` is untouched).

If the reactive route already said `READY_TO_BUILD`, `decisionRoute:
"REACTIVE"` and the strategic route is not evaluated (avoids a double
proposal in the same quarter; both routes independently produce at most
one proposal each, and `evaluateNewFactoryDecision` still returns 0 or 1
proposals per quarter, unchanged contract).

## 10. Existing-expansion interaction (§20)

Unchanged Gate G logic (`existingExpansionProposedThisQuarter &&
!gapJustifiesOverlap`) governs the *reactive* route as today. The
*strategic* route's own "existing expansion alone insufficient" check
(§9 table) is a separate, additional condition — not a relaxation of Gate
G — so a company can still propose existing-line expansion and a strategic
new factory in the same quarter exactly when today's `gapJustifiesOverlap`
(`strategicScaleGapRatio > 0.3`) already permits simultaneous proposals,
preserving §20's "not a simple exclusion, but still bounded by space/cash."

## 11. Trace fields (§30)

`NewFactoryAssessment` gains (all optional, additive, no schema version
bump needed since this is a TS interface not a persisted schema):

```ts
readonly decisionRoute: "REACTIVE" | "STRATEGIC_FORWARD_CAPACITY" | "NONE";
readonly strategicPosture: StrategicPosture | null;
readonly forwardCapacityGap: ForwardCapacityGapResult | null;   // §5 result, null unless posture is AGGRESSIVE_EARLY_CAPACITY and Vision present
readonly marketGrowthEvidence: {
  readonly recentOwnContractGrowthRatio: number | null;
  readonly observedMarketGrowthRatio: number | null;
} | null;
readonly existingExpansionAlternativeSufficientTons: number | null;
readonly postConstructionActivationFeasible: boolean | null;
```

New reason codes (`reasonCodes.ts`): `NEW_FACTORY_STRATEGIC_FORWARD_GAP`,
`NEW_FACTORY_STRATEGIC_PROPOSED`, `NEW_FACTORY_STRATEGIC_DEFERRED_FINANCE`,
`NEW_FACTORY_STRATEGIC_DEFERRED_ACTIVATION`,
`NEW_FACTORY_STRATEGIC_DEFERRED_GROWTH_EVIDENCE`,
`NEW_FACTORY_STRATEGIC_GAP_INSUFFICIENT`. All added to the existing
registry array in `reasonCodes.ts`, not a parallel list.

`captureStrategy` (aiPack/capture.ts) copies the new fields onto
`PackStrategy.newFactory` the same way it copies existing ones (no new
capture function).

## 12. UI (§31, §44)

`CompanyInspector.tsx`'s existing "Investment Thinking" section gains, when
`decisionRoute === "STRATEGIC_FORWARD_CAPACITY"`, a small sub-block above
the existing gate list:

```
Strategic route: Lead-the-Market
New factory completion: Q{forecastCompletionTurn}
Expected scale at completion: {projectedCommercialScaleAtCompletion} t/Q
Existing binding capacity: {existingCapacityAtCompletion} t/Q
Forward gap: {forwardCapacityGapTons} t/Q
Finance: {Feasible | Infeasible}
Decision: {BUILD EARLY | DEFERRED}
```
matching §31's example verbatim. `StrategyView.tsx` (Analysis) gains a
"Route" column (`Reactive` / `Strategic Forward`) alongside the existing
"新工場" status column — reuses `describeNewFactoryBlocker`, extended to
also describe strategic-route blockers by the same single function so the
UI never has two divergent "why is this blocked" surfaces.

## 13. Benchmark plan (Phase F, not this document)

1. Baseline 32Q, `seed=management-console-32q`, all 5 companies with §27's
   candidate posture assignment — record per-company: proposal turn,
   approval turn, completion turn, `decisionRoute`, contract/production
   growth, factory utilization, cash trough, debt peak, operating profit,
   distress flags, 3rd-factory decision.
2. Same seed, same companies, but force every company to
   `DEMAND_CONFIRMED` (reactive-only) — A/B against (1) for the two
   candidate-aggressive companies (MASS, BAL) specifically: factory timing
   delta, market share delta, cumulative OP delta, cash trough delta, debt
   peak delta, idle capacity delta, finished-goods delta.
3. Repeat (1) across 5 seeds — confirm the strategic route fires in more
   than one seed and does not depend on one lucky RNG draw.
4. Run the same aggressive profile against any existing downturn/oversupply
   scenario definition; if none exists in
   `app/lib/v2/industryLab/scenario/definitions/` (or equivalent), build a
   **test-fixture-only** demand-deceleration scenario (not a new production
   scenario file) purely to exercise STRAT-13, and document that it is a
   test fixture, not a new game scenario.

## 14. Failure modes / risks

- **Circular capacity counting** — mitigated by §5.3's explicit exclusion
  of the pending project's own future capacity.
- **Vision-only overbuilding** (a HIGH-ambition company always proposes
  regardless of market reality) — mitigated by §5.2's `min()` of Vision and
  trend estimates, and by §8's post-construction activation re-check every
  quarter after completion.
- **Double proposal in one quarter** — mitigated by §9's "reactive route
  already READY_TO_BUILD → skip strategic route" ordering, unchanged 0-or-1
  proposal contract.
- **Divergent capacity SSoT re-emerging** — mitigated by §4's single
  exported `computeBindingProductionCapacityTons` helper used by all three
  former call sites plus the new module.
- **Threshold overfitting to the BAL manual playthrough** — mitigated by
  never hard-coding turn numbers, headcounts, or contract totals; every
  threshold reused in this design is an *existing*, already-calibrated
  constant (`STRATEGIC_GROWTH_PARAMETERS_V1`, `upfrontCoverageRatioByRiskTolerance`),
  not a new one invented to match the one playthrough.
- **Regression to existing 32Q autoplay tests** — `DEMAND_CONFIRMED`
  companies (JPQ, CONSV, VAP per §27 candidate list) must produce byte-
  identical decisions to today, verified by STRAT-1; only MASS/BAL (the
  posture actually changes) are expected to diverge from
  `test15StandardAiIntegratedAutoplay.test.ts`'s existing fixtures, and
  that file's MASS/BAL-specific assertions will need updating as part of
  Phase D/F, called out explicitly rather than silently patched.
