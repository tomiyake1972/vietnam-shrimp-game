// ShrimpX V2 — 5社の既定 Vision（創業者・経営者の「志」）
//
// 【この数値がどう決まったか：推測ではなく実測に基づく】
// scripts/visionBaselineCalibration.ts で現行 32Q baseline を実測した結果：
//
//   ・ベトナム5社が獲得対象にできる TRUE 需要   Q1 174,888 → Q32 266,642 t/四半期
//   ・5社の実際の合計成約                       Q1  57,628 → Q32  66,100 t/四半期
//     （＝需要の伸びは他産地へ流れており、5社のシェアは 33% → 25% へ低下している）
//   ・1社あたり成約                             11,000〜14,000 t/四半期
//   ・1社あたり設備能力（3品目計）              16,245〜19,109 t/四半期・工場は全社1
//   ・工場スペース残                            15,500〜16,650 units（既存工場内の増設余地は大きい）
//   ・Q32 現金 134M〜321M USD・負債はいずれも 0
//
// 【§4に基づく既定案の調整とその理由】
// 当初案（MASS 70,000 / BAL 60,000 / JPQ 50,000〜55,000 / CONSV 45,000〜50,000 /
// VAP 25,000〜35,000）は合計 250,000〜270,000 t/四半期であり、これは **Q32時点で
// ベトナム5社が獲得対象にできる需要の総量（266,642t）とほぼ同じ**、つまり
// 「5社が世界の対ベトナム需要を100%取り切る」ことを全社が同時に志す形になる。
// 志（aspiration）は達成義務ではないとはいえ、算術的に同時成立しえない目標は
// strategic gap を全社で恒常的に最大へ張り付かせ、Vision間の差が判断へ出なくなる。
//
// そこで**当初案の会社間の比率（70 : 60 : 52.5 : 47.5 : 30）をそのまま保ったまま
// 全体を 4/7 へ縮尺**し、5社合計 148,000 t/四半期（Q32 TRUE需要の約55%、現在の
// 5社合計成約の約2.2倍）とした。会社ごとの性格・順位・志の強弱は当初案のままである。
// この水準でも、たとえば MASS は現在能力 19,109t に対し 40,000t を志すため、
// 既存工場内の増設だけでは届かず新工場の検討が必然的に発生する（＝今回の主題である
// 新工場判断が「起きるが自明ではない」水準になっている）。
//
// 【Vision は quota ではない】ここに書いた数値へゲーム結果を強制しない。
// 達成できないことはバグではない。Vision は strategic gap を測る物差しである。

import { CompanyVision, CompanyVisionDocument, COMPANY_VISION_SCHEMA_VERSION, VisionGrowthWaypoint } from "./types";

/**
 * 参考成長軌道の形。
 * 新工場は着工から稼働まで 3四半期の建設 ＋ 1四半期の立ち上げ ＋ 3四半期の ramp を
 * 要するため（capex/parameters.ts の既存値）、序盤はほぼ横ばい、中盤以降に立ち上がる
 * 凸型にしてある。**この形自体も参考であり、達成義務ではない。**
 */
function waypoints(q1: number, q8: number, q16: number, q24: number, q32: number): readonly VisionGrowthWaypoint[] {
  return [
    { turn: 1, scaleTonsPerQuarter: q1 },
    { turn: 8, scaleTonsPerQuarter: q8 },
    { turn: 16, scaleTonsPerQuarter: q16 },
    { turn: 24, scaleTonsPerQuarter: q24 },
    { turn: 32, scaleTonsPerQuarter: q32 },
  ];
}

const MASS_VISION: CompanyVision = {
  visionId: "MASS-vision-v1",
  effectiveFromTurn: 1,
  growthAmbition: "HIGH",
  targetScaleTonsPerQuarterAtQ32: 40000,
  preferredEndState: "LARGE_VOLUME",
  willingnessToBuildFactories: "HIGH",
  financialRiskTolerance: "HIGH",
  desiredProductEvolution: "HOSO_SCALE",
  referenceGrowthPath: waypoints(18000, 21000, 27000, 33500, 40000),
  longTermNarrative:
    "量で勝つ。HOSOを軸に生産量を積み上げ、ベトナム最大級の輸出量を持つ会社になる。工場を建てることを恐れず、借入も成長のための手段として使う。",
  emphasisProducts: ["hoso", "pd"],
};

const BAL_VISION: CompanyVision = {
  visionId: "BAL-vision-v1",
  effectiveFromTurn: 1,
  growthAmbition: "HIGH",
  targetScaleTonsPerQuarterAtQ32: 34000,
  preferredEndState: "LARGE_INTEGRATED",
  willingnessToBuildFactories: "HIGH",
  financialRiskTolerance: "MEDIUM",
  desiredProductEvolution: "INTEGRATED",
  referenceGrowthPath: waypoints(16000, 18500, 23000, 28500, 34000),
  longTermNarrative:
    "HOSO・PD・VAPのすべてを自社で扱える総合水産会社になる。規模も追うが、特定商品・特定市場に依存しない構成を保つ。財務は無理をしない範囲で攻める。",
  emphasisProducts: ["hoso", "pd", "vap"],
};

const JPQ_VISION: CompanyVision = {
  visionId: "JPQ-vision-v1",
  effectiveFromTurn: 1,
  growthAmbition: "HIGH",
  targetScaleTonsPerQuarterAtQ32: 30000,
  preferredEndState: "QUALITY_SCALE",
  willingnessToBuildFactories: "MEDIUM",
  financialRiskTolerance: "MEDIUM",
  desiredProductEvolution: "PD_SCALE",
  referenceGrowthPath: waypoints(16000, 18000, 21500, 25500, 30000),
  longTermNarrative:
    "品質を落とさずに大きくなる。日本市場で選ばれ続けるPDの品質を維持したまま規模を伸ばす。品質を守れないと判断すれば、規模の方を諦める。",
  emphasisProducts: ["pd"],
};

const CONSV_VISION: CompanyVision = {
  visionId: "CONSV-vision-v1",
  effectiveFromTurn: 1,
  growthAmbition: "MEDIUM",
  targetScaleTonsPerQuarterAtQ32: 27000,
  preferredEndState: "LARGE_INTEGRATED",
  willingnessToBuildFactories: "MEDIUM",
  financialRiskTolerance: "LOW",
  desiredProductEvolution: "INTEGRATED",
  referenceGrowthPath: waypoints(15000, 16500, 19500, 23000, 27000),
  longTermNarrative:
    "潰れない会社であり続けたうえで、着実に大きくなる。手元資金と負債水準に余裕があるときにだけ投資する。無理な成長で財務を痛めるくらいなら成長を遅らせる。",
  emphasisProducts: ["hoso", "pd"],
};

const VAP_VISION: CompanyVision = {
  visionId: "VAP-vision-v1",
  effectiveFromTurn: 1,
  growthAmbition: "LOW",
  targetScaleTonsPerQuarterAtQ32: 17000,
  preferredEndState: "VALUE_SPECIALIST",
  willingnessToBuildFactories: "LOW",
  financialRiskTolerance: "MEDIUM",
  desiredProductEvolution: "VAP_VALUE",
  referenceGrowthPath: waypoints(14000, 14500, 15500, 16300, 17000),
  longTermNarrative:
    "大きさでは勝たない。付加価値加工品で単価と利益率を取り、小さくても強い会社であり続ける。量を追うための工場は建てない。",
  emphasisProducts: ["vap"],
};

const VISION_DOCUMENTS: readonly CompanyVisionDocument[] = [
  { schemaVersion: COMPANY_VISION_SCHEMA_VERSION, companyId: "MASS", visions: [MASS_VISION] },
  { schemaVersion: COMPANY_VISION_SCHEMA_VERSION, companyId: "BAL", visions: [BAL_VISION] },
  { schemaVersion: COMPANY_VISION_SCHEMA_VERSION, companyId: "JPQ", visions: [JPQ_VISION] },
  { schemaVersion: COMPANY_VISION_SCHEMA_VERSION, companyId: "CONSV", visions: [CONSV_VISION] },
  { schemaVersion: COMPANY_VISION_SCHEMA_VERSION, companyId: "VAP", visions: [VAP_VISION] },
];

/** 会社ID → Vision履歴。将来のプレイヤー編集では、この既定を差し替えるだけで済む。 */
export const DEFAULT_COMPANY_VISION_DOCUMENTS: ReadonlyMap<string, CompanyVisionDocument> = new Map(
  VISION_DOCUMENTS.map((d) => [d.companyId, d])
);

/**
 * 会社の既定 Vision 履歴を返す。
 * 未知の会社IDに対しては**架空のVisionを作らない**（null を返し、呼び出し側が
 * 「Visionが与えられていない会社」として扱えるようにする）。
 */
export function defaultVisionDocumentFor(companyId: string): CompanyVisionDocument | null {
  return DEFAULT_COMPANY_VISION_DOCUMENTS.get(companyId) ?? null;
}
