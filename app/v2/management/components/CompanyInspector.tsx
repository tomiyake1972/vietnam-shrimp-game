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
import { Collapsible } from "./Collapsible";

interface Props {
  readonly dataset: SimulationAnalyticsDataset;
  readonly fixtures: readonly CompanyFixture[];
  readonly selectedCompanyId: string;
  readonly onSelect: (companyId: string) => void;
  readonly strategyDocs: Readonly<Record<string, CompanyStrategyDocument>>;
}

const DASH = "－";
const money = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${(v / 1_000_000).toFixed(1)}M`);
const tons = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${Math.round(v).toLocaleString()}t`);

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

export function CompanyInspector({ dataset, fixtures, selectedCompanyId, onSelect, strategyDocs }: Props) {
  const fixture = fixtures.find((f) => f.companyId === selectedCompanyId);
  const latestTurn = dataset.turns[dataset.turns.length - 1] ?? null;
  const snapshot = latestTurn === null ? null : companySnapshot(dataset, selectedCompanyId, latestTurn);
  const bottleneck = dataset.bottlenecks.find((b) => b.companyId === selectedCompanyId && b.turn === latestTurn) ?? null;
  const strategy = strategyDocs[selectedCompanyId] && latestTurn !== null ? resolveStrategyAtTurn(strategyDocs[selectedCompanyId], latestTurn) : null;

  const traceAt = (stage: string) =>
    dataset.aiTrace.find((t) => t.companyId === selectedCompanyId && t.turn === latestTurn && t.stage === stage) ?? null;
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

          <Section title="Mission / Vision" testId="inspector-mission-toggle">
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
