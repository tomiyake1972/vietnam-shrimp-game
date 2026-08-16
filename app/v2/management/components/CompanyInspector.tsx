"use client";

// ShrimpX V2 — 32Q Management Console: Company Inspector（Phase 2で dataset 駆動へ変更）
//
// 【Phase 2 での変更点】
// Phase 1 は表示のたびに Standard AI をその場で呼び直していた（画面専用の実行経路）。
// Phase 2 では、実行中に記録した AI Trace（＝実際にゲームへ提出された判断そのもの）
// だけを見る。これにより
//   - 画面の表示と実際の意思決定が食い違わない
//   - 保存済み Simulation Run をリロード後に開いても同じ内容が出る
// の2点が同時に満たされる。
//
// 【生成AIを呼ばない】【捏造しない】取得できない項目は「－」と表示する。

import { CompanyFixture } from "../../../lib/v2/companyLab/types";
import { SimulationAnalyticsDataset } from "../../../lib/v2/companyLab/simulation/analytics/types";
import { companySnapshot } from "../../../lib/v2/companyLab/simulation/analytics/views";
import { BOTTLENECK_LABELS } from "../../../lib/v2/companyLab/simulation/analytics/types";
import { CompanyStrategyDocument, resolveStrategyAtTurn } from "../../../lib/v2/companyLab/strategyProfile/types";
import { PackCompanyTurnCapture } from "../../../lib/v2/companyLab/simulation/types";
import { Collapsible } from "./Collapsible";
import { describeNewFactoryBlocker } from "../../../lib/v2/companyLab/standardAi/decision/newFactory";

interface Props {
  readonly dataset: SimulationAnalyticsDataset;
  readonly fixtures: readonly CompanyFixture[];
  readonly selectedCompanyId: string;
  readonly onSelect: (companyId: string) => void;
  readonly strategyDocs: Readonly<Record<string, CompanyStrategyDocument>>;
  /** 【Vision駆動の戦略成長】会社×ターンの志・戦略ギャップ・新工場判断の記録。 */
  readonly strategyTurns: readonly PackCompanyTurnCapture[];
}

const GROWTH_PRESSURE_LABELS: Readonly<Record<string, string>> = {
  LOW: "低（志の軌道に乗っている）",
  MODERATE: "中（やや遅れている）",
  HIGH: "高（志に対して明確に遅れている）",
  URGENT: "切迫（志との差が大きい）",
};

const NEW_FACTORY_STATUS_LABELS: Readonly<Record<string, string>> = {
  NOT_CONSIDERED: "検討対象外",
  MONITORING: "候補として監視中",
  CONSIDERING: "具体的に検討中",
  READY_TO_BUILD: "提案（着工可能と判断）",
  DEFERRED: "見送り",
  APPROVED: "承認済み・建設中",
};

const CONSTRAINT_LABELS: Readonly<Record<string, string>> = {
  SALES_CAPACITY: "営業能力",
  PRODUCTION_CAPACITY: "生産能力",
  LABOR: "労働力",
  RAW_MATERIAL: "原料",
  INVENTORY_POLICY: "在庫方針",
  MARKET: "市場競争",
  FINANCE: "資金",
  OTHER: "その他",
  NONE: "なし（志の範囲で取り切れている）",
};

const COMMITMENT_LIMITER_LABELS: Readonly<Record<string, string>> = {
  NONE: "志のまま取りに行けた",
  RECENT_CONVERSION: "直近の成約率を踏まえて抑えた",
  MARKET_OPPORTUNITY: "観測できる採算機会が足りない",
  SALES_CAPACITY: "営業組織が捌ける案件量が足りない",
  STRETCH_LIMIT: "志への上乗せ上限に当たった",
};

const ZERO_HIRE_REASON_LABELS: Readonly<Record<string, string>> = {
  SALES_HIRING_BLOCKED_BY_PRODUCTION: "生産能力に余力が無いため増やさない",
  SALES_HIRING_BLOCKED_BY_LIQUIDITY: "資金余力が足りないため増やさない",
  SALES_HIRING_BLOCKED_BY_RAW_SUPPLY_UNCERTAINTY: "原料供給が不確実なため増やさない",
  SALES_HIRING_NOT_ECONOMIC: "追加1人が担う販売機会が無いため増やさない",
  SALES_HIRING_LIMITED_BY_TARGET_SCALE: "目指す規模に既に達しているため増やさない",
  SALES_HIRING_DEFERRED_UNTIL_CAPACITY_EXPANSION: "生産能力の拡張が先のため増やさない",
  SALES_FORCE_EXCESS_CAPACITY: "営業容量が過剰なため減員した",
};

const DASH = "－";
const money = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${(v / 1_000_000).toFixed(1)}M`);
const tons = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${Math.round(v).toLocaleString()}t`);
const percent = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${(v * 100).toFixed(0)}%`);

/**
 * 【Phase 6C・#05 §9】経営の思考を決定論的なテンプレートで1本の文にする。
 *
 * **生成AIは使わない。** 与えられた数値と理由コードだけから組み立てる。
 * 値が無いところは書かない（推測で埋めない）。
 */
function commercialNarrative(companyId: string, g: PackCompanyTurnCapture["commercialGrowth"], s: PackCompanyTurnCapture["salesOrganization"]): string {
  const parts: string[] = [];

  if (g.visionReferenceScaleTons !== null && g.commercialAmbitionTons !== null) {
    const behind = g.commercialAmbitionTons < g.visionReferenceScaleTons;
    parts.push(
      behind
        ? `${companyId}はVisionの参考軌道（${Math.round(g.visionReferenceScaleTons).toLocaleString()}t）に対して販売規模が遅れている。`
        : `${companyId}はVisionの参考軌道（${Math.round(g.visionReferenceScaleTons).toLocaleString()}t）に対して遅れていない。`
    );
  }
  if (g.profitableOpportunityTons !== null && g.profitableOpportunityTons > 0) {
    parts.push("観測可能な採算機会があるため販売拡大を狙う。");
  }
  if (g.commercialAmbitionTons !== null) {
    parts.push(`今期は${Math.round(g.commercialAmbitionTons).toLocaleString()}tを目指し、`);
  }
  parts.push(`${Math.round(g.submittedSalesTons).toLocaleString()}tを市場へ提示した。`);
  parts.push(`実際の成約は${Math.round(g.contractedSalesTons).toLocaleString()}t。`);
  if (g.actualProductionTons > 0) {
    parts.push(`生産は${Math.round(g.actualProductionTons).toLocaleString()}t。`);
  }
  if (g.primaryGrowthConstraint && g.primaryGrowthConstraint !== "NONE") {
    parts.push(`現在の主な成長制約は${CONSTRAINT_LABELS[g.primaryGrowthConstraint] ?? g.primaryGrowthConstraint}。`);
  } else if (g.primaryGrowthConstraint === "NONE") {
    parts.push("現在、志の範囲では取り切れており、明確な成長制約は出ていない。");
  }
  if (s.actualHireCount > 0) {
    parts.push(`営業は${s.actualHireCount}人を採用した。`);
  } else if (s.constraintReason) {
    parts.push(`営業は増やさなかった（${ZERO_HIRE_REASON_LABELS[s.constraintReason] ?? s.constraintReason}）。`);
  }
  return parts.join("");
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-sm font-medium tabular-nums text-slate-100">{value}</dd>
    </div>
  );
}

/** 常に開いたまま見せる小さなブロック（会社の基本情報だけ）。 */
function AlwaysSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-slate-700 bg-slate-900/50 p-2.5">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300">{title}</h3>
      {children}
    </section>
  );
}

/**
 * 詳細セクションは既定で閉じる。
 * 32Q を回す操作と分析画面への移動を最優先し、Console 起動直後に情報を積み上げない。
 */
function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <Collapsible title={title} testId={testId}>
      {children}
    </Collapsible>
  );
}

export function CompanyInspector({ dataset, fixtures, selectedCompanyId, onSelect, strategyDocs, strategyTurns }: Props) {
  const fixture = fixtures.find((f) => f.companyId === selectedCompanyId);
  const latestTurn = dataset.turns[dataset.turns.length - 1] ?? null;
  const snapshot = latestTurn === null ? null : companySnapshot(dataset, selectedCompanyId, latestTurn);
  const bottleneck = dataset.bottlenecks.find((b) => b.companyId === selectedCompanyId && b.turn === latestTurn) ?? null;
  const strategy = strategyDocs[selectedCompanyId] && latestTurn !== null ? resolveStrategyAtTurn(strategyDocs[selectedCompanyId], latestTurn) : null;

  const traceAt = (stage: string) =>
    dataset.aiTrace.find((t) => t.companyId === selectedCompanyId && t.turn === latestTurn && t.stage === stage) ?? null;
  // 【Vision駆動の戦略成長】最新ターンの志・戦略ギャップ・新工場判断。
  const latestStrategy = strategyTurns.find((s) => s.companyId === selectedCompanyId && s.turn === latestTurn)?.strategy ?? null;
  const vision = latestStrategy?.vision ?? null;
  // 【Phase 6C】Vision → Ambition → Commitment → Contracts → Production の因果。
  const latestCapture = strategyTurns.find((s) => s.companyId === selectedCompanyId && s.turn === latestTurn) ?? null;
  const growth = latestCapture?.commercialGrowth ?? null;
  const salesOrg = latestCapture?.salesOrganization ?? null;
  const newFactory = latestStrategy?.newFactory ?? null;
  // 【Phase 6D】MONITORING では失敗 gate が記録上存在しない（提案圧力未達が止めている）。
  const blocker = newFactory ? describeNewFactoryBlocker(newFactory) : null;
  const blockingGate = newFactory?.gates.find((g) => !g.passed) ?? null;

  const diagnosed = traceAt("DIAGNOSED");
  const decided = traceAt("DECIDED");
  const constrained = traceAt("CONSTRAINED");

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
              f.companyId === selectedCompanyId ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
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
          <AlwaysSection title="会社">
            <p className="text-sm font-semibold text-slate-100">{fixture.displayName}</p>
            <p className="mt-0.5 text-xs text-slate-400">
              archetype: {fixture.archetype} / 表示中: {latestTurn === null ? "実績なし" : `Turn ${latestTurn}`}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{fixture.description}</p>
          </AlwaysSection>

          {/* 【Standard AI Crisis Management・Phase CM-1・指示§14】Operating Modeは
              NORMAL時も含め常に見える位置に置き、危機時だけ理由を添えて目立たせる。
              大規模UI改修はしない（Vision/Strategic Outlookの既存パターンを踏襲）。 */}
          {latestStrategy?.crisis && latestStrategy.crisis.state !== "NORMAL" ? (
            <AlwaysSection title="Operating Mode">
              <div data-testid="operating-mode-card">
                <p
                  className={`text-sm font-semibold ${
                    latestStrategy.crisis.state === "SEVERE_DISTRESS" ? "text-red-400" : "text-amber-300"
                  }`}
                  data-testid="operating-mode-label"
                >
                  {latestStrategy.crisis.state === "SEVERE_DISTRESS" ? "SEVERE DISTRESS（深刻な資金繰り危機）" : "LIQUIDITY STRESS（資金繰り悪化）"}
                </p>
                <dl className="mt-1.5">
                  <Row
                    label="Procurement Capacity"
                    value={
                      latestStrategy.crisis.procurementScaleRatio === null
                        ? DASH
                        : `${Math.round(latestStrategy.crisis.procurementScaleRatio * 100)}%`
                    }
                  />
                  <Row label="Underwriting" value={latestStrategy.crisis.underwritingFrozen ? "Frozen" : latestStrategy.crisis.underwritingFrozen === false ? "通常" : DASH} />
                  <Row label="新規受注" value={latestStrategy.crisis.newSalesSuppressed ? "抑制中（既存Backlogは履行継続）" : "通常"} />
                  <Row label="新規設備投資" value={latestStrategy.crisis.capexPaused ? "停止中（着工済みは継続）" : "通常"} />
                  <Row label="営業採用" value={latestStrategy.crisis.salesHiringStopped ? "停止中" : "通常"} />
                </dl>
                <p className="mt-1.5 text-[11px] leading-snug text-slate-400">{latestStrategy.crisis.summary}</p>
              </div>
            </AlwaysSection>
          ) : null}

          {/* 【Strategy Profile Quantification・Phase SP-Q1・指示§23】名前のみの表示。
              全parameter editorやON/OFF toggleは今回追加しない（benchmark configで十分）。
              mode="OFF"（既定）ではStrategy Profileセクション自体を出さない。 */}
          {latestStrategy?.profile && latestStrategy.profile.mode === "ON" ? (
            <AlwaysSection title="Strategy Profile">
              <div data-testid="strategy-profile-card">
                <dl>
                  <Row label="Management Profile" value={latestStrategy.profile.managementProfileId} />
                  <Row label="Orientation Profile" value={latestStrategy.profile.orientationProfileId} />
                </dl>
              </div>
            </AlwaysSection>
          ) : null}

          {/* 【常に見える】経営の「志」は折りたたまない。ここが今回の中心だからである。 */}
          <AlwaysSection title="Vision（経営者の志）">
            {vision === null ? (
              <p className="text-xs text-slate-400" data-testid="vision-card-empty">
                この実行には Vision の記録がありません（Vision 導入より前に保存された実行です）。
              </p>
            ) : (
              <div data-testid="vision-card">
                <p className="text-sm leading-relaxed text-slate-100">{vision.longTermNarrative}</p>
                <dl className="mt-1.5">
                  <Row label="Q32で目指す規模" value={`${vision.targetScaleTonsPerQuarterAtQ32.toLocaleString()} t/期`} />
                  <Row label="目指す会社像" value={vision.preferredEndState} />
                  <Row label="成長への意欲" value={vision.growthAmbition} />
                  <Row label="工場建設への前向きさ" value={vision.willingnessToBuildFactories} />
                  <Row label="財務リスク許容度" value={vision.financialRiskTolerance} />
                  <Row label="商品構成の方向" value={vision.desiredProductEvolution} />
                </dl>
                <p className="mt-1.5 text-[11px] leading-snug text-amber-300/80">
                  Vision を決めるのは<strong>人間の経営者</strong>です。Standard AI はこの志を自分で作らず、志と現在地の差に反応して今期の判断を行います。
                  Q32の規模は「目指す姿」であって達成義務ではありません。
                </p>
              </div>
            )}
          </AlwaysSection>

          <AlwaysSection title="Strategic Outlook（志に対する現在地）">
            {latestStrategy === null || latestStrategy.growthPressure === null ? (
              <p className="text-xs text-slate-400">記録がありません。</p>
            ) : (
              <dl data-testid="strategic-outlook">
                <Row
                  label="参考成長軌道（当期）"
                  value={latestStrategy.visionTargetScaleAtCurrentTurn === null ? DASH : tons(latestStrategy.visionTargetScaleAtCurrentTurn)}
                />
                <Row label="現在の持続可能規模" value={tons(latestStrategy.currentSustainableScaleTons)} />
                <Row
                  label="戦略ギャップ"
                  value={
                    latestStrategy.strategicScaleGapTons === null
                      ? DASH
                      : `${tons(latestStrategy.strategicScaleGapTons)}（${((latestStrategy.strategicScaleGapRatio ?? 0) * 100).toFixed(1)}%）`
                  }
                />
                <Row label="成長圧力" value={GROWTH_PRESSURE_LABELS[latestStrategy.growthPressure] ?? latestStrategy.growthPressure} />
              </dl>
            )}
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              参考成長軌道は「志に対して今どこにいるか」を測る物差しであり、目標値ではありません。未来の需要・価格の予測は使っていません。
            </p>
          </AlwaysSection>

          {/* 【常に見える】§8: 主要値だけを簡潔に。詳細は下の折りたたみへ。 */}
          <AlwaysSection title="Commercial Growth（売りたい → 取りに行く → 売れた → 作った）">
            {growth === null || growth.availability !== "AVAILABLE" ? (
              <p className="text-xs text-slate-400" data-testid="commercial-growth-empty">
                この実行には商業成長の記録がありません（Phase 6C より前に保存された実行です）。値を推測で補完することはしません。
              </p>
            ) : (
              <div data-testid="commercial-growth">
                <p className="text-sm leading-relaxed text-slate-100" data-testid="commercial-narrative">
                  {commercialNarrative(selectedCompanyId, growth, salesOrg!)}
                </p>
                <dl className="mt-1.5">
                  <Row label="① 参考成長軌道（Vision）" value={tons(growth.visionReferenceScaleTons)} />
                  <Row label="② 売りたい量（Ambition）" value={tons(growth.commercialAmbitionTons)} />
                  <Row label="③ 取りに行く量（Commitment）" value={tons(growth.commercialCommitmentTons)} />
                  <Row label="④ 市場へ提示した量（Submitted）" value={tons(growth.submittedSalesTons)} />
                  <Row label="⑤ 実際に売れた量（Contracts）" value={tons(growth.contractedSalesTons)} />
                  <Row label="⑥ 作った量（Production）" value={tons(growth.actualProductionTons)} />
                  <Row label="取れなかった採算機会" value={tons(growth.unservedProfitableOpportunityTons)} />
                  <Row
                    label="主な成長制約"
                    value={
                      growth.primaryGrowthConstraint === null
                        ? DASH
                        : (CONSTRAINT_LABELS[growth.primaryGrowthConstraint] ?? growth.primaryGrowthConstraint)
                    }
                  />
                </dl>
                <p className="mt-1 text-[11px] leading-snug text-slate-500">
                  ②〜⑥は<strong>それぞれ別の量</strong>です。「売りたい」「市場へ取りに行く」「実際に売れた」「作る」を同じ数字として扱わないでください。
                </p>
              </div>
            )}
          </AlwaysSection>

          <Section title="Commercial Thinking（なぜその量を取りに行ったのか）" testId="inspector-commercial-thinking-toggle">
            {growth === null || growth.availability !== "AVAILABLE" ? (
              <p className="text-xs text-slate-400">記録がありません。</p>
            ) : (
              <dl data-testid="commercial-thinking">
                <Row
                  label="提出量を縛った要因"
                  value={growth.commitmentLimiter === null ? DASH : (COMMITMENT_LIMITER_LABELS[growth.commitmentLimiter] ?? growth.commitmentLimiter)}
                />
                <Row label="直近の成約率（観測）" value={percent(growth.observedConversionRatio)} />
                <Row label="提出量の逆算に使った期待成約率" value={percent(growth.submissionTargetConversionRatio)} />
                <Row label="生産量の見積りに使った期待成約率" value={percent(growth.productionExpectedConversionRatio)} />
                <Row label="今期の 提出→成約" value={percent(growth.submissionToContractRatio)} />
                <Row label="今期の 成約→納品" value={percent(growth.contractToDeliveryRatio)} />
                <Row label="観測できる採算機会" value={tons(growth.profitableOpportunityTons)} />
                <Row label="生産必要量" value={tons(growth.productionRequirementTons)} />
              </dl>
            )}
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              成約率は<strong>自社の過去の実績</strong>から観測した値であり、市場の真の需要（TRUE WORLD）ではありません。
            </p>
          </Section>

          <Section title="Sales Organization（人が足りないのか、増やしたくないのか）" testId="inspector-sales-organization-toggle">
            {salesOrg === null || salesOrg.availability !== "AVAILABLE" ? (
              <p className="text-xs text-slate-400">記録がありません。</p>
            ) : (
              <dl data-testid="sales-organization">
                <Row label="現在の営業人員" value={`${salesOrg.currentHeadcount}人`} />
                <Row label="必要人数" value={salesOrg.requiredHeadcount === null ? DASH : `${salesOrg.requiredHeadcount}人`} />
                <Row
                  label="経済的に欲しい人数"
                  value={salesOrg.unconstrainedEconomicDesiredHeadcount === null ? DASH : `${salesOrg.unconstrainedEconomicDesiredHeadcount}人`}
                />
                <Row
                  label="組織上ここまで増やせる"
                  value={salesOrg.organizationallyAllowedHeadcount === null ? DASH : `${salesOrg.organizationallyAllowedHeadcount}人`}
                />
                <Row
                  label="資金上ここまで増やせる"
                  value={salesOrg.financiallyAllowedHeadcount === null ? DASH : `${salesOrg.financiallyAllowedHeadcount}人`}
                />
                <Row label="今期の採用" value={`${salesOrg.actualHireCount}人`} />
                <Row label="今期の減員" value={`${salesOrg.actualLayoffCount}人`} />
                <Row label="営業能力" value={tons(salesOrg.salesCapacityTons)} />
                <Row label="うち使った量" value={tons(salesOrg.usedSalesCapacityTons)} />
                <Row label="営業能力の稼働率" value={percent(salesOrg.utilization)} />
                <Row
                  label="増やさなかった理由"
                  value={salesOrg.constraintReason === null ? "（採用した）" : (ZERO_HIRE_REASON_LABELS[salesOrg.constraintReason] ?? salesOrg.constraintReason)}
                />
              </dl>
            )}
          </Section>

          <Section title="Investment Thinking（新工場を建てる／建てない理由）" testId="inspector-investment-thinking-toggle">
            {newFactory === null ? (
              <p className="text-xs text-slate-400">新工場の検討記録がありません。</p>
            ) : (
              <div data-testid="investment-thinking">
                <p className="text-sm font-semibold text-sky-300">{NEW_FACTORY_STATUS_LABELS[newFactory.status] ?? newFactory.status}</p>
                <dl className="mt-1">
                  <Row label="投資額（標準工場）" value={money(newFactory.projectCostUsd)} />
                  <Row label="着工四半期の支払" value={money(newFactory.firstPaymentUsd)} />
                  <Row label="判断を止めたゲート" value={blocker ?? "（全ゲート通過・提案）"} />
                  {newFactory.decisionRoute && newFactory.decisionRoute !== "NONE" ? (
                    <Row
                      label="判断経路"
                      value={
                        newFactory.decisionRoute === "STRATEGIC_FORWARD_CAPACITY"
                          ? "Strategic route: Lead-the-Market（先行能力投資）"
                          : "Reactive route（今の稼働率・需要に反応）"
                      }
                    />
                  ) : null}
                  {newFactory.strategicPosture ? <Row label="戦略姿勢" value={newFactory.strategicPosture} /> : null}
                </dl>
                {newFactory.forwardCapacityGap ? (
                  <div className="mt-1.5 rounded border border-amber-800/60 bg-amber-950/30 p-1.5" data-testid="investment-thinking-forward-gap">
                    <p className="text-[11px] font-semibold text-amber-300">Forward Capacity Gap（完成予定時点の能力不足見込み）</p>
                    <dl className="mt-0.5">
                      <Row label="新工場完成予定" value={`Q${newFactory.forwardCapacityGap.forecastCompletionTurn}`} />
                      <Row label="完成時点の想定規模" value={tons(newFactory.forwardCapacityGap.projectedCommercialScaleAtCompletion)} />
                      <Row label="現在の実効能力" value={tons(newFactory.forwardCapacityGap.existingCapacityAtCompletion)} />
                      <Row
                        label="Forward Gap"
                        value={`${tons(newFactory.forwardCapacityGap.forwardCapacityGapTons)}（${percent(newFactory.forwardCapacityGap.forwardCapacityGapRatio)}）`}
                      />
                      <Row label="財務" value={newFactory.postConstructionActivationFeasible ? "Feasible" : "見送り"} />
                      {newFactory.reactiveStatusAtStrategicDecision ? (
                        <Row
                          label="Reactive route"
                          value={`NOT READY（${NEW_FACTORY_STATUS_LABELS[newFactory.reactiveStatusAtStrategicDecision] ?? newFactory.reactiveStatusAtStrategicDecision}${
                            newFactory.reactiveBlockerAtStrategicDecision ? ` / ${newFactory.reactiveBlockerAtStrategicDecision}` : ""
                          }）`}
                        />
                      ) : null}
                    </dl>
                  </div>
                ) : null}
                {blockingGate ? <p className="mt-1 text-[11px] leading-snug text-slate-300">{blockingGate.note}</p> : null}
                <ul className="mt-1.5 list-inside list-disc">
                  {newFactory.reasonCodes.map((code, index) => (
                    <li key={`${code}-${index}`} className="font-mono text-[11px] leading-snug text-slate-400">
                      {code}
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
                  「建てなかった」ことも記録された経営判断です。単一の不透明なスコアではなく、ゲートごとの値と閾値が残っています。
                </p>
              </div>
            )}
          </Section>

          <Section title="Mission / Vision（自由文。数値判断には未使用）" testId="inspector-mission-toggle">
            <dl>
              <Row label="Mission" value={strategyDocs[selectedCompanyId]?.mission || "（未設定）"} />
              <Row label="Vision" value={strategyDocs[selectedCompanyId]?.vision || "（未設定）"} />
            </dl>
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              Mission / Vision は既定が空で、それらしい文言を自動生成していません。
            </p>
          </Section>

          <Section title="Strategy Profile（表示のみ・AI判断へ未接続）" testId="inspector-strategy-toggle">
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
              Phase 2 でも保存・表示のみで、Standard AI の数値判断へは接続していません。
            </p>
          </Section>

          <Section title="財務" testId="inspector-finance-toggle">
            <dl>
              <Row label="Revenue" value={money(snapshot?.get("revenue"))} />
              <Row label="Operating Profit" value={money(snapshot?.get("operatingProfit"))} />
              <Row label="Net Income" value={money(snapshot?.get("netIncome"))} />
              <Row label="Cash" value={money(snapshot?.get("cash"))} />
              <Row label="Debt" value={money(snapshot?.get("debt"))} />
            </dl>
          </Section>

          <Section title="操業" testId="inspector-operations-toggle">
            <dl>
              <Row
                label="Sales Headcount"
                value={snapshot?.get("salesHeadcount") === null || snapshot?.get("salesHeadcount") === undefined ? DASH : String(snapshot.get("salesHeadcount"))}
              />
              <Row label="HOSO 生産 / 能力" value={`${tons(snapshot?.get("hosoProduced"))} / ${tons(snapshot?.get("hosoCapacity"))}`} />
              <Row label="PD 生産 / 能力" value={`${tons(snapshot?.get("pdProduced"))} / ${tons(snapshot?.get("pdCapacity"))}`} />
              <Row label="VAP 生産 / 能力" value={`${tons(snapshot?.get("vapProduced"))} / ${tons(snapshot?.get("vapCapacity"))}`} />
              <Row label="共通前処理能力" value={tons(snapshot?.get("commonCapacity"))} />
            </dl>
          </Section>

          <Section title="ボトルネック" testId="inspector-bottleneck-toggle">
            {bottleneck === null ? (
              <p className="text-xs text-slate-400">まだ実績がありません。</p>
            ) : (
              <>
                <p className="mb-1 text-sm font-semibold text-amber-300">{BOTTLENECK_LABELS[bottleneck.primary]}</p>
                <dl>
                  <Row label="原料不足" value={tons(bottleneck.rawMaterialShortfall)} />
                  <Row label="設備不足" value={tons(bottleneck.equipmentShortfall)} />
                  <Row label="労働力不足" value={tons(bottleneck.laborShortfall)} />
                </dl>
              </>
            )}
          </Section>

          <Section title="Standard AI 状況診断（実行時に記録した値）" testId="inspector-diagnosis-toggle">
            {diagnosed === null ? (
              <p className="text-xs text-slate-400">診断の記録がありません。</p>
            ) : (
              <dl>
                {diagnosed.items
                  .filter((i) => i.label === "主要制約" || i.label === "第2の制約" || i.value !== undefined)
                  .slice(0, 8)
                  .map((i, index) => (
                    <Row
                      key={`${i.label}-${index}`}
                      label={i.label}
                      value={i.value !== undefined ? `${i.value.toFixed(2)}${i.text ? `（${i.text}）` : ""}` : (i.text ?? DASH)}
                    />
                  ))}
              </dl>
            )}
          </Section>

          <Section title="Standard AI 主要意思決定（実際に提出した値）" testId="inspector-decision-toggle">
            {decided === null ? (
              <p className="text-xs text-slate-400">意思決定の記録がありません。</p>
            ) : (
              <dl>
                {decided.items.map((i, index) => (
                  <Row
                    key={`${i.label}-${index}`}
                    label={i.label}
                    value={i.value === undefined ? (i.text ?? DASH) : i.unit === "USD" ? money(i.value) : `${Math.round(i.value).toLocaleString()}${i.unit ?? ""}`}
                  />
                ))}
              </dl>
            )}
          </Section>

          <Section title="判断根拠（Standard AI が付けた理由コード）" testId="inspector-reasons-toggle">
            {constrained === null || constrained.items.filter((i) => i.value === undefined && i.text !== undefined).length === 0 ? (
              <p className="text-[11px] text-slate-500">記録なし</p>
            ) : (
              <ul className="list-inside list-disc">
                {constrained.items
                  .filter((i) => i.value === undefined && i.text !== undefined)
                  .slice(0, 6)
                  .map((i, index) => (
                    <li key={`${i.label}-${index}`} className="text-[11px] leading-snug text-slate-300">
                      <span className="font-mono text-slate-400">{i.label}</span> — {i.text}
                    </li>
                  ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
