// ShrimpX V2 — Phase SAI-GROW-3B-3: Deliverable Commitment / Backlog Discipline
//
// 【解決する構造】DS3 MASSで新規提出・成約が納品可能量を継続的に上回り、
// backlogが131〜154kt（代表seedでは231kt級）まで積み上がる。
//
// 【この層が分離するもの】
//   Strategic Growth Opportunity ≠ Commercial Ambition ≠ Immediate Deliverable Commitment
// 将来100kt売れる機会があっても、近い将来60ktしか納品できない会社が、
// 既存backlogを抱えたまま100ktの新規確定受注を積み増すことはしない。
// **Commercial Ambition（志）は一切下げない**。下げるのは「今期の提出量」だけであり、
// capが効いたことは「成長機会が無い」ではなく「何に投資すべきか」のsignalとして出す（§9）。
//
// 【新しいeconomic modelを作らない】使う値はすべて既存のもの:
//   ・完成品在庫            observation.finishedGoodsByProduct
//   ・実効生産能力          bindingCapacity.ts::computeBindingProductionCapacityTons
//   ・納期時点の実効能力    observation.nearTermEffectiveCapacityByProduct
//                          （observation.tsが computeEffectiveFactories を納期の四半期で
//                            呼んだ結果。承認済みCapitalProjectの完成・ramp・新設Factory
//                            稼働開始の判定はすべて既存関数のまま。未承認案件・Visionは
//                            capexState.portfolioに存在しないため構造的に入らない）
//   ・資金手当て可能な原料  fundableOperations.ts::computeFundableRawMaterial（3B-2と同一式）
//   ・受注残の内訳          observation.overdue / healthyForwardBacklogByProduct
//                          （sales/backlog.ts と同じ「dueDate < currentPeriod」規約）
//   ・納期                  observation.deliveryLeadTimeQuarters
//                          （sales/parameters.ts の standardLeadTimeTurns。現行1四半期。
//                            「4Q固定」のような独自horizonを持ち込まない）

import { ProductAmount, sumProductAmount } from "../types";

const EPSILON = 1e-6;

/** 納品可能量を実際に縛った要因（§9 Constraint Routing。次に何へ投資すべきかを示す）。 */
export type DeliverabilityConstraint =
  | "NONE"
  | "PRODUCTION" // 生産能力が足りない → Production CAPEX へ
  | "RAW_MATERIAL" // 資金手当てできる原料が足りない → 調達拡大・運転資金へ
  | "BACKLOG" // 既存受注残が納品能力を食っている → まず捌く
  | "LIQUIDITY"; // 原料不足の原因が資金である → 資金調達へ

export interface DeliverableCommitmentInput {
  /** Crisis Gate適用前のCommercial Commitment提出目標量。 */
  readonly commitmentBeforeDeliverabilityTons: number;
  /** 今期の期待転換率（提出→成約）。commercialCommitment.tsが出した値をそのまま使う。 */
  readonly expectedConversionRatio: number;
  readonly finishedGoodsByProduct: ProductAmount;
  /** 当期の実効生産能力（binding。商品別ライン合計と共通前処理のmin）。 */
  readonly bindingProductionCapacityTons: number;
  /** 納期到来時点の実効生産能力（承認済みCAPEXの完成・ramp反映済み）。 */
  readonly nearTermBindingProductionCapacityTons: number;
  /** 3B-2と同一式で求めた、資金手当てできる原料量（在庫ポジション込み）。 */
  readonly fundableRawMaterialTons: number;
  readonly overdueBacklogByProduct: ProductAmount;
  readonly healthyForwardBacklogByProduct: ProductAmount;
  /** 資金が原料不足の原因かどうか（LIQUIDITY routingの判定に使う）。 */
  readonly rawMaterialLimitedByFunding: boolean;
  /**
   * 納期までの四半期数（sales/parameters.ts の standardLeadTimeTurns。現行1）。
   * 「受注残が納品能力の何四半期分あれば正常か」の基準にそのまま使う。
   * リードタイム1四半期のゲームでは、常に約1四半期分の受注残が存在するのが正常であり、
   * それを超えた分だけが「納品できないのに積み増した分」である。
   */
  readonly deliveryLeadTimeQuarters: number;
  /**
   * 過剰受注時でも市場から退出しないための最低提出比率。
   * 新しい定数を作らず、parameters.ts の minDomesticPurchaseRatioOfBase
   * （＝「どんなときでも基準活動のこの割合は確保する」という既存の最低確保比）を
   * そのまま流用する。
   */
  readonly minimumMarketPresenceRatio: number;
}

export interface DeliverableCommitmentState {
  readonly commitmentBeforeDeliverabilityTons: number;
  readonly deliverableCapacityCurrentTons: number;
  readonly deliverableCapacityNearTermTons: number;
  readonly existingBacklogTons: number;
  readonly healthyForwardBacklogTons: number;
  readonly overdueBacklogTons: number;
  /** 既存backlogを今期の納品能力で捌ききれず、納期の四半期へ持ち越す量。 */
  readonly carryOverBacklogTons: number;
  /** 納品能力比で見て「正常」とみなす受注残（納品能力 × リードタイム四半期数）。 */
  readonly normalBacklogAllowanceTons: number;
  /** 正常水準を超えた受注残（overdueは全額がここに入る）。新規受注の余力を食う分。 */
  readonly excessBacklogTons: number;
  /** 自社能力比で見た受注残の消化期間（四半期）。会社規模に依存しない尺度。 */
  readonly backlogDeliveryHorizonQuarters: number;
  /** 新規受注に使える納品余力。 */
  readonly remainingDeliverableHeadroomTons: number;
  /** 提出量ベースのcap（＝納品余力 ÷ 期待転換率）。 */
  readonly deliverabilityCapTons: number;
  readonly finalSubmissionTargetTons: number;
  readonly incrementalSubmissionReductionTons: number;
  readonly bindingDeliverabilityConstraint: DeliverabilityConstraint;
  readonly applied: boolean;
}

/**
 * 【§2 Deliverable Capacity SSoT / §3 Existing Backlog / §6 Commitment Cap】
 *
 * Current Deliverable Capacity  = 完成品在庫 + min(当期の実効生産能力, 資金手当て可能原料)
 * NearTerm Deliverable Capacity = min(納期時点の実効生産能力, 資金手当て可能原料)
 *   ※ 納期時点の能力には承認済みCAPEXの完成・rampが入る（未承認・Visionは入らない）。
 *   ※ 能力があっても資金手当てできる原料が無ければ全量は入れない（§8）。
 *
 * carryOverBacklog                = max(0, 既存受注残 − Current Deliverable Capacity)
 * RemainingDeliverableHeadroom    = max(0, NearTerm Deliverable Capacity − carryOverBacklog)
 *
 * 【§6 二重にconversionを掛けない】commercialCommitment.tsのsubmissionTargetTonsは
 * **提出量**（＝成約見込み ÷ 期待転換率）である。納品余力は**成約量**の制約なので、
 * 提出量の上限へ直すために期待転換率で割り戻す。ここでconversionを掛ける（＝二重に割る）
 * ことはしない。
 */
export function computeDeliverableCommitment(input: DeliverableCommitmentInput): DeliverableCommitmentState {
  const finishedGoodsTons = sumProductAmount(input.finishedGoodsByProduct);
  const overdueBacklogTons = sumProductAmount(input.overdueBacklogByProduct);
  const healthyForwardBacklogTons = sumProductAmount(input.healthyForwardBacklogByProduct);
  const existingBacklogTons = overdueBacklogTons + healthyForwardBacklogTons;

  const fundableRawMaterialTons = Math.max(0, input.fundableRawMaterialTons);
  const currentProductionDeliverableTons = Math.min(Math.max(0, input.bindingProductionCapacityTons), fundableRawMaterialTons);
  const deliverableCapacityCurrentTons = finishedGoodsTons + currentProductionDeliverableTons;
  // 【§8 raw material の扱い・実測による訂正】
  // 当初 nearTerm も min(能力, 当期の資金手当て可能原料) にしていたが、これは誤りだった。
  // 今期成約した契約の納期は**翌四半期**であり、その原料は翌四半期の資金
  // （今期の売掛回収を含む）で買う。今期の現金だけで翌期の納品可能量を打ち切ると、
  // 資金繰りサイクルの谷にいる健全な会社の提出量が壊滅的に縮む
  // （実測: 健全なJPQのT1で提出18,667t → 2,778t、既存回帰テスト21件が落ちた）。
  //
  // 原料資金の制約は「当期」の概念であり、下の deliverableCapacityCurrentTons に
  // 既に入っている。原料を買えない会社は当期の納品能力が落ち、その結果
  // carryOverBacklog が膨らんで headroom が縮む——という**正しい経路**で効く。
  // 二重に当期の資金制約を翌期へ適用しない。
  const deliverableCapacityNearTermTons = Math.max(0, input.nearTermBindingProductionCapacityTons);

  // 【§5 BacklogDeliveryHorizon】固定の「◯kt以上」ではなく、自社の持続的な納品能力比で測る。
  // 100kt企業の30ktと10kt企業の30ktを同じ危険度にしないための、規模非依存の尺度。
  const sustainableDeliverableTons = Math.max(deliverableCapacityNearTermTons, currentProductionDeliverableTons);
  const backlogDeliveryHorizonQuarters =
    sustainableDeliverableTons > EPSILON ? existingBacklogTons / sustainableDeliverableTons : existingBacklogTons > EPSILON ? Infinity : 0;

  // 【§3・§4・§5】新規受注の余力を食うのは「正常な水準を超えた受注残」だけである。
  //
  // リードタイム1四半期のゲームでは、今期成約した契約は翌期が納期になるため、
  // **常に約1四半期分の受注残が存在するのが正常**であり、これがHealthy Forward Backlog。
  // したがって「納品能力 × リードタイム四半期数」を正常水準とし、それを超えた分
  // （excessBacklog）だけを新規受注の余力から差し引く。
  // 固定の「◯kt以上」ではなく自社の納品能力比なので、100kt企業の30ktと
  // 10kt企業の30ktが同じ扱いにならない（§5）。
  //
  // 納期超過（overdue）は「正常水準」の枠を消費しない＝全額がexcessとして効く
  // ため、healthy forwardより強く新規受注を抑える（§4）。
  // 【overdueを無条件に差し引かない・実測による訂正】当初 excess = max(0, healthyForward −
  // allowance) + overdue としていたが、これは受注残総量が正常水準を大きく下回る会社
  // （backlog delivery horizon 0.6〜0.7四半期）にも overdue の全額を課してしまい、
  // JPQ / CONSV / VAP の生産が17〜22%落ち、Commercial Ambitionまで縮んだ（実測・DS3 8seed）。
  // overdueは「新規受注をより強く抑えるsignal」であって、それ自体が納品能力を
  // 消費するわけではない。§5の「自社能力比で判断する」に従い、overdueは
  // **正常水準の枠を削る**形で効かせる（overdueが大きいほど許容backlogが小さくなる）。
  const baseBacklogAllowanceTons = Math.max(0, sustainableDeliverableTons * Math.max(0, input.deliveryLeadTimeQuarters));
  const normalBacklogAllowanceTons = Math.max(0, baseBacklogAllowanceTons - overdueBacklogTons);
  const excessBacklogTons = Math.max(0, existingBacklogTons - normalBacklogAllowanceTons);
  // 診断用（今期の納品能力で捌けずに翌期へ回る量。routingの主因判定に使う）。
  const carryOverBacklogTons = Math.max(0, existingBacklogTons - deliverableCapacityCurrentTons);

  // 【§10・§16-D】過剰受注でも市場から退出しない下限。
  // 新しい定数は作らず、既存の最低確保比（minDomesticPurchaseRatioOfBase）を流用する。
  // これが無いと、能力が一時的に極端に落ちた会社の新規提出が0になり、
  // 「生産能力の不足が販売をゼロへ伝播する」既存の禁止事項（受入F-1）に抵触する。
  const marketPresenceFloorTons =
    deliverableCapacityNearTermTons * Math.max(0, Math.min(1, input.minimumMarketPresenceRatio));
  const remainingDeliverableHeadroomTons = Math.max(
    Math.max(0, deliverableCapacityNearTermTons - excessBacklogTons),
    marketPresenceFloorTons
  );

  // 【§6】提出量ベースへ戻す（conversionは1回だけ使う）。
  const conversion = Math.max(EPSILON, Math.min(1, input.expectedConversionRatio));
  const deliverabilityCapTons = remainingDeliverableHeadroomTons / conversion;

  const finalSubmissionTargetTons = Math.min(input.commitmentBeforeDeliverabilityTons, deliverabilityCapTons);
  const incrementalSubmissionReductionTons = Math.max(0, input.commitmentBeforeDeliverabilityTons - finalSubmissionTargetTons);
  const applied = incrementalSubmissionReductionTons > EPSILON;

  // 【§9 Constraint Routing】capが効いたときだけ、何が縛ったかをrouteする。
  // 「成長機会が無い」とは診断しない。優先順位は
  //   受注残が能力を食っている > 原料（資金起因ならLIQUIDITY） > 生産能力
  let bindingDeliverabilityConstraint: DeliverabilityConstraint = "NONE";
  if (applied) {
    if (excessBacklogTons > EPSILON) {
      bindingDeliverabilityConstraint = "BACKLOG";
    } else if (fundableRawMaterialTons < input.nearTermBindingProductionCapacityTons - EPSILON) {
      bindingDeliverabilityConstraint = input.rawMaterialLimitedByFunding ? "LIQUIDITY" : "RAW_MATERIAL";
    } else {
      bindingDeliverabilityConstraint = "PRODUCTION";
    }
  }

  return {
    commitmentBeforeDeliverabilityTons: input.commitmentBeforeDeliverabilityTons,
    deliverableCapacityCurrentTons,
    deliverableCapacityNearTermTons,
    existingBacklogTons,
    healthyForwardBacklogTons,
    overdueBacklogTons,
    carryOverBacklogTons,
    normalBacklogAllowanceTons,
    excessBacklogTons,
    backlogDeliveryHorizonQuarters,
    remainingDeliverableHeadroomTons,
    deliverabilityCapTons,
    finalSubmissionTargetTons,
    incrementalSubmissionReductionTons,
    bindingDeliverabilityConstraint,
    applied,
  };
}
