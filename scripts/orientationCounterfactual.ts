// ShrimpX V2 — orientation counterfactual 診断（本体コード変更なし）
//
// 同一 Turn state を固定し、会社ID→志向プロファイルの対応表だけを
// このプロセス内で差し替えて、Standard AI の販売計画がどれだけ動くかを測る。
// COMPANY_ORIENTATION_BY_COMPANY_ID はレジストリ的な可変オブジェクトなので、
// 診断中だけ書き換えて必ず元へ戻す（保存データ・シナリオには一切触れない）。
//
//   npx tsx scripts/orientationCounterfactual.ts

import { initializeCompanyLab, advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import {
  COMPANY_ORIENTATION_BY_COMPANY_ID,
  COMPANY_ORIENTATION_PROFILES,
  CompanyOrientationProfile,
  resolveStandardAiProfileForMode,
} from "../app/lib/v2/companyLab/standardAi/orientationProfile";
import { DYNAMIC_SCENARIO_2 } from "../app/lib/v2/scenario/definitions/dynamicScenario2";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { CompanyLabState } from "../app/lib/v2/companyLab/types";
import { CompanyId } from "../app/lib/v2/sales/types";

const PRODUCTS = ["hoso", "pd", "vap"] as const;
const MARKETS = ["CN", "US", "EU", "JP", "OTHER"] as const;
const SEED = "ds2-cf";
const SNAPSHOT_TURNS = [1, 12];
// standardAiProfileMode。実ゲームは未設定＝OFF。ON にすると engine.ts が志向を注入する。
const MODE: "OFF" | "ON" = process.env.AI_PROFILE_MODE === "ON" ? "ON" : "OFF";

const mutableMap = COMPANY_ORIENTATION_BY_COMPANY_ID as Record<string, string>;
const mutableProfiles = COMPANY_ORIENTATION_PROFILES as Record<string, CompanyOrientationProfile>;
const ORIGINAL_MAP = { ...mutableMap };
const ORIGINAL_PROFILES: Record<string, CompanyOrientationProfile> = JSON.parse(JSON.stringify(COMPANY_ORIENTATION_PROFILES));

/**
 * 倍率を中立(1.0)からの乖離ぶんだけ factor 倍して強める（診断専用）。
 * orientationProfile.ts は許容範囲（市場 0.80〜1.25 / 商品 0.85〜1.20）を超えると
 * 実行時エラーにする安全弁を持つため、その範囲へクランプして観測する
 * （＝現行の設計が許す最大まで強めた場合、という意味になる）。
 */
function amplify(profile: CompanyOrientationProfile, factor: number): CompanyOrientationProfile {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const ampMarket = (v: number) => clamp(1 + (v - 1) * factor, 0.8, 1.25);
  const ampProduct = (v: number) => clamp(1 + (v - 1) * factor, 0.85, 1.2);
  return {
    ...profile,
    marketMultipliers: Object.fromEntries(Object.entries(profile.marketMultipliers).map(([k, v]) => [k, ampMarket(v)])) as CompanyOrientationProfile["marketMultipliers"],
    productMultipliers: Object.fromEntries(Object.entries(profile.productMultipliers).map(([k, v]) => [k, ampProduct(v)])) as CompanyOrientationProfile["productMultipliers"],
  };
}

function buildStateAt(turn: number): { state: CompanyLabState; fixtures: ReturnType<typeof initializeCompanyLab>["fixtures"] } {
  const { state: initial, fixtures } = initializeCompanyLab({ scenarioId: DYNAMIC_SCENARIO_2.scenarioId, mode: "canonical", seed: SEED, turns: 32 });
  let state = initial;
  for (let t = 1; t < turn; t++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions = fixtures.map((f) =>
      generateStandardAiDecisionWithDiagnostics(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn).decision
    );
    state = advanceCompanyLabQuarter(state, fixtures, Object.fromEntries(decisions.map((d) => [d.companyId, d])));
  }
  return { state, fixtures };
}

/** 指定会社の販売計画から、商品構成％と市場構成％を出す。 */
function salesMix(
  state: CompanyLabState,
  fixtures: ReturnType<typeof initializeCompanyLab>["fixtures"],
  companyId: CompanyId,
  mode: "OFF" | "ON"
) {
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const publicInfo = buildPublicMarketInfo(state);
  // engine.ts:327 と同じ手順で params を解決してから渡す（実ゲームと同等の経路）。
  const resolution = resolveStandardAiProfileForMode(companyId, mode);
  const { decision } = generateStandardAiDecisionWithDiagnostics(
    fixture,
    buildCompanyOwnState(state, fixture),
    publicInfo,
    state.currentPeriod,
    state.scenarioState.currentTurn,
    resolution.params
  );
  const byProduct: Record<string, number> = { hoso: 0, pd: 0, vap: 0 };
  const byMarket: Record<string, number> = { CN: 0, US: 0, EU: 0, JP: 0, OTHER: 0 };
  let total = 0;
  for (const p of decision.salesPlans) {
    const q = unwrapUnit(p.desiredQuantity);
    byProduct[p.product] += q;
    byMarket[p.market] += q;
    total += q;
  }
  return { byProduct, byMarket, total };
}

const pct = (part: number, total: number) => (total <= 0 ? " - " : `${((part / total) * 100).toFixed(1)}`.padStart(5));

function line(label: string, mix: ReturnType<typeof salesMix>): string {
  return (
    `    ${label.padEnd(30)}` +
    ` 商品 ${PRODUCTS.map((p) => `${p}=${pct(mix.byProduct[p], mix.total)}%`).join(" ")}` +
    `  市場 ${MARKETS.map((m) => `${m}=${pct(mix.byMarket[m], mix.total)}%`).join(" ")}` +
    `  計=${Math.round(mix.total).toLocaleString()}t`
  );
}

const TARGETS: readonly CompanyId[] = ["MASS", "JPQ", "VAP"];
const SWAP_SOURCES: readonly CompanyId[] = ["MASS", "JPQ", "VAP"];

for (const turn of SNAPSHOT_TURNS) {
  console.log(`\n${"=".repeat(100)}\n=== Turn ${turn} 固定 state での counterfactual（seed=${SEED}, standardAiProfileMode=${MODE}）\n${"=".repeat(100)}`);
  const { state, fixtures } = buildStateAt(turn);

  for (const target of TARGETS) {
    console.log(`\n  [${target} の state を固定し、志向プロファイルだけ差し替え]`);

    // 1) 自社本来の志向
    Object.assign(mutableMap, ORIGINAL_MAP);
    Object.assign(mutableProfiles, JSON.parse(JSON.stringify(ORIGINAL_PROFILES)));
    const base = salesMix(state, fixtures, target, MODE);
    console.log(line(`自社(${ORIGINAL_MAP[target]})`, base));

    // 2) 他社の志向へ差し替え
    for (const source of SWAP_SOURCES) {
      if (source === target) continue;
      Object.assign(mutableMap, ORIGINAL_MAP);
      Object.assign(mutableProfiles, JSON.parse(JSON.stringify(ORIGINAL_PROFILES)));
      mutableMap[target] = ORIGINAL_MAP[source];
      const swapped = salesMix(state, fixtures, target, MODE);
      const dHoso = ((swapped.byProduct.hoso / swapped.total - base.byProduct.hoso / base.total) * 100).toFixed(1);
      const dVap = ((swapped.byProduct.vap / swapped.total - base.byProduct.vap / base.total) * 100).toFixed(1);
      const dCn = ((swapped.byMarket.CN / swapped.total - base.byMarket.CN / base.total) * 100).toFixed(1);
      const dJp = ((swapped.byMarket.JP / swapped.total - base.byMarket.JP / base.total) * 100).toFixed(1);
      console.log(line(`→ ${source}志向(${ORIGINAL_MAP[source]})`, swapped) + `  ΔHOSO=${dHoso}pt ΔVAP=${dVap}pt ΔCN=${dCn}pt ΔJP=${dJp}pt`);
    }

    // 3) 自社志向を2倍に強めた場合（診断専用）
    Object.assign(mutableMap, ORIGINAL_MAP);
    Object.assign(mutableProfiles, JSON.parse(JSON.stringify(ORIGINAL_PROFILES)));
    const ownId = ORIGINAL_MAP[target];
    mutableProfiles[ownId] = amplify(ORIGINAL_PROFILES[ownId], 2);
    const amped = salesMix(state, fixtures, target, MODE);
    const aHoso = ((amped.byProduct.hoso / amped.total - base.byProduct.hoso / base.total) * 100).toFixed(1);
    const aVap = ((amped.byProduct.vap / amped.total - base.byProduct.vap / base.total) * 100).toFixed(1);
    const aCn = ((amped.byMarket.CN / amped.total - base.byMarket.CN / base.total) * 100).toFixed(1);
    const aJp = ((amped.byMarket.JP / amped.total - base.byMarket.JP / base.total) * 100).toFixed(1);
    console.log(line(`→ 自社志向2倍(範囲上限へclamp)`, amped) + `  ΔHOSO=${aHoso}pt ΔVAP=${aVap}pt ΔCN=${aCn}pt ΔJP=${aJp}pt`);
  }
}

// 必ず元へ戻す。
Object.assign(mutableMap, ORIGINAL_MAP);
Object.assign(mutableProfiles, JSON.parse(JSON.stringify(ORIGINAL_PROFILES)));
console.log("\n（プロファイル定義は元の値へ復元済み。本体コードは変更していない）");
