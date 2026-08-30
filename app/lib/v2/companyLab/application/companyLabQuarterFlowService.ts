// ShrimpX V2 — 会社ラボ 四半期処理 Application Service（Phase 8C-2）
//
// Phase 8C-1で実装した永続化Repository（app/lib/v2/companyLab/persistence/）と、
// 既存の四半期処理エンジン（app/lib/v2/companyLab/runner.ts の
// initializeCompanyLab / advanceCompanyLabQuarter）の間に立ち、「永続化された
// 会社ラボの四半期処理」を1つのユースケースとして実行する層。
//
// 【責務の分担】
//   - 本サービス: ラボ作成・ドラフト保存/提出・四半期処理の実行順序の制御、
//     再開時の直近履歴注入、コミット前の履歴検証、冪等な再試行、
//     ロック取得/解放、競合結果の型付きエラーへの変換。
//   - Repository（8C-1）: ストレージの読み書きと、revision確認＋複数キー更新の
//     Redis側単一原子処理（Lua）。本サービスは「読んで比較して書く」を
//     CASとして扱わない（比較と更新は必ずLua側で行われる。§6.3）。
//   - decisionsProvider（呼び出し側が注入）: 提出済みドラフト本体（unknown、
//     UI層のCompanyDecisionDraft想定）を全社ぶんのCompanyDecisionInputへ変換する。
//     lib層はUI層の型に依存しない、という既存のレイヤー分離（8C-1 types.tsの
//     CompanyLabDraftEnvelope.draft: unknownの設計判断）をそのまま守るための注入点。
//     8C-3以降のAPI層が、app/v2/company-lab/decisionDraft.tsのドラフト解釈と
//     autoPolicy（プレイヤー以外の4社）をここへ配線する想定。
//
// 【draftのライフサイクル（8C-2指示§3.2。既存モデルの範囲で表現し、新しい状態
//   モデルは追加しない）】
//   - draftが存在しない            … loadDraft() === null
//   - 存在するが未提出             … envelope.submittedAt === null
//   - 提出済み                     … envelope.submittedAt !== null
//   - 処理済み                     … draftはコミット時に原子的に削除され、
//                                    current.lastProcessedTurnId === そのturnId になる

import { ENGINE_VERSION_V2 } from "../../core/version";
import { PeriodV2 } from "../../core/period";
import { CompanyId } from "../../sales/types";
import { CompanyDecisionInput, CompanyFixture, CompanyLabConfig, CompanyLabError, CompanyLabState, CompanyQuarterRecord } from "../types";
import { advanceCompanyLabQuarter, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { PublicMarketInfo } from "../types";
import { createCompanyLabRuntimeSnapshot, restoreCompanyLabStateFromRuntimeSnapshot } from "../persistence/snapshot";
import { validateCompanyLabQuarterHistoryEntry } from "../persistence/schema";
import {
  CompanyLabDraftEnvelope,
  CompanyLabPersistedStateV1,
  CompanyLabQuarterHistoryEntry,
  CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
} from "../persistence/types";
import { CompanyLabStateRepository } from "../persistence/repository";
import {
  CompanyLabCompletedError,
  CompanyLabDraftAlreadySubmittedError,
  CompanyLabDraftConflictError,
  CompanyLabDraftNotFoundError,
  CompanyLabDraftNotSubmittedError,
  CompanyLabDraftTurnMismatchError,
  CompanyLabIntegrityError,
  CompanyLabLockConflictError,
  CompanyLabLockUnavailableError,
  CompanyLabNotFoundError,
  CompanyLabQuarterProcessingError,
  CompanyLabRevisionConflictError,
  CompanyLabTurnConflictError,
} from "../persistence/errors";

// ---------------------------------------------------------------------
// 1. 入出力型
// ---------------------------------------------------------------------

/** decisionsProviderが受け取る、四半期の意思決定を組み立てるために必要な文脈。 */
export interface CompanyLabDecisionContext {
  /** 直近履歴注入済みの復元状態（読み取り専用として扱うこと）。 */
  readonly restoredState: CompanyLabState;
  readonly fixtures: readonly CompanyFixture[];
  readonly publicInfo: PublicMarketInfo;
  readonly period: PeriodV2;
  readonly turn: number;
  readonly playerCompanyId: CompanyId;
  /** 提出済みドラフトの本体（unknown。解釈はprovider側の責務）。 */
  readonly submittedDraftBody: unknown;
}

/**
 * 提出済みドラフトから全社ぶんの意思決定を組み立てる関数。fixturesに含まれる
 * 全会社のCompanyDecisionInputを返す必要がある（不足していれば処理は
 * コミット前に失敗し、確定状態は変更されない）。
 */
export type CompanyLabDecisionsProvider = (context: CompanyLabDecisionContext) => Readonly<Record<CompanyId, CompanyDecisionInput>>;

export interface CreateLabInput {
  readonly labId: string;
  readonly config: CompanyLabConfig;
  /**
   * 【Phase 8C-3B】このラボでプレイヤーが操作する会社。作成時に必須で指定し、
   * ラボの永続状態（stored.playerCompanyId）へ保存する。以後の四半期処理は
   * 常にこの保存済み値を使い、リクエストごとに差し替えることはできない
   * （8C-3B指示§6）。存在しない会社IDを指定した場合はCompanyLabErrorを投げる。
   */
  readonly playerCompanyId: CompanyId;
  readonly now: string;
}

export interface CreateLabResult {
  readonly labId: string;
  readonly fixtures: readonly CompanyFixture[];
  readonly stored: CompanyLabPersistedStateV1;
}

export interface SaveDraftInput {
  readonly labId: string;
  readonly turnId: string;
  readonly draftBody: unknown;
  readonly now: string;
}

export interface SubmitDraftInput {
  readonly labId: string;
  readonly turnId: string;
  readonly now: string;
}

/**
 * 【Phase 8G】提出取り消し（withdraw）の入力。submitDraftの逆操作で、ドラフト本体は
 * 一切変更せず（プレイヤーが入力した値をそのまま残す）、submittedAtだけをnullへ戻す。
 * これにより、提出後に四半期処理が失敗した場合（例：営業人員の配分合計が実在人数を
 * 超えているエラー）でも、ドラフトを編集して再提出できる経路を用意する
 * （Phase 8C-1時点の「正式提出後の編集防止」は維持しつつ、取り消し操作を新設して
 * 両立させる。新しいdraftライフサイクルの状態は追加しない — 既存の
 * "存在しない/未提出/提出済み"の3状態のうち、"提出済み"→"未提出"の遷移を許可するだけ）。
 */
export interface WithdrawDraftInput {
  readonly labId: string;
  readonly turnId: string;
  readonly now: string;
}

export interface ProcessQuarterInput {
  readonly labId: string;
  /** この四半期処理の一意ID。同じturnIdでの再試行は冪等（§6.1）。 */
  readonly turnId: string;
  /** 四半期処理ロックのトークン（処理ごとに一意。呼び出し側が生成する）。 */
  readonly lockToken: string;
  readonly now: string;
  /** ロックTTL（ミリ秒）。省略時はDEFAULT_PROCESSING_LOCK_TTL_MS。 */
  readonly lockTtlMilliseconds?: number;
  /**
   * 【Phase 8C-3B】playerCompanyIdは意図的にこの入力から削除してある。作成時に
   * ラボへ保存された`stored.playerCompanyId`を唯一の正とし、処理requestごとに
   * 別会社へ差し替えられないようにするため（8C-3B指示§6「処理requestごとに
   * 別会社へ差し替えられない」）。呼び出し側（API/UI層）は、この値を指定する
   * 手段を持たない。
   */
  readonly decisionsProvider: CompanyLabDecisionsProvider;
}

export interface ProcessQuarterResult {
  /**
   * "processed"       … 今回の呼び出しで四半期処理・原子コミットが完了した。
   * "alreadyProcessed" … 同じturnIdが既に確定済みだったため、再計算・再保存せず
   *                      保存済みの確定結果を返した（§6.1。コミット成功後に
   *                      応答だけが失われた場合の再試行を安全にする）。
   */
  readonly status: "processed" | "alreadyProcessed";
  readonly revision: number;
  readonly historyEntry: CompanyLabQuarterHistoryEntry;
}

/**
 * 既定のロックTTL。1四半期処理（5社×1ターンのエンジン実行＋スナップショット生成＋
 * コミット）は実測で数百ms〜数秒のオーダーであり、60秒はその10倍以上の余裕を持つ。
 * ロック自動延長は実装しない（8C-2指示§13対象外）。TTL切れ時の安全性はロック
 * トークン検証（原子コミットのexpectedLockToken）が保証する（§6.4）。
 */
export const DEFAULT_PROCESSING_LOCK_TTL_MS = 60_000;

// ---------------------------------------------------------------------
// 2. サービス本体
// ---------------------------------------------------------------------

export interface CompanyLabQuarterFlowServiceDependencies {
  readonly repository: CompanyLabStateRepository;
}

export interface CompanyLabQuarterFlowService {
  createLab(input: CreateLabInput): Promise<CreateLabResult>;
  saveDraft(input: SaveDraftInput): Promise<CompanyLabDraftEnvelope>;
  submitDraft(input: SubmitDraftInput): Promise<CompanyLabDraftEnvelope>;
  withdrawDraft(input: WithdrawDraftInput): Promise<CompanyLabDraftEnvelope>;
  processQuarter(input: ProcessQuarterInput): Promise<ProcessQuarterResult>;
}

/**
 * 【ENG-COMPANYLAB-RESUME-HISTORY-1】resume時に注入する確定履歴record（古い→新しい）。
 *
 * 直近2件だけを返す。全履歴はロードしない。
 * latest はすでに呼び出し側が取得済みのものを受け取り、二重readを避ける。
 * 1つ前のturnが履歴indexに存在するときだけ追加で1件読む。
 */
const RESUME_HISTORY_RECORD_COUNT = 2;

async function loadRecentHistoryRecords(
  repository: CompanyLabStateRepository,
  labId: string,
  latest: CompanyLabQuarterHistoryEntry
): Promise<readonly CompanyQuarterRecord[]> {
  const previousTurn = latest.turn - 1;
  if (RESUME_HISTORY_RECORD_COUNT < 2 || previousTurn < 1) return [latest.record];
  const turns = await repository.loadHistoryIndex(labId);
  if (!turns.includes(previousTurn)) return [latest.record];
  const previous = await repository.loadHistoryEntry(labId, previousTurn);
  return [previous.record, latest.record];
}

export function createCompanyLabQuarterFlowService(deps: CompanyLabQuarterFlowServiceDependencies): CompanyLabQuarterFlowService {
  const { repository } = deps;

  async function createLab(input: CreateLabInput): Promise<CreateLabResult> {
    // 初期状態の生成は既存のinitializeCompanyLabをそのまま使う（重複実装しない）。
    const { state, fixtures } = initializeCompanyLab(input.config);
    // 【Phase 8C-3B】playerCompanyIdはこのラボのfixturesに実在する会社でなければ
    // ならない。API層（validation.ts）も既知の5社IDに対して事前検証するが、
    // ここでも防御的に確認する（直接Application Serviceを呼ぶ将来の呼び出し元・
    // API検証をバイパスする経路からも同じ不変条件を守るため）。
    if (!fixtures.some((f) => f.companyId === input.playerCompanyId)) {
      throw new CompanyLabError(
        `playerCompanyId "${input.playerCompanyId}" はこのシナリオのfixturesに存在しません。` +
          `有効な会社ID: ${fixtures.map((f) => f.companyId).join(", ")}`
      );
    }
    const runtime = createCompanyLabRuntimeSnapshot(state);
    // Repositoryが存在確認・current作成・labs一覧追加を原子的に行い、
    // 重複labIdはCompanyLabAlreadyExistsErrorになる（§3.1）。
    //
    // 【ENG-COMPANYLAB-EFFECTIVE-CONFIG-PERSIST-1】保存するのは呼び出し側が渡した
    // raw な input.config ではなく、initializeCompanyLab が解決した
    // **effective config（state.config）** である。
    //
    // 【なぜraw保存では壊れるか】initializeCompanyLab は
    // applyScenarioRequiredCapabilities（runner.ts）で、そのシナリオが成立するのに
    // 必要な機能フラグ（ScenarioDefinition.requiredCapabilities）を config へ
    // マージしてから state.config に入れる。ところが以前はここで input.config を
    // 保存していたため、シナリオ由来で追加された sai5 フラグが Redis へ入らず、
    // resume 時（restoreCompanyLabStateFromRuntimeSnapshot は保存済み config を
    // そのまま state.config に使う）に機能がOFFへ戻っていた。実測: DS1/DS2 は
    // requiredCapabilities で productLifecycle / supplyPremiumFeedback /
    // salesBaseAccumulation の3つを true 宣言しているが、保存後の config.sai5 は
    // undefined になっていた（＝requiredCapabilities が防ごうとしていた
    // 「シナリオが定義した世界と違う世界が動く」事象そのもの）。
    //
    // 【安全性】applyScenarioRequiredCapabilities は「足りなければ足す」だけで、
    // 呼び出し側が明示した値を無効化しない。宣言を持たないシナリオでは
    // effectiveConfig === config（同一参照）なので、baseline 等の保存内容は
    // 一切変わらない。schema・schemaVersion・Redis key は変更していない
    // （既に検証・復元対象である sai5 の中身が正しく入るようになるだけ）。
    //
    // 【既存Runは補修しない】既に requiredCapabilities 由来の sai5 が欠落した
    // まま保存されている Run に対する migration・Redis書き換え・resume時の
    // 自動補完は行わない（本修正の対象は「新規作成されるLabが最初から正しい
    // effective config を保存すること」のみ）。
    const stored = await repository.createLab({
      labId: input.labId,
      engineVersion: ENGINE_VERSION_V2,
      config: state.config,
      fixtures,
      playerCompanyId: input.playerCompanyId,
      runtime,
      now: input.now,
    });
    return { labId: input.labId, fixtures, stored };
  }

  async function saveDraft(input: SaveDraftInput): Promise<CompanyLabDraftEnvelope> {
    const stored = await repository.loadCurrentState(input.labId); // 不存在ならCompanyLabNotFoundError
    if (stored.currentState.runtime.isComplete) {
      throw new CompanyLabCompletedError(input.labId);
    }
    const existing = await repository.loadDraft(input.labId);
    if (existing !== null && existing.submittedAt !== null) {
      if (existing.turnId === input.turnId) {
        // 正式提出後の編集防止（8C-1指示§3-2の8C-2持ち越し分）。
        throw new CompanyLabDraftAlreadySubmittedError(input.labId);
      }
      // 【Phase 8C-3A、Fable監査Minor-1対応】提出済みだが未処理の別turnのdraftが
      // 既に存在する場合、異なるturnIdの新しいdraftで静かに上書きしない。turnIdの
      // シーケンス管理は呼び出し側の責務だが（8C-2指示§7）、呼び出し側が誤って
      // 処理待ちの提出済みdraftと異なるturnIdを送った場合に備え、Application
      // Service層で構造的に防ぐ（Repository/契約テストではなく、ここで検出する
      // 理由は、この判定がdraft単体の状態だけで完結し、Redis側の原子コミットの
      // 対象外＝読み取り専用の事前ガードとして安全に実装できるため）。
      throw new CompanyLabDraftConflictError(input.labId, existing.turnId, input.turnId);
    }
    const isSameTurnUpdate = existing !== null && existing.turnId === input.turnId;
    const envelope: CompanyLabDraftEnvelope = {
      labId: input.labId,
      period: stored.currentState.runtime.currentPeriod,
      turnId: input.turnId,
      revision: stored.currentState.revision,
      draft: input.draftBody,
      createdAt: isSameTurnUpdate ? existing.createdAt : input.now,
      updatedAt: input.now,
      submittedAt: null,
    };
    await repository.saveDraft(envelope);
    return envelope;
  }

  async function submitDraft(input: SubmitDraftInput): Promise<CompanyLabDraftEnvelope> {
    const stored = await repository.loadCurrentState(input.labId); // 不存在ならCompanyLabNotFoundError
    // 【Phase 8C-3A、Fable監査Minor-2対応】saveDraft・processQuarterと同様、完了済み
    // ラボでのdraft提出を明示的に拒否する（既存の到達可能な状態遷移だけを辿る限り
    // 実害はなかったが、一貫性・将来の呼び出し経路追加への防御のため追加する）。
    if (stored.currentState.runtime.isComplete) {
      throw new CompanyLabCompletedError(input.labId);
    }
    const existing = await repository.loadDraft(input.labId);
    if (existing === null) {
      throw new CompanyLabDraftNotFoundError(input.labId);
    }
    if (existing.turnId !== input.turnId) {
      throw new CompanyLabDraftTurnMismatchError(input.labId, input.turnId, existing.turnId);
    }
    if (existing.submittedAt !== null) {
      // 同じturnIdの再提出は冪等（既に提出済みのenvelopeをそのまま返す。二重更新しない）。
      return existing;
    }
    const submitted: CompanyLabDraftEnvelope = { ...existing, submittedAt: input.now, updatedAt: input.now };
    await repository.saveDraft(submitted);
    return submitted;
  }

  async function withdrawDraft(input: WithdrawDraftInput): Promise<CompanyLabDraftEnvelope> {
    const stored = await repository.loadCurrentState(input.labId); // 不存在ならCompanyLabNotFoundError
    if (stored.currentState.runtime.isComplete) {
      throw new CompanyLabCompletedError(input.labId);
    }
    const existing = await repository.loadDraft(input.labId);
    if (existing === null) {
      throw new CompanyLabDraftNotFoundError(input.labId);
    }
    if (existing.turnId !== input.turnId) {
      throw new CompanyLabDraftTurnMismatchError(input.labId, input.turnId, existing.turnId);
    }
    if (existing.submittedAt === null) {
      // 既に未提出（編集中）のdraftへの取り消し要求は、四半期処理と同様に冪等に扱う
      // （二重クリック・再送でエラーにしない。何も変更せずそのまま返す）。
      return existing;
    }
    // 【重要】draft本体（プレイヤーが入力した値）には一切触れない。submittedAtだけを
    // nullへ戻すことで、次回読み込み時にphaseが"submitted"→"editing"へ戻り、
    // かつ同じ内容のまま編集を再開できる（coerceDraftOrRebuildが提出時の値を
    // そのまま返す。viewModel.tsのisPlausibleCompanyDecisionDraftチェック経由）。
    const withdrawn: CompanyLabDraftEnvelope = { ...existing, submittedAt: null, updatedAt: input.now };
    await repository.saveDraft(withdrawn);
    return withdrawn;
  }

  async function processQuarter(input: ProcessQuarterInput): Promise<ProcessQuarterResult> {
    const lockTtl = input.lockTtlMilliseconds ?? DEFAULT_PROCESSING_LOCK_TTL_MS;

    // --- 1. ラボ存在確認＋現在状態取得（不存在ならCompanyLabNotFoundError） ---
    const stored = await repository.loadCurrentState(input.labId);

    // --- 2. 冪等な再試行の判定（§6.1）。コミット成功時にdraftは原子的に削除される
    //     ため、draft確認より先にこの判定を行う必要がある（後で確認すると、正当な
    //     再試行がdraftNotFoundに誤変換されてしまう）。 ---
    if (stored.currentState.lastProcessedTurnId === input.turnId) {
      const latest = await repository.loadLatestHistoryEntry(input.labId);
      if (latest === null || latest.turnId !== input.turnId) {
        throw new CompanyLabIntegrityError(
          input.labId,
          `current.lastProcessedTurnId(${input.turnId})に対応する直近履歴エントリが見つかりません` +
            `（直近履歴のturnId: ${latest === null ? "履歴なし" : latest.turnId}）。`
        );
      }
      return { status: "alreadyProcessed", revision: stored.currentState.revision, historyEntry: latest };
    }

    // --- 3. 完了済みラボの拒否（§10。current・history・draftのいずれも変更しない） ---
    if (stored.currentState.runtime.isComplete) {
      throw new CompanyLabCompletedError(input.labId);
    }

    // --- 4. 対象turnの提出済みdraftの確認（§3.2） ---
    const draft = await repository.loadDraft(input.labId);
    if (draft === null) {
      throw new CompanyLabDraftNotFoundError(input.labId);
    }
    if (draft.turnId !== input.turnId) {
      throw new CompanyLabDraftTurnMismatchError(input.labId, input.turnId, draft.turnId);
    }
    if (draft.submittedAt === null) {
      throw new CompanyLabDraftNotSubmittedError(input.labId);
    }

    // --- 5. 四半期処理ロックの取得（§6.4） ---
    const acquired = await repository.acquireProcessingLock({
      labId: input.labId,
      token: input.lockToken,
      ttlMilliseconds: lockTtl,
      now: input.now,
    });
    if (!acquired) {
      throw new CompanyLabLockUnavailableError(input.labId);
    }

    try {
      // --- 6. 直近確定履歴の取得＋整合性確認（§4。最重要要件） ---
      const latest = await repository.loadLatestHistoryEntry(input.labId);
      if (stored.currentState.lastProcessedTurnId !== undefined) {
        if (latest === null || latest.turnId !== stored.currentState.lastProcessedTurnId) {
          throw new CompanyLabIntegrityError(
            input.labId,
            `currentのlastProcessedTurnId(${stored.currentState.lastProcessedTurnId})と直近履歴エントリ` +
              `（${latest === null ? "履歴なし" : `turnId=${latest.turnId}`}）が一致しません。`
          );
        }
      } else if (latest !== null) {
        throw new CompanyLabIntegrityError(input.labId, `currentは未処理（lastProcessedTurnIdなし）なのに履歴エントリ（turn=${latest.turn}）が存在します。`);
      }

      // --- 7. スナップショット＋直近確定履歴recordからCompanyLabStateを復元 ---
      // 【最重要】turn 2以降のrunner（buildPreviousMarketContext・buildCompanyOwnState・
      // buildPublicMarketInfo）は確定履歴のrecordから前四半期の市場価格・工場負荷・
      // ベトナム国内前期価格を参照する。空のhistoryで復元すると例外は出ないが
      // シナリオのprehistory価格へ静かにフォールバックし、中断なし実行と異なる
      // 結果を生成してしまう。
      //
      // 【ENG-COMPANYLAB-RESUME-HISTORY-1】注入するrecordを直近1件から**直近2件**へ増やす。
      // 全履歴はロードしない（必要最小限）。
      //
      // 【なぜ2件必要か】resume経路のhistory consumerのうち最も長い履歴を必要とするのは
      // buildPublicMarketInfo（runner.ts）で、次の2つがいずれも「末尾から2件目」を読む:
      //   - 市場×商品構成比のtrend: prevRecord と prevPrevRecord（history[length-2]）の差分。
      //     2件目が無いと決定論的な基礎曲線 computeMarketProductMix へフォールバックし、
      //     連続実行と異なるtrendになる。
      //   - buildObservedMarketDemand: history[length - MARKET_DEMAND_OBSERVATION_LAG_QUARTERS]
      //     （LAG=2）。末尾からの相対位置で引くため、末尾2件を保てば同じrecordを指す。
      // 公開市場情報はStandard AIとPlayer画面の双方が読むため、1件だけの復元では
      // resume直後の1ターンだけ市場trendが変わり、その意思決定が以後へ伝播していた
      // （実測: Standard AIはbaseline/DS1/DS2いずれも1件で乖離、2件以上で完全一致。
      //  AutoPolicyはtrendを読まないため1件でも一致していた）。
      // engine自体（配当累計・前期市場文脈）は1件で足りるが、公開情報側の要件が2件である。
      //
      // 【順序】古い → 新しい（[T-2, T-1]）。restoreCompanyLabStateFromRuntimeSnapshot は
      // 受け取った配列をそのまま state.history として使い、consumer は末尾を「直近」として
      // 読むため、逆順にしてはならない。
      // 【履歴不足】0件なら []、1件しか無ければ [latest] のまま。エラーにはしない。
      // 【欠損の扱い】どのturnが存在するかは既存の履歴index（唯一の正本）に従い、
      // indexに載っているentryが読めない場合は loadFullHistory と同じく
      // CompanyLabHistoryEntryNotFoundError が伝播する（独自のsilentな握り潰しを追加しない）。
      const historyRecords = latest !== null ? await loadRecentHistoryRecords(repository, input.labId, latest) : [];
      const restoredState = restoreCompanyLabStateFromRuntimeSnapshot(stored.config, stored.currentState.runtime, historyRecords);
      const turn = restoredState.scenarioState.currentTurn;
      if (latest !== null && latest.turn !== turn - 1) {
        throw new CompanyLabIntegrityError(input.labId, `直近履歴のturn(${latest.turn})が、これから処理するturn(${turn})の直前ではありません。`);
      }

      // --- 8. 意思決定の組み立て（提出済みドラフト本体をproviderへ渡す） ---
      const publicInfo = buildPublicMarketInfo(restoredState);
      const decisions = input.decisionsProvider({
        restoredState,
        fixtures: stored.fixtures,
        publicInfo,
        period: restoredState.currentPeriod,
        turn,
        // 【Phase 8C-3B】playerCompanyIdは呼び出し元の入力ではなく、常にラボ作成時に
        // 保存されたstored.playerCompanyIdを使う（処理requestごとに別会社へ
        // 差し替えられないようにするため。8C-3B指示§6）。
        playerCompanyId: stored.playerCompanyId,
        submittedDraftBody: draft.draft,
      });
      for (const fixture of stored.fixtures) {
        if (!decisions[fixture.companyId]) {
          throw new CompanyLabQuarterProcessingError(input.labId, `decisionsProviderが会社 "${fixture.companyId}" の意思決定を返しませんでした。`);
        }
      }
      // createLab側でplayerCompanyIdがfixturesに存在することを保証済みのため、
      // ここで再現するとすれば保存データの破損に限られる（防御的にIntegrityErrorとする）。
      if (!stored.fixtures.some((f) => f.companyId === stored.playerCompanyId)) {
        throw new CompanyLabIntegrityError(input.labId, `保存済みplayerCompanyId "${stored.playerCompanyId}" がこのラボのfixturesに存在しません。`);
      }

      // --- 9-10. 処理前スナップショット確定＋エンジン実行＋処理後スナップショット生成 ---
      // 処理前スナップショットは保存済みcurrentのruntimeそのもの（復元・再スナップショットの
      // 往復を挟まず、確定済みの値を使う）。
      const preProcessingStateSnapshot = stored.currentState.runtime;
      let nextState: CompanyLabState;
      try {
        nextState = advanceCompanyLabQuarter(restoredState, stored.fixtures, decisions);
      } catch (e) {
        // コミット前の失敗（§6.5）。確定状態・draftは一切変更されない（draftは
        // 提出済みのまま残るため、原因解消後に同じturnIdで安全に再試行できる）。
        throw new CompanyLabQuarterProcessingError(input.labId, e instanceof Error ? e.message : String(e));
      }
      const postProcessingStateSnapshot = createCompanyLabRuntimeSnapshot(nextState);
      const record = nextState.history[nextState.history.length - 1];

      // --- 11-12. 履歴エントリの作成＋コミット前検証（§5） ---
      const entryDraft: CompanyLabQuarterHistoryEntry = {
        turnId: input.turnId,
        turn,
        period: record.period,
        engineVersion: stored.engineVersion,
        schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
        preProcessingStateSnapshot,
        postProcessingStateSnapshot,
        playerSubmission: decisions[stored.playerCompanyId],
        otherCompaniesDecisions: stored.fixtures.filter((f) => f.companyId !== stored.playerCompanyId).map((f) => decisions[f.companyId]),
        record,
        processedAt: input.now,
      };
      // 「書くことはできるが、後で読み出せない履歴」を構造的に作れないようにする。
      // 検証に失敗した場合はコミットを呼び出さず、current・history・index・draftの
      // いずれも変更されない（CompanyLabPersistedStateValidationErrorがそのまま伝播する）。
      const historyEntry = validateCompanyLabQuarterHistoryEntry(entryDraft, "$");

      // --- 13. Redis側単一原子処理によるコミット（§6.3。読み直し比較によるCASは行わない） ---
      const nextStoredState: CompanyLabPersistedStateV1 = {
        ...stored,
        currentState: {
          runtime: postProcessingStateSnapshot,
          lastProcessedTurnId: input.turnId,
          revision: stored.currentState.revision + 1,
        },
        draft: null,
        metadata: { createdAt: stored.metadata.createdAt, updatedAt: input.now },
      };
      const commitResult = await repository.commitQuarterAtomically({
        labId: input.labId,
        turn,
        turnId: input.turnId,
        expectedRevision: stored.currentState.revision,
        expectedLockToken: input.lockToken,
        nextStoredState,
        historyEntry,
      });

      // --- 14. コミット結果の変換 ---
      switch (commitResult.status) {
        case "committed":
          return { status: "processed", revision: commitResult.revision, historyEntry };
        case "alreadyCommitted": {
          // 本処理のロック下では通常到達しないが、原子コミット層の冪等判定を尊重して
          // 保存済みの確定結果を返す（再計算・二重保存はしない）。
          const latestAfter = await repository.loadLatestHistoryEntry(input.labId);
          if (latestAfter === null || latestAfter.turnId !== input.turnId) {
            throw new CompanyLabIntegrityError(input.labId, `alreadyCommittedと判定されたturnId(${input.turnId})の履歴エントリが見つかりません。`);
          }
          return { status: "alreadyProcessed", revision: commitResult.revision, historyEntry: latestAfter };
        }
        case "revisionConflict":
          throw new CompanyLabRevisionConflictError(input.labId, stored.currentState.revision, commitResult.actualRevision);
        case "historyConflict":
          throw new CompanyLabTurnConflictError(input.labId, turn, commitResult.existingTurnId);
        case "lockConflict":
          throw new CompanyLabLockConflictError(input.labId);
        case "currentNotFound":
          throw new CompanyLabNotFoundError(input.labId);
        case "draftNotFound":
          throw new CompanyLabDraftNotFoundError(input.labId);
        case "draftNotSubmitted":
          throw new CompanyLabDraftNotSubmittedError(input.labId);
        case "draftTurnMismatch":
          throw new CompanyLabDraftTurnMismatchError(input.labId, input.turnId, commitResult.actualTurnId);
        default: {
          const exhaustive: never = commitResult;
          throw new CompanyLabIntegrityError(input.labId, `未知のコミット結果です: ${JSON.stringify(exhaustive)}`);
        }
      }
    } finally {
      // --- 15. 自分のtokenに対応するロックだけを解放する（他処理のロックは削除されない。
      //     解放の失敗はTTLによる自然解放へフォールバックするため、本処理の結果を
      //     上書きしない（成功/失敗いずれの経路でも例外を握りつぶす）。 ---
      try {
        await repository.releaseProcessingLock(input.labId, input.lockToken);
      } catch {
        // TTLで解放される。ここでの失敗により本来の結果・エラーを損なわない。
      }
    }
  }

  return { createLab, saveDraft, submitDraft, withdrawDraft, processQuarter };
}
