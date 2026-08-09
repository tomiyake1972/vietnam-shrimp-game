// ShrimpX V2 — 外部原料調達 監査ベンチマーク（Test16 段階D→E の前提確認）
//
// 【背景】段階C/Dで次の状態が8Q固定されていることが分かった。
//   capacity shortfall はある → 原料不足 → 設備稼働率が低い
//   → capex の sustained-utilization 条件を満たさない → CAPEX_DEFERRED
// 設備投資経路が閉じている原因が原料側にあるため、まず外部調達を監査する。
//
// 【この監査で区別したいもの】
//   (1) 買おうとしていない        … desired が requirement に対して小さい
//   (2) 買おうとしているが買えない … desired > allocated（市場側の上限・競合）
//   (3) 資金がなくて買えない      … procurementConstraint.scaleRatio < 1
//   (4) 価格が高く経済合理性で買わない … 提示価格 vs 市場価格の関係
//
// 【決定論性】Date.now()・Math.random()を使わない。同じbranchなら同じJSONが出る。
// 【ゲーム環境を変更しない】fixture・パラメータ・エンジンに一切触れない。
//
// 使い方: npx tsx scripts/rawMaterialProcurementAudit.ts > artifacts/rawProcurementAudit.json

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { CompanyLabConfig, CompanyDecisionInput } from "../app/lib/v2/companyLab/types";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../app/lib/v2/rawMaterials/parameters";
import { STANDARD_AI_PARAMETERS_V1 } from "../app/lib/v2/companyLab/standardAi/parameters";
import { unwrapUnit } from "../app/lib/v2/core/units";

const TURNS = 8;

/** 段階A〜Dのベンチマークと同一の設定（比較可能性のため変えない）。 */
function auditConfig(): CompanyLabConfig {
  return {
    scenarioId: "baseline",
    mode: "canonical",
    seed: "market-aware-sales-benchmark-20260808",
    turns: TURNS,
  } as unknown as CompanyLabConfig;
}

function n(v: unknown): number | null {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
/** 分母0を許容する安全な除算。 */
function ratio(a: number | null, b: number | null): number | null {
  if (a === null || b === null || Math.abs(b) < 1e-9) return null;
  return a / b;
}

interface AuditRow {
  readonly turn: number;
  readonly companyId: string;

  // --- 必要量 ---
  /** Standard AIが調達判断に使った所要原料（生産計画のdesiredQuantity合計）。 */
  readonly plannedRawRequirement: number | null;

  // --- 自社養殖 ---
  readonly aquacultureCapacity: number | null;
  readonly aquacultureStockingPlanned: number | null;
  readonly aquacultureGrowing: number | null;
  readonly aquacultureHarvested: number | null;

  // --- 国内調達 ---
  /** 資金制約が掛かる前の、Standard AIが出した希望量。 */
  readonly domesticDesiredBeforeConstraint: number | null;
  /** 資金制約適用後、実際にエンジンへ渡った希望量。 */
  readonly domesticDesiredAfterConstraint: number | null;
  /** 実際に配分された量。 */
  readonly domesticAllocated: number | null;
  /** 提示買付価格（= 市場価格 + priceAdjustment）。 */
  readonly domesticBidPrice: number | null;
  readonly domesticMarketPrice: number | null;
  /** その四半期にプレイヤー系会社が配分対象にできた総供給。 */
  readonly domesticAvailableSupply: number | null;
  /** どの会社にも配分されなかった残余供給（>0なら「市場に残っていた」）。 */
  readonly domesticUnallocatedSupply: number | null;
  /** 反独占シェア上限（参照供給 × maximumBuyerShare）。 */
  readonly domesticShareCapTons: number | null;
  readonly domesticCompetitivenessWeight: number | null;
  readonly domesticCoverageScore: number | null;
  /** 外部加工業者の買付意向（プレイヤーが取れない分）。 */
  readonly externalProcessorIntent: number | null;
  readonly aggregatedPurchaseIntent: number | null;

  // --- 輸入 ---
  readonly importOrderedDesired: number | null;
  readonly importAllocatedInTransit: number | null;
  readonly importArrivedThisTurn: number | null;
  readonly importOrdersBlocked: boolean | null;
  readonly importLeadTimeTurns: number;
  readonly importAvailableSupplyRatio: number;

  // --- 資金・借入 ---
  readonly procurementScaleRatio: number | null;
  readonly procurementPlannedCashNeedUsd: number | null;
  readonly procurementAvailableLiquidityUsd: number | null;
  readonly procurementUnmetDemandUsd: number | null;
  readonly cash: number | null;
  readonly loanRequestedUsd: number | null;
  readonly loanApprovedUsd: number | null;
  readonly loanDeniedUsd: number | null;
  readonly borrowingAvailableCapacityUsd: number | null;
  readonly underwritingReasons: readonly string[];

  // --- 結果 ---
  readonly rawMaterialInventory: number | null;
  readonly rawMaterialShortfall: number | null;

  // --- Standard AI 調達diagnostics（実際に計算した判断根拠をそのまま保存） ---
  readonly procurementDiagnostics: readonly { readonly code: string; readonly keyValues: Record<string, number> }[];

  // --- 判定（上記の実測値のみから導く） ---
  readonly verdict: string;
}

/**
 * 4分類の判定。**実測値だけで決める**。
 *
 * 【unallocatedSupply を「市場が枯渇した証拠」に使ってはならない】
 * プレイヤー系会社が配分対象にできる供給は
 *   companyAvailableDomesticSupply = transactedVolume × min(1, 全社意向 / 実効需要)
 * として**全社の買付意向に比例して決まる**（turn/runner.ts）。
 * したがって残余供給は構造上ほぼ常に0になり、供給不足を意味しない。
 * 「市場側で買えなかった」の唯一正しい判定は
 *   実配分 < 資金制約後の希望量
 * である（資金制約ぶんを差し引いてなお届かなかった量）。
 */
function classify(r: Omit<AuditRow, "verdict">): string {
  const req = r.plannedRawRequirement ?? 0;
  const desired = r.domesticDesiredBeforeConstraint ?? 0;
  const scale = r.procurementScaleRatio ?? 1;
  const desiredAfterCash = desired * scale;
  const allocated = r.domesticAllocated ?? 0;
  const ownSupply = (r.aquacultureHarvested ?? 0) + (r.importArrivedThisTurn ?? 0);
  const secured = allocated + ownSupply;

  if (req <= 1e-9) return "no_requirement";
  if (secured >= req * 0.98) return "sufficient";

  const parts: string[] = [];
  // (3) 資金がなくて買えない
  if (scale < 0.999) parts.push("cash_constrained");
  if (r.importOrdersBlocked === true) parts.push("import_blocked_by_arrears");
  // (2) 買おうとしているが買えない（資金制約ぶんを除いてなお配分が届かない）
  if (desiredAfterCash > allocated * 1.02 + 1) {
    const shareCap = r.domesticShareCapTons;
    if (shareCap !== null && allocated >= shareCap * 0.98) parts.push("blocked_by_share_cap");
    else parts.push("blocked_by_market_allocation");
  }
  // (4) 価格が高く経済合理性から買わない（提示価格を市場より下げている＝買い負けを選んだ）
  if ((r.domesticBidPrice ?? 0) < (r.domesticMarketPrice ?? 0) - 1e-6) parts.push("declined_on_price");
  // (1) 買おうとしていない: 資金制約が無くても希望量自体が不足分を埋めていない
  if (desired + ownSupply < req * 0.98) parts.push("did_not_intend_to_buy_enough");

  return parts.length > 0 ? parts.join("+") : "shortfall_unexplained";
}

function run(): void {
  const { state: initialState, fixtures } = initializeCompanyLab(auditConfig());
  let state = initialState;
  const rows: AuditRow[] = [];

  const shareCapRatio = RAW_MATERIALS_PARAMETERS_V1.domesticPurchase.maximumBuyerShare;

  for (let turn = 1; turn <= TURNS && !state.isComplete; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    // 資金制約が掛かる**前**のAI判断を保持する（記録側は制約後の値しか持たないため）。
    const preConstraint: Record<string, { desired: number; imports: number; stocking: number; capacity: number; required: number; diags: { code: string; keyValues: Record<string, number> }[] }> = {};

    for (const fixture of fixtures) {
      const ownState = buildCompanyOwnState(state, fixture);
      const { decision, diagnostics } = generateStandardAiDecisionWithDiagnostics(
        fixture,
        ownState,
        publicInfo,
        state.currentPeriod,
        turn
      );
      decisions[fixture.companyId] = decision;

      const entries = diagnostics.entries ?? [];
      preConstraint[fixture.companyId] = {
        desired: Number(unwrapUnit(decision.domesticPurchasePlan.desiredQuantity)),
        imports: decision.importOrders.reduce((s, o) => s + Number(unwrapUnit(o.orderedQuantity)), 0),
        stocking: decision.aquacultureStockingPlans.reduce((s, p) => s + Number(unwrapUnit(p.plannedStockingQuantity)), 0),
        capacity: decision.aquacultureStockingPlans.reduce((s, p) => s + Number(unwrapUnit(p.aquacultureCapacity)), 0),
        // 所要原料はStandard AIが調達判断に使ったのと同じ定義（生産計画のdesiredQuantity合計）。
        required: decision.productionPlans.reduce((s, p) => s + Number(unwrapUnit(p.desiredQuantity)), 0),
        diags: entries
          .filter((e) => e.domain === "procurement" || String(e.code).startsWith("PROCUREMENT_") || String(e.code).startsWith("RAW_MATERIAL_"))
          .map((e) => ({
            code: String(e.code),
            keyValues: Object.fromEntries(Object.entries(e.keyValues ?? {}).map(([k, v]) => [k, Number(v)])),
          })),
      };
    }

    state = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record = state.history[state.history.length - 1];

    for (const fixture of fixtures) {
      const id = fixture.companyId;
      const pre = preConstraint[id];
      const summary = record?.companySummaries.find((s) => s.companyId === id);
      const fin = record?.financialResults?.find((f) => f.companyId === id);
      const financing = record?.financingResults?.find((f) => f.companyId === id);
      const alloc = record?.domesticAllocation;
      const allocEntry = alloc?.companies.find((c) => c.companyId === id);
      const dbg = record?.turnDebug;
      const postDecision = record?.decisions?.find((d) => d.companyId === id);

      const availableSupply = n(alloc ? unwrapUnit(alloc.availableSupply) : undefined);

      const base: Omit<AuditRow, "verdict"> = {
        turn,
        companyId: id,
        plannedRawRequirement: pre.required,

        aquacultureCapacity: pre.capacity,
        aquacultureStockingPlanned: pre.stocking,
        aquacultureGrowing: n(summary?.aquacultureGrowingQuantity),
        aquacultureHarvested: n(summary?.aquacultureHarvestedQuantity),

        domesticDesiredBeforeConstraint: pre.desired,
        domesticDesiredAfterConstraint: n(postDecision ? unwrapUnit(postDecision.domesticPurchasePlan.desiredQuantity) : undefined),
        domesticAllocated: n(summary?.domesticPurchaseQuantity),
        domesticBidPrice: n(summary?.domesticPurchasePrice),
        domesticMarketPrice: n(alloc ? unwrapUnit(alloc.marketPrice) : undefined),
        domesticAvailableSupply: availableSupply,
        domesticUnallocatedSupply: n(alloc ? unwrapUnit(alloc.unallocatedSupply) : undefined),
        // shareCapは「市場全体の供給 × maximumBuyerShare」。参照供給はturnDebugのdomesticMarketSupply。
        domesticShareCapTons:
          dbg?.domesticMarketSupply !== undefined ? Number(unwrapUnit(dbg.domesticMarketSupply)) * shareCapRatio : null,
        domesticCompetitivenessWeight: n(allocEntry?.competitivenessWeight),
        domesticCoverageScore: n(allocEntry?.coverageScore),
        externalProcessorIntent: n(dbg?.externalProcessorIntent !== undefined ? unwrapUnit(dbg.externalProcessorIntent) : undefined),
        aggregatedPurchaseIntent: n(dbg?.aggregatedPurchaseIntent !== undefined ? unwrapUnit(dbg.aggregatedPurchaseIntent) : undefined),

        importOrderedDesired: pre.imports,
        importAllocatedInTransit: n(summary?.importInTransitQuantity),
        importArrivedThisTurn: n(summary?.importArrivedQuantity),
        importOrdersBlocked: financing?.procurementConstraint?.importOrdersBlocked ?? null,
        importLeadTimeTurns: RAW_MATERIALS_PARAMETERS_V1.imports.standardLeadTimeTurns,
        importAvailableSupplyRatio: RAW_MATERIALS_PARAMETERS_V1.imports.importAvailableSupplyRatio,

        procurementScaleRatio: n(financing?.procurementConstraint?.scaleRatio),
        procurementPlannedCashNeedUsd: n(financing?.procurementConstraint?.plannedCashNeedUsd),
        procurementAvailableLiquidityUsd: n(financing?.procurementConstraint?.availableLiquidityUsd),
        procurementUnmetDemandUsd: n(financing?.procurementConstraint?.unmetDemandUsd),
        cash: n(fin?.balanceSheet?.cash),
        loanRequestedUsd: n(financing?.underwriting?.requestedAmountUsd),
        loanApprovedUsd: n(financing?.underwriting?.approvedAmountUsd),
        loanDeniedUsd: n(financing?.underwriting?.deniedAmountUsd),
        borrowingAvailableCapacityUsd: n(financing?.borrowingCapacity?.availableAdditionalCapacityUsd),
        underwritingReasons: (financing?.underwriting?.reasons ?? []).map(String),

        rawMaterialInventory: n(summary?.rawMaterialInventory),
        rawMaterialShortfall: n(summary?.rawMaterialShortfall),

        procurementDiagnostics: pre.diags,
      };

      rows.push({ ...base, verdict: classify(base) });
    }
  }

  process.stdout.write(
    JSON.stringify(
      {
        label: "raw-material-procurement-audit",
        turns: TURNS,
        // 判定の前提となる本番パラメータ（変更していないことの記録）
        parameters: {
          maximumBuyerShare: shareCapRatio,
          importAvailableSupplyRatio: RAW_MATERIALS_PARAMETERS_V1.imports.importAvailableSupplyRatio,
          standardLeadTimeTurns: RAW_MATERIALS_PARAMETERS_V1.imports.standardLeadTimeTurns,
          importMixRatio: STANDARD_AI_PARAMETERS_V1.importMixRatio,
          maxAquacultureShareOfRequirement: STANDARD_AI_PARAMETERS_V1.maxAquacultureShareOfRequirement,
          minDomesticPurchaseRatioOfBase: STANDARD_AI_PARAMETERS_V1.minDomesticPurchaseRatioOfBase,
          rawMaterialTargetQuarters: STANDARD_AI_PARAMETERS_V1.rawMaterialTargetQuarters,
          severeCashPressureThreshold: STANDARD_AI_PARAMETERS_V1.severeCashPressureThreshold,
        },
        rows,
      },
      null,
      2
    )
  );
  void ratio;
}

run();
