"use client";

// ShrimpX V2 — 32Q Management Console: 経営モード切替（Phase 7・Manual Override）
//
// 会社ごとの割り当てと、そのTurnの意思決定状況を示す参照表示。
// 【SEAT-UI】編集の入口は画面上部の「参加管理」へ集約したため、ここからは
// 切り替え・GM代理入力のボタンを外してある。

import { CompanyControlMode } from "../../../lib/v2/companyLab/simulation/types";
import { CompanyFixture } from "../../../lib/v2/companyLab/types";

interface Props {
  readonly fixtures: readonly CompanyFixture[];
  readonly controlModes: Readonly<Record<string, CompanyControlMode>>;
  /** そのターンぶんの意思決定が既に確定しているPLAYER会社。 */
  readonly decidedCompanyIds: ReadonlySet<string>;
  /** 現在Consoleが意思決定待ちで停止している会社（いなければ空）。 */
  readonly waitingCompanyIds: readonly string[];
  readonly currentTurn: number;
}

export function CompanyControlPanel({ fixtures, controlModes, decidedCompanyIds, waitingCompanyIds, currentTurn }: Props) {
  const hasAnyPlayerCompany = fixtures.some((f) => (controlModes[f.companyId] ?? "STANDARD_AI") === "PLAYER");
  return (
    <section className="rounded-md border border-slate-700 bg-slate-900/50 p-2.5" data-testid="company-control-panel">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300">経営モード（Manual Override）</h3>
      <p className="mb-2 text-[11px] leading-snug text-slate-500">
        いまの割り当ての一覧です（表示のみ）。切り替え・参加リンクの発行・GM代理入力は、画面上部の「参加管理」で行います。切り替えは次のTurnから適用され、今すでに確定済みのTurnの意思決定は上書きしません。
      </p>
      {/* 【受入指示§6-8】PLAYER会社が存在する場合だけ、小さな補足として表示する
          （全社AI利用時には邪魔しない）。既に実行済みのTurn結果は失われないことを明記する。 */}
      {hasAnyPlayerCompany ? (
        <p className="mb-2 text-[11px] leading-snug text-slate-400" data-testid="player-reload-warning">
          ⓘ プレイヤー操作待ちの途中状態・まだ確定していない入力内容は、ページを再読み込みすると失われます（既に実行済みのTurnの結果は失われません）。
        </p>
      ) : null}
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
                {/* 【SEAT-UI】編集の入口は画面上部の「参加管理」へ集約した。
                    ここは参照表示にする（同じ操作が2箇所にあると、どちらで
                    変えたのか分からなくなり、保存状態の出し分けも二重になる）。 */}
                <span
                  data-testid={`company-control-mode-${f.companyId}`}
                  className="rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-[11px] text-slate-300"
                >
                  {mode === "PLAYER" ? "自分で操作" : "Standard AI"}
                </span>
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
