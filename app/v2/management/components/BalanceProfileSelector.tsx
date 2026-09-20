"use client";

// ShrimpX V2 — Setup画面のBalance Profile選択（BALANCE-PROFILE-1）
//
// 【目的】新規Run開始時に、保存済みのBalance Profileを選んで
// そのTurn別スケジュールをRunへコピーできるようにする。
//
// 【開始前に中身が見えること】Profileを選んだら、実際にどのTurnへ
// どの指数・配当性向が入るのかを開始前に確認できる必要がある。
// 表示は manualBalanceScheduleTable（＝Engineが使うのと同じ
// resolveManualBalanceForTurn）を通すため、プレビューと実適用がずれない。
//
// 【Neutralは保存物ではない】Neutralはコード側の定数であり、
// 選んでもRunのconfigへキーを書き込まない（既存Runと同一のconfigになる）。

import { useMemo } from "react";
import {
  MANUAL_PRICE_INDEX_NEUTRAL,
  manualBalanceScheduleTable,
} from "../../../lib/v2/companyLab/manualBalance/overrides";
import type { BalanceProfile } from "../../../lib/v2/companyLab/manualBalance/profile";
import { isNeutralBalanceProfile } from "../../../lib/v2/companyLab/manualBalance/profile";

interface BalanceProfileSelectorProps {
  readonly profiles: readonly BalanceProfile[];
  readonly selectedProfileId: string;
  readonly onSelect: (profileId: string) => void;
  /** プレビューするTurn範囲の上限（Runの予定Turn数）。 */
  readonly previewTurns: number;
  readonly disabled?: boolean;
}

function formatIndex(value: number | undefined): string {
  return value === undefined ? "－" : String(value);
}

export function BalanceProfileSelector({
  profiles,
  selectedProfileId,
  onSelect,
  previewTurns,
  disabled = false,
}: BalanceProfileSelectorProps) {
  const selected = profiles.find((p) => p.profileId === selectedProfileId) ?? profiles[0] ?? null;

  // 【プレビューはEngineと同じ解決器を通す】1〜previewTurnsの各Turnで実際に
  // 効く最終値を出す。ここで独自にscheduleを走査しない。
  const rows = useMemo(() => {
    if (!selected || isNeutralBalanceProfile(selected)) return [];
    return manualBalanceScheduleTable(selected.schedule, 1, previewTurns).filter(
      (row) => row.appliedSource.kind !== "none"
    );
  }, [selected, previewTurns]);

  return (
    <section className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="setup-balance-profile-section">
      <h2 className="mb-2 text-sm font-semibold">6. Balance Profile（経済バランスの固定スケジュール）</h2>

      <select
        value={selected?.profileId ?? ""}
        disabled={disabled}
        onChange={(e) => onSelect(e.target.value)}
        data-testid="setup-balance-profile-select"
        className="w-full rounded border border-slate-600 bg-slate-900 px-2 py-1.5 text-xs disabled:opacity-40"
      >
        {profiles.map((profile) => (
          <option key={profile.profileId} value={profile.profileId}>
            {profile.profileName}
          </option>
        ))}
      </select>

      {selected ? (
        <div className="mt-2" data-testid="setup-balance-profile-preview">
          <p className="text-[11px] leading-snug text-slate-400" data-testid="setup-balance-profile-description">
            {selected.description || "（説明なし）"}
          </p>

          {isNeutralBalanceProfile(selected) ? (
            <p className="mt-1.5 text-[11px] leading-snug text-slate-500" data-testid="setup-balance-profile-neutral-note">
              手動補正を行いません。このRunのconfigにはバランス調整の設定そのものが書き込まれず、
              Balance Profileを使わない既存のRunと完全に同一の挙動になります。
            </p>
          ) : (
            <>
              <p className="mt-1.5 text-[11px] text-slate-500">
                適用予定（Turn 1〜{previewTurns}のうち、設定があるTurnのみ表示）。価格指数は
                {MANUAL_PRICE_INDEX_NEUTRAL}が補正なしです。
              </p>
              <div className="mt-1 max-h-48 overflow-auto">
                <table className="w-full min-w-[420px] text-[11px]" data-testid="setup-balance-profile-table">
                  <thead>
                    <tr className="border-b border-slate-700 text-left text-slate-400">
                      <th className="py-1 pr-2">Turn</th>
                      <th className="py-1 pr-2">販売指数</th>
                      <th className="py-1 pr-2">原料指数</th>
                      <th className="py-1 pr-2">配当性向</th>
                      <th className="py-1 pr-2">由来</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.turn} className="border-b border-slate-800" data-testid={`setup-balance-profile-row-${row.turn}`}>
                        <td className="py-1 pr-2 tabular-nums">{row.turn}</td>
                        <td className="py-1 pr-2 tabular-nums">{formatIndex(row.settings.salesPriceIndex)}</td>
                        <td className="py-1 pr-2 tabular-nums">{formatIndex(row.settings.rawMarketPriceIndex)}</td>
                        <td className="py-1 pr-2 tabular-nums">
                          {row.settings.dividendPayout.kind === "specified"
                            ? `${(row.settings.dividendPayout.payoutRatio * 100).toFixed(1)}%`
                            : "－"}
                        </td>
                        <td className="py-1 pr-2 text-slate-500">
                          {row.appliedSource.kind === "perTurn" ? "ターン別" : "継続"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length === 0 ? (
                <p className="mt-1 text-[11px] text-slate-500" data-testid="setup-balance-profile-empty-range">
                  このProfileには Turn 1〜{previewTurns} に適用される設定がありません。
                </p>
              ) : (
                <p className="mt-1 text-[11px] text-slate-500" data-testid="setup-balance-profile-range">
                  適用範囲: Turn {rows[0].turn} 〜 {rows[rows.length - 1].turn}
                </p>
              )}

              {selected.sourceScenarioId || selected.sourceSeed || selected.sourceSalesModelId ? (
                <p className="mt-1 text-[10px] leading-snug text-slate-500" data-testid="setup-balance-profile-source">
                  作成元: Scenario {selected.sourceScenarioId ?? "不明"} / seed {selected.sourceSeed ?? "不明"} / 販売市場モデル{" "}
                  {selected.sourceSalesModelId ?? "不明"}
                </p>
              ) : null}
            </>
          )}

          <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
            Profileの内容はRun開始時にこのRunへコピーされます。開始後にProfile側を編集しても、
            このRunの設定は変わりません（逆にRun側で手修正してもProfileは変わりません）。
          </p>
        </div>
      ) : null}
    </section>
  );
}
