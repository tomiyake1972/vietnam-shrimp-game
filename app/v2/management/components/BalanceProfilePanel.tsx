"use client";

// ShrimpX V2 — Management Console の Balance Profile パネル（BALANCE-PROFILE-1）
//
// 【このパネルの責務】
//  1. このRunの「元Balance Profile」をread-onlyで示す
//  2. 開始時のProfileから手動変更されているか（drift）を示す
//  3. 現在のmanual scheduleをProfileとして保存する
//  4. Profileを次の未実行Turn以降へ明示的に再適用する
//  5. Profileのexport / import
//
// 【Profileへ自動反映しない】Runの手動変更がProfile本体へ書き戻る経路は作らない。
// Profileが変わるのは「Profileとして保存」を押したときだけである。
//
// 【過去Turnを変更しない】再適用は必ず次の未実行Turn以降にしか効かない。

import { useState } from "react";
import { SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import type { ManualBalanceSchedule } from "../../../lib/v2/companyLab/manualBalance/overrides";
import {
  BALANCE_PROFILE_SPEC_VERSION,
  BalanceProfile,
  balanceProfileFingerprint,
  buildBalanceProfileDocument,
  isScheduleDriftedFromProfile,
  parseBalanceProfileDocument,
  reapplyProfileScheduleFromTurn,
} from "../../../lib/v2/companyLab/manualBalance/profile";
import { newBalanceProfileId, saveBalanceProfile } from "../lib/balanceProfileStore";
import {
  UNKNOWN_SOURCE_COMMIT,
  isSingleCalculationCommit,
  latestRecordedCommit,
  resolveCurrentAppSourceCommit,
} from "../../../lib/v2/companyLab/simulation/calculationCommit";
import {
  balanceCalibrationLogToCsv,
  balanceCalibrationLogToJson,
  buildBalanceCalibrationLog,
} from "../../../lib/v2/companyLab/manualBalance/calibrationLog";

interface BalanceProfilePanelProps {
  readonly session: SimulationSession | null;
  /** 保存済みProfile一覧（Neutralを含む）。 */
  readonly profiles: readonly BalanceProfile[];
  /** Profile一覧を再読み込みさせる（保存・取り込み後）。 */
  readonly onProfilesChanged: () => void;
  /** scheduleを保存する（成功でtrue）。Manual Balanceパネルと同じ保存経路を使う。 */
  readonly onApplySchedule: (schedule: ManualBalanceSchedule) => Promise<boolean>;
  readonly busy: boolean;
  readonly locked: boolean;
}

export function BalanceProfilePanel({
  session,
  profiles,
  onProfilesChanged,
  onApplySchedule,
  busy,
  locked,
}: BalanceProfilePanelProps) {
  const [saveName, setSaveName] = useState("");
  const [saveDescription, setSaveDescription] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [reapplyProfileId, setReapplyProfileId] = useState<string>("");
  const [working, setWorking] = useState(false);

  if (!session) {
    return <p className="text-xs text-slate-400">Runを開始すると、ここでBalance Profileを確認・保存できます。</p>;
  }

  const editable = !busy && !locked && !working;
  const nextTurn = session.state.scenarioState.currentTurn;
  const schedule = session.state.config.manualBalanceOverrides;
  const originProfile = session.run.appliedBalanceProfile;
  const drifted = isScheduleDriftedFromProfile(originProfile, schedule);

  /**
   * 【アプリ現在版】いま動いているアプリのcommit。
   * Profileの作成元として記録してよいが、**Runの計算commitではない**。
   * Runの計算commitは run.calculationCommitHistory から読む（下のcalcCommit系）。
   */
  const appSourceCommit = resolveCurrentAppSourceCommit();
  const currentConditions = {
    specVersion: BALANCE_PROFILE_SPEC_VERSION,
    scenarioId: session.run.scenarioId,
    seed: session.run.seed,
    salesModelId: session.state.config.salesModelId ?? null,
    sourceCommit: appSourceCommit,
  };

  const calcHistory = session.run.calculationCommitHistory;
  const calcLatest = latestRecordedCommit(calcHistory);
  const calcIsSingle = isSingleCalculationCommit(calcHistory);

  const buildProfileFromCurrent = (profileId: string, now: string): BalanceProfile => ({
    profileId,
    profileName: saveName.trim(),
    description: saveDescription.trim(),
    specVersion: BALANCE_PROFILE_SPEC_VERSION,
    createdAt: now,
    updatedAt: now,
    createdFromRunId: session.run.simulationRunId,
    sourceCommit: currentConditions.sourceCommit,
    sourceScenarioId: currentConditions.scenarioId,
    sourceSeed: currentConditions.seed,
    ...(currentConditions.salesModelId !== null ? { sourceSalesModelId: currentConditions.salesModelId } : {}),
    // 元Runの計算commit（判明している場合のみ。推測で埋めない）。
    ...(calcLatest !== null ? { sourceRunCalculationCommit: calcLatest } : {}),
    schedule: schedule ?? [],
  });

  const handleSaveAsProfile = (): void => {
    if (!editable) return;
    if (saveName.trim() === "") {
      setMessage("Profile名を入力してください。");
      return;
    }
    const now = new Date().toISOString();
    const profile = buildProfileFromCurrent(newBalanceProfileId(now), now);
    const error = saveBalanceProfile(profile);
    if (error) {
      setMessage(`保存できませんでした: ${error}`);
      return;
    }
    setMessage(`Profile「${profile.profileName}」として保存しました（指紋 ${balanceProfileFingerprint(profile.schedule)}）。`);
    setSaveName("");
    setSaveDescription("");
    onProfilesChanged();
  };

  const handleReapply = async (): Promise<void> => {
    if (!editable) return;
    const profile = profiles.find((p) => p.profileId === reapplyProfileId);
    if (!profile) {
      setMessage("再適用するProfileを選んでください。");
      return;
    }
    setWorking(true);
    try {
      // 【過去Turnは変更しない】必ず次の未実行Turn以降にだけ効かせる。
      const next = reapplyProfileScheduleFromTurn(schedule, profile, nextTurn, new Date().toISOString());
      const ok = await onApplySchedule(next);
      setMessage(
        ok
          ? `Profile「${profile.profileName}」をTurn ${nextTurn} 以降へ再適用しました（確定済みTurnは変更していません）。`
          : "再適用の保存に失敗しました。設定は変更されていません。"
      );
    } finally {
      setWorking(false);
    }
  };

  const handleImport = (): void => {
    if (!editable) return;
    const result = parseBalanceProfileDocument(importText, currentConditions);
    if (!result.ok) {
      setMessage(`取り込めませんでした: ${result.error}`);
      return;
    }
    // 取り込んだProfileはIDを振り直して保存する（元IDのまま保存すると、
    // 別環境の同IDのProfileを黙って上書きしてしまうため）。
    const now = new Date().toISOString();
    const stored: BalanceProfile = { ...result.profile, profileId: newBalanceProfileId(now), updatedAt: now };
    const error = saveBalanceProfile(stored);
    if (error) {
      setMessage(`保存できませんでした: ${error}`);
      return;
    }
    setMessage(
      result.conditionDifferences.length === 0
        ? `Profile「${stored.profileName}」を取り込みました（作成元条件は現在のRunと一致しています）。`
        : `Profile「${stored.profileName}」を取り込みました。ただし作成元条件が異なります: ${result.conditionDifferences
            .map((d) => `${d.field}（取込 ${d.imported} / 現在 ${d.current}）`)
            .join("、")}`
    );
    setImportText("");
    onProfilesChanged();
  };

  const exportTarget = profiles.find((p) => p.profileId === reapplyProfileId);
  const exportedJson = exportTarget
    ? JSON.stringify(buildBalanceProfileDocument(exportTarget, new Date().toISOString()), null, 2)
    : "";

  return (
    <div className="space-y-3 text-xs">
      {/* --- このRunの元Profile（read-only） --- */}
      <div className="rounded border border-slate-700 bg-slate-900/60 p-2" data-testid="console-origin-profile">
        <p className="mb-1 text-[10px] font-semibold text-slate-300">このRunの元Balance Profile</p>
        {originProfile ? (
          <>
            <p className="text-[11px] text-slate-200" data-testid="console-origin-profile-name">
              {originProfile.appliedBalanceProfileName}
            </p>
            <p className="text-[10px] text-slate-500">
              ID {originProfile.appliedBalanceProfileId} / 仕様版 {originProfile.appliedBalanceProfileSpecVersion} / 開始時の指紋{" "}
              {originProfile.appliedBalanceProfileFingerprint}
            </p>
            <p className="mt-1 text-[10px]" data-testid="console-origin-profile-drift">
              {drifted ? (
                <span className="rounded bg-amber-900/50 px-1 py-0.5 text-amber-300">
                  Profile適用後に手動変更あり（現在の指紋 {balanceProfileFingerprint(schedule ?? [])}）
                </span>
              ) : (
                <span className="rounded bg-slate-800 px-1 py-0.5 text-slate-400">Profile適用時から変更なし</span>
              )}
            </p>
          </>
        ) : (
          // 【推測で埋めない】この機能より前のRun・Neutralで開始したRunを区別しない
          // 断定はしない。どちらも「Profileの記録がない」とだけ述べる。
          <p className="text-[11px] text-slate-500" data-testid="console-origin-profile-none">
            このRunにはBalance Profileの記録がありません（Profileを使わずに開始したか、この機能より前に作られたRunです）。
          </p>
        )}
        <p className="mt-1 text-[10px] leading-snug text-slate-500">
          ここに出るのは「開始時にコピー元となったProfile」です。各Turnで実際に適用された値は、
          バランス調整パネルの「適用実績」を正としてください。
        </p>
      </div>

      {/* --- このRunを計算したcommit（アプリ現在版とは別物） --- */}
      <div className="rounded border border-slate-700 bg-slate-900/60 p-2" data-testid="console-calculation-commit">
        <p className="mb-1 text-[10px] font-semibold text-slate-300">このRunを計算したcommit</p>
        {calcHistory === undefined || calcHistory.length === 0 ? (
          <p className="text-[11px] text-slate-500" data-testid="console-calculation-commit-unknown">
            記録がありません（この機能より前に計算されたRunです）。各Turnの計算commitは<strong>不明</strong>です。
          </p>
        ) : calcIsSingle ? (
          <p className="text-[11px] text-slate-200" data-testid="console-calculation-commit-single">
            {calcHistory[0].sourceCommit}
            {calcHistory[0].sourceCommit === UNKNOWN_SOURCE_COMMIT ? "（ビルド時にcommitが埋め込まれていません）" : ""}
          </p>
        ) : (
          <div data-testid="console-calculation-commit-multi">
            <p className="text-[11px] text-amber-300">
              複数のcommitにまたがって計算されています（単一のcommitでは説明できません）。
            </p>
            <ul className="mt-0.5 list-disc pl-4 text-[10px] text-slate-400">
              {calcHistory.map((entry) => (
                <li key={`${entry.effectiveFromTurn}-${entry.sourceCommit}`}>
                  Turn {entry.effectiveFromTurn} 以降: {entry.sourceCommit}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-1 text-[10px] leading-snug text-slate-500">
          いま表示しているアプリのcommitは <span data-testid="console-app-commit">{appSourceCommit}</span> です。
          これは「このRunを計算した版」とは別物であり、Calibration Logでも別の項目として出力されます。
        </p>
      </div>

      {/* --- 現在の設定をProfileとして保存 --- */}
      <details className="rounded border border-slate-700 bg-slate-900/40 p-2">
        <summary className="cursor-pointer text-[10px] text-slate-400">現在の設定をBalance Profileとして保存</summary>
        <div className="mt-2 space-y-1.5">
          <input
            type="text"
            value={saveName}
            disabled={!editable}
            placeholder="Profile名（例: Cash-Control-A）"
            onChange={(e) => setSaveName(e.target.value)}
            data-testid="profile-save-name"
            className="w-full rounded border border-slate-600 bg-slate-900 px-1.5 py-1 text-[11px] disabled:opacity-40"
          />
          <input
            type="text"
            value={saveDescription}
            disabled={!editable}
            placeholder="説明・メモ（任意）"
            onChange={(e) => setSaveDescription(e.target.value)}
            data-testid="profile-save-description"
            className="w-full rounded border border-slate-600 bg-slate-900 px-1.5 py-1 text-[11px] disabled:opacity-40"
          />
          <button
            type="button"
            disabled={!editable || saveName.trim() === ""}
            onClick={handleSaveAsProfile}
            data-testid="profile-save-button"
            className="rounded border border-sky-700 bg-sky-950/40 px-2 py-1 text-[11px] hover:bg-sky-900/40 disabled:opacity-40"
          >
            Profileとして保存
          </button>
          <p className="text-[10px] leading-snug text-slate-500">
            保存先はこのブラウザです（共有サーバーへは保存しません）。別の端末へ渡すときは下のexportを使ってください。
          </p>
        </div>
      </details>

      {/* --- 再適用 / export / import --- */}
      <details className="rounded border border-slate-700 bg-slate-900/40 p-2">
        <summary className="cursor-pointer text-[10px] text-slate-400">Profileの再適用・持ち出し・取り込み</summary>
        <div className="mt-2 space-y-2">
          <div>
            <label className="mb-0.5 block text-[10px] text-slate-400">対象Profile</label>
            <select
              value={reapplyProfileId}
              disabled={!editable}
              onChange={(e) => setReapplyProfileId(e.target.value)}
              data-testid="profile-select"
              className="w-full rounded border border-slate-600 bg-slate-900 px-1.5 py-1 text-[11px] disabled:opacity-40"
            >
              <option value="">（選択してください）</option>
              {profiles.map((p) => (
                <option key={p.profileId} value={p.profileId}>
                  {p.profileName}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!editable || reapplyProfileId === ""}
              onClick={() => void handleReapply()}
              data-testid="profile-reapply-button"
              className="mt-1 rounded border border-slate-600 px-2 py-1 text-[11px] hover:bg-slate-800 disabled:opacity-40"
            >
              Turn {nextTurn} 以降へ再適用
            </button>
            <p className="mt-0.5 text-[10px] leading-snug text-slate-500">
              再適用は次の未実行Turn以降にのみ効きます。確定済みTurnの結果は変更されません。
            </p>
          </div>

          {exportTarget ? (
            <div>
              <p className="mb-0.5 text-[10px] text-slate-400">選択中Profileの書き出し</p>
              <textarea
                readOnly
                value={exportedJson}
                rows={5}
                data-testid="profile-export"
                className="w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-[10px] text-slate-300"
              />
            </div>
          ) : null}

          <div>
            <p className="mb-0.5 text-[10px] text-slate-400">Profileの取り込み（貼り付け）</p>
            <textarea
              value={importText}
              rows={4}
              disabled={!editable}
              onChange={(e) => setImportText(e.target.value)}
              data-testid="profile-import"
              className="w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-[10px] disabled:opacity-40"
            />
            <button
              type="button"
              disabled={!editable || importText.trim() === ""}
              onClick={handleImport}
              data-testid="profile-import-button"
              className="mt-1 rounded border border-slate-600 px-2 py-1 text-[11px] hover:bg-slate-800 disabled:opacity-40"
            >
              取り込む
            </button>
          </div>
        </div>
      </details>

      <CalibrationLogDownload session={session} />

      {message ? (
        <p className="text-[10px] text-slate-300" data-testid="profile-message">
          {message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 【Balance Calibration Log・§11】Runの条件 + Turn別実績を1つの表として取り出す。
 *
 * 【新しいExport体系を作らない】既存の ExportPackButton / FinalDataDownloadButton と
 * 同じ「Blob → objectURL → anchor.click()」パターンをそのまま使う。
 * 行の値は確定済みの記録を読むだけで、ここで再計算はしない。
 */
function CalibrationLogDownload({ session }: { readonly session: SimulationSession }) {
  const [note, setNote] = useState<string | null>(null);

  const download = (format: "json" | "csv"): void => {
    const exportedAt = new Date().toISOString();
    // 【Export時点のアプリcommit】Runの計算commitとしては使われない
    // （buildBalanceCalibrationLog が行ごとの計算commitを履歴から解決する）。
    const log = buildBalanceCalibrationLog(session, exportedAt, resolveCurrentAppSourceCommit());
    if (log.appliedRecordsUnavailable) {
      setNote("このRunには適用実績の記録がありません（この機能より前に計算されたRunのため、Turn別の実績は不明です）。");
      return;
    }
    if (log.rows.length === 0) {
      setNote("まだTurnが確定していないため、出力できる実績行がありません。");
      return;
    }

    const body = format === "json" ? balanceCalibrationLogToJson(log) : balanceCalibrationLogToCsv(log);
    const type = format === "json" ? "application/json" : "text/csv";
    const blob = new Blob([body], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `balance-calibration-${session.run.simulationRunId}.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setNote(`${log.rows.length}Turnぶんの実績を ${format.toUpperCase()} で書き出しました。`);
  };

  return (
    <details className="rounded border border-slate-700 bg-slate-900/40 p-2">
      <summary className="cursor-pointer text-[10px] text-slate-400">Balance Calibration Log の書き出し</summary>
      <div className="mt-2 space-y-1.5">
        <p className="text-[10px] leading-snug text-slate-500">
          Runの条件（source commit / Scenario / seed / 販売市場モデル / Balance Profile）と、
          Turn別の適用実績（各指数・配当性向・原料の補正前後・販売基準価格の補正前後・警告）を1つの表にします。
        </p>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => download("csv")}
            data-testid="calibration-log-csv"
            className="rounded border border-slate-600 px-2 py-1 text-[11px] hover:bg-slate-800"
          >
            CSVで書き出し
          </button>
          <button
            type="button"
            onClick={() => download("json")}
            data-testid="calibration-log-json"
            className="rounded border border-slate-600 px-2 py-1 text-[11px] hover:bg-slate-800"
          >
            JSONで書き出し
          </button>
        </div>
        {note ? (
          <p className="text-[10px] text-slate-300" data-testid="calibration-log-note">
            {note}
          </p>
        ) : null}
      </div>
    </details>
  );
}
