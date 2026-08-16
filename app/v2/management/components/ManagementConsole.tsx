"use client";

// ShrimpX V2 — 32Q Management Console（Phase 2）
//
// 【engine を省略しない】1 Turn / 4 Turns / 32 Turns はいずれも
// simulation/engine.ts の advanceSimulationTurn を「その回数だけ」呼ぶ。
// fast-run 専用の簡易計算は存在しない。
//
// 【progress は実測】"Running Turn 7 / 32" は実際に処理中のターン番号である。
//
// 【STOP は本物】次のターンの処理へ入る前に停止する。完了済みターンはそのまま残る。
//
// 【Phase 2 で解消した2点】
//   A. リロードで結果が消える  → 実行の区切りごとに Simulation Run として保存し、
//      次回の読み込み時に active run を復元する。
//   B. Console と Analysis が別々のデータを見ている → 両画面とも
//      simulationRunId で同じ Simulation Run を読む（Analysis は再実行しない）。
//
// 【表示は必ず dataset を通す】実行直後もリロード後も、描画に使うのは
// buildDatasetFromSession / 保存された dataset の**同じ形**である。
// 「実行中は state から、復元後は dataset から」という二重経路を作らない。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  advanceSimulationTurn,
  applyVisionOverrideToSession,
  createSimulationSession,
  resetVisionOverrideForSessionCompany,
} from "../../../lib/v2/companyLab/simulation/engine";
import { CompanyVisionOverrideEntry } from "../../../lib/v2/companyLab/vision/overrides";
import { VisionCalibrationPanel } from "./VisionCalibrationPanel";
import {
  CompanyControlMode,
  MANAGEMENT_CONSOLE_STANDARD_TURNS,
  PackCompanyTurnCapture,
  SimulationRun,
  SimulationSession,
} from "../../../lib/v2/companyLab/simulation/types";
import { CompanyDecisionInput } from "../../../lib/v2/companyLab/types";
import { CompanyDecisionDraft } from "../../company-lab/decisionDraft";
import { CompanyControlPanel } from "./CompanyControlPanel";
import { getLiveSession, upsertLiveSession } from "../lib/liveSessionRegistry";
import { buildDatasetFromSession } from "../../../lib/v2/companyLab/simulation/analytics/dataset";
import { SimulationAnalyticsDataset } from "../../../lib/v2/companyLab/simulation/analytics/types";
import { toCompanySeries } from "../../../lib/v2/companyLab/simulation/analytics/views";
import { SimulationRunSummary, StoredSimulationRun } from "../../../lib/v2/companyLab/simulation/persistence/types";
import { restoreSessionFromResumePayload } from "../../../lib/v2/companyLab/simulation/persistence/resume";
import { createEmptyStrategyDocument, CompanyStrategyDocument } from "../../../lib/v2/companyLab/strategyProfile/types";
import { CompanyFixture } from "../../../lib/v2/companyLab/types";
import {
  getActiveSimulationRunId,
  listSimulationRuns,
  loadSimulationRun,
  setActiveSimulationRunId,
} from "../lib/simulationRunStore";
import { persistResumableRun } from "../lib/persistRun";
import { SeriesChart } from "./SeriesChart";
import { CompanyInspector } from "./CompanyInspector";
import { MarketSummary } from "./MarketSummary";
import { ScenarioNewsPanel } from "./ScenarioNewsPanel";
import { resolveNewsTurn, selectScenarioNewsForTurn } from "../lib/scenarioNews";
import { RunSelector } from "./RunSelector";
import { Collapsible } from "./Collapsible";
import { StrategySummary } from "./StrategySummary";
import { ExportPackButton } from "./ExportPackButton";
import { QUICK_NAVIGATION } from "../analysis/catalog";
import { listScenarioAliases } from "../../../lib/v2/industryLab/cli/scenarioAliases";
import { newRunId } from "../lib/runId";

const DEFAULT_SCENARIO_ID = "baseline";
const DEFAULT_SEED = "management-console-32q";

/**
 * 選べるシナリオ一覧。
 * **ここに一覧を書き写さない** — scenario/definitions の登録簿（ALL_SCENARIO_DEFINITIONS）
 * をそのまま読む。シナリオを追加すれば、この画面の選択肢にも自動で現れる。
 */
const SCENARIO_OPTIONS = listScenarioAliases().map((e) => ({
  value: e.alias,
  label: `${e.definition.title}（${e.alias}）`,
  durationTurns: e.definition.durationTurns,
}));

/** metadata 用のタイムスタンプ。ゲーム判断には一切渡さない。 */
function nowIso(): string {
  return new Date().toISOString();
}

type RunPhase = "idle" | "running" | "stopping";

/** 表示に必要な最小限。実行中は session から、復元時は保存済み run から埋まる。 */
interface ConsoleView {
  readonly run: SimulationRun;
  readonly dataset: SimulationAnalyticsDataset;
  /** 続きを進められるのは、このブラウザで実際に走らせているセッションだけ。 */
  readonly session: SimulationSession | null;
  /**
   * 【Vision駆動の戦略成長】会社×ターンごとの志・戦略ギャップ・新工場判断。
   * Vision 導入より前に保存された Run では空になる（架空の Vision を作らない）。
   */
  readonly strategyTurns: readonly PackCompanyTurnCapture[];
}

function viewFromSession(session: SimulationSession): ConsoleView {
  return { run: session.run, dataset: buildDatasetFromSession(session), session, strategyTurns: session.packCompanyTurns };
}

export function ManagementConsole() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // 【Phase 8・Run Context Preservation】URLの ?run= を最優先で見る。
  // これがあれば「今表示すべき Simulation Run」はURLが示しており、
  // localStorageの「直近アクティブなrun」に頼る必要が無い。
  const runQueryParam = searchParams.get("run");

  // シナリオと seed は「次に新しく始める実行」の設定である。
  // 実行中の run のシナリオは view.run.scenarioId であり、こちらを書き換えても遡及しない。
  const [scenarioId, setScenarioId] = useState(DEFAULT_SCENARIO_ID);
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [view, setView] = useState<ConsoleView | null>(null);
  const [fixtures, setFixtures] = useState<readonly CompanyFixture[]>([]);
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [runningTurn, setRunningTurn] = useState<number | null>(null);
  const [targetTurns, setTargetTurns] = useState<number>(MANAGEMENT_CONSOLE_STANDARD_TURNS);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("BAL");
  const [savedRuns, setSavedRuns] = useState<readonly SimulationRunSummary[]>([]);
  const [storageNote, setStorageNote] = useState<string | null>(null);
  /**
   * 【Turn14以降Save/Resume停止BLOCKER修正・指示§17/§31】browser・server両方の保存が
   * 失敗した場合、ゲームの見た目上のTurnだけが進み続けて保存正本が追いつかない
   * （「Turn18まで進めたように見えてTurn14へ消える」）状態を防ぐ。両方失敗した直後は
   * さらにTurnを進めるボタンを無効化し、次に保存が成功する（browser・serverの
   * どちらか一方でも成功する）までブロックする。
   */
  const [persistenceBlocked, setPersistenceBlocked] = useState(false);
  /**
   * 【Q25→Q26 authoritative persistence停止BLOCKER修正・指示§16/§41】
   * 直近のpersist()が成功した時点のcompletedTurns/revision（＝「保存正本が
   * 実際に到達しているTurn」）。live（画面のCompleted Turns）と比較して表示することで、
   * 三宅がstagingで「Live == Saved」だけを見れば保存停止に気づける診断表示を出す
   * （本格的なPERSISTENCE_OUT_OF_SYNC状態機械までは今回導入しないが、
   * 「見た目のTurnだけ進んで保存が追いついていない」状態を隠さないための最小限の
   * 可視化）。per-turn persistへの変更（runInternal参照）により、通常はこの2つは
   * 常に一致するはずで、一致しない場合だけ強調表示する。
   */
  const [lastPersisted, setLastPersisted] = useState<{ readonly completedTurns: number; readonly revision: number } | null>(null);
  /**
   * 【Management Console認証Cookie整合性調査・指示§13】staging限定の認証診断
   * （/api/v2/company-lab/session-status）。persistenceBlockedになった時だけ
   * 確認し、「Auth: VALID/INVALID」を表示する。秘密情報は含まない。
   */
  const [authDiagnostic, setAuthDiagnostic] = useState<"unknown" | "valid" | "invalid">("unknown");
  const [restoring, setRestoring] = useState(true);
  const stopRequested = useRef(false);
  /**
   * 【Q25→Q26 authoritative persistence停止BLOCKER修正・指示§10】run()の再入防止。
   * phase（React state）の更新は非同期・バッチされ得るため、同じイベントティック内で
   * 連打・二重クリックされた場合、2つのrun()呼び出しが両方とも「phase !== "idle"」の
   * チェックを古い値のまま通過し、同じliveセッションから独立に2本のturn進行ループが
   * 並行して走り得る（それぞれが自分のcurrentをsetView/persistする競合状態）。
   * ref は同期的に読み書きできるため、この競合を確実に防ぐ（stateのbatchingの影響を
   * 受けない）。
   */
  const runInProgress = useRef(false);

  // --- 【Phase 7・Manual Override】会社ごとの経営モードと、PLAYER会社の当ターン意思決定 ---
  // 未確定は STANDARD_AI 相当（指示§3「新しいSimulation Run作成時は5社すべてSTANDARD_AI」）。
  const [companyControlModes, setCompanyControlModes] = useState<Readonly<Record<string, CompanyControlMode>>>({});
  // そのターンぶんだけ持つ（確定後、advanceSimulationTurn へ渡したら毎回クリアする）。
  const [confirmedPlayerDecisions, setConfirmedPlayerDecisions] = useState<Readonly<Record<string, CompanyDecisionInput>>>({});
  const [confirmedPlayerDrafts, setConfirmedPlayerDrafts] = useState<Readonly<Record<string, CompanyDecisionDraft>>>({});
  const [waitingForPlayerCompanyIds, setWaitingForPlayerCompanyIds] = useState<readonly string[]>([]);

  /** 新しい実行を始めるときは、経営モード・確定済み意思決定をすべてdefaultへ戻す（指示§3/§29/§30）。 */
  const resetControlState = useCallback(() => {
    setCompanyControlModes({});
    setConfirmedPlayerDecisions({});
    setConfirmedPlayerDrafts({});
    setWaitingForPlayerCompanyIds([]);
    setPersistenceBlocked(false);
  }, []);

  const [strategyDocs] = useState<Readonly<Record<string, CompanyStrategyDocument>>>(() => {
    const s = createSimulationSession({ simulationRunId: "schema", scenarioId: DEFAULT_SCENARIO_ID, seed: DEFAULT_SEED, requestedTurns: 1, startedAt: "init" });
    return Object.fromEntries(s.fixtures.map((f) => [f.companyId, createEmptyStrategyDocument(f.companyId)]));
  });

  /** 空セッションを作る（fixtures はここでしか手に入らないので必ず保持する）。 */
  const createFresh = useCallback(
    (startedAt: string): SimulationSession =>
      createSimulationSession({
        simulationRunId: newRunId(`${scenarioId}-${seed}`, startedAt),
        scenarioId,
        seed,
        requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
        startedAt,
      }),
    [scenarioId, seed]
  );

  /**
   * 【Phase 9・Save/Resume】保存済みRunを開くとき、resumePayloadがあれば
   * 「続きから進められる」本物のSimulation Sessionへ復元する（liveSessionRegistryにも
   * 登録し、以降はこのタブ内の通常のライブセッションと同じに扱われる）。
   * resumePayloadが無い（古いRun）場合だけ、従来どおり閲覧専用のdataset表示に留める
   * （Q1からの再構築や、別Runの暗黙生成はしない）。
   * 起動時の復元（useEffect）と Run History からの選択（selectRun）の両方から呼ぶ。
   */
  const applyStoredRun = useCallback((stored: StoredSimulationRun) => {
    const resumePayload = stored.resumePayload;
    if (resumePayload) {
      // 【指示§16】resumePayloadが壊れている・非互換な形をしていた場合、Q1へ黙って
      // 作り直したり、既存の実績（dataset）まで捨てたりしない。閲覧専用（VIEW_ONLY）へ
      // 落ちたうえで、理由をstorageNoteとして画面に出す。
      try {
        const session = restoreSessionFromResumePayload(stored.run, resumePayload, stored.packCapture, stored.dataset);
        // 復元直後に最低限アクセスして、壊れた形（欠けたフィールド等）を早期検出する。
        void session.state.scenarioState.currentTurn;
        void session.fixtures.length;
        upsertLiveSession(session.run.simulationRunId, {
          session,
          companyControlModes: resumePayload.companyControlModes,
          confirmedPlayerDecisions: resumePayload.confirmedPlayerDecisions,
          confirmedPlayerDrafts: {},
          selectedCompanyId: "BAL",
        });
        setView(viewFromSession(session));
        setFixtures(session.fixtures);
        setScenarioId(session.run.scenarioId);
        setSeed(session.run.seed);
        setCompanyControlModes(resumePayload.companyControlModes);
        setConfirmedPlayerDecisions(resumePayload.confirmedPlayerDecisions);
        setConfirmedPlayerDrafts({});
        setWaitingForPlayerCompanyIds(
          session.run.stopReason === "waiting_for_player"
            ? session.fixtures
                .filter(
                  (f) =>
                    (resumePayload.companyControlModes[f.companyId] ?? "STANDARD_AI") === "PLAYER" &&
                    resumePayload.confirmedPlayerDecisions[f.companyId] === undefined
                )
                .map((f) => f.companyId)
            : []
        );
        return;
      } catch (e) {
        setStorageNote(
          `この Simulation Run の保存済み状態（resumePayload）が壊れているため、続きからは進められません（${
            e instanceof Error ? e.message : String(e)
          }）。閲覧専用として表示します。`
        );
        // フォールスルーして下の閲覧専用表示へ。
      }
    }
    setView({ run: stored.run, dataset: stored.dataset, session: null, strategyTurns: stored.packCapture?.companyTurns ?? [] });
  }, []);

  // --- 起動時：Run Contextを復元する ---
  // 優先順位（指示§4/§5/§27 NAV-1〜NAV-7）：
  //   1. URLの ?run= が、このタブでまだ生きている liveSessionRegistry と一致する
  //      → 進行中のセッションをそのまま復元する（Turnが1に戻らない・続きから進められる）。
  //   2. URLの ?run= はあるが liveSessionRegistry に無い（別タブ・ハードリロード等）
  //      → resumePayloadがあれば続きから、無ければ読み取り専用で復元する。
  //   3. URLに ?run= が無い → 従来どおりlocalStorageの直近アクティブなrunを見る。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const blank = createFresh("init");
      if (!cancelled) setFixtures(blank.fixtures);

      if (runQueryParam) {
        const live = getLiveSession(runQueryParam);
        if (live) {
          if (!cancelled) {
            setView(viewFromSession(live.session));
            setFixtures(live.session.fixtures);
            setScenarioId(live.session.run.scenarioId);
            setSeed(live.session.run.seed);
            setCompanyControlModes(live.companyControlModes);
            setConfirmedPlayerDecisions(live.confirmedPlayerDecisions);
            setConfirmedPlayerDrafts(live.confirmedPlayerDrafts);
            setSelectedCompanyId(live.selectedCompanyId);
            setActiveSimulationRunId(runQueryParam);
            setRestoring(false);
          }
          return;
        }
        const stored = await loadSimulationRun(runQueryParam);
        if (cancelled) return;
        if (stored) {
          applyStoredRun(stored);
          setScenarioId(stored.run.scenarioId);
          setSeed(stored.run.seed);
          setActiveSimulationRunId(runQueryParam);
          setSavedRuns(await listSimulationRuns());
          setRestoring(false);
          return;
        }
        // 指定されたrunが見つからない場合だけ、従来のフォールバックへ進む
        // （存在しないrunIdを捏造した空Runとして扱わない・明示的なエラーは出さず静かにフォールバック）。
      }

      const runs = await listSimulationRuns();
      if (cancelled) return;
      setSavedRuns(runs);

      const activeId = getActiveSimulationRunId() ?? runs[0]?.simulationRunId ?? null;
      if (activeId) {
        const live = getLiveSession(activeId);
        if (live) {
          if (!cancelled) {
            setView(viewFromSession(live.session));
            setFixtures(live.session.fixtures);
            setScenarioId(live.session.run.scenarioId);
            setSeed(live.session.run.seed);
            setCompanyControlModes(live.companyControlModes);
            setConfirmedPlayerDecisions(live.confirmedPlayerDecisions);
            setConfirmedPlayerDrafts(live.confirmedPlayerDrafts);
            setSelectedCompanyId(live.selectedCompanyId);
            setRestoring(false);
          }
          return;
        }
        const stored = await loadSimulationRun(activeId);
        if (!cancelled && stored) {
          applyStoredRun(stored);
          setRestoring(false);
          return;
        }
      }
      if (!cancelled) {
        setView(viewFromSession(blank));
        setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [createFresh, runQueryParam, applyStoredRun]);

  // --- ライブセッションレジストリへの書き込み（Analysis/PLAYER Workspace等、別routeが読む） ---
  // Consoleが持つ状態が変わるたびに書き込む。pendingDrafts（Workspace内の未確定下書き）は
  // Consoleが関知しないフィールドのため、upsertLiveSessionのマージにより保持される。
  useEffect(() => {
    if (!view?.session) return;
    upsertLiveSession(view.session.run.simulationRunId, {
      session: view.session,
      companyControlModes,
      confirmedPlayerDecisions,
      confirmedPlayerDrafts,
      selectedCompanyId,
    });
  }, [view, companyControlModes, confirmedPlayerDecisions, confirmedPlayerDrafts, selectedCompanyId]);

  // 【Management Console認証Cookie整合性調査・指示§13】保存がブロックされたら、
  // staging限定の診断endpointで実際に認証Cookieが有効かを確認する
  // （秘密情報は返さない。開発者・三宅がHTTP 403の原因をこの画面だけで切り分けられる）。
  useEffect(() => {
    if (!persistenceBlocked) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/v2/company-lab/session-status");
        if (cancelled || !response.ok) return;
        const body = (await response.json()) as { authenticated?: boolean };
        setAuthDiagnostic(body.authenticated ? "valid" : "invalid");
      } catch {
        // 診断自体が失敗しても本体機能には影響させない（unknownのまま）。
      }
    })();
    return () => {
      cancelled = true;
      // ブロック解除・再ブロック時は次の診断結果が出るまでunknownへ戻す
      // （cleanup側で行うことで、effect本体からの同期setStateを避ける）。
      setAuthDiagnostic("unknown");
    };
  }, [persistenceBlocked]);

  /**
   * 実行の区切りで保存する。保存先（サーバー／ブラウザ）は必ず画面へ出す。
   * 【Phase 9・Save/Resume】経営モード・確定済みPLAYER意思決定は、呼び出し側の
   * ローカル変数から明示的に受け取る（state setterは非同期のため、直前に更新した
   * 値がまだstateへ反映されていない可能性があり、stateを読むと古い値を保存しかねない）。
   */
  /**
   * 【Q25→Q26 authoritative persistence停止BLOCKER修正】呼び出し側（run()）が、
   * このTurnの保存が成立したかどうかを見て次のTurnへ進めるかどうかを決められるよう、
   * 真偽値を返す（旧実装はvoidで、呼び出し側は結果を見ずに次のTurnへ進んでいた）。
   */
  const persist = useCallback(
    async (
      session: SimulationSession,
      controlModes: Readonly<Record<string, CompanyControlMode>>,
      playerDecisions: Readonly<Record<string, CompanyDecisionInput>>
    ): Promise<boolean> => {
      const result = await persistResumableRun(session, controlModes, playerDecisions);
      setSavedRuns(await listSimulationRuns());
      setStorageNote(
        result.savedTo.length === 0
          ? `保存できませんでした（${[result.browserError, result.serverError].filter(Boolean).join(" / ")}）`
          : result.savedTo.length === 2
            ? "保存先: サーバー（Redis、正本）＋このブラウザ（軽量キャッシュ）"
            : result.savedTo[0] === "browser"
              ? `⚠️ サーバー保存に失敗しました（${result.serverError}）。ブラウザの軽量キャッシュのみ更新（識別情報だけで、続きからは進められません）。`
              : "保存先: サーバー（Redis、正本）のみ（ブラウザキャッシュは更新失敗。ゲーム進行には影響しません）"
      );
      // 【Persistence Architecture Phase 3・指示§6/§7/§8】サーバーがauthoritative。
      // Turnを進めてよいかどうかは server 保存の成否だけで決める
      // （browser軽量キャッシュの成否はゲーム進行をブロックしない）。
      const ok = result.serverSaveSucceeded;
      setPersistenceBlocked(!ok);
      if (ok) setLastPersisted({ completedTurns: session.run.completedTurns, revision: result.persistenceRevision });
      return ok;
    },
    []
  );

  /**
   * 【Management Console Vision Calibration・指示§12】実行中のRunへVision
   * overrideを適用する。session.state.config.visionOverridesを更新した新しい
   * sessionへ差し替えるだけで、過去Turnのcapture・現在の意思決定計算そのものは
   * 一切再計算しない（次のTurn実行時にresolveCompanyVisionが自然に拾う）。
   * ライブセッションレジストリへの書き込みは既存のuseEffect（view依存）に任せ、
   * ここでは重複して呼ばない。即座にサーバーへも保存し、次のTurnボタンを押す前に
   * リロードしてもoverrideが消えないようにする。
   */
  const handleApplyVisionOverride = useCallback(
    (companyId: string, entry: CompanyVisionOverrideEntry) => {
      if (!view?.session) return;
      const updated = applyVisionOverrideToSession(view.session, companyId, entry);
      setView(viewFromSession(updated));
      void persist(updated, companyControlModes, confirmedPlayerDecisions);
    },
    [view, companyControlModes, confirmedPlayerDecisions, persist]
  );

  const handleResetVisionOverride = useCallback(
    (companyId: string) => {
      if (!view?.session) return;
      const updated = resetVisionOverrideForSessionCompany(view.session, companyId);
      setView(viewFromSession(updated));
      void persist(updated, companyControlModes, confirmedPlayerDecisions);
    },
    [view, companyControlModes, confirmedPlayerDecisions, persist]
  );

  const runInternal = useCallback(
    async (turns: number) => {
      // 【Persistence Architecture Phase 3・指示§6/§8】サーバー保存（正本）が
      // 失敗している場合、見た目のTurnだけ進んで保存正本が追いつかない状態を許さない
      // （ブラウザの軽量キャッシュはgameplay resumeを保証する層ではないため、
      // browserだけ成功していてもブロックする）。
      if (persistenceBlocked) {
        setErrorMessage(
          "直前のサーバー保存（正本）が失敗しており、このまま進めると進行状況が保存されずに失われます。" +
            "ネットワーク状態・stagingログインセッションを確認するか、保存できる状態になってから再度お試しください" +
            "（画面下部の保存先表示を参照）。"
        );
        return;
      }
      setErrorMessage(null);
      setTargetTurns(turns);
      setPhase("running");
      stopRequested.current = false;

      // 保存済み実行を表示しているだけの状態（view.session===null）からは、新しい実行として
      // 開始する（保存物には途中状態を含めていないため、続きから進めるふりをしない）。
      // 【Phase 8】Setup画面で作った直後（まだ0ターン）のライブセッションは、それ自体が
      // 「これから進めるべき本物のRun」であり、0ターンだからといって作り直してはいけない
      // （以前はhistory.length>0を要求しており、Setup直後にBALをPLAYERにしていても
      // 最初のTurnボタンでその設定ごと別Runへ作り直されてしまうバグがあった）。
      // シナリオ・seed を変えたら、途中の実行を引き継がず新しい実行として始める
      // （別シナリオのターンが1本の Simulation Run に混ざることを防ぐ）。
      const live = view?.session ?? null;
      const liveMatchesSettings = live !== null && live.run.scenarioId === scenarioId && live.run.seed === seed;
      const continuesLiveRun = liveMatchesSettings;
      let current = continuesLiveRun ? live : createFresh(nowIso());
      // 【指示§30】シナリオ切替・新規Runでは経営モード・確定済み意思決定をdefaultへ戻す。
      // 既存Runの続きなら、これまでの経営モード切替（PLAYER化など）を引き継ぐ（指示§18）。
      // 【重要】setState は非同期のため、このrun()呼び出し内のループ判定にはstateではなく
      // ローカル変数を使う（reset直後に古いstateを読んでしまう不整合を避ける）。
      const controlModesForThisRun = continuesLiveRun ? companyControlModes : {};
      if (!continuesLiveRun) {
        resetControlState();
        router.replace(`/v2/management?run=${encodeURIComponent(current.run.simulationRunId)}`);
      }
      setView(viewFromSession(current));
      setWaitingForPlayerCompanyIds([]);

      // このrun()呼び出しの間だけ有効な、直近のPLAYER確定意思決定。
      // ターン処理後は消費してクリアする（次のPLAYERターンでは再び未入力に戻るのが正しい）。
      let pendingPlayerDecisions: Readonly<Record<string, CompanyDecisionInput>> = continuesLiveRun ? confirmedPlayerDecisions : {};

      for (let i = 0; i < turns; i++) {
        // 【本物のSTOP】次のターンへ入る前に確認する。処理中の中断はしない。
        if (stopRequested.current) {
          current = { ...current, run: { ...current.run, stopReason: "stopped_by_user", completedAt: nowIso() } };
          setView(viewFromSession(current));
          // 【複数工場CAPEX Targeting E2E受入で発見・修正】setPhase("idle")を先に呼ぶと、
          // まだpersist()（ブラウザ・サーバーへの保存）が完了していないうちにRun/1Turn
          // ボタンが再度押せる状態になり、その直後にhard reloadすると直近のターンぶんが
          // 保存前に失われる（実測: reload直前10/32だったcompletedTurnsがreload後8/32に
          // 後退する再現バグを確認した）。persist完了まではボタンをdisabledのままにする。
          await persist(current, controlModesForThisRun, pendingPlayerDecisions);
          setPhase("idle");
          setRunningTurn(null);
          return;
        }
        if (current.state.isComplete) break;

        // 【指示§11/§12/§27/§28】PLAYER会社の当ターン意思決定が未確定なら、勝手に先へ進めず停止する。
        const missingPlayerCompanies = current.fixtures.filter(
          (f) => (controlModesForThisRun[f.companyId] ?? "STANDARD_AI") === "PLAYER" && pendingPlayerDecisions[f.companyId] === undefined
        );
        if (missingPlayerCompanies.length > 0) {
          current = { ...current, run: { ...current.run, companyControlModes: controlModesForThisRun, stopReason: "waiting_for_player" } };
          setView(viewFromSession(current));
          setWaitingForPlayerCompanyIds(missingPlayerCompanies.map((f) => f.companyId));
          break;
        }

        const turnNumber = current.state.scenarioState.currentTurn;
        setRunningTurn(turnNumber);
        // ブラウザへ制御を戻し、進捗表示を実際に描画させる。
        await new Promise((r) => requestAnimationFrame(() => r(null)));

        const outcome = advanceSimulationTurn(current, nowIso(), pendingPlayerDecisions);
        current = { ...outcome.session, run: { ...outcome.session.run, companyControlModes: controlModesForThisRun } };
        setView(viewFromSession(current));
        // このターンで使った確定済みPLAYER意思決定は消費済み。次のターンはまた未入力から。
        pendingPlayerDecisions = {};
        setConfirmedPlayerDecisions({});
        setConfirmedPlayerDrafts({});

        if (!outcome.advanced) {
          if (outcome.error) setErrorMessage(`Simulation stopped at Turn ${turnNumber}: ${outcome.error.message}`);
          break;
        }

        // 【指示§9/§10/§12】このTurnの保存が成立して初めて、次のTurnへ進む。
        // 4Turns/32Turnsのようなバッチでも、Turn境界ごとにここを通る
        // （バッチの最後にまとめて1回だけ保存する旧実装は、途中の保存失敗を検知できず、
        // liveだけが先へ進んでしまう窓を作っていた）。
        const persisted = await persist(current, controlModesForThisRun, pendingPlayerDecisions);
        if (!persisted) {
          setErrorMessage(
            `Turn ${turnNumber} の保存に失敗したため、これ以上Turnを進めません` +
              `（画面下部の保存先表示を参照。保存できる状態になってから再度お試しください）。`
          );
          setPhase("idle");
          setRunningTurn(null);
          return;
        }
      }
      // 完走・シナリオ終端・失敗・PLAYER待ちのいずれでも保存する（失敗の記録も残す）。
      // 【複数工場CAPEX Targeting E2E受入で発見・修正】persist完了前にボタンを再度押せる
      // 状態へ戻すと、hard reloadで直近ターンが保存前に失われる競合が起きる（上のSTOP分岐と
      // 同じ理由）。
      await persist(current, controlModesForThisRun, pendingPlayerDecisions);
      setPhase("idle");
      setRunningTurn(null);
    },
    [persistenceBlocked, view, createFresh, persist, scenarioId, seed, companyControlModes, confirmedPlayerDecisions, resetControlState, router]
  );


  /**
   * 指定ターン数だけ進める。1回のターン処理ごとに描画を更新する。
   *
   * 【Q25→Q26 authoritative persistence停止BLOCKER修正・指示§9/§10/§12】
   * 以前は複数ターンをまとめて計算してからループの最後に1回だけpersist()していた
   * （4Turns/32Turnsのループが「途中の失敗を検知できない・途中まで進んだ分が
   * 保存されないまま次のバッチへ進んでしまう」窓を広く持っていた）。
   * ここでは1ターン進めるたびにpersist()し、その保存が成立した場合にだけ
   * 次のターンへ進む（"Turn N simulation complete → authoritative persist success
   * → only then allow Turn N+1"）。保存が失敗したら、そのバッチの残りターンへは
   * 進まずその場で止める（liveをこれ以上先へ進めない）。
   */
  const run = useCallback(
    async (turns: number) => {
      if (phase !== "idle" || restoring) return;
      // 【指示§10】run()の再入防止（stateのphaseチェックだけでは、同じイベント
      // ティック内での連打・二重クリックによる並行実行を防ぎきれない。refは
      // 同期的に確定するため、ここで即座に確保する）。
      if (runInProgress.current) return;
      runInProgress.current = true;
      try {
        await runInternal(turns);
      } finally {
        runInProgress.current = false;
      }
    },
    [phase, restoring, runInternal]
  );

  const reset = useCallback(() => {
    if (phase !== "idle") return;
    const fresh = createFresh(nowIso());
    setView(viewFromSession(fresh));
    setErrorMessage(null);
    setRunningTurn(null);
    setStorageNote(null);
    resetControlState();
    router.replace(`/v2/management?run=${encodeURIComponent(fresh.run.simulationRunId)}`);
  }, [phase, createFresh, resetControlState, router]);

  /**
   * 【指示§15】経営モード変更も保存タイミングの1つ。
   * 変更直後のSimulation Sessionが無ければ（保存済みRunの閲覧のみ・実行前）保存しない
   * （resumePayloadはSimulation Sessionが無いと組み立てられない）。
   */
  const handleChangeControlMode = useCallback(
    (companyId: string, mode: CompanyControlMode) => {
      setCompanyControlModes((prev) => {
        const next = { ...prev, [companyId]: mode };
        const session = view?.session;
        if (session) {
          void persist(session, next, confirmedPlayerDecisions);
        }
        return next;
      });
    },
    [view, persist, confirmedPlayerDecisions]
  );

  /** 【PLAYER Company Workspace】「この会社を操作」は、モーダルではなく専用routeへ遷移する。 */
  const openPlayerWorkspace = useCallback(
    (companyId: string) => {
      if (!view?.run.simulationRunId) return;
      router.push(`/v2/management/player?run=${encodeURIComponent(view.run.simulationRunId)}&company=${encodeURIComponent(companyId)}`);
    },
    [view, router]
  );

  const selectRun = useCallback(
    async (simulationRunId: string) => {
      const live = getLiveSession(simulationRunId);
      if (live) {
        setView(viewFromSession(live.session));
        setFixtures(live.session.fixtures);
        setScenarioId(live.session.run.scenarioId);
        setSeed(live.session.run.seed);
        setCompanyControlModes(live.companyControlModes);
        setConfirmedPlayerDecisions(live.confirmedPlayerDecisions);
        setConfirmedPlayerDrafts(live.confirmedPlayerDrafts);
        setSelectedCompanyId(live.selectedCompanyId);
        setActiveSimulationRunId(simulationRunId);
        setErrorMessage(null);
        router.replace(`/v2/management?run=${encodeURIComponent(simulationRunId)}`);
        return;
      }
      const stored = await loadSimulationRun(simulationRunId);
      if (!stored) return;
      setActiveSimulationRunId(simulationRunId);
      applyStoredRun(stored);
      setErrorMessage(null);
      router.replace(`/v2/management?run=${encodeURIComponent(simulationRunId)}`);
    },
    [router, applyStoredRun]
  );

  const dataset = view?.dataset ?? null;
  const revenueSeries = useMemo(
    () => (dataset ? toCompanySeries(dataset, "revenue").map((s) => ({ key: s.companyId, label: s.companyId, color: s.color, points: s.points })) : []),
    [dataset]
  );
  const profitSeries = useMemo(
    () => (dataset ? toCompanySeries(dataset, "operatingProfit").map((s) => ({ key: s.companyId, label: s.companyId, color: s.color, points: s.points })) : []),
    [dataset]
  );

  const completedTurns = dataset?.turns.length ?? 0;
  const busy = phase !== "idle";
  const isComplete = completedTurns >= MANAGEMENT_CONSOLE_STANDARD_TURNS;
  const isRestoredOnly = view !== null && view.session === null && completedTurns > 0;

  // 【Dynamic Scenario 1 Testplay】そのターンに公開してよいシナリオNews。
  // 実行中のセッションがあればシナリオが今いるターン、保存済み実行を眺めている
  // だけなら最後に完了したターンを対象にする（それより先の情報は持っていない）。
  // 記事の選定・未来記事の除外は lib/scenarioNews.ts 経由で情報公開エンジンが行う。
  const scenarioNews = useMemo(() => {
    if (view === null) return { scenarioNotFound: false, releases: [], turn: 1 } as const;
    const turn = resolveNewsTurn({
      scenarioCurrentTurn: view.session?.state.scenarioState.currentTurn ?? null,
      completedTurns,
    });
    return selectScenarioNewsForTurn(view.run.scenarioId, turn);
  }, [view, completedTurns]);

  const money = (v: number | null | undefined) => (v === null || v === undefined ? "－" : `${(v / 1_000_000).toFixed(1)}M`);
  const latestValue = (companyId: string, metric: string): number | null => {
    if (!dataset) return null;
    const turn = dataset.turns[dataset.turns.length - 1];
    return dataset.companyMetrics.find((f) => f.companyId === companyId && f.turn === turn && f.metric === metric)?.value ?? null;
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* ---------------- TOP BAR ---------------- */}
      <header className="sticky top-0 z-10 border-b border-slate-700 bg-slate-900/95 px-4 py-2.5 backdropblur">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <h1 className="text-base font-bold tracking-tight">ShrimpX 経営管制室</h1>
            <p className="text-[11px] text-slate-400">Game Owner / test environment 専用</p>
          </div>

          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
            <div>
              <dt className="text-slate-400">Scenario</dt>
              <dd className="font-mono font-semibold">{view?.run.scenarioId ?? "－"}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Turn</dt>
              <dd className="font-mono font-semibold" data-testid="turn-counter">
                {completedTurns} / {MANAGEMENT_CONSOLE_STANDARD_TURNS}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Simulation Run ID</dt>
              <dd className="max-w-[220px] truncate font-mono text-[11px]" data-testid="run-id">
                {view?.run.simulationRunId ?? "－"}
              </dd>
            </div>
          </dl>

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => run(1)} disabled={busy || restoring || persistenceBlocked} data-testid="run-1"
              className="rounded bg-sky-700 px-3 py-1.5 text-sm font-semibold hover:bg-sky-600 disabled:opacity-40">
              1 Turn
            </button>
            <button type="button" onClick={() => run(4)} disabled={busy || restoring || persistenceBlocked} data-testid="run-4"
              className="rounded bg-sky-700 px-3 py-1.5 text-sm font-semibold hover:bg-sky-600 disabled:opacity-40">
              4 Turns
            </button>
            <button type="button" onClick={() => run(MANAGEMENT_CONSOLE_STANDARD_TURNS)} disabled={busy || restoring || persistenceBlocked} data-testid="run-32"
              className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-semibold hover:bg-emerald-600 disabled:opacity-40">
              32 Turns
            </button>
            <button type="button" onClick={() => { stopRequested.current = true; setPhase("stopping"); }} disabled={phase !== "running"} data-testid="stop"
              className="rounded bg-rose-700 px-3 py-1.5 text-sm font-semibold hover:bg-rose-600 disabled:opacity-40">
              STOP
            </button>
            <button type="button" onClick={reset} disabled={busy}
              className="rounded border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-40">
              Reset
            </button>
            <Link
              href={view?.run.simulationRunId ? `/v2/management/analysis?run=${encodeURIComponent(view.run.simulationRunId)}` : "/v2/management/analysis"}
              data-testid="analysis-link"
              className="rounded border border-sky-600 px-3 py-1.5 text-sm font-semibold text-sky-300 hover:bg-slate-800"
            >
              Analysis Home
            </Link>
            {/* 【指示J/K】ゲーム条件（Scenario/Seed/初期PLAYER設定）を選び直すための入口。
                現在のRunは保存されたままで、押すと新しい条件で「別のRun」を開始できる
                Setup画面へ移動するだけ（現在のRunを破棄する表現にはしない）。 */}
            <Link
              href="/v2/management/setup"
              data-testid="back-to-setup-link"
              className="rounded border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
              title="現在のRunは保存されたままです。ゲーム条件設定画面から、別の条件で新しいRunを開始できます。"
            >
              ゲーム条件へ戻る
            </Link>
          </div>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
          {/* progress: 実際に処理中のターン番号を出す（水増ししない） */}
          <div className="min-h-[20px] text-xs" role="status" aria-live="polite" data-testid="progress">
            {restoring ? (
              <span className="text-slate-500">保存済みの実行を確認しています…</span>
            ) : phase === "running" && runningTurn !== null ? (
              <span className="text-sky-300">
                Running Turn {runningTurn} / {MANAGEMENT_CONSOLE_STANDARD_TURNS}（Completed {completedTurns} / {targetTurns} 要求分）
              </span>
            ) : phase === "stopping" ? (
              <span className="text-amber-300">停止要求を受け付けました。処理中のターンの完了を待っています…</span>
            ) : errorMessage ? (
              <span className="text-rose-400" data-testid="error-message">{errorMessage}</span>
            ) : waitingForPlayerCompanyIds.length > 0 ? (
              <span className="font-semibold text-amber-300" data-testid="waiting-for-player-message">
                {waitingForPlayerCompanyIds.join(", ")} の意思決定待ち — Completed {completedTurns} / {MANAGEMENT_CONSOLE_STANDARD_TURNS} Turns
              </span>
            ) : view?.run.stopReason === "stopped_by_user" ? (
              <span className="text-amber-300">Stopped by user — Completed {completedTurns} / {MANAGEMENT_CONSOLE_STANDARD_TURNS} Turns</span>
            ) : isComplete && completedTurns > 0 ? (
              <span className="font-semibold text-emerald-400" data-testid="complete-message">
                Simulation Complete — {completedTurns} / {MANAGEMENT_CONSOLE_STANDARD_TURNS} Turns
              </span>
            ) : completedTurns > 0 ? (
              <span className="text-slate-400">Completed {completedTurns} / {MANAGEMENT_CONSOLE_STANDARD_TURNS} Turns</span>
            ) : (
              <span className="text-slate-500">待機中</span>
            )}
          </div>

          {/* 次に新しく始める実行の設定。実行中は変更できない（走っている run のシナリオは変わらない）。 */}
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-400">シナリオ</span>
            <select
              value={scenarioId}
              onChange={(e) => setScenarioId(e.target.value)}
              disabled={busy || restoring}
              data-testid="scenario-selector"
              className="max-w-[320px] rounded border border-slate-600 bg-slate-900 px-2 py-1 text-[11px] disabled:opacity-40"
            >
              {SCENARIO_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-400">Seed</span>
            <input
              type="text"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              disabled={busy || restoring}
              data-testid="seed-input"
              spellCheck={false}
              className="w-[220px] rounded border border-slate-600 bg-slate-900 px-2 py-1 font-mono text-[11px] disabled:opacity-40"
            />
          </label>

          <RunSelector runs={savedRuns} selectedRunId={view?.run.simulationRunId ?? null} onSelect={selectRun} disabled={busy} />

          {view && completedTurns > 0 && (view.run.scenarioId !== scenarioId || view.run.seed !== seed) ? (
            <span className="text-[11px] text-amber-300" data-testid="scenario-changed-note">
              表示中の実行は「{view.run.scenarioId} / {view.run.seed}」です。次に Turn を進めると、選択中の設定で新しい実行が始まります。
            </span>
          ) : null}

          {storageNote ? (
            <span className={`text-[11px] ${persistenceBlocked ? "font-semibold text-rose-400" : "text-slate-400"}`} data-testid="storage-note">
              {storageNote}
            </span>
          ) : null}

          {/* 【Q25→Q26 authoritative persistence停止BLOCKER修正・指示§16/§41】
              Live（画面のCompleted Turns）と直近の保存成功時点のTurnを並べて出す。
              通常は常に一致するはずで、一致しない場合だけ強調表示する
              （見た目のTurnだけ進んで保存が追いついていない状態を隠さない）。 */}
          {lastPersisted ? (
            <span
              className={`text-[11px] font-mono ${lastPersisted.completedTurns < completedTurns ? "font-semibold text-rose-400" : "text-slate-500"}`}
              data-testid="live-vs-saved"
            >
              Live: {completedTurns} / Saved: {lastPersisted.completedTurns} (rev {lastPersisted.revision})
              {lastPersisted.completedTurns < completedTurns ? " — 保存が追いついていません" : ""}
            </span>
          ) : null}
        </div>

        {persistenceBlocked ? (
          <div className="mt-1.5 rounded-md border border-rose-700 bg-rose-950/60 px-3 py-2 text-xs text-rose-200" data-testid="persistence-blocked-banner">
            <p>
              ⚠️ 直前のサーバー保存（正本）が失敗しました。この状態のままTurnを進めると、進行状況が保存されずに失われます。
              保存できる状態になるまで、Turnを進めるボタンを無効化しています。
              {authDiagnostic !== "unknown" ? (
                <span className="ml-2 font-mono" data-testid="auth-diagnostic">
                  [Auth: {authDiagnostic === "valid" ? "VALID" : "INVALID"}]
                </span>
              ) : null}
            </p>
            {/* 【Management Console認証Cookie整合性調査・指示§11】HTTP 403（stagingログイン
                セッションが無効）の場合の再ログイン導線。テキスト案内だけだと、ユーザーが
                URLを手入力・別検索して別オリジンへ迷い込む恐れがあるため、必ず同一オリジン内の
                相対リンクにする。returnToで戻り先（このRunのURL）を渡し、ログイン後に
                Management Consoleへ自動的に戻す（指示§17）。 */}
            <p className="mt-1">
              HTTP 403（認証セッション切れ）の場合は、
              <Link
                href={`/v2/company-lab/play/login?returnTo=${encodeURIComponent(
                  typeof window !== "undefined" ? window.location.pathname + window.location.search : "/v2/management"
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-rose-100 underline underline-offset-2 hover:text-white"
                data-testid="persistence-relogin-link"
              >
                こちらから再ログイン
              </Link>
              してください（新しいタブで開きます。ログイン後、このRunへ自動的に戻ります）。
              再ログイン後、この画面で「1 Turn」等を押すと保存を再試行します。
            </p>
          </div>
        ) : null}

        {/* Quick Navigation: 主要分析へ1クリックで移動する。
            通常の <a href> なので Ctrl+Click・中クリック・「新しいタブで開く」がそのまま使える。 */}
        <nav className="mt-1.5 flex flex-wrap items-center gap-1.5" aria-label="主要分析へのショートカット">
          <span className="text-[11px] text-slate-400">分析へ:</span>
          {QUICK_NAVIGATION.map((q) => (
            <Link
              key={q.testId}
              href={view?.run.simulationRunId ? `${q.path}?run=${encodeURIComponent(view.run.simulationRunId)}` : q.path}
              data-testid={`console-${q.testId}`}
              className="rounded border border-slate-600 px-2 py-0.5 text-[11px] text-sky-300 hover:bg-slate-800"
            >
              {q.label}
            </Link>
          ))}
        </nav>

        {isRestoredOnly ? (
          <p className="mt-1 text-[11px] text-amber-300/90" data-testid="restored-note">
            保存済みの Simulation Run を表示しています。保存物には途中状態を含めていないため、
            この実行の「続き」からは進められません（実行ボタンを押すと新しい実行を開始します）。
          </p>
        ) : null}

        {/* 【指示A】active Runが無ければSetupへ誘導してよい（強制リダイレクトはしない）。 */}
        {!restoring && !runQueryParam && completedTurns === 0 ? (
          <p className="mt-1 text-[11px] text-sky-300" data-testid="setup-guide-note">
            まだこのRunにターンが進んでいません。
            <Link href="/v2/management/setup" className="ml-1 underline underline-offset-2">
              ゲーム条件を設定して開始する
            </Link>
            こともできます。
          </p>
        ) : null}
      </header>

      {/* ---------------- BODY ---------------- */}
      <div className="flex flex-col gap-3 p-3 lg:flex-row">
        {/* LEFT: Game Overview 約65% */}
        <main className="flex flex-col gap-3 lg:w-[65%]">
          <SeriesChart
            title="Revenue Trend（5社 / 32Q）"
            series={revenueSeries}
            totalTurns={MANAGEMENT_CONSOLE_STANDARD_TURNS}
            highlightKey={selectedCompanyId}
            unitLabel="USD"
            emptyMessage="まだデータがありません。ターンを進めてください。"
          />
          <SeriesChart
            title="Operating Profit Trend（5社 / 32Q）"
            series={profitSeries}
            totalTurns={MANAGEMENT_CONSOLE_STANDARD_TURNS}
            highlightKey={selectedCompanyId}
            unitLabel="USD"
            emptyMessage="まだデータがありません。ターンを進めてください。"
          />

          {dataset ? (
            <Collapsible title="Market Summary（最新ターンの市場実績）" testId="console-market-summary-toggle">
              <MarketSummary dataset={dataset} />
            </Collapsible>
          ) : null}

          {/* 【Dynamic Scenario 1 Testplay】そのターンのシナリオNewsを読めるようにする。
              表示する記事の選定は lib/scenarioNews.ts が既存の情報公開エンジンへ委ねており、
              ここではシナリオIDとターンを渡すだけ。未来の記事は情報公開エンジンが構造的に落とす。 */}
          {view ? (
            <Collapsible
              title={`シナリオNews（Turn ${scenarioNews.turn}）`}
              testId="console-scenario-news-toggle"
              hint="プレイヤーが読むのと同じ記事です。"
            >
              <ScenarioNewsPanel turn={scenarioNews.turn} releases={scenarioNews.releases} scenarioNotFound={scenarioNews.scenarioNotFound} />
            </Collapsible>
          ) : null}

          {/* 【既定画面を重くしない】5社の志と成長圧力は折りたたみで持つ。 */}
          <Collapsible title="Vision と成長圧力（5社サマリー）" testId="console-strategy-summary-toggle">
            <StrategySummary strategyTurns={view?.strategyTurns ?? []} runId={view?.run.simulationRunId ?? null} />
          </Collapsible>

          {/* 【Management Console Vision Calibration・指示§12】実行中でもVisionを調整できる。 */}
          <Collapsible title="Vision & Strategy Calibration（実行中の編集）" testId="console-vision-calibration-toggle">
            <VisionCalibrationPanel session={view?.session ?? null} onApply={handleApplyVisionOverride} onReset={handleResetVisionOverride} />
          </Collapsible>

          <ExportPackButton
            simulationRunId={view?.run.simulationRunId ?? null}
            scenarioId={view?.run.scenarioId ?? null}
            seed={view?.run.seed ?? null}
            completedTurns={completedTurns}
          />

          <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
            <h2 className="mb-2 text-sm font-semibold">5社サマリー（最新ターン）</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-xs text-slate-400">
                    <th className="py-1 pr-2">会社</th>
                    <th className="py-1 pr-2 text-right">Revenue</th>
                    <th className="py-1 pr-2 text-right">Op. Profit</th>
                    <th className="py-1 pr-2 text-right">Net Income</th>
                    <th className="py-1 pr-2 text-right">Cash</th>
                    <th className="py-1 text-right">Debt</th>
                  </tr>
                </thead>
                <tbody>
                  {(dataset?.companies ?? []).map((c) => {
                    const op = latestValue(c.companyId, "operatingProfit");
                    return (
                      <tr
                        key={c.companyId}
                        onClick={() => setSelectedCompanyId(c.companyId)}
                        className={`cursor-pointer border-b border-slate-800 hover:bg-slate-800/60 ${c.companyId === selectedCompanyId ? "bg-slate-800/80" : ""}`}
                      >
                        <td className="py-1 pr-2">
                          <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ backgroundColor: c.color }} aria-hidden />
                          {c.companyId}
                        </td>
                        <td className="py-1 pr-2 text-right tabular-nums">{money(latestValue(c.companyId, "revenue"))}</td>
                        <td className={`py-1 pr-2 text-right tabular-nums ${(op ?? 0) < 0 ? "text-rose-400" : ""}`}>{money(op)}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{money(latestValue(c.companyId, "netIncome"))}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{money(latestValue(c.companyId, "cash"))}</td>
                        <td className="py-1 text-right tabular-nums">{money(latestValue(c.companyId, "debt"))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {completedTurns === 0 ? <p className="mt-2 text-xs text-slate-400">ターンを進めると実績が表示されます。</p> : null}
          </section>
        </main>

        {/* RIGHT: Company Inspector 約35% */}
        <aside className="flex flex-col gap-3 lg:w-[35%]">
          {fixtures.length > 0 ? (
            <CompanyControlPanel
              fixtures={fixtures}
              controlModes={companyControlModes}
              onChangeMode={handleChangeControlMode}
              decidedCompanyIds={new Set(Object.keys(confirmedPlayerDecisions))}
              waitingCompanyIds={waitingForPlayerCompanyIds}
              onOperate={openPlayerWorkspace}
              disabled={busy || view?.session === null}
              currentTurn={view?.session?.state.scenarioState.currentTurn ?? view?.run.startingTurn ?? 1}
            />
          ) : null}
          {view?.session === null && fixtures.length > 0 ? (
            <p className="text-[11px] text-amber-300/90">
              保存済みの実行を表示しているため、経営モードの切替・PLAYER操作はできません（実行ボタンで新しい実行を開始してください）。
            </p>
          ) : null}

          <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-2.5">
            <h2 className="mb-2 text-sm font-semibold">Company Inspector</h2>
            {dataset ? (
              <CompanyInspector
                dataset={dataset}
                fixtures={fixtures}
                selectedCompanyId={selectedCompanyId}
                onSelect={setSelectedCompanyId}
                strategyDocs={strategyDocs}
                strategyTurns={view?.strategyTurns ?? []}
              />
            ) : (
              <p className="text-sm text-slate-400">読み込み中…</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
