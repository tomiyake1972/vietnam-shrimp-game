"use client";

// ShrimpX V2 — 32Q Management Console: Company Inspector（Phase 1）
//
// 【生成AIを呼ばない】表示はすべて既存の state / history / Standard AI diagnostics の再利用。
// 【捏造しない】取得できない項目は「－」と表示し、推測値で埋めない。

import { CompanyFixture, CompanyLabState } from "../../../lib/v2/companyLab/types";
import { buildCompanyInspectorSnapshot } from "../../../lib/v2/companyLab/simulation/series";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../../lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../../lib/v2/companyLab/standardAi/policy";
import { CompanyStrategyDocument, resolveStrategyAtTurn } from "../../../lib/v2/companyLab/strategyProfile/types";
import { unwrapUnit } from "../../../lib/v2/core/units";

interface Props {
  readonly state: CompanyLabState;
  readonly fixtures: readonly CompanyFixture[];
  readonly selectedCompanyId: string;
  readonly onSelect: (companyId: string) => void;
  readonly strategyDocs: Readonly<Record<string, CompanyStrategyDocument>>;
}

const DASH = "－";
const money = (v: number | null) => (v === null ? DASH : `${(v / 1_000_000).toFixed(1)}M`);
const tons = (v: number | null) => (v === null ? DASH : `${Math.round(v).toLocaleString()}t`);

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-sm font-medium tabular-nums text-slate-100">{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-slate-700 bg-slate-900/50 p-2.5">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300">{title}</h3>
      {children}
    </section>
  );
}

export function CompanyInspector({ state, fixtures, selectedCompanyId, onSelect, strategyDocs }: Props) {
  const fixture = fixtures.find((f) => f.companyId === selectedCompanyId);
  const snapshot = buildCompanyInspectorSnapshot(state, selectedCompanyId, fixtures);
  const turn = state.scenarioState.currentTurn;

  // 当期の Standard AI 判断（次のターンで実際に使われるものと同じ関数・同じ入力）。
  // 純粋関数なので、会社を切り替えてもゲームの進行には一切影響しない。
  let diagnostics: ReturnType<typeof generateStandardAiDecisionWithDiagnostics> | null = null;
  if (fixture) {
    try {
      const ownState = buildCompanyOwnState(state, fixture);
      const publicInfo = buildPublicMarketInfo(state);
      diagnostics = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, state.currentPeriod, turn);
    } catch {
      diagnostics = null;
    }
  }

  const sd = diagnostics?.diagnostics.situationDiagnosis;
  const decision = diagnostics?.decision;
  const strategy = strategyDocs[selectedCompanyId]
    ? resolveStrategyAtTurn(strategyDocs[selectedCompanyId], turn)
    : null;

  const entriesByDomain = (domain: string) =>
    (diagnostics?.diagnostics.entries ?? []).filter((e) => e.domain === domain);

  return (
    <div className="flex h-full flex-col gap-2.5 overflow-y-auto">
      <div className="flex flex-wrap gap-1.5">
        {fixtures.map((f) => (
          <button
            key={f.companyId}
            type="button"
            onClick={() => onSelect(f.companyId)}
            aria-pressed={f.companyId === selectedCompanyId}
            className={`rounded px-2.5 py-1 text-xs font-semibold transition ${
              f.companyId === selectedCompanyId
                ? "bg-sky-600 text-white"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {f.companyId}
          </button>
        ))}
      </div>

      {!fixture ? (
        <p className="text-sm text-slate-400">会社が見つかりません。</p>
      ) : (
        <>
          <Section title="会社">
            <p className="text-sm font-semibold text-slate-100">{fixture.displayName}</p>
            <p className="mt-0.5 text-xs text-slate-400">
              archetype: {fixture.archetype} / Turn {turn}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{fixture.description}</p>
          </Section>

          <Section title="Mission / Vision">
            <dl>
              <Row label="Mission" value={strategyDocs[selectedCompanyId]?.mission || "（未設定）"} />
              <Row label="Vision" value={strategyDocs[selectedCompanyId]?.vision || "（未設定）"} />
            </dl>
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              Mission / Vision は今回新設した項目です。既定は空で、それらしい文言を自動生成していません。
            </p>
          </Section>

          <Section title="Strategy Profile（表示のみ・AI判断へ未接続）">
            {strategy === null ? (
              <p className="text-xs text-slate-400">未設定</p>
            ) : (
              <dl>
                <Row label="有効ターン" value={`Turn ${strategy.effectiveFromTurn} 〜`} />
                <Row label="商品フォーカス" value={strategy.profile.productFocus} />
                <Row label="特化度" value={String(strategy.profile.specialization)} />
                <Row label="成長志向" value={String(strategy.profile.growthAppetite)} />
                <Row label="投資志向" value={String(strategy.profile.investmentAppetite)} />
                <Row label="財務保守性" value={String(strategy.profile.financialConservatism)} />
                <Row label="在庫姿勢" value={strategy.profile.inventoryPosture} />
                <Row label="契約志向" value={strategy.profile.contractPreference} />
                <Row label="時間軸" value={strategy.profile.strategicHorizon} />
              </dl>
            )}
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              Phase 1 では保存・表示のみで、Standard AI の数値判断へは接続していません。
            </p>
          </Section>

          <Section title="財務">
            <dl>
              <Row label="Revenue" value={money(snapshot?.revenue ?? null)} />
              <Row label="Operating Profit" value={money(snapshot?.operatingProfit ?? null)} />
              <Row label="Net Income" value={money(snapshot?.netIncome ?? null)} />
              <Row label="Cash" value={money(snapshot?.cash ?? null)} />
              <Row label="Debt" value={money(snapshot?.debt ?? null)} />
            </dl>
          </Section>

          <Section title="操業">
            <dl>
              <Row label="Sales Headcount" value={snapshot?.salesHeadcount === null || snapshot === null ? DASH : String(snapshot.salesHeadcount)} />
              <Row label="HOSO 生産 / 能力" value={`${tons(snapshot?.hosoProduced ?? null)} / ${tons(snapshot?.hosoCapacity ?? null)}`} />
              <Row label="PD 生産 / 能力" value={`${tons(snapshot?.pdProduced ?? null)} / ${tons(snapshot?.pdCapacity ?? null)}`} />
              <Row label="VAP 生産 / 能力" value={`${tons(snapshot?.vapProduced ?? null)} / ${tons(snapshot?.vapCapacity ?? null)}`} />
              <Row label="共通前処理能力" value={tons(snapshot?.commonCapacity ?? null)} />
            </dl>
          </Section>

          <Section title="ボトルネック">
            {snapshot === null ? (
              <p className="text-xs text-slate-400">まだ実績がありません。</p>
            ) : (
              <>
                <p className="mb-1 text-sm font-semibold text-amber-300">
                  {snapshot.primaryBottleneck ?? "不足なし"}
                </p>
                <dl>
                  <Row label="原料不足" value={tons(snapshot.rawMaterialShortfall)} />
                  <Row label="設備不足" value={tons(snapshot.equipmentShortfall)} />
                  <Row label="労働力不足" value={tons(snapshot.laborShortfall)} />
                </dl>
              </>
            )}
          </Section>

          <Section title="Standard AI 状況診断">
            {sd === undefined ? (
              <p className="text-xs text-slate-400">診断が取得できません。</p>
            ) : (
              <dl>
                <Row label="主要制約" value={String(sd.primaryConstraint)} />
                <Row label="副次制約" value={String(sd.secondaryConstraint)} />
              </dl>
            )}
          </Section>

          <Section title="Standard AI 主要意思決定">
            {decision === undefined ? (
              <p className="text-xs text-slate-400">意思決定が取得できません。</p>
            ) : (
              <dl>
                <Row label="営業採用" value={String(decision.salesForceHireCount ?? 0)} />
                <Row
                  label="販売計画（市場×商品）"
                  value={`${decision.salesPlans.length} 件 / ${Math.round(
                    decision.salesPlans.reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0)
                  ).toLocaleString()}t`}
                />
                <Row
                  label="生産計画"
                  value={`${Math.round(
                    decision.productionPlans.reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0)
                  ).toLocaleString()}t`}
                />
                <Row label="国内買付希望" value={tons(unwrapUnit(decision.domesticPurchasePlan.desiredQuantity))} />
                <Row
                  label="輸入発注"
                  value={tons(decision.importOrders.reduce((s, o) => s + unwrapUnit(o.orderedQuantity), 0))}
                />
                <Row
                  label="Worker配置"
                  value={`${decision.workerAssignments.reduce((s, w) => s + w.regularHeadcount, 0)} 人`}
                />
                <Row
                  label="設備投資提案"
                  value={
                    decision.capexDecision.newProjectProposals.length === 0
                      ? "なし"
                      : decision.capexDecision.newProjectProposals.map((p) => String(p.projectType)).join(", ")
                  }
                />
                <Row label="借入申請" value={money(decision.financingRequest.desiredAmountUsd)} />
              </dl>
            )}
          </Section>

          <Section title="判断根拠（diagnostics）">
            {(["procurement", "capex", "finance"] as const).map((domain) => {
              const list = entriesByDomain(domain);
              return (
                <div key={domain} className="mb-1.5 last:mb-0">
                  <p className="text-[11px] font-semibold uppercase text-slate-400">{domain}</p>
                  {list.length === 0 ? (
                    <p className="text-[11px] text-slate-500">記録なし</p>
                  ) : (
                    <ul className="list-inside list-disc">
                      {list.slice(0, 4).map((e, i) => (
                        <li key={`${e.code}-${i}`} className="text-[11px] leading-snug text-slate-300">
                          <span className="font-mono text-slate-400">{e.code}</span>
                          {e.decisionSummary ? ` — ${e.decisionSummary}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </Section>
        </>
      )}
    </div>
  );
}
