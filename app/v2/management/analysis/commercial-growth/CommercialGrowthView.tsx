"use client";

// ShrimpX V2 — Commercial Growth（独立URL・#05 Phase 6C §10〜§13）
//
// 【この画面が答える問い】
//   ・この会社は今期どこまで売りたかったのか（Commercial Ambition）。
//   ・そのうち、実際に市場へ取りに行ったのはいくらか（Commercial Commitment）。
//   ・提示した量のうち、いくら成約したのか。そして、いくら作ったのか。
//   ・成長を止めているのは営業なのか、生産能力なのか、労働力なのか。
//
// 【混同させない】「売りたい」「市場へ取りに行く」「実際に売れた」「作る」は
// 別々の量である。1本のチャートに並べるのは、その差を見せるためである。
//
// 【捏造しない】記録が無い実行では「記録がありません」と出す。

import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../../../../lib/v2/companyLab/simulation/types";
import { SeriesChart } from "../../components/SeriesChart";
import { AnalysisPageShell } from "../components/AnalysisPageShell";
import { replaceQueryParam, useAnalysisRun, useQueryParam } from "../lib/useAnalysisRun";

const PATH = "/v2/management/analysis/commercial-growth";

const CONSTRAINT_LABELS: Readonly<Record<string, string>> = {
  SALES_CAPACITY: "営業能力",
  PRODUCTION_CAPACITY: "生産能力",
  LABOR: "労働力",
  RAW_MATERIAL: "原料",
  INVENTORY_POLICY: "在庫方針",
  MARKET: "市場競争",
  FINANCE: "資金",
  OTHER: "その他",
  NONE: "なし",
};

const LIMITER_LABELS: Readonly<Record<string, string>> = {
  NONE: "志のまま",
  RECENT_CONVERSION: "直近の成約率",
  MARKET_OPPORTUNITY: "市場機会",
  SALES_CAPACITY: "営業能力",
  STRETCH_LIMIT: "上乗せ上限",
};

const ZERO_HIRE_LABELS: Readonly<Record<string, string>> = {
  SALES_HIRING_BLOCKED_BY_PRODUCTION: "生産能力",
  SALES_HIRING_BLOCKED_BY_LIQUIDITY: "資金",
  SALES_HIRING_BLOCKED_BY_RAW_SUPPLY_UNCERTAINTY: "原料",
  SALES_HIRING_NOT_ECONOMIC: "機会なし",
  SALES_HIRING_LIMITED_BY_TARGET_SCALE: "目標規模到達",
  SALES_HIRING_DEFERRED_UNTIL_CAPACITY_EXPANSION: "能力拡張待ち",
  SALES_FORCE_EXCESS_CAPACITY: "容量過剰",
};

const DASH = "－";
const tons = (v: number | null | undefined) => (v === null || v === undefined ? DASH : Math.round(v).toLocaleString());
const percent = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${(v * 100).toFixed(0)}%`);

const CONSTRAINT_KEYS = ["SALES_CAPACITY", "PRODUCTION_CAPACITY", "LABOR", "RAW_MATERIAL", "INVENTORY_POLICY", "OTHER"] as const;

export function CommercialGrowthView() {
  const { stored, runs, loading, notFoundRunId } = useAnalysisRun();

  const captures = stored?.packCapture?.companyTurns ?? [];
  const companyIds = [...new Set(captures.map((c) => c.companyId))];
  const companyParam = useQueryParam("company", companyIds[0] ?? "");
  const company = companyIds.includes(companyParam) ? companyParam : (companyIds[0] ?? "");

  const rows = captures.filter((c) => c.companyId === company).sort((a, b) => a.turn - b.turn);
  const totalTurns = Math.max(MANAGEMENT_CONSOLE_STANDARD_TURNS, stored?.dataset.turns.length ?? 0);
  const recorded = rows.some((r) => r.commercialGrowth?.availability === "AVAILABLE");

  // 【§11】同一チャートで6系列を比較する（単位はすべて HOSO換算トン/四半期）。
  const series = [
    { key: "vision", label: "① Vision 参考軌道", color: "#a855f7", points: rows.map((r) => ({ turn: r.turn, value: r.commercialGrowth?.visionReferenceScaleTons ?? null })) },
    { key: "ambition", label: "② 売りたい量（Ambition）", color: "#f472b6", points: rows.map((r) => ({ turn: r.turn, value: r.commercialGrowth?.commercialAmbitionTons ?? null })) },
    { key: "commitment", label: "③ 取りに行く量（Commitment）", color: "#fbbf24", points: rows.map((r) => ({ turn: r.turn, value: r.commercialGrowth?.commercialCommitmentTons ?? null })) },
    { key: "submitted", label: "④ 市場へ提示（Submitted）", color: "#38bdf8", points: rows.map((r) => ({ turn: r.turn, value: r.commercialGrowth?.submittedSalesTons ?? null })) },
    { key: "contracted", label: "⑤ 成約（Contracts）", color: "#34d399", points: rows.map((r) => ({ turn: r.turn, value: r.commercialGrowth?.contractedSalesTons ?? null })) },
    { key: "produced", label: "⑥ 生産（Production）", color: "#94a3b8", points: rows.map((r) => ({ turn: r.turn, value: r.commercialGrowth?.actualProductionTons ?? null })) },
  ];

  return (
    <AnalysisPageShell
      title="Commercial Growth（売りたい → 取りに行く → 売れた → 作った）"
      description="この4つは別々の量です。志（Ambition）をそのまま市場へ出すわけではなく、成約しない量まで作るわけでもありません。成長を止めているのが営業なのか生産能力なのかも、ここで分解して示します。"
      stored={stored}
      runs={runs}
      loading={loading}
      notFoundRunId={notFoundRunId}
      path={PATH}
      extraQuery={company ? { company } : undefined}
    >
      {companyIds.length === 0 || !recorded ? (
        <p className="text-sm text-slate-400" data-testid="commercial-growth-empty">
          この Simulation Run には商業成長の記録がありません（Phase 6C より前に保存された実行です）。値を推測で補完することはしません。
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="会社の選択">
            <span className="text-xs text-slate-400">会社</span>
            {companyIds.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => replaceQueryParam("company", id)}
                aria-pressed={id === company}
                data-testid={`commercial-growth-company-${id}`}
                className={`rounded px-2.5 py-1 text-xs font-semibold ${id === company ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
              >
                {id}
              </button>
            ))}
          </div>

          <SeriesChart
            title="Vision → Ambition → Commitment → Submitted → Contracts → Production"
            series={series}
            totalTurns={totalTurns}
            unitLabel="HOSO換算トン / 四半期"
            format={(v) => Math.round(v).toLocaleString()}
            testId="commercial-growth-chart"
            emptyMessage="商業成長の記録がありません。"
          />

          {/* 【§12】ターンごとの制約内訳。既存の正式診断の値だけを出す。 */}
          <section className="mt-3 overflow-x-auto rounded-md border border-slate-700">
            <h2 className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300">Constraint Breakdown（何が成長を止めたか）</h2>
            <table className="w-full min-w-[860px] text-left text-[11px]" data-testid="commercial-growth-constraint-table">
              <thead className="bg-slate-900 text-slate-400">
                <tr>
                  <th className="px-2 py-1">Q</th>
                  <th className="px-2 py-1">主因</th>
                  <th className="px-2 py-1">未充足計</th>
                  {CONSTRAINT_KEYS.map((k) => (
                    <th key={k} className="px-2 py-1">
                      {CONSTRAINT_LABELS[k]}
                    </th>
                  ))}
                  <th className="px-2 py-1">提出を縛った要因</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const g = r.commercialGrowth;
                  return (
                    <tr key={r.turn} className="border-t border-slate-800 text-slate-300">
                      <td className="px-2 py-1 tabular-nums">{r.turn}</td>
                      <td className="px-2 py-1">
                        {g?.primaryGrowthConstraint === null || g?.primaryGrowthConstraint === undefined
                          ? DASH
                          : (CONSTRAINT_LABELS[g.primaryGrowthConstraint] ?? g.primaryGrowthConstraint)}
                      </td>
                      <td className="px-2 py-1 tabular-nums">{tons(g?.unservedProfitableOpportunityTons)}</td>
                      {CONSTRAINT_KEYS.map((k) => (
                        <td key={k} className="px-2 py-1 tabular-nums text-slate-400">
                          {tons(g?.constraintBreakdownTons?.[k])}
                        </td>
                      ))}
                      <td className="px-2 py-1 text-slate-400">
                        {g?.commitmentLimiter ? (LIMITER_LABELS[g.commitmentLimiter] ?? g.commitmentLimiter) : DASH}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
            内訳は同じトン数を二度数えない分解です（在庫 → 生産能力 → 営業能力 → その他の順に割り当て、労働力・原料が診断で名指しされた場合はそちらへ移します）。
            新工場の根拠になりうるのは「生産能力」の分だけです。
          </p>

          {/* 【§13】営業組織。「人が足りない」と「増やしたくない」を区別する。 */}
          <section className="mt-4 overflow-x-auto rounded-md border border-slate-700">
            <h2 className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300">
              Sales Organization（人が足りないのか、増やしたくないのか）
            </h2>
            <table className="w-full min-w-[900px] text-left text-[11px]" data-testid="commercial-growth-sales-org-table">
              <thead className="bg-slate-900 text-slate-400">
                <tr>
                  <th className="px-2 py-1">Q</th>
                  <th className="px-2 py-1">現在</th>
                  <th className="px-2 py-1">必要</th>
                  <th className="px-2 py-1">経済的に欲しい</th>
                  <th className="px-2 py-1">組織上の上限</th>
                  <th className="px-2 py-1">資金上の上限</th>
                  <th className="px-2 py-1">採用</th>
                  <th className="px-2 py-1">減員</th>
                  <th className="px-2 py-1">営業能力</th>
                  <th className="px-2 py-1">稼働率</th>
                  <th className="px-2 py-1">増やさなかった理由</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const s = r.salesOrganization;
                  return (
                    <tr key={r.turn} className="border-t border-slate-800 text-slate-300">
                      <td className="px-2 py-1 tabular-nums">{r.turn}</td>
                      <td className="px-2 py-1 tabular-nums">{s?.currentHeadcount ?? DASH}</td>
                      <td className="px-2 py-1 tabular-nums">{s?.requiredHeadcount ?? DASH}</td>
                      <td className="px-2 py-1 tabular-nums">{s?.unconstrainedEconomicDesiredHeadcount ?? DASH}</td>
                      <td className="px-2 py-1 tabular-nums">{s?.organizationallyAllowedHeadcount ?? DASH}</td>
                      <td className="px-2 py-1 tabular-nums">{s?.financiallyAllowedHeadcount ?? DASH}</td>
                      <td className="px-2 py-1 tabular-nums text-emerald-300">{s?.actualHireCount ?? DASH}</td>
                      <td className="px-2 py-1 tabular-nums text-amber-300">{s?.actualLayoffCount ?? DASH}</td>
                      <td className="px-2 py-1 tabular-nums">{tons(s?.salesCapacityTons)}</td>
                      <td className="px-2 py-1 tabular-nums">{percent(s?.utilization)}</td>
                      <td className="px-2 py-1 text-slate-400">
                        {s?.constraintReason ? (ZERO_HIRE_LABELS[s.constraintReason] ?? s.constraintReason) : DASH}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
            採用が0の四半期には必ず理由が入ります。「必要人数に届いていないのに0」であっても、生産能力・資金・機会のどれが理由かが分かります。
          </p>

          {/* 転換率（TRUE WORLD ではなく、自社の観測）。 */}
          <section className="mt-4 overflow-x-auto rounded-md border border-slate-700">
            <h2 className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300">Conversion（提出 → 成約 → 納品）</h2>
            <table className="w-full min-w-[720px] text-left text-[11px]" data-testid="commercial-growth-conversion-table">
              <thead className="bg-slate-900 text-slate-400">
                <tr>
                  <th className="px-2 py-1">Q</th>
                  <th className="px-2 py-1">提出</th>
                  <th className="px-2 py-1">成約</th>
                  <th className="px-2 py-1">納品</th>
                  <th className="px-2 py-1">提出→成約</th>
                  <th className="px-2 py-1">成約→納品</th>
                  <th className="px-2 py-1">直近の観測成約率</th>
                  <th className="px-2 py-1">提出の逆算に使った率</th>
                  <th className="px-2 py-1">生産の見積りに使った率</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const g = r.commercialGrowth;
                  return (
                    <tr key={r.turn} className="border-t border-slate-800 text-slate-300">
                      <td className="px-2 py-1 tabular-nums">{r.turn}</td>
                      <td className="px-2 py-1 tabular-nums">{tons(g?.submittedSalesTons)}</td>
                      <td className="px-2 py-1 tabular-nums">{tons(g?.contractedSalesTons)}</td>
                      <td className="px-2 py-1 tabular-nums">{tons(g?.deliveredSalesTons)}</td>
                      <td className="px-2 py-1 tabular-nums">{percent(g?.submissionToContractRatio)}</td>
                      <td className="px-2 py-1 tabular-nums">{percent(g?.contractToDeliveryRatio)}</td>
                      <td className="px-2 py-1 tabular-nums text-slate-400">{percent(g?.observedConversionRatio)}</td>
                      <td className="px-2 py-1 tabular-nums text-slate-400">{percent(g?.submissionTargetConversionRatio)}</td>
                      <td className="px-2 py-1 tabular-nums text-slate-400">{percent(g?.productionExpectedConversionRatio)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
            成約率は<strong>自社が過去に提出した量と、自社が実際に取れた量</strong>から観測した値です。市場の真の需要（TRUE WORLD）ではありません。
            提出量の逆算には目標帯へ寄せた率を、生産量の見積りには観測値そのものを使います（狙いと予測を混ぜないため）。
          </p>
        </>
      )}
    </AnalysisPageShell>
  );
}
