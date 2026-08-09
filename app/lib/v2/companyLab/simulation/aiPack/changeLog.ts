// ShrimpX V2 — AI Analysis Pack: Major Change Log
//
// 【生成AIで要約しない】前ターンとの差分から決定論的に作る。
// 「重要な変化」の判定は、下の閾値だけで決まる（同じ入力なら常に同じ出力）。
//
// 【閾値を置く理由】価格や財務数値の 0.01 の揺れをすべて event 化すると、
// 変化ログが本来見たい構造変化（採用・増設・律速の切り替わり）に埋もれる。
// **生の数値は world / companies の timeline にすべて残っている**ので、
// ここで落ちるのは「変化ログに載るかどうか」だけである。

import { SimulationAnalyticsDataset } from "../analytics/types";
import { PackCompanyTurn, PackMajorChange, PackWorldTurn } from "./types";

/**
 * 変化ログに載せる閾値。Data Dictionary にも同じ値を記載する。
 * 相対閾値は |新-旧| / max(|旧|, 1) で判定する。
 */
export const MAJOR_CHANGE_THRESHOLDS = {
  /** 人数系（営業人員・市場別配置）: 1人以上動いたら記録する。 */
  headcountAbsolute: 1,
  /** 能力系（トン）: 100t 以上動いたら記録する。 */
  capacityTons: 100,
  /** 金額系（現金・借入）: 相対10%以上かつ絶対100,000 USD以上。 */
  moneyRelative: 0.1,
  moneyAbsoluteUsd: 100_000,
  /** 価格（USD/kg）: 相対5%以上。 */
  priceRelative: 0.05,
  /** 市場需要（トン）: 相対10%以上。 */
  demandRelative: 0.1,
} as const;

function crossedMoneyThreshold(before: number, after: number): boolean {
  const delta = Math.abs(after - before);
  return delta >= MAJOR_CHANGE_THRESHOLDS.moneyAbsoluteUsd && delta / Math.max(Math.abs(before), 1) >= MAJOR_CHANGE_THRESHOLDS.moneyRelative;
}

function crossedRelative(before: number, after: number, relative: number): boolean {
  return Math.abs(after - before) / Math.max(Math.abs(before), 1e-9) >= relative;
}

function fmt(v: number | null, digits = 0): string {
  return v === null ? "－" : v.toFixed(digits);
}

function money(v: number | null): string {
  return v === null ? "－" : `${(v / 1_000_000).toFixed(2)}M USD`;
}

function direction(before: number, after: number): PackMajorChange["changeType"] {
  return after > before ? "INCREASE" : "DECREASE";
}

/**
 * 会社と世界の変化ログを作る。
 * 会社は Pack の company turns、世界は Pack の world turns を入力とする
 * （どちらも既に確定実績から作られた記録であり、ここで再計算はしない）。
 */
export function buildMajorChanges(
  dataset: SimulationAnalyticsDataset,
  worldTurns: readonly PackWorldTurn[],
  companies: Readonly<Record<string, { readonly companyId: string; readonly turns: readonly PackCompanyTurn[] }>>
): readonly PackMajorChange[] {
  const changes: PackMajorChange[] = [];

  // --- 会社 ---
  for (const companyId of Object.keys(companies)) {
    const turns = companies[companyId].turns;
    for (let i = 1; i < turns.length; i++) {
      const prev = turns[i - 1];
      const curr = turns[i];
      const turn = curr.turn;

      // 営業人員
      const beforeHead = prev.endingState.salesHeadcount;
      const afterHead = curr.endingState.salesHeadcount;
      if (beforeHead !== null && afterHead !== null && Math.abs(afterHead - beforeHead) >= MAJOR_CHANGE_THRESHOLDS.headcountAbsolute) {
        changes.push({ turn, scope: companyId, metric: "SALES_HEADCOUNT", from: fmt(beforeHead), to: fmt(afterHead), changeType: direction(beforeHead, afterHead) });
      }

      // 市場別営業配置
      for (const alloc of curr.decision.salesAllocationByMarket) {
        const before = prev.decision.salesAllocationByMarket.find((a) => a.market === alloc.market)?.headcount;
        if (before === undefined) continue;
        if (Math.abs(alloc.headcount - before) >= MAJOR_CHANGE_THRESHOLDS.headcountAbsolute) {
          changes.push({
            turn,
            scope: companyId,
            metric: `SALES_ALLOCATION_${alloc.market}`,
            from: fmt(before),
            to: fmt(alloc.headcount),
            changeType: direction(before, alloc.headcount),
          });
        }
      }

      // 商品別能力・工場数
      for (const product of ["hoso", "pd", "vap"] as const) {
        const before = prev.endingState.capacityTonsByProduct[product];
        const after = curr.endingState.capacityTonsByProduct[product];
        if (before === null || after === null) continue;
        if (Math.abs(after - before) >= MAJOR_CHANGE_THRESHOLDS.capacityTons) {
          changes.push({
            turn,
            scope: companyId,
            metric: `${product.toUpperCase()}_CAPACITY`,
            from: fmt(before),
            to: fmt(after),
            changeType: direction(before, after),
          });
        }
      }
      if (prev.endingState.factoryCount !== null && curr.endingState.factoryCount !== null && prev.endingState.factoryCount !== curr.endingState.factoryCount) {
        changes.push({
          turn,
          scope: companyId,
          metric: "FACTORY_COUNT",
          from: fmt(prev.endingState.factoryCount),
          to: fmt(curr.endingState.factoryCount),
          changeType: direction(prev.endingState.factoryCount, curr.endingState.factoryCount),
        });
      }

      // 現金・借入
      const cashBefore = prev.endingState.cashUsd;
      const cashAfter = curr.endingState.cashUsd;
      if (cashBefore !== null && cashAfter !== null && crossedMoneyThreshold(cashBefore, cashAfter)) {
        changes.push({ turn, scope: companyId, metric: "CASH", from: money(cashBefore), to: money(cashAfter), changeType: direction(cashBefore, cashAfter) });
      }
      const debtBefore = prev.endingState.debtUsd;
      const debtAfter = curr.endingState.debtUsd;
      if (debtBefore !== null && debtAfter !== null && crossedMoneyThreshold(debtBefore, debtAfter)) {
        changes.push({ turn, scope: companyId, metric: "DEBT", from: money(debtBefore), to: money(debtAfter), changeType: direction(debtBefore, debtAfter) });
      }

      // 律速の切り替わり（閾値なし。切り替わったら必ず記録する）
      if (prev.diagnosis.commercialBottleneck !== curr.diagnosis.commercialBottleneck) {
        changes.push({
          turn,
          scope: companyId,
          metric: "PRIMARY_BOTTLENECK",
          from: String(prev.diagnosis.commercialBottleneck),
          to: String(curr.diagnosis.commercialBottleneck),
          changeType: "TRANSITION",
        });
      }

      // 設備投資イベント（状態が変わったものだけ）
      for (const event of curr.execution.capexEvents) {
        if (event.statusBefore === event.statusAfter) continue;
        changes.push({
          turn,
          scope: companyId,
          metric: `CAPEX_${event.projectType}`,
          from: event.statusBefore,
          to: event.statusAfter,
          changeType: "EVENT",
        });
      }
    }

    // 初回ターンの設備投資イベントも拾う（i=1 から始めるループでは漏れるため）。
    const firstTurn = turns[0];
    if (firstTurn) {
      for (const event of firstTurn.execution.capexEvents) {
        if (event.statusBefore === event.statusAfter) continue;
        changes.push({
          turn: firstTurn.turn,
          scope: companyId,
          metric: `CAPEX_${event.projectType}`,
          from: event.statusBefore,
          to: event.statusAfter,
          changeType: "EVENT",
        });
      }
    }
  }

  // --- 世界（TRUE WORLD の価格・需要） ---
  for (let i = 1; i < worldTurns.length; i++) {
    const prev = worldTurns[i - 1];
    const curr = worldTurns[i];
    for (const mp of curr.trueWorld.marketProducts) {
      const before = prev.trueWorld.marketProducts.find((p) => p.market === mp.market && p.product === mp.product);
      if (!before) continue;
      if (before.priceUsdPerKg !== null && mp.priceUsdPerKg !== null && crossedRelative(before.priceUsdPerKg, mp.priceUsdPerKg, MAJOR_CHANGE_THRESHOLDS.priceRelative)) {
        changes.push({
          turn: curr.turn,
          scope: "WORLD",
          metric: `${mp.market}_${mp.product.toUpperCase()}_PRICE`,
          from: fmt(before.priceUsdPerKg, 2),
          to: fmt(mp.priceUsdPerKg, 2),
          changeType: direction(before.priceUsdPerKg, mp.priceUsdPerKg),
        });
      }
      if (before.trueDemandTons !== null && mp.trueDemandTons !== null && crossedRelative(before.trueDemandTons, mp.trueDemandTons, MAJOR_CHANGE_THRESHOLDS.demandRelative)) {
        changes.push({
          turn: curr.turn,
          scope: "WORLD",
          metric: `${mp.market}_${mp.product.toUpperCase()}_DEMAND`,
          from: fmt(before.trueDemandTons),
          to: fmt(mp.trueDemandTons),
          changeType: direction(before.trueDemandTons, mp.trueDemandTons),
        });
      }
    }
    // シナリオイベントの開始・終了
    const beforeIds = new Set(prev.scenarioEvents.map((e) => e.eventId));
    const currIds = new Set(curr.scenarioEvents.map((e) => e.eventId));
    for (const event of curr.scenarioEvents) {
      if (!beforeIds.has(event.eventId)) {
        changes.push({ turn: curr.turn, scope: "WORLD", metric: "SCENARIO_EVENT", from: "(none)", to: `${event.eventId} STARTED`, changeType: "EVENT" });
      }
    }
    for (const event of prev.scenarioEvents) {
      if (!currIds.has(event.eventId)) {
        changes.push({ turn: curr.turn, scope: "WORLD", metric: "SCENARIO_EVENT", from: `${event.eventId} ACTIVE`, to: "ENDED", changeType: "EVENT" });
      }
    }
  }

  void dataset;
  return changes.sort((a, b) => a.turn - b.turn || a.scope.localeCompare(b.scope) || a.metric.localeCompare(b.metric));
}

/** CSV（04_Event_Change_Log.csv）。 */
export function majorChangesToCsv(changes: readonly PackMajorChange[]): string {
  const header = "turn,scope,metric,from,to,changeType";
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = changes.map((c) => [String(c.turn), c.scope, c.metric, c.from, c.to, c.changeType].map(escape).join(","));
  return [header, ...rows].join("\n");
}
