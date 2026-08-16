"use client";

// ShrimpX V2 — Management Console Vision Calibration（Run実行中の編集）
//
// 【指示§12「Run開始後のVision編集」】Setup画面（新規Run作成時）だけでなく、
// 実行中のManagement Consoleからも各社のQ32 Vision目標を編集できるようにする。
// ただし既に確定した過去Turnは書き換えない（指示§13）。編集は必ず
// 「次のTurnから」（effectiveFromTurn = nextTurn）有効になる。
//
// 【SSoT】ここでも defaultCompanyVisionAtTurn / resolveCompanyVision
//（vision/overrides.ts）だけを読む。架空の計算をここで新しく作らない。

import { useState } from "react";
import { SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import { StrategicPosture } from "../../../lib/v2/companyLab/vision/types";
import {
  CompanyVisionOverrideEntry,
  VISION_TARGET_SCALE_MAX_TONS_PER_QUARTER,
  VISION_TARGET_SCALE_MIN_TONS_PER_QUARTER,
  activeCompanyVisionOverrideEntry,
  defaultCompanyVisionAtTurn,
  isVisionTargetScaleInValidRange,
  resolveCompanyVision,
} from "../../../lib/v2/companyLab/vision/overrides";
import { COMPANY_LAB_COMPANY_IDS } from "../../../lib/v2/companyLab";

const STRATEGIC_POSTURE_OPTIONS: readonly StrategicPosture[] = ["AGGRESSIVE_EARLY_CAPACITY", "DEMAND_CONFIRMED", "VALUE_FIRST"];

interface VisionCalibrationPanelProps {
  readonly session: SimulationSession | null;
  readonly onApply: (companyId: string, entry: CompanyVisionOverrideEntry) => void;
  readonly onReset: (companyId: string) => void;
}

export function VisionCalibrationPanel({ session, onApply, onReset }: VisionCalibrationPanelProps) {
  // 【指示§12】未確定の「次のTurn」を編集対象にする（過去Turnへは適用できない）。
  const nextTurn = session ? session.state.scenarioState.currentTurn : 1;
  const [drafts, setDrafts] = useState<Record<string, { target: number; posture: StrategicPosture }>>({});

  if (!session) {
    return <p className="text-xs text-slate-400">Runを開始すると、ここから実行中のVisionを調整できます。</p>;
  }

  const visionOverrides = session.state.config.visionOverrides;

  return (
    <div className="overflow-x-auto">
      <p className="mb-2 text-[11px] leading-snug text-slate-500">
        ここでの変更は<strong className="text-slate-300">Turn {nextTurn}以降</strong>
        から有効になります（既に確定したTurnのAI判断・Analysis Packは書き換えません）。単位は t / quarter（t/四半期）。
      </p>
      <table className="w-full min-w-[640px] text-xs">
        <thead>
          <tr className="border-b border-slate-700 text-left text-slate-400">
            <th className="py-1 pr-2">Company</th>
            <th className="py-1 pr-2">Default</th>
            <th className="py-1 pr-2">Current</th>
            <th className="py-1 pr-2">New Target</th>
            <th className="py-1 pr-2">Posture</th>
            <th className="py-1 pr-2" />
          </tr>
        </thead>
        <tbody>
          {COMPANY_LAB_COMPANY_IDS.map((companyId) => {
            const defaultVision = defaultCompanyVisionAtTurn(companyId, nextTurn);
            const currentVision = resolveCompanyVision(companyId, nextTurn, visionOverrides);
            const activeOverride = activeCompanyVisionOverrideEntry(visionOverrides, companyId, nextTurn);
            const draft = drafts[companyId] ?? {
              target: currentVision?.targetScaleTonsPerQuarterAtQ32 ?? defaultVision?.targetScaleTonsPerQuarterAtQ32 ?? VISION_TARGET_SCALE_MIN_TONS_PER_QUARTER,
              posture: currentVision?.strategicPosture ?? defaultVision?.strategicPosture ?? "DEMAND_CONFIRMED",
            };
            const valid = isVisionTargetScaleInValidRange(draft.target);
            return (
              <tr key={companyId} className="border-b border-slate-800">
                <td className="py-1 pr-2 font-semibold">{companyId}</td>
                <td className="py-1 pr-2 tabular-nums text-slate-500">{defaultVision?.targetScaleTonsPerQuarterAtQ32.toLocaleString() ?? "－"}</td>
                <td className="py-1 pr-2 tabular-nums">
                  {currentVision?.targetScaleTonsPerQuarterAtQ32.toLocaleString() ?? "－"}
                  {activeOverride ? (
                    <span className="ml-1 rounded bg-amber-900/50 px-1 py-0.5 text-[10px] text-amber-300" data-testid={`vision-override-badge-${companyId}`}>
                      override（Turn{activeOverride.effectiveFromTurn}〜）
                    </span>
                  ) : null}
                </td>
                <td className="py-1 pr-2">
                  <input
                    type="number"
                    value={draft.target}
                    step={1000}
                    min={VISION_TARGET_SCALE_MIN_TONS_PER_QUARTER}
                    max={VISION_TARGET_SCALE_MAX_TONS_PER_QUARTER}
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [companyId]: { ...draft, target: Math.round(Number(e.target.value)) } }))
                    }
                    data-testid={`vision-calibration-target-${companyId}`}
                    className={`w-28 rounded border bg-slate-900 px-1.5 py-1 text-[11px] ${valid ? "border-slate-600" : "border-red-600"}`}
                  />
                </td>
                <td className="py-1 pr-2">
                  <select
                    value={draft.posture}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [companyId]: { ...draft, posture: e.target.value as StrategicPosture } }))}
                    data-testid={`vision-calibration-posture-${companyId}`}
                    className="rounded border border-slate-600 bg-slate-900 px-1.5 py-1 text-[11px]"
                  >
                    {STRATEGIC_POSTURE_OPTIONS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1 pr-2 whitespace-nowrap">
                  <button
                    type="button"
                    disabled={!valid}
                    onClick={() => {
                      onApply(companyId, {
                        effectiveFromTurn: nextTurn,
                        targetScaleTonsPerQuarterAtQ32: draft.target,
                        strategicPosture: draft.posture,
                        source: "MANUAL_OVERRIDE",
                      });
                      setDrafts((prev) => {
                        const next = { ...prev };
                        delete next[companyId];
                        return next;
                      });
                    }}
                    data-testid={`vision-calibration-apply-${companyId}`}
                    className="mr-1.5 rounded border border-sky-700 bg-sky-950/40 px-2 py-1 text-[11px] hover:bg-sky-900/40 disabled:opacity-40"
                  >
                    Apply from Turn {nextTurn}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onReset(companyId);
                      setDrafts((prev) => {
                        const next = { ...prev };
                        delete next[companyId];
                        return next;
                      });
                    }}
                    data-testid={`vision-calibration-reset-${companyId}`}
                    className="rounded border border-slate-600 px-2 py-1 text-[11px] hover:bg-slate-800"
                  >
                    Reset to Default
                  </button>
                  {!valid ? (
                    <p className="mt-0.5 text-[10px] text-red-400">
                      {VISION_TARGET_SCALE_MIN_TONS_PER_QUARTER.toLocaleString()}〜{VISION_TARGET_SCALE_MAX_TONS_PER_QUARTER.toLocaleString()}t/期
                    </p>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
