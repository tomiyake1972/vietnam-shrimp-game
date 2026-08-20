// ShrimpX V2 — 32Q Management Console: 表示用の時系列（Phase 1）
//
// 【再計算しない】すべて確定済みの CompanyQuarterRecord から値を**取り出すだけ**。
// 表示のためにゲームの計算をやり直さない（画面と実績が食い違わないようにするため）。
//
// 【値を捏造しない】取得できない項目は null のままにし、0 で埋めない。

import { CompanyFixture, CompanyLabState, CompanyQuarterRecord } from "../types";
import { computeEffectiveFactories } from "../../capex/factoryConstruction";
import { calculateFactoryEffectiveCapacity } from "../../production/capacity";
import { unwrapUnit } from "../../core/units";

/** 会社ごとに固定する表示色（会社を切り替えても線の色は変わらない）。 */
export const COMPANY_COLORS: Readonly<Record<string, string>> = {
  BAL: "#2563eb",
  MASS: "#dc2626",
  JPQ: "#16a34a",
  VAP: "#9333ea",
  CONSV: "#ea580c",
};

export interface CompanyTurnPoint {
  readonly turn: number;
  readonly revenue: number | null;
  readonly operatingProfit: number | null;
  readonly netIncome: number | null;
  readonly cash: number | null;
  readonly debt: number | null;
}

export interface CompanySeries {
  readonly companyId: string;
  readonly displayName: string;
  readonly color: string;
  readonly points: readonly CompanyTurnPoint[];
}

function n(v: unknown): number | null {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/**
 * 5社 × 全ターンの主要指標。Revenue / Operating Profit のトレンド図と
 * Analysis Overview の両方がこの1つの関数を使う（表示ごとに別集計を作らない）。
 */
export function buildCompanySeries(
  history: readonly CompanyQuarterRecord[],
  companies: readonly { readonly companyId: string; readonly displayName: string }[]
): readonly CompanySeries[] {
  return companies.map((c) => ({
    companyId: c.companyId,
    displayName: c.displayName,
    color: COMPANY_COLORS[c.companyId] ?? "#64748b",
    points: history.map((record) => {
      const fin = record.financialResults?.find((f) => f.companyId === c.companyId);
      const financing = record.financingResults?.find((f) => f.companyId === c.companyId);
      const debt =
        financing === undefined
          ? null
          : (financing.endingShortTermLoansUsd ?? 0) + (financing.endingLongTermLoansUsd ?? 0);
      return {
        turn: record.turn,
        revenue: n(fin?.profitAndLoss?.netRevenue),
        operatingProfit: n(fin?.profitAndLoss?.operatingProfit),
        netIncome: n(fin?.profitAndLoss?.netIncome),
        cash: n(fin?.balanceSheet?.cash),
        debt,
      };
    }),
  }));
}

/** Company Inspector 用の、指定会社の最新ターンのスナップショット。 */
export interface CompanyInspectorSnapshot {
  readonly companyId: string;
  readonly turn: number | null;
  readonly revenue: number | null;
  readonly operatingProfit: number | null;
  readonly netIncome: number | null;
  readonly cash: number | null;
  readonly debt: number | null;
  readonly salesHeadcount: number | null;
  readonly hosoProduced: number | null;
  readonly pdProduced: number | null;
  readonly vapProduced: number | null;
  readonly hosoCapacity: number | null;
  readonly pdCapacity: number | null;
  readonly vapCapacity: number | null;
  readonly commonCapacity: number | null;
  readonly rawMaterialShortfall: number | null;
  readonly equipmentShortfall: number | null;
  readonly laborShortfall: number | null;
  /** 最も大きい不足を「現在のボトルネック」として示す。全て0なら null。 */
  readonly primaryBottleneck: string | null;
}

export function buildCompanyInspectorSnapshot(
  state: CompanyLabState,
  companyId: string,
  fixtures: readonly CompanyFixture[]
): CompanyInspectorSnapshot | null {
  const record = state.history[state.history.length - 1];
  if (!record) return null;
  const summary = record.companySummaries.find((s) => s.companyId === companyId);
  if (!summary) return null;
  const fin = record.financialResults?.find((f) => f.companyId === companyId);
  const financing = record.financingResults?.find((f) => f.companyId === companyId);

  const raw = n(unwrapUnit(summary.rawMaterialShortfall)) ?? 0;
  const equip = n(unwrapUnit(summary.equipmentShortfall)) ?? 0;
  const labor = n(unwrapUnit(summary.laborShortfall)) ?? 0;
  const max = Math.max(raw, equip, labor);
  const primaryBottleneck =
    max <= 0 ? null : max === raw ? "原料不足" : max === equip ? "設備能力不足" : "労働力不足";

  const salesHeadcount = state.salesForceHiringState?.companies.find((c) => c.companyId === companyId)?.headcount ?? null;

  const fixture = fixtures.find((f) => f.companyId === companyId);
  const capexStateForCompany = state.capexState.companies.find((c) => c.companyId === companyId);
  const capacities =
    fixture === undefined
      ? undefined
      : (() => {
          const effective = capexStateForCompany
            ? // 【ENG-FAC-1 read-path consistency】記録・表示系も lifecycle 適用後の能力を使う。
              computeEffectiveFactories(
                fixture.factories,
                { companies: [capexStateForCompany] },
                state.currentPeriod,
                state.factoryLifecycleState
              )
            : fixture.factories;
          return effective.reduce(
            (acc, f) => {
              const c = calculateFactoryEffectiveCapacity(f);
              return {
                hoso: acc.hoso + unwrapUnit(c.hoso),
                pd: acc.pd + unwrapUnit(c.pd),
                vap: acc.vap + unwrapUnit(c.vap),
                commonProcessing: acc.commonProcessing + unwrapUnit(c.commonProcessing),
              };
            },
            { hoso: 0, pd: 0, vap: 0, commonProcessing: 0 }
          );
        })();

  return {
    companyId,
    turn: record.turn,
    revenue: n(fin?.profitAndLoss?.netRevenue),
    operatingProfit: n(fin?.profitAndLoss?.operatingProfit),
    netIncome: n(fin?.profitAndLoss?.netIncome),
    cash: n(fin?.balanceSheet?.cash),
    debt:
      financing === undefined
        ? null
        : (financing.endingShortTermLoansUsd ?? 0) + (financing.endingLongTermLoansUsd ?? 0),
    salesHeadcount,
    hosoProduced: n(unwrapUnit(summary.hosoProduced)),
    pdProduced: n(unwrapUnit(summary.pdProduced)),
    vapProduced: n(unwrapUnit(summary.vapProduced)),
    // 能力は capex 反映後の実効値を、fixture と capexState から組み立てる
    // （記録側に会社別能力のスナップショットが無いため、能力計算の唯一の情報源である
    //  computeEffectiveFactories / calculateFactoryEffectiveCapacity を通す）。
    hosoCapacity: capacities?.hoso ?? null,
    pdCapacity: capacities?.pd ?? null,
    vapCapacity: capacities?.vap ?? null,
    commonCapacity: capacities?.commonProcessing ?? null,
    rawMaterialShortfall: raw,
    equipmentShortfall: equip,
    laborShortfall: labor,
    primaryBottleneck,
  };
}
