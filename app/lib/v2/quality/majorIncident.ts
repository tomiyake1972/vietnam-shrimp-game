// ShrimpX V2 — 品質・顧客信頼・納期信頼性モジュール 重大品質事故（Phase 7A）
//
// 大きな品質事故だけをシード付き乱数で発生させる（期待される品質悪化自体は
// operationalRisk.ts/qualityOutcome.tsで決定論的に計算する）。重大事故用の
// 乱数は、市場価格・イベント・会社方針が消費する乱数ストリームとは完全に
// 独立させる。会社・工場・商品ごとに、その組み合わせだけから決定論的に
// 導出したシード文字列で新しいRandomStreamを都度生成するため、
//   - 同じシード・同じ意思決定なら事故結果まで完全一致する
//   - 会社・工場・商品の入力順を変えても結果が変わらない（各組み合わせが
//     独立したストリームを持ち、他の組み合わせの消費順に影響されない）
// という2つの受入条件を構造的に満たす。

import { createRandomStream } from "../core/random";
import { Product } from "../market/types";
import { QualityParameters, QUALITY_PARAMETERS_V1 } from "./parameters";
import { MajorIncidentDraw } from "./types";

/**
 * 重大事故判定用の独立シード文字列を導出する。
 * 例: `{gameSeed}::quality::turn{turn}::company{companyId}::factory{factoryId}::product{product}`
 * 市場価格用のシード（`${seed}::${period}`、turn/runner.ts参照）や、シナリオ
 * イベント用のシードとは名前空間（`::quality::`）で明確に分離しているため、
 * 同じgameSeedを使っていても乱数列が交差しない。
 */
export function deriveQualityIncidentSeed(gameSeed: string, turn: number, companyId: string, factoryId: string, product: Product): string {
  return `${gameSeed}::quality::turn${turn}::company${companyId}::factory${factoryId}::product${product}`;
}

/** 総合操業リスクから重大事故の発生確率を算出する。 */
export function calculateMajorIncidentProbability(operationalRisk: number, params: QualityParameters = QUALITY_PARAMETERS_V1): number {
  const { baseIncidentProbability, maximumRiskIncidentProbability, riskExponent, maximumIncidentProbability } = params.majorIncident;
  const risk = Math.min(1, Math.max(0, operationalRisk));
  const raw = baseIncidentProbability + maximumRiskIncidentProbability * Math.pow(risk, riskExponent);
  return Math.min(maximumIncidentProbability, Math.max(0, raw));
}

/**
 * 独立乱数ストリームで重大事故の発生・重大度を判定する。1呼び出しにつき
 * 「発生判定」「重大度」の2回を必ずこの順で消費する（呼び出しごとに新しい
 * RandomStreamをシードから生成するため、他の判定の消費順には一切影響しない）。
 */
export function drawMajorIncident(seed: string, probability: number): MajorIncidentDraw {
  const stream = createRandomStream(seed);
  const occurred = stream.chance(probability);
  // 重大度用の乱数は、発生しなかった場合でも必ず1回消費する（消費順序を
  // occurredの結果に依存させないため。結果への影響はseverity=0で無効化する）。
  const severityRoll = stream.next();
  const severity = occurred ? severityRoll : 0;
  return { occurred, severity, probability, seed };
}
