"use client";

// ShrimpX V2 — 32Q Management Console: 経営モード切替（Phase 7・Manual Override）
//
// 会社ごとに STANDARD_AI / PLAYER を切り替えるための最小UI。
// スマホでも操作しやすいよう横スクロールさせず、縦積みで表示する（指示§31/§32）。

import { CompanyControlMode } from "../../../lib/v2/companyLab/simulation/types";
import { CompanyFixture } from "../../../lib/v2/companyLab/types";

interface Props {
  readonly fixtures: readonly CompanyFixture[];
  readonly controlModes: Readonly<Record<string, CompanyControlMode>>;
  readonly onChangeMode: (companyId: string, mode: CompanyControlMode) => void;
  /** そのターンぶんの意思決定が既に確定しているPLAYER会社。 */
  readonly decidedCompanyIds: ReadonlySet<string>;
  /** 現在Consoleが意思決定待ちで停止している会社（いなければ空）。 */
  readonly waitingCompanyIds: readonly string[];
  readonly onOperate: (companyId: string) => void;
  readonly disabled: boolean;
  readonly currentTurn: number;
}

export function CompanyControlPanel({ fixtures, controlModes, onChangeMode, decidedCompanyIds, waitingCompanyIds, onOperate, disabled, currentTurn }: Props) {
  return (
    <section className="rounded-md border border-slate-700 bg-slate-900/50 p-2.5" data-testid="company-control-panel">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300">経営モード（Manual Override）</h3>
      <p className="mb-2 text-[11px] leading-snug text-slate-500">
        会社ごとに Standard AI / 自分で操作 を切り替えられます。切り替えは次のTurnから適用されます。今すでに確定済みのTurnの意思決定は上書きしません。
      </p>
      <ul className="flex flex-col gap-1.5">
        {fixtures.map((f) => {
          const mode: CompanyControlMode = controlModes[f.companyId] ?? "STANDARD_AI";
          const isWaiting = waitingCompanyIds.includes(f.companyId);
          const isDecided = decidedCompanyIds.has(f.companyId);
          return (
            <li
              key={f.companyId}
              data-testid={`company-control-row-${f.companyId}`}
              className={`flex flex-col gap-1 rounded border px-2 py-1.5 sm:flex-row sm:items-center sm:justify-between ${
                isWaiting ? "border-amber-500 bg-amber-950/30" : "border-slate-700 bg-slate-900/40"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-100">{f.companyId}</span>
                <select
                  value={mode}
                  disabled={disabled}
                  onChange={(e) => onChangeMode(f.companyId, e.target.value as CompanyControlMode)}
                  data-testid={`company-control-mode-${f.companyId}`}
                  className="rounded border border-slate-600 bg-slate-900 px-1.5 py-1 text-[11px] disabled:opacity-40"
                >
                  <option value="STANDARD_AI">Standard AI</option>
                  <option value="PLAYER">自分で操作</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                {mode === "PLAYER" ? (
                  <span
                    className={`text-[11px] font-medium ${isDecided ? "text-emerald-400" : "text-amber-300"}`}
                    data-testid={`company-control-status-${f.companyId}`}
                  >
                    {isDecided ? `Turn ${currentTurn} 意思決定済み` : `Turn ${currentTurn} 未入力`}
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-500" data-testid={`company-control-status-${f.companyId}`}>
                    AI 自動
                  </span>
                )}
                {mode === "PLAYER" ? (
                  <button
                    type="button"
                    onClick={() => onOperate(f.companyId)}
                    data-testid={`company-control-operate-${f.companyId}`}
                    className="rounded bg-sky-700 px-3 py-1.5 text-xs font-semibold hover:bg-sky-600"
                  >
                    この会社を操作
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {waitingCompanyIds.length > 0 ? (
        <p className="mt-2 text-[11px] font-semibold text-amber-300" data-testid="waiting-for-player-note">
          {waitingCompanyIds.join(", ")} の意思決定待ちです。入力後、Turnボタンを押すと続きが進みます。
        </p>
      ) : null}
    </section>
  );
}
