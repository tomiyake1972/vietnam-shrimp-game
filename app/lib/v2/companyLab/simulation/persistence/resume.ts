// ShrimpX V2 — 32Q Management Console Phase 9: Simulation Run の Save / Resume
//
// SimulationSession ⇄ SimulationResumePayload の相互変換だけを持つ。
// 計算ロジックは一切無い（純粋なデータの組み立て・分解だけ）。

import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState } from "../../types";
import { CompanyControlMode, SimulationRun, SimulationSession } from "../types";
import { SimulationAnalyticsDataset } from "../analytics/types";
import { SimulationResumePayload } from "./types";
import { CompanyLabRuntimeSnapshot } from "../../persistence/types";
import { SalesContract } from "../../../sales/types";
import { RawMaterialLot } from "../../../rawMaterials/types";
import { COMMERCIAL_HISTORY_RETAINED_QUARTERS } from "../../commercialHistoryState";
import { PeriodV2, previousPeriod } from "../../../core/period";

/**
 * 【Save/Resume 長期永続化・鮮度整合 BLOCKER修正】resumePayload.state.history に
 * 残す直近ターン数。
 *
 * 監査の結果（history consumer audit）、次ターンのsimulation継続に生きたパスで
 * 履歴を読む箇所は marketDemandObservation.ts の固定lag=2（history[length-2]）
 * だけで、それ以外の継続系コード（engine.ts / runner.ts 等）は最後の1件しか
 * 読まない。history全件を読むのは Analysis/export/UI閲覧用（buildDatasetFromSession等）
 * であり、これらは resumePayload ではなく別途保存される dataset/packCapture
 * （常にライブの完全なsession.state.historyから作られ、trimmedなresumePayload.state.history
 * の影響を受けない）を読む。
 *
 * 4を採用: 生きたパスで必要な2に対して、将来Phase Iで検討され得る2Q/4Qトレンド
 * 判断のための余地を残す（instruction §8「32Q全部をresume snapshotへ残す設計に
 * 戻さない」を守りつつ、必要最小限より少し余裕を持たせる）。
 */
export const ROLLING_RESUME_HISTORY_WINDOW = 4;

/**
 * 【Turn14以降Save/Resume停止BLOCKER Phase2・state compaction】
 * resumePayload保存用に、直近 COMMERCIAL_HISTORY_RETAINED_QUARTERS 四半期より
 * 古い、かつ既に履行完了／キャンセル済みの契約を除去する。
 *
 * 【consumer audit（根拠）】
 *   - Standard AIの受注状況把握（observation.ts:70-72）は
 *     status ∈ {"open","partiallyFulfilled","overdue"} だけを見る（未履行契約は
 *     どれだけ古くても残す必要がある＝時間窓を設けず、statusだけで判定する）。
 *   - Standard AIの「提出→成約」転換率観測（standardAi/commercialHistory.ts
 *     observeContractConversion）は、直近履歴 history.records
 *     （companyLab/commercialHistoryState.ts, COMMERCIAL_HISTORY_RETAINED_QUARTERS=6
 *     四半期ぶんだけ保持）の各periodに対応する契約を contractedPeriod で突き合わせて
 *     originalQuantityを集計する。ここは status を問わない（履行済み・キャンセル済みも
 *     含めて集計する既存仕様）ため、直近 COMMERCIAL_HISTORY_RETAINED_QUARTERS 四半期
 *     ぶんの契約はstatusによらず残す必要がある。
 *   - 顧客信頼度（customerTrustByMarket、observation.ts:395）は契約配列を
 *     再走査しない独立フィールドであり、この間引きの影響を受けない。
 *   - 売掛金（AR）は state.financeState.receivables という独立フィールドであり、
 *     契約配列の再走査で求めていない（finance/types.ts参照）。
 *   - 上記以外に .contracts を無条件（status不問・全期間）で読む継続系コードは
 *     見つからなかった（company-lab-proper側のcreateCompanyLabRuntimeSnapshotは
 *     契約を無条件で保持するが、これは会社ラボ本体のRedis Runtime Snapshotの
 *     既存仕様であり、本関数はSimulation Run専用のresumePayload生成にのみ適用する）。
 */
function trimContractsForResume(contracts: readonly SalesContract[], currentPeriod: PeriodV2): readonly SalesContract[] {
  let cutoffPeriod = currentPeriod;
  for (let i = 0; i < COMMERCIAL_HISTORY_RETAINED_QUARTERS; i++) cutoffPeriod = previousPeriod(cutoffPeriod);
  return contracts.filter((c) => {
    if (c.status === "open" || c.status === "partiallyFulfilled" || c.status === "overdue") return true;
    return c.contractedPeriod.localeCompare(cutoffPeriod) >= 0;
  });
}

/**
 * 【Turn14以降Save/Resume停止BLOCKER Phase2・state compaction】
 * resumePayload保存用に、完全消費済み（status="consumed"）・期限切れ
 * （status="expired"）の原料ロットを除去する。
 *
 * 【consumer audit（根拠）】
 *   - 生産計画への原料配分（production/allocation.ts:121-124）は
 *     status==="available" のロットだけを対象に会社別の使用可能量を合計する。
 *   - 原料在庫評価額（finance/initialState.ts:rawMaterialInventoryValueUsd）は
 *     status ∈ {"available","inTransitImport"} だけを合算する（Balance Sheetの
 *     原料在庫はこの関数だけが計算しており、除去対象のロットは元々ゼロ寄与）。
 *   - production/runner.ts:88 の rawMaterialLotOrigins（ロットID→inboundPeriod）は
 *     当四半期に消費されたロット（＝当四半期時点でstatus==="available"だった
 *     ロットの部分集合）のIDだけが実際に参照される。過去に既に消費済み・
 *     期限切れになったロットのIDがこのマップに存在しなくても、当四半期の
 *     batchesが参照するIDは常に解決できる。
 *   - status==="consumed" のロットは remainingQuantity=0 のため、
 *     金額計算（lotsValueUsd等）へ含めても寄与はゼロ（除去しても計算結果は
 *     不変）。status==="expired" のロットは rawMaterialInventoryValueUsd の
 *     対象外のため、既にBalance Sheetの評価には寄与していない。
 *   - lotId は連番で使い回されない（buildLotId参照）ため、過去の消費済み・
 *     期限切れロットを除去しても「新規ロット判定」（companyLabAdapter.ts:260
 *     lotIdsAtStart）が誤って新規と誤判定することはない。
 */
function trimRawMaterialLotsForResume(lots: readonly RawMaterialLot[]): readonly RawMaterialLot[] {
  return lots.filter((l) => l.status !== "consumed" && l.status !== "expired");
}

/**
 * 【Turn14以降Save/Resume停止BLOCKER Phase2・state compaction】
 * resumePayload保存用に、productionState.history（四半期ごとの生産処理記録の
 * 蓄積、ProductionQuarterRecord[]）を空配列へ間引く。
 *
 * 【consumer audit（根拠・既存の前例）】production/runner.ts の
 * advanceProductionQuarter は、返り値の次stateへ history を追記するだけで、
 * 自分自身も含め継続系コードのどこからも history を読まない（history は
 * write-onlyの蓄積値）。会社ラボ本体の永続化層
 * （companyLab/persistence/snapshot.ts）は、この事実に基づいて既に同じ間引きを
 * 行っている（"productionState.historyは常に空配列で復元する...production側の
 * ゲームロジックはこの内部historyの過去要素を一切参照しないため、空配列での
 * 復元は計算結果に影響しない"）。Analysis側（dataset.ts）もproductionState
 * そのものを読まない（company-lab本体のstate.history経由でturn実績を読む）ため、
 * Simulation Run側でも同じ間引きが安全に適用できる。
 *
 * 【finishedGoodsLotsの間引き】あわせて、完全充当済み（status="allocated"、
 * remainingQuantity=0）・期限切れ（status="expired"）の完成品ロットも除去する。
 * rawMaterialLotsと全く同じ構造（消費指示に基づくstatus遷移を持つロット配列）
 * であり、consumer auditも同型:
 *   - 契約充当計画（production/fulfillment.ts:47）は
 *     status==="available" && remainingQuantity>0 のロットだけを対象にする。
 *   - Standard AIの完成品在庫把握（standardAi/observation.ts:81
 *     finishedGoodsByProduct）も status==="available" だけを合算する。
 *   - status==="allocated" のロットはremainingQuantity=0のため、金額換算等へ
 *     含めても寄与はゼロ。status==="expired" のロットは在庫評価・充当対象外。
 *   - lotIdは連番で使い回されない（buildLotId等、ロット生成関数は毎回一意な
 *     連番を刻む）ため、除去しても新規ロット判定を誤らせない。
 */
function trimProductionStateForResume(state: CompanyLabState): CompanyLabState["productionState"] {
  return {
    ...state.productionState,
    history: [],
    finishedGoodsLots: state.productionState.finishedGoodsLots.filter((l) => l.status !== "allocated" && l.status !== "expired"),
  };
}

/** resumePayload保存用に、CompanyLabStateを間引く（history・contracts・rawMaterialLots・productionState.history）。 */
function trimStateForResume(state: CompanyLabState): CompanyLabState {
  return {
    ...state,
    history: state.history.length <= ROLLING_RESUME_HISTORY_WINDOW ? state.history : state.history.slice(-ROLLING_RESUME_HISTORY_WINDOW),
    contracts: trimContractsForResume(state.contracts, state.currentPeriod),
    rawMaterialLots: trimRawMaterialLotsForResume(state.rawMaterialLots),
    productionState: trimProductionStateForResume(state),
  };
}

/**
 * 【Turn14以降Save/Resume停止BLOCKER Phase2・state compaction】
 * latestQuarterPreProcessingSnapshot（CompanyLabRuntimeSnapshot）も、
 * state.contracts/state.rawMaterialLotsと同じ配列を保持しているため
 * （companyLab/persistence/snapshot.ts:createCompanyLabRuntimeSnapshot参照）、
 * 同じ間引きを適用する。productionStateはこの型では元々
 * {currentPeriod, finishedGoodsLots} だけ（historyを持たない）ため、そちらは
 * 間引き不要。
 *
 * 【PLAYER Company Databookへの影響（companyDatabookPayload.ts参照）】
 * この値は「期首状態」としてDatabook Excelの契約ロールフォワード明細
 * （buildExportSalesContractRollforward, exportDto/dto/contractDto.ts）の
 * "期首"側の入力になる。同関数は preProcessingStateSnapshot.contracts を
 * 期首契約のインデックスとして使うが、当四半期に活動（新規成約・履行・期末残高
 * のいずれか）が無い契約は、期首・当期新規・当期履行・期末残高がすべて
 * ゼロの行になる。本関数が除去する契約（履行済み／キャンセル済み・
 * COMMERCIAL_HISTORY_RETAINED_QUARTERS四半期より前に成約）は、定義上
 * 当四半期の活動が無い契約の部分集合であるため、除去してもロールフォワード
 * 明細の非ゼロ行・検算列には影響しない（全ゼロ行が表示されなくなるだけの
 * 差異であり、reloadした実行では一部の全ゼロ・無活動の古い契約行が
 * 表示されなくなり得る。これは金額・数量の正しさには影響しない既知の
 * 表示差異として§Mで報告する）。
 */
function trimLatestQuarterPreProcessingSnapshotForResume(
  snapshot: CompanyLabRuntimeSnapshot | null
): CompanyLabRuntimeSnapshot | null {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    contracts: trimContractsForResume(snapshot.contracts, snapshot.currentPeriod),
    rawMaterialLots: trimRawMaterialLotsForResume(snapshot.rawMaterialLots),
    productionState: {
      ...snapshot.productionState,
      finishedGoodsLots: snapshot.productionState.finishedGoodsLots.filter((l) => l.status !== "allocated" && l.status !== "expired"),
    },
  };
}

/**
 * aiTurnTraces（history同様、次ターン継続には使われない・純粋な分析用の蓄積値。
 * dataset.ts:aiTurnTraces参照は buildDatasetFromSession 経由でのみ）も同じ
 * window分だけへ間引く。turn範囲がhistoryとずれるとaiTraceの再計算が不整合になる
 * ため、historyと同じ件数（同じ直近ターン集合）を残す。
 */
function trimAiTurnTracesForResume(traces: SimulationSession["aiTurnTraces"], windowTurns: readonly number[]): SimulationSession["aiTurnTraces"] {
  if (windowTurns.length === 0) return traces;
  const minTurn = windowTurns[0];
  return traces.filter((t) => t.turn >= minTurn);
}

/**
 * SimulationSessionから、保存すべきresumePayloadを組み立てる。
 * companyControlModes・confirmedPlayerDecisionsはSimulationSession自体には
 * 持たせていない（Management Console側のReact stateが唯一の情報源）ため、
 * 呼び出し側から渡す。
 */
export function buildResumePayload(
  session: SimulationSession,
  companyControlModes: Readonly<Record<string, CompanyControlMode>>,
  confirmedPlayerDecisions: Readonly<Record<string, CompanyDecisionInput>>
): SimulationResumePayload {
  const trimmedState = trimStateForResume(session.state);
  const windowTurns = trimmedState.history.map((r) => r.turn);
  return {
    state: trimmedState,
    fixtures: session.fixtures,
    companyControlModes,
    confirmedPlayerDecisions,
    aiTurnTraces: trimAiTurnTracesForResume(session.aiTurnTraces, windowTurns),
    observedDemand: session.observedDemand,
    salesHeadcountByTurn: session.salesHeadcountByTurn,
    capacityByTurn: session.capacityByTurn,
    latestQuarterPreProcessingSnapshot: trimLatestQuarterPreProcessingSnapshotForResume(session.latestQuarterPreProcessingSnapshot),
  };
}

/**
 * 保存済みのSimulationRunメタデータ＋resumePayloadから、続きから進められる
 * SimulationSessionを再構築する。
 *
 * 【捏造しない】packCompanyTurns/packWorldTurnsはpackCaptureから復元する
 * （呼び出し側がstored.packCaptureを渡す。無ければ空のまま＝AI Analysis Packの
 * 該当セクションはNOT_RECORDEDとして扱われる。既存の後方互換方針と同じ）。
 */
export function restoreSessionFromResumePayload(
  run: SimulationRun,
  resumePayload: SimulationResumePayload,
  packCapture?: { readonly companyTurns: SimulationSession["packCompanyTurns"]; readonly worldTurns: SimulationSession["packWorldTurns"] },
  /**
   * 【Save/Resume 長期永続化・鮮度整合 BLOCKER修正】resume元のStoredSimulationRunが
   * 持っていた dataset（resumePayload.state.historyがrolling windowへ間引かれる前、
   * ライブの完全なsession.state.historyから作られていたため、reload以前のturnぶんの
   * Analysis事実をすべて含む）。渡すと、以後 buildDatasetFromSession が呼ばれるたびに
   * これとマージされ、Analysis/AI Pack/Databookが読むdatasetからreload以前のturnが
   * 欠落しない（session.priorAnalyticsDatasetとして保持する。dataset.ts参照）。
   */
  priorAnalyticsDataset?: SimulationAnalyticsDataset
): SimulationSession {
  const config: CompanyLabConfig = {
    scenarioId: run.scenarioId,
    mode: "canonical",
    seed: run.seed,
    turns: run.requestedTurns,
  };
  return {
    run,
    state: resumePayload.state,
    fixtures: resumePayload.fixtures,
    config,
    aiTurnTraces: resumePayload.aiTurnTraces,
    observedDemand: resumePayload.observedDemand,
    salesHeadcountByTurn: resumePayload.salesHeadcountByTurn,
    capacityByTurn: resumePayload.capacityByTurn,
    packCompanyTurns: packCapture?.companyTurns ?? [],
    packWorldTurns: packCapture?.worldTurns ?? [],
    latestQuarterPreProcessingSnapshot: resumePayload.latestQuarterPreProcessingSnapshot,
    priorAnalyticsDataset,
  };
}
