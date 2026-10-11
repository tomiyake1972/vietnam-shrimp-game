/**
 * 【UI-CLARITY-1 A-8】A-8の前後で、年間配当（配当性向100%指定）の資金制約が
 * どの会社に出るかを実測する。E2E AD-E2E-2 が「JPQで現金上限に当たる」ことを
 * 固定していたため、A-8による結果変化で該当会社が変わっていないかを確認する。
 * baseline / 既定seed / 4Turn（Q4が年度末）という、E2Eと同じ最小条件で回す。
 */
import { advanceSimulationTurns, createSimulationSession } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildAnnualDividendPanelRows } from "../../app/lib/v2/companyLab/simulation/annualDividendPanelRows";
import type { ManualBalanceSchedule } from "../../app/lib/v2/companyLab/manualBalance/overrides";

const TS_AT = "2026-10-11T00:00:00.000Z";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const M = (n: number) => (n / 1e6).toFixed(2);

const payout100: ManualBalanceSchedule = [
  {
    kind: "continuing",
    effectiveFromTurn: 1,
    settings: { dividendPayout: { kind: "specified", payoutRatio: 1.0 }, salesPriceIndex: undefined, rawMarketPriceIndex: undefined },
    source: "MANUAL_OVERRIDE",
    recordedAt: TS_AT,
  },
];

const session = createSimulationSession({
  simulationRunId: "a8-probe-annual-dividend",
  scenarioId: "baseline-v0.1",
  seed: "management-console-32q",
  requestedTurns: 4,
  startedAt: TS_AT,
  sourceCommit: "A8-PROBE",
  companyControlModes: Object.fromEntries(COMPANIES.map((c) => [c, "STANDARD_AI"])) as Record<string, "PLAYER" | "STANDARD_AI">,
  manualBalanceOverrides: payout100,
});

const final = advanceSimulationTurns({ session, turns: 4, timestamp: TS_AT, sourceCommit: "A8-PROBE" });
console.log(["会社", "状態", "年間純利益$M", "年間目標$M", "実支払$M", "未達$M", "理由"].map((h) => h.padStart(16)).join(""));
for (const row of buildAnnualDividendPanelRows(final)) {
  if (row.turn !== 4) continue;
  const st = row.settlement;
  console.log(
    [
      row.companyId,
      row.status,
      st ? M(st.annualNetIncomeUsd) : "記録なし",
      st ? M(st.annualDividendTargetUsd) : "記録なし",
      st ? M(st.appliedDividendUsd) : "記録なし",
      st ? M(st.annualDividendShortfallUsd) : "記録なし",
      st?.shortfallReason ?? "－",
    ]
      .map((c) => String(c).padStart(16))
      .join("")
  );
}
