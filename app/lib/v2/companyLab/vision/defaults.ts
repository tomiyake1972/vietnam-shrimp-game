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
//
// 【2026-08・MASS Vision Calibration（ChatGPT #05指示）】32Qベンチマークで、
// 現行の工場能力構成（第2工場までで会社能力が40,000t/期を超え得る）に対し、
// 5社のQ32数量Visionが17,000〜40,000t/期に集中していたため、「Q32 Visionの
// 達成には第2工場で足りる」状況になり、Standard AIが第3工場まで検討する
// 戦略的理由がほとんど発生しなかった。これはNew Factory trigger自体の問題では
// なく、Vision calibrationが会社の成長戦略を十分に差別化していなかった問題。
//
// MASSを「超成長・量産型企業」として Q32 Vision を 80,000t/期へ引き上げる
// （他4社の既定値は変更しない）。この変更は targetScaleTonsPerQuarterAtQ32 と
// それに整合する referenceGrowthPath の付け替えのみであり、
// 「Visionが80,000だから第3工場を建てる」という強制ロジックは一切追加しない
// （工場建設判断は既存の Strategic Posture / Forward Capacity Gap / Finance /
// Market / Operational feasibility を通じて Standard AI 自身が行う）。

import { CompanyVision, CompanyVisionDocument, COMPANY_VISION_SCHEMA_VERSION, VisionGrowthWaypoint } from "./types";

// 【Strategic Posture・§27候補案】
// MASS・BALは高成長ambition・HIGH willingnessToBuildFactoriesと整合するため
// AGGRESSIVE_EARLY_CAPACITY（先行能力投資型）。JPQ・CONSVは既存Vision通り
// 実績確認後に投資するDEMAND_CONFIRMED。VAPは規模を追わない志（emphasisProducts=vap、
// "量を追うための工場は建てない"というlongTermNarrative）と整合するVALUE_FIRST。

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
  visionId: "MASS-vision-v2",
  effectiveFromTurn: 1,
  growthAmbition: "HIGH",
  targetScaleTonsPerQuarterAtQ32: 80000,
  preferredEndState: "LARGE_VOLUME",
  willingnessToBuildFactories: "HIGH",
  financialRiskTolerance: "HIGH",
  desiredProductEvolution: "HOSO_SCALE",
  // 【2026-08 recalibration】q1は変更しない（現在の実設備能力に近い水準を保つ。
  // ここをQ32目標と同じ比率で引き上げると、初期からgapが過大になりQ1〜Q5での
  // 暴走投資を誘発しかねない）。中盤以降に立ち上がる凸型の傾きだけを、
  // Q32=80,000へ届くよう強める。
  referenceGrowthPath: waypoints(18000, 22000, 32000, 52000, 80000),
  longTermNarrative:
    "量で勝つ。8年後、世界需要の拡大を先取りして80,000t/期級の会社になる。HOSO・PDを軸に大規模化し、成長市場では工場完成前に将来の能力不足を読んで先行投資する。工場を建てることを恐れず、借入も成長のための手段として使う。2工場で終わらず、3工場目も当然の選択肢として持つ。ただし市況が崩れれば、その強気が裏目に出ることも受け入れる。",
  emphasisProducts: ["hoso", "pd"],
  strategicPosture: "AGGRESSIVE_EARLY_CAPACITY",
};

const BAL_VISION: CompanyVision = {
  visionId: "BAL-vision-v1",
  effectiveFromTurn: 1,
  growthAmbition: "HIGH",
  // 【SAI-VISION-1】Q32目標のみ 34,000 → 60,000 へ更新（夜間sensitivity Case A1）。
  // growthAmbition / willingnessToBuildFactories / financialRiskTolerance /
  // strategicPosture / desiredProductEvolution / emphasisProducts は一切変更しない。
  // referenceGrowthPathは開始規模16,000を保ちQ32まで線形（Case A1と同一の軌道）。
  targetScaleTonsPerQuarterAtQ32: 60000,
  preferredEndState: "LARGE_INTEGRATED",
  willingnessToBuildFactories: "HIGH",
  financialRiskTolerance: "MEDIUM",
  desiredProductEvolution: "INTEGRATED",
  referenceGrowthPath: waypoints(16000, 25935, 37290, 48645, 60000),
  longTermNarrative:
    "HOSO・PD・VAPのすべてを自社で扱える総合水産会社になる。規模も追うが、特定商品・特定市場に依存しない構成を保つ。財務は無理をしない範囲で攻める。",
  emphasisProducts: ["hoso", "pd", "vap"],
  strategicPosture: "AGGRESSIVE_EARLY_CAPACITY",
};

const JPQ_VISION: CompanyVision = {
  visionId: "JPQ-vision-v1",
  effectiveFromTurn: 1,
  growthAmbition: "HIGH",
  // 【SAI-VISION-1】Q32目標のみ 30,000 → 50,000 へ更新（夜間sensitivity Case A1）。
  // growthAmbition は HIGH のまま（MEDIUMへ落としても挙動が完全に同一であることを実測済み）。
  targetScaleTonsPerQuarterAtQ32: 50000,
  preferredEndState: "QUALITY_SCALE",
  willingnessToBuildFactories: "MEDIUM",
  financialRiskTolerance: "MEDIUM",
  desiredProductEvolution: "PD_SCALE",
  referenceGrowthPath: waypoints(16000, 23677, 32452, 41226, 50000),
  longTermNarrative:
    "品質を落とさずに大きくなる。日本市場で選ばれ続けるPDの品質を維持したまま規模を伸ばす。品質を守れないと判断すれば、規模の方を諦める。",
  emphasisProducts: ["pd"],
  strategicPosture: "DEMAND_CONFIRMED",
};

const CONSV_VISION: CompanyVision = {
  visionId: "CONSV-vision-v1",
  effectiveFromTurn: 1,
  growthAmbition: "MEDIUM",
  // 【SAI-VISION-1】Q32目標のみ 27,000 → 45,000 へ更新（夜間sensitivity Case A1）。
  // financialRiskTolerance は LOW のまま（DS3実測で借入0・distress 0を維持することを確認済み）。
  targetScaleTonsPerQuarterAtQ32: 45000,
  preferredEndState: "LARGE_INTEGRATED",
  willingnessToBuildFactories: "MEDIUM",
  financialRiskTolerance: "LOW",
  desiredProductEvolution: "INTEGRATED",
  referenceGrowthPath: waypoints(15000, 21774, 29516, 37258, 45000),
  longTermNarrative:
    "潰れない会社であり続けたうえで、着実に大きくなる。手元資金と負債水準に余裕があるときにだけ投資する。無理な成長で財務を痛めるくらいなら成長を遅らせる。",
  emphasisProducts: ["hoso", "pd"],
  strategicPosture: "DEMAND_CONFIRMED",
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
  strategicPosture: "VALUE_FIRST",
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
