// ShrimpX V2 — 設備投資モジュール 四半期クローズ（Phase 8B-2A）
//
// 【全体の処理順序（実装指示§14・§28。既存companyLab runnerの構造に合わせ、
// financing/liquidityClose.tsのclosseQuarterWithFinancingが確定させた
// 「デットサービス後の確定現金」を起点に、設備投資の現金配分を決める）】
//   1. closeQuarterWithFinancing（Phase 8B-1、既存・変更なし）が当四半期の
//      最終的な財務結果（デットサービス後の確定現金を含む）を確定する。
//   2. 設備投資可能額 = max(0, その確定現金 − 最低現金準備額)。
//   3. 新規提案の承認判定 → 取消/再開要求の適用 → 支払優先順位付け →
//      全額支払のみの分割払い試行（現金が尽きるまで、または全案件処理まで）。
//   4. finance/のclosefinancialQuarterを「三段目」として呼び、financing側の
//      数値（すでに確定済み・再計算しない）とcapex側の数値（当四半期支払・
//      完成振替・期末CIP・非減価償却対象額）を同時に渡して最終PL/BS/CFを得る。
//
// 【financingロジックを複製しない設計】financing側の利息・元本・借入残高は
// 一切再計算せず、closeQuarterWithFinancingがすでに返したFinancingQuarterResult
// （公開フィールドのみ）からFinancingAdjustmentを再構成して三段目へそのまま
// 渡す（三段目のclosefinancialQuarterは同じ入力から同じ計算をもう一度行うだけ
// であり、accruedInterestPayable等の恒等式は崩れない）。

import { PeriodV2 } from "../core/period";
import { CompanyId } from "../sales/types";
import { Product } from "../market/types";
import {
  CapexAdjustment,
  CompanyFinanceState,
  CompanyFinancialQuarterResult,
  FinancingAdjustment,
} from "../finance/types";
import { closeFinancialQuarter, CompanyQuarterBusinessActuals } from "../finance/quarterClose";
import { FinanceParameters } from "../finance/parameters";
import { FinancingQuarterResult } from "../financing/types";
import { CapexParameters } from "./parameters";
import { computeCapexMaintenanceCostUsd } from "./capacityEffect";
import { computeCapexComponentDepreciationUsd } from "./depreciation";
import { FACTORY_SPACE_PARAMETERS_V1, FactorySpaceParameters } from "../production/factorySpace";
import { computeCandidateProjectSpaceUnits, FactorySpaceApprovalBudget } from "./factorySpace";
import {
  applyCancelRequest,
  attemptPayment,
  buildPaymentQueue,
  evaluateProposal,
  hasActivePdMechanizationProjectForFactory,
  hasActiveQualityControlEquipmentProjectForFactory,
  isActiveStatus,
  ProposalApprovalGate,
  ProposalFactoryCountGate,
  ProposalFactoryMechanizationGate,
  ProposalSpaceGate,
  replaceProject,
  validateResumeRequest,
} from "./projectLifecycle";
import { MAX_FACTORIES_PER_COMPANY, wouldExceedMaxFactories } from "./factoryConstruction";
import type { FactoryLifecycleAdjustment } from "./factoryDisposal";
import { CapexDecisionInput, CapexQuarterResult, CapexRejectedProposal, CapexValidationError, CapitalProject, CompanyCapexState } from "./types";

export interface CloseQuarterWithCapexInput {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly prevFinanceState: CompanyFinanceState;
  readonly actuals: CompanyQuarterBusinessActuals;
  /** closeQuarterWithFinancing（Phase 8B-1）が確定させた、資金繰り確定後・設備投資前の最終財務結果。 */
  readonly financeResultBeforeCapex: CompanyFinancialQuarterResult;
  /** 同じ呼び出しが返したFinancingQuarterResult（利息・元本・借入残高の再構成に使う。再計算はしない）。 */
  readonly financingQuarterResult: FinancingQuarterResult;
  /** 当四半期開始時点の未払利息残高（prevFinancingState.accruedInterestPayableUsd）。 */
  readonly beginningAccruedInterestPayableUsd: number;
  readonly prevCapexState: CompanyCapexState;
  readonly decision: CapexDecisionInput;
  readonly approvalGate: ProposalApprovalGate;
  /**
   * 【Phase 8D-3】当四半期の新規承認に使える工場スペース枠（全工場合計）。
   * 省略時はスペース判定を行わない（Phase 8D以前の呼び出し元・既存テストとの後方互換）。
   * 【複数工場CAPEX Targeting修正】factorySpaceBudgetByFactoryが渡された場合は
   * そちらが優先される（Factory単位の判定）。この会社合算値は、
   * factorySpaceBudgetByFactoryを渡さない・単一工場企業の呼び出し元向けの
   * 後方互換パスとしてのみ使う。
   */
  readonly factorySpaceBudget?: FactorySpaceApprovalBudget;
  /**
   * 【複数工場CAPEX Targeting修正・§10】Factoryごとの新規承認スペース枠
   * （factoryId → 枠）。渡された場合、各提案は
   * targetFactoryId（未設定ならprimaryFactoryId）に対応する枠だけを消費する
   * （会社全体の合算では判定しない）。省略時はfactorySpaceBudget（会社合算）に
   * フォールバックする。
   */
  readonly factorySpaceBudgetByFactory?: ReadonlyMap<string, FactorySpaceApprovalBudget>;
  /**
   * 【複数工場CAPEX Targeting修正】targetFactoryId未指定の提案が既定で対象とする
   * Factory（＝主工場、factories先頭）。factorySpaceBudgetByFactoryを渡す場合は
   * 必ず一緒に渡すこと（省略時はtargetFactoryId未指定の提案のスペース判定を
   * 行わない＝無条件で通ってしまう）。
   */
  readonly primaryFactoryId?: string;
  /** スペース係数（省略時は FACTORY_SPACE_PARAMETERS_V1）。 */
  readonly factorySpaceParams?: FactorySpaceParameters;
  /**
   * 【ENG-FAC-1】Factory lifecycle（Mothball / Sale）の会計効果。
   * 算出はcapex/factoryDisposal.tsのcomputeFactoryLifecycleAccountingが行い、
   * ここでは受け取ってcloseFinancialQuarterへ素通しするだけ（再計算しない）。
   * 省略時は本機能の導入前と完全に同一の挙動になる。
   */
  readonly factoryLifecycleAdjustment?: FactoryLifecycleAdjustment;
  /**
   * 【ENG-FAC-1】**当四半期の期首より前に**売却完了して会社BSから除却済みの
   * Capital Project ID集合。既存資産の減価償却ベース復元
   * （nonDepreciatingCapexGrossAtPeriodStartUsd）から除外する。
   * 当四半期に売却完了する分はまだ期首BSに載っているため、ここには含めない。
   */
  readonly capexProjectIdsDerecognizedBeforePeriod?: ReadonlySet<string>;
  /**
   * 【ENG-FAC-1】**当四半期時点で**売却完了（SOLD）した工場へ帰属する
   * Capital Project ID集合。当四半期の減価償却・固定保守費から除外する
   * （実装指示§12「SOLD: depreciationなし」）。
   */
  readonly capexProjectIdsDerecognizedAsOfPeriod?: ReadonlySet<string>;
  /**
   * 【Test15新設】この会社の既存（静的fixture由来）工場数。newFactoryConstruction
   * 提案の1社あたり工場数上限（capex/factoryConstruction.tsのMAX_FACTORIES_PER_COMPANY）
   * 判定に使う。省略時は0扱い（Phase 8D以前の呼び出し元・既存テストとの後方互換。
   * ただし省略するとnewFactoryConstructionを提案しても既存工場ぶんが数えられず
   * 上限判定が甘くなるため、新工場建設を扱う呼び出し元は必ず渡すこと）。
   */
  readonly existingFactoryCount?: number;
  /**
   * 【ENG-FAC-1・実装指示§13】売却完了(SOLD)によって解放された工場スロットの内訳。
   * capex/factoryConstruction.tsのcomputeFactorySlotReleaseが算出する。
   * 省略時は解放なし（本機能の導入前と同一の挙動）。SALE_PENDINGは売却完了まで
   * スロットを占有し続けるため、ここには現れない。
   */
  readonly factorySlotRelease?: { readonly soldBaselineFactoryCount: number; readonly soldNewFactoryIds: ReadonlySet<string> };
  /**
   * 【develop/v2統合・Phase2監査2-3】この会社の当四半期時点の実在Factory ID一覧
   * （稼働開始済み新設Factoryを含む、呼び出し元がcomputeEffectiveFactories基準で
   * 算出したもの）。pdMechanization提案のtargetFactoryIdが実在するかどうかの
   * 判定に使う。省略時はこの判定を行わない（既存呼び出し元・既存テストとの後方互換）。
   */
  readonly validFactoryIds?: readonly string[];
}

export interface CloseQuarterWithCapexOutput {
  readonly financeResult: CompanyFinancialQuarterResult;
  readonly nextFinanceState: CompanyFinanceState;
  readonly nextCapexState: CompanyCapexState;
  readonly capexQuarterResult: CapexQuarterResult;
}

function totalActiveProjects(projects: readonly CapitalProject[]): number {
  return projects.filter((p) => isActiveStatus(p.status)).length;
}

/**
 * 1社・1四半期ぶんの設備投資処理（提案評価・取消/再開・支払配分）と、
 * finance/への三段目closeFinancialQuarter呼び出しをまとめて行う。
 */
export function closeQuarterWithCapex(
  input: CloseQuarterWithCapexInput,
  financeParams: FinanceParameters,
  params: CapexParameters,
  processingRateByProduct: Readonly<Record<Product, number>>
): CloseQuarterWithCapexOutput {
  const { companyId, period, prevCapexState, decision } = input;
  if (prevCapexState.companyId !== companyId) {
    throw new CapexValidationError(`設備投資状態と当期の会社IDが一致しません: ${prevCapexState.companyId} vs ${companyId}`);
  }
  if (decision.companyId !== companyId) {
    throw new CapexValidationError(`設備投資の意思決定と当期の会社IDが一致しません: ${decision.companyId} vs ${companyId}`);
  }

  // --- 1. 取消要求の適用 ---
  let projects: CapitalProject[] = [...prevCapexState.portfolio.projects];
  for (const cancel of decision.cancelRequests) {
    projects = applyCancelRequest(projects, cancel, period);
  }

  // --- 2. 再開要求の検証（statusは変更しない。対象IDだけ収集する） ---
  const resumeProjectIds = new Set<string>();
  for (const resume of decision.resumeRequests) {
    validateResumeRequest(projects, resume);
    resumeProjectIds.add(resume.projectId);
  }

  // --- 3. 新規提案の評価（承認/拒否。同時進行中案件数の上限は提案を処理するたびに再評価する） ---
  // 【Phase 8D-3】工場スペースの残枠も、承認するたびに減らしながら評価する。
  // これにより、同一四半期に複数案件を提案した場合でもスペースが二重に使われない。
  //
  // 【Phase 8D監査L-1・安全側の仕様（意図的、修正不要）】input.factorySpaceBudgetは
  // 呼び出し元（companyLab/runner.ts）が当四半期のこの関数呼び出しより前の
  // 状態から算出して渡す値であり、直前のステップ1（取消要求の適用）で当四半期に
  // 取り消した案件のスペースは、このremainingSpaceUnitsにはまだ反映されていない。
  // つまり「同一四半期に取り消した案件のスペースは、同じ四半期の新規案件承認には
  // 再利用できず、翌四半期から解放される」。過剰承認を避ける安全側の挙動であり、
  // 意図した仕様である。
  const spaceParams = input.factorySpaceParams ?? FACTORY_SPACE_PARAMETERS_V1;
  // 【複数工場CAPEX Targeting修正】factorySpaceBudgetByFactoryが渡されていれば
  // Factoryごとに残枠を追跡する（承認するたびにその対象Factoryの枠だけを減らす）。
  // 渡されていなければ、従来どおり会社合算の単一枠にフォールバックする。
  const remainingSpaceUnitsByFactory = new Map<string, number>(
    input.factorySpaceBudgetByFactory ? [...input.factorySpaceBudgetByFactory].map(([factoryId, budget]) => [factoryId, budget.remainingSpaceUnits]) : []
  );
  let remainingSpaceUnits = input.factorySpaceBudget?.remainingSpaceUnits ?? 0;
  const existingFactoryCount = input.existingFactoryCount ?? 0;
  const rejectedProposals: CapexRejectedProposal[] = [];
  let nextProjectSequence = prevCapexState.nextProjectSequence;
  decision.newProjectProposals.forEach((proposal, index) => {
    const activeCount = totalActiveProjects(projects);
    const projectId = `${companyId}-CAPEX-${nextProjectSequence}`;
    const requiredSpaceUnits = computeCandidateProjectSpaceUnits(proposal.projectType, params, spaceParams);
    const resolvedFactoryId = proposal.targetFactoryId ?? input.primaryFactoryId;
    const perFactoryBudget = resolvedFactoryId !== undefined ? input.factorySpaceBudgetByFactory?.get(resolvedFactoryId) : undefined;
    const spaceGate: ProposalSpaceGate | undefined =
      perFactoryBudget !== undefined
        ? {
            requiredSpaceUnits,
            remainingSpaceUnits: remainingSpaceUnitsByFactory.get(resolvedFactoryId!) ?? 0,
            totalSpaceUnits: perFactoryBudget.totalSpaceUnits,
            epsilonSpaceUnits: spaceParams.epsilonSpaceUnits,
          }
        : input.factorySpaceBudget !== undefined
          ? {
              requiredSpaceUnits,
              remainingSpaceUnits,
              totalSpaceUnits: input.factorySpaceBudget.totalSpaceUnits,
              epsilonSpaceUnits: spaceParams.epsilonSpaceUnits,
            }
          : undefined;
    // 【Test15新設】newFactoryConstruction提案のみ、1社あたり工場数上限を判定する。
    // projectsは同一四半期内の直前までの承認をすでに反映済みのため（`projects = [...projects, outcome.approved]`で
    // 逐次更新）、同じ四半期に複数のnewFactoryConstructionを提案しても正しく積み上がる。
    const factoryCountGate: ProposalFactoryCountGate | undefined =
      proposal.projectType === "newFactoryConstruction"
        ? {
            wouldExceedMax: wouldExceedMaxFactories(existingFactoryCount, projects, input.factorySlotRelease),
            maxFactoriesPerCompany: MAX_FACTORIES_PER_COMPANY,
          }
        : undefined;
    // 【Test15新設、複数工場CAPEX Targeting修正で全案件種別のtargetFactoryExists判定へ拡張】
    // hasActiveProjectForSameFactory（同一Factoryへの重複進行）はpdMechanization固有の
    // ルールのままだが、targetFactoryExists（存在しないFactoryへの投資を拒否する）は
    // targetFactoryIdを持つ提案であれば種別を問わず判定する。
    // projectsは同一四半期内の直前までの承認をすでに反映済みのため、同じ四半期に
    // 同じFactoryへ2件提案しても2件目は正しく拒否される。
    // 【QI-I1最終化】qualityControlEquipmentはtargetFactoryId省略時に主工場
    // （input.primaryFactoryId）を暗黙の対象とする既存規約があるため、重複投資判定は
    // resolvedFactoryId（targetFactoryId ?? primaryFactoryId）基準で行う。pdMechanization
    // はtargetFactoryIdが必須のため、この一般化による挙動変化はない。
    const mechanizationGate: ProposalFactoryMechanizationGate | undefined =
      resolvedFactoryId !== undefined
        ? {
            hasActiveProjectForSameFactory:
              proposal.projectType === "pdMechanization"
                ? hasActivePdMechanizationProjectForFactory(projects, resolvedFactoryId)
                : proposal.projectType === "qualityControlEquipment"
                  ? hasActiveQualityControlEquipmentProjectForFactory(projects, resolvedFactoryId, input.primaryFactoryId)
                  : false,
            // 【develop/v2統合・Phase2監査2-3】validFactoryIdsが渡されている場合だけ判定する
            // （省略時はundefinedのまま＝評価しない。既存呼び出し元との後方互換）。
            ...(input.validFactoryIds !== undefined && proposal.targetFactoryId !== undefined
              ? { targetFactoryExists: input.validFactoryIds.includes(proposal.targetFactoryId) }
              : {}),
          }
        : undefined;
    const outcome = evaluateProposal(
      companyId,
      proposal,
      activeCount,
      input.approvalGate,
      params,
      period,
      projectId,
      index + 1,
      spaceGate,
      factoryCountGate,
      mechanizationGate
    );
    if ("approved" in outcome) {
      projects = [...projects, outcome.approved];
      nextProjectSequence += 1;
      if (perFactoryBudget !== undefined && resolvedFactoryId !== undefined) {
        remainingSpaceUnitsByFactory.set(resolvedFactoryId, (remainingSpaceUnitsByFactory.get(resolvedFactoryId) ?? 0) - requiredSpaceUnits);
      } else {
        remainingSpaceUnits -= requiredSpaceUnits;
      }
    } else {
      rejectedProposals.push(outcome.rejected);
    }
  });

  // --- 4. 設備投資可能額（実装指示§14） ---
  const preCapexCashUsd = input.financeResultBeforeCapex.balanceSheet.cash as number;
  const cashAvailableForCapexUsd = Math.max(0, preCapexCashUsd - params.minimumCashReserveUsd);

  // --- 5. 支払優先順位付け → 全額支払のみの分割払い試行 ---
  const queue = buildPaymentQueue(projects, resumeProjectIds);
  let remainingCashUsd = cashAvailableForCapexUsd;
  let totalPaidThisQuarterUsd = 0;
  let completedProjectsTransferUsd = 0;
  const events = queue.map((project) => {
    const attempt = attemptPayment(project, remainingCashUsd, period, params);
    remainingCashUsd -= attempt.cashSpentUsd;
    totalPaidThisQuarterUsd += attempt.cashSpentUsd;
    completedProjectsTransferUsd += attempt.completedTransferUsd;
    projects = replaceProject(projects, attempt.updatedProject);
    return attempt.event;
  });

  // --- 6. 期末建設中勘定・非減価償却対象額 ---
  const endingConstructionInProgressUsd = projects.filter((p) => isActiveStatus(p.status)).reduce((s, p) => s + p.cumulativePaidUsd, 0);
  // 【ENG-FAC-1】過去の四半期に売却完了して会社BSから除却済みの資産は、この復元式から
  // 除外する（除外しないと、既に存在しない資産ぶんだけ既存資産の償却ベースが目減りする）。
  const derecognizedBeforePeriod = input.capexProjectIdsDerecognizedBeforePeriod;
  const nonDepreciatingCapexGrossAtPeriodStartUsd = prevCapexState.portfolio.projects
    .filter((p) => p.status === "completed")
    .filter((p) => !(derecognizedBeforePeriod?.has(p.projectId) ?? false))
    .reduce((s, p) => s + (p.capitalizedAmountUsd ?? 0), 0);
  // 【ENG-FAC-1】売却完了した工場へ帰属する資産は、当四半期から減価償却・固定保守費の
  // 対象外になる。
  const derecognizedAsOfPeriod = input.capexProjectIdsDerecognizedAsOfPeriod;
  const projectsStillOwned = derecognizedAsOfPeriod ? projects.filter((p) => !derecognizedAsOfPeriod.has(p.projectId)) : projects;

  // --- 6.5. 【Phase 8B-2B、Phase 8B-2Cでコンポーネント別に変更】当期の新規capex
  //          資産の建物・機械別減価償却費・固定保守費 ---
  // 当四半期に完成した案件はoperationalStartPeriodが必ず翌四半期以降になるため
  // （completedPeriodの翌四半期＋readiness）、支払処理後のprojects（=completed
  // 判定済み）を使っても、当期完成分がここで誤って計上されることはない。
  const capexDepreciation = computeCapexComponentDepreciationUsd(projectsStillOwned, params, period);
  const capexAssetsDepreciationUsd = capexDepreciation.totalUsd;
  const capexAssetsBuildingDepreciationUsd = capexDepreciation.buildingUsd;
  const capexAssetsMachineryDepreciationUsd = capexDepreciation.machineryUsd;
  const capexMaintenanceCostUsd = computeCapexMaintenanceCostUsd(projectsStillOwned, params, period);

  const capexAdjustment: CapexAdjustment = {
    capexPaymentCashUsd: totalPaidThisQuarterUsd,
    completedProjectsTransferUsd,
    endingConstructionInProgressUsd,
    nonDepreciatingCapexGrossAtPeriodStartUsd,
    capexAssetsDepreciationUsd,
    capexAssetsBuildingDepreciationUsd,
    capexAssetsMachineryDepreciationUsd,
    capexMaintenanceCostUsd,
  };

  // --- 7. financing側の数値を再構成（再計算しない。公開フィールドから組み立てるだけ） ---
  const fr = input.financingQuarterResult;
  const reconstructedFinancing: FinancingAdjustment = {
    interestExpenseUsd: fr.interestAccrualUsd,
    interestPaidCashUsd: fr.interestPaidCashUsd,
    loanDrawUsd: fr.loanDrawUsd,
    principalRepaymentCashUsd: fr.principalPaidCashUsd,
    endingShortTermLoansUsd: fr.endingShortTermLoansUsd,
    endingLongTermLoansUsd: fr.endingLongTermLoansUsd,
    beginningAccruedInterestPayableUsd: input.beginningAccruedInterestPayableUsd,
  };

  // --- 8. 三段目のclosefinancialQuarter呼び出し（最終PL/BS/CF） ---
  const passThree = closeFinancialQuarter(
    input.prevFinanceState,
    input.actuals,
    financeParams,
    processingRateByProduct,
    reconstructedFinancing,
    capexAdjustment,
    input.factoryLifecycleAdjustment
  );

  const nextCapexState: CompanyCapexState = {
    companyId,
    portfolio: { companyId, projects },
    nextProjectSequence,
  };

  const capexQuarterResult: CapexQuarterResult = {
    companyId,
    period,
    rejectedProposals,
    events,
    cashAvailableForCapexUsd,
    totalPaidThisQuarterUsd,
    completedProjectsTransferUsd,
    endingConstructionInProgressUsd,
    nonDepreciatingCapexGrossAtPeriodStartUsd,
    capexAssetsDepreciationUsd,
    capexAssetsBuildingDepreciationUsd,
    capexAssetsMachineryDepreciationUsd,
    capexMaintenanceCostUsd,
  };

  return {
    financeResult: passThree.result,
    nextFinanceState: passThree.nextState,
    nextCapexState,
    capexQuarterResult,
  };
}

/** 会社の新規設備投資状態（案件なし）。companyLab/runner.tsの初期化から使う。 */
export function buildInitialCompanyCapexState(companyId: CompanyId): CompanyCapexState {
  return {
    companyId,
    portfolio: { companyId, projects: [] },
    nextProjectSequence: 1,
  };
}
