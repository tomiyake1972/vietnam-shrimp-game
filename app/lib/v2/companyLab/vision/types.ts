// ShrimpX V2 — Company Vision（創業者・経営者の「志」）
//
// 【最重要の役割分担】
//   Vision        … 会社が「どんな会社になりたいか」。**外から与える**。
//   Standard AI   … その志のもとで、今期の合理的な判断を行う経営スタッフ。
//
// Standard AI が自分で「8年後に売上を2倍にしたい」と発明してはいけない。
// Vision は会社プロファイルとして与えられ、Standard AI はそこから生まれる
// 戦略ギャップに反応するだけである。
//
// 【Vision は hard quota ではない】
// 「Q32で70,000tだから必ず70,000t作る」という実装は禁止。Vision は
//   strategic pressure / aspiration / gap
// として働き、市況悪化・赤字・在庫過剰・資金不足なら成長投資を延期できる。
// 逆に好況なら前倒しできる。**達成できないことはバグではない。**
//
// 【将来のプレイヤー編集に備える】
// Vision は effectiveFromTurn を持つ履歴として保持する。
// 「Q1〜10 は高成長、Q11以降は保守的」といった変更を将来入れられるようにする。

import { Product } from "../../market/types";

export const COMPANY_VISION_SCHEMA_VERSION = "companyVision-v1";

/** 成長への意欲。数値判断に使う構造化フィールド。 */
export type GrowthAmbition = "HIGH" | "MEDIUM" | "LOW";

/** 目指す最終的な会社像。 */
export type PreferredEndState =
  /** 大規模・総合（HOSO/PD/VAPを幅広く持つ大手）。 */
  | "LARGE_INTEGRATED"
  /** 大規模・量産型。 */
  | "LARGE_VOLUME"
  /** 品質を保ったまま規模を追う。 */
  | "QUALITY_SCALE"
  /** 規模を追わず高付加価値で稼ぐ。 */
  | "VALUE_SPECIALIST"
  /** 小さくても高収益。 */
  | "COMPACT_PROFITABLE";

/** 工場を建てることへの前向きさ。 */
export type FactoryBuildWillingness = "HIGH" | "MEDIUM" | "LOW";

/** 財務リスク許容度。ただしこれが財務安全性を完全に無視することはない。 */
export type FinancialRiskTolerance = "HIGH" | "MEDIUM" | "LOW";

/** 商品構成の進化方向。 */
export type DesiredProductEvolution = "HOSO_SCALE" | "PD_SCALE" | "VAP_VALUE" | "INTEGRATED" | "SPECIALIST";

/**
 * 参考成長軌道の1点。
 *
 * 【TARGET ではなく REFERENCE PATH】ゲーム結果をこの数字へ強制しない。
 * 「Visionに対して今どのくらいの位置にいるか」を測るための物差しにすぎない。
 */
export interface VisionGrowthWaypoint {
  readonly turn: number;
  readonly scaleTonsPerQuarter: number;
}

/** 1つの Vision（ある時点から有効な会社の志）。 */
export interface CompanyVision {
  readonly visionId: string;
  /** このVisionが有効になるターン（1始まり）。 */
  readonly effectiveFromTurn: number;
  readonly growthAmbition: GrowthAmbition;
  /** Q32時点で目指す四半期あたり規模（HOSO換算トン/四半期）。aspiration であって quota ではない。 */
  readonly targetScaleTonsPerQuarterAtQ32: number;
  readonly preferredEndState: PreferredEndState;
  readonly willingnessToBuildFactories: FactoryBuildWillingness;
  readonly financialRiskTolerance: FinancialRiskTolerance;
  readonly desiredProductEvolution: DesiredProductEvolution;
  /** 参考成長軌道（決定論的。空なら開始規模とQ32目標の線形補間を使う）。 */
  readonly referenceGrowthPath: readonly VisionGrowthWaypoint[];
  /** 人間向けの説明。数値判断には一切使わない。 */
  readonly longTermNarrative: string;
  /** 重視する商品（人間向け・将来のR&D投資判断の受け皿。今回は数値判断に使わない）。 */
  readonly emphasisProducts: readonly Product[];
}

/** 1社ぶんの Vision 履歴（将来のプレイヤー編集に備える）。 */
export interface CompanyVisionDocument {
  readonly schemaVersion: string;
  readonly companyId: string;
  /** effectiveFromTurn 昇順。少なくとも1件（turn 1 から有効なもの）を持つ。 */
  readonly visions: readonly CompanyVision[];
}

/**
 * 指定ターンで有効な Vision を返す。
 * 「そのターン以前に有効化された中で最も新しいもの」を選ぶ（未来のVisionは使わない）。
 */
export function resolveVisionAtTurn(document: CompanyVisionDocument, turn: number): CompanyVision | null {
  let resolved: CompanyVision | null = null;
  for (const vision of document.visions) {
    if (vision.effectiveFromTurn <= turn && (resolved === null || vision.effectiveFromTurn > resolved.effectiveFromTurn)) {
      resolved = vision;
    }
  }
  return resolved;
}

/**
 * 参考成長軌道のうち、指定ターンで参照すべき規模。
 *
 * waypoint が定義されていればその間を線形補間し、無ければ
 * 「開始規模 → Q32目標」の線形補間にフォールバックする。
 * **どちらの場合も参考値であり、達成義務ではない。**
 */
export function referenceScaleAtTurn(vision: CompanyVision, turn: number, startingScaleTonsPerQuarter: number, horizonTurn = 32): number {
  const path = [...vision.referenceGrowthPath].sort((a, b) => a.turn - b.turn);
  if (path.length === 0) {
    const progress = Math.min(1, Math.max(0, (turn - 1) / Math.max(1, horizonTurn - 1)));
    return startingScaleTonsPerQuarter + (vision.targetScaleTonsPerQuarterAtQ32 - startingScaleTonsPerQuarter) * progress;
  }
  if (turn <= path[0].turn) return path[0].scaleTonsPerQuarter;
  const last = path[path.length - 1];
  if (turn >= last.turn) return last.scaleTonsPerQuarter;
  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1];
    const next = path[i];
    if (turn <= next.turn) {
      const span = next.turn - prev.turn;
      const ratio = span <= 0 ? 0 : (turn - prev.turn) / span;
      return prev.scaleTonsPerQuarter + (next.scaleTonsPerQuarter - prev.scaleTonsPerQuarter) * ratio;
    }
  }
  return last.scaleTonsPerQuarter;
}
