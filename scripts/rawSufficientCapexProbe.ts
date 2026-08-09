// ShrimpX V2 — 「原料十分ケース」プローブ（テスト／ベンチマーク専用条件）
//
// 【目的】原料制約から切り離して、次の3点を確認する。
//   (1) HOSO capex が発動するか
//   (2) HOSO 能力が 8k → 12k → 16k → 20k → 24k(上限) へ進めるか
//   (3) 設備稼働率が capex の持続性しきい値へ届くか
//
// 【なぜ必要か】原料調達監査（rawMaterialProcurementAudit.ts）で、
// 国内調達が資金ゲート（prevCash × domesticPurchaseCashAllocationRatio
// + 承認融資）で 33〜90% に絞られ、そのぶん生産が落ち、設備稼働率が
// 0.21〜0.65 に張り付き、capex の sustained-utilization 条件（0.92）へ
// 一度も届かないことが分かった。原料が十分ならこの連鎖が解けるのかを、
// 原料側だけを外して確かめる。
//
// 【本番パラメータは一切変更しない】
// ゲームのパラメータ・fixture・エンジンには触れない。毎ターンの開始時に
// 「使用可能な原料ロットを積み増す」という**テスト専用の入力条件**を与える
// だけである。これは production behavior を観測するための fixture であり、
// ゲームバランスの変更ではない。
//
// 使い方: npx tsx scripts/rawSufficientCapexProbe.ts > artifacts/rawSufficientCapexProbe.json

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { CompanyLabConfig, CompanyDecisionInput, CompanyLabState } from "../app/lib/v2/companyLab/types";
import { RawMaterialLot } from "../app/lib/v2/rawMaterials/types";
import { calculateFactoryEffectiveCapacity } from "../app/lib/v2/production/capacity";
import { computeEffectiveFactories } from "../app/lib/v2/capex/factoryConstruction";
import { hosoEqTons, usdPerHosoEqKg, unwrapUnit } from "../app/lib/v2/core/units";

const TURNS = 8;
/** 毎ターン各社へ供給する使用可能原料（十分量。所要の上限を余裕をもって上回る値）。 */
const TOPUP_TONS = 40_000;
/** 積み増しロットの単価。国内買付の初期ロット水準に合わせる（利益を歪めないため相場並みに置く）。 */
const TOPUP_UNIT_COST = 4.2;

function probeConfig(): CompanyLabConfig {
  return {
    scenarioId: "baseline",
    mode: "canonical",
    seed: "market-aware-sales-benchmark-20260808",
    turns: TURNS,
  } as unknown as CompanyLabConfig;
}

/**
 * 【テスト専用条件】各社へ使用可能原料を積み増した state を返す。
 *
 * 既存ロットは削除しない（消費・期限切れの通常挙動をそのまま残す）。
 * 追加ロットは status="available" / availableFromPeriod=当期 なので、
 * その四半期からFIFOで使える。expiryPeriod は設定しないため期限切れしない。
 */
function withSufficientRawMaterial(state: CompanyLabState, companyIds: readonly string[], turn: number): CompanyLabState {
  const topups: RawMaterialLot[] = companyIds.map((companyId) => ({
    lotId: `${companyId}-PROBE-T${turn}`,
    companyId: companyId as RawMaterialLot["companyId"],
    source: "domestic",
    originCountry: "VN",
    inboundPeriod: state.currentPeriod,
    originalQuantity: hosoEqTons(TOPUP_TONS),
    remainingQuantity: hosoEqTons(TOPUP_TONS),
    unitCost: usdPerHosoEqKg(TOPUP_UNIT_COST),
    availableFromPeriod: state.currentPeriod,
    status: "available",
  }));
  return { ...state, rawMaterialLots: [...state.rawMaterialLots, ...topups] };
}

interface ProbeRow {
  readonly turn: number;
  readonly companyId: string;
  readonly hosoCapacity: number | null;
  readonly equipmentUtilizationLastQuarter: number | null;
  readonly capexSustainedThreshold: number | null;
  readonly capexProposals: readonly string[];
  readonly capexDiagnostics: readonly { readonly code: string; readonly keyValues: Record<string, number> }[];
  readonly rawMaterialShortfall: number | null;
  readonly contractedVolume: number | null;
  readonly operatingProfit: number | null;
  readonly cash: number | null;
}

function n(v: unknown): number | null {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function run(): void {
  const { state: initialState, fixtures } = initializeCompanyLab(probeConfig());
  let state = initialState;
  const companyIds = fixtures.map((f) => f.companyId);
  const rows: ProbeRow[] = [];

  for (let turn = 1; turn <= TURNS && !state.isComplete; turn++) {
    // テスト専用条件をこのターンの開始時に適用する。
    state = withSufficientRawMaterial(state, companyIds, turn);

    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    const perCompany: Record<string, Pick<ProbeRow, "capexProposals" | "capexDiagnostics" | "hosoCapacity">> = {};

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

      // その時点のHOSO実効能力（capex反映後）。上限24,000tへ到達するかを追う。
      // buildCompanyOwnState と同じ手順（前四半期末までのcapex状態を基準）で組み立てる。
      const capexStateForCompany = state.capexState.companies.find((c) => c.companyId === fixture.companyId);
      const effectiveFactories = capexStateForCompany
        ? computeEffectiveFactories(fixture.factories, { companies: [capexStateForCompany] }, state.currentPeriod)
        : fixture.factories;
      const hoso = effectiveFactories.reduce((sum, f) => sum + unwrapUnit(calculateFactoryEffectiveCapacity(f).hoso), 0);

      perCompany[fixture.companyId] = {
        hosoCapacity: hoso,
        capexProposals: (decision.capexDecision?.newProjectProposals ?? []).map((p) => String(p.projectType)),
        capexDiagnostics: (diagnostics.entries ?? [])
          .filter((e) => e.domain === "capex")
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
      const p = perCompany[id];
      const summary = record?.companySummaries.find((s) => s.companyId === id);
      const fin = record?.financialResults?.find((f) => f.companyId === id);
      const util = p.capexDiagnostics.find((c) => "equipmentUtilizationLastQuarter" in c.keyValues);
      rows.push({
        turn,
        companyId: id,
        hosoCapacity: p.hosoCapacity,
        equipmentUtilizationLastQuarter: util ? util.keyValues.equipmentUtilizationLastQuarter : null,
        capexSustainedThreshold: util ? util.keyValues.capexSustainedUtilizationThreshold : null,
        capexProposals: p.capexProposals,
        capexDiagnostics: p.capexDiagnostics,
        rawMaterialShortfall: n(summary?.rawMaterialShortfall),
        contractedVolume: n(summary?.newContractedQuantity),
        operatingProfit: n(fin?.profitAndLoss?.operatingProfit),
        cash: n(fin?.balanceSheet?.cash),
      });
    }
  }

  process.stdout.write(
    JSON.stringify(
      {
        label: "raw-sufficient-capex-probe",
        turns: TURNS,
        testOnlyCondition: { topupTonsPerCompanyPerTurn: TOPUP_TONS, topupUnitCostUsdPerHosoEqKg: TOPUP_UNIT_COST },
        rows,
      },
      null,
      2
    )
  );
}

run();
