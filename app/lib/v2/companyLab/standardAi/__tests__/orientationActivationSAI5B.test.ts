// ShrimpX V2 — Phase SAI-5B: CompanyOrientationProfile の実ゲーム有効化テスト
//
// 【このPhaseで何を固定するか】SP-Q1監査で、resolveStandardAiProfileForMode 自体は
// 正しく動くのに standardAiProfileMode を設定する呼び出し元が app/v2・app/api の
// どこにも無く、実ゲームが全て mode 未指定 = OFF（会社差ゼロ）で動いていたことが
// 判明した。SAI-5B はその配線を通し、
//   1. 会社別プロファイルが実ゲームの3経路（Simulation Run / PLAYER Workspace /
//      Company Lab）で実際に解決されること
//   2. その結果として販売構成に会社別の「傾き」が実際に出ること
//   3. 明示的な "OFF"（ablation/diagnostic）は従来どおり無効化できること
// を固定する。
//
// 【会社別の別AIロジックは作らない】ここで検証するのは既存の共通Standard AIへ
// 渡すparamsの差だけであり、会社IDによる判断分岐は追加していない。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPANY_ORIENTATION_BY_COMPANY_ID,
  DEFAULT_RUNTIME_STANDARD_AI_PROFILE_MODE,
  resolveOrientationProfile,
  resolveStandardAiProfileForMode,
} from "../orientationProfile";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { advanceSimulationTurn, createSimulationSession } from "../../simulation/engine";
import { SimulationSession } from "../../simulation/types";
import { CompanyId } from "../../../sales/types";
import { unwrapUnit } from "../../../core/units";
import { defaultVisionDocumentFor } from "../../vision/defaults";

const AT = "2026-01-01T00:00:00.000Z";
const COMPANIES: readonly CompanyId[] = ["BAL", "MASS", "JPQ", "VAP", "CONSV"];

// ---------------------------------------------------------------------
// SAI5B-1: 志向定義そのものが会社の正式設計（Vision）と一致している
// ---------------------------------------------------------------------

test("SAI5B-1: 各社の最大商品志向が、Visionのその会社の主軸商品（emphasisProducts）と一致する", () => {
  // Vision（vision/defaults.ts）が会社設計のSSoT。志向プロファイルはそこから
  // 逸脱してはいけない（SAI-5AではJPQ・VAP社がVisionと逆転していた）。
  const expectedTopProduct: Readonly<Record<string, "hoso" | "pd" | "vap">> = {
    MASS: "hoso",
    JPQ: "pd",
    VAP: "vap",
    CONSV: "pd",
  };
  for (const [companyId, expected] of Object.entries(expectedTopProduct)) {
    const multipliers = resolveOrientationProfile(companyId as CompanyId).productMultipliers;
    const top = (["hoso", "pd", "vap"] as const).reduce((a, b) => (multipliers[a] >= multipliers[b] ? a : b));
    assert.equal(top, expected, `${companyId}の最大商品志向`);

    const vision = defaultVisionDocumentFor(companyId)?.visions[0];
    assert.ok(vision, `${companyId}のVisionが見つからない`);
    assert.ok(
      vision!.emphasisProducts.includes(expected),
      `${companyId}: VisionのemphasisProducts(${vision!.emphasisProducts.join(",")})に最大志向商品(${expected})が含まれていない`
    );
  }
});

test("SAI5B-1b: BALは完全中立で、MASS/JPQ/VAP/CONSVは市場志向の最大値が設計どおり（CN/JP/US/EU）", () => {
  const bal = resolveOrientationProfile("BAL");
  for (const v of Object.values(bal.marketMultipliers)) assert.equal(v, 1.0);
  for (const v of Object.values(bal.productMultipliers)) assert.equal(v, 1.0);

  const expectedTopMarket: Readonly<Record<string, string>> = { MASS: "CN", JPQ: "JP", VAP: "US", CONSV: "EU" };
  for (const [companyId, expected] of Object.entries(expectedTopMarket)) {
    const m = resolveOrientationProfile(companyId as CompanyId).marketMultipliers;
    const top = Object.entries(m).reduce((a, b) => (a[1] >= b[1] ? a : b))[0];
    assert.equal(top, expected, `${companyId}の最大市場志向`);
  }
});

// ---------------------------------------------------------------------
// SAI5B-2: 実ゲームの既定でONになっている（Simulation Run / PLAYER Workspace）
// ---------------------------------------------------------------------

test("SAI5B-2: 実ゲームの既定モードはONで、createSimulationSessionがconfigへ明示的に書き込む", () => {
  assert.equal(DEFAULT_RUNTIME_STANDARD_AI_PROFILE_MODE, "ON");
  const session = createSimulationSession({
    simulationRunId: "sai5b-default",
    scenarioId: "baseline",
    seed: "sai5b-default-seed",
    requestedTurns: 2,
    startedAt: AT,
    // standardAiProfileMode を指定しない＝実ゲームのSetup画面・Management Consoleと同じ。
  });
  assert.equal(session.state.config.standardAiProfileMode, "ON", "未指定の新規Runは既定でONになるべき");
  assert.equal(session.config.standardAiProfileMode, "ON", "トップレベルconfigにも同じ値が入るべき");
});

test("SAI5B-3: engine.ts経由の実行で、5社それぞれの会社別profileが実際に解決・記録される", () => {
  let session: SimulationSession = createSimulationSession({
    simulationRunId: "sai5b-resolve",
    scenarioId: "baseline",
    seed: "sai5b-resolve-seed",
    requestedTurns: 2,
    startedAt: AT,
  });
  const outcome = advanceSimulationTurn(session, AT);
  assert.ok(outcome.advanced, "Turn1が進行すること");
  session = outcome.session;

  for (const companyId of COMPANIES) {
    const profile = session.packCompanyTurns.find((c) => c.companyId === companyId && c.turn === 1)?.strategy?.profile;
    assert.ok(profile, `${companyId}のPackStrategy.profileが記録されていない`);
    assert.equal(profile!.mode, "ON", `${companyId}はON経路で動くべき`);
    assert.equal(
      profile!.orientationProfileId,
      COMPANY_ORIENTATION_BY_COMPANY_ID[companyId],
      `${companyId}の志向プロファイルが対応表どおりに解決されていない`
    );
  }
});

// ---------------------------------------------------------------------
// SAI5B-4: 有効化の結果として、販売構成に会社別の傾きが実際に出る
// ---------------------------------------------------------------------

/** engine.tsを数ターン回し、会社別の成約構成（商品・市場）のshareを返す。 */
function salesSharesAfterTurns(mode: "OFF" | "ON" | undefined, turns: number) {
  let session: SimulationSession = createSimulationSession({
    simulationRunId: `sai5b-mix-${mode ?? "default"}`,
    scenarioId: "baseline",
    seed: "sai5b-mix-seed",
    requestedTurns: turns,
    startedAt: AT,
    standardAiProfileMode: mode,
  });
  const byCompany = new Map<string, { product: Record<string, number>; market: Record<string, number>; total: number }>();
  for (const companyId of COMPANIES) {
    byCompany.set(companyId, { product: { hoso: 0, pd: 0, vap: 0 }, market: { CN: 0, US: 0, EU: 0, JP: 0, OTHER: 0 }, total: 0 });
  }
  for (let t = 0; t < turns; t++) {
    const outcome = advanceSimulationTurn(session, AT);
    if (!outcome.advanced) break;
    session = outcome.session;
    const record = session.state.history[session.state.history.length - 1];
    for (const c of record.salesRecord.newContracts) {
      const acc = byCompany.get(c.companyId);
      if (!acc) continue;
      const q = unwrapUnit(c.originalQuantity);
      acc.product[c.product] += q;
      acc.market[c.market] += q;
      acc.total += q;
    }
  }
  const share = (companyId: string, kind: "product" | "market", key: string) => {
    const acc = byCompany.get(companyId)!;
    return acc.total <= 0 ? 0 : (acc[kind][key] / acc.total) * 100;
  };
  return share;
}

test("SAI5B-4: ON既定の実行では、各社が設計どおりの方向へ傾く（BAL比で MASS=HOSO/CN、JPQ=PD/JP、VAP=VAP/US、CONSV=EU）", () => {
  const on = salesSharesAfterTurns(undefined, 4);

  // MASS: HOSO・中国。BALより明確に高い。
  assert.ok(on("MASS", "product", "hoso") > on("BAL", "product", "hoso"), "MASSのHOSO比率はBALより高いはず");
  assert.ok(on("MASS", "market", "CN") > on("BAL", "market", "CN"), "MASSの中国比率はBALより高いはず");

  // JPQ: PD・日本。PDは5社で最大、日本も5社で最大。
  const pdShares = COMPANIES.map((c) => ({ c, v: on(c, "product", "pd") }));
  assert.equal(pdShares.reduce((a, b) => (a.v >= b.v ? a : b)).c, "JPQ", "PD比率が最大の会社はJPQであるべき");
  const jpShares = COMPANIES.map((c) => ({ c, v: on(c, "market", "JP") }));
  assert.equal(jpShares.reduce((a, b) => (a.v >= b.v ? a : b)).c, "JPQ", "日本比率が最大の会社はJPQであるべき");

  // VAP社: VAP・米国。どちらも5社で最大。
  const vapShares = COMPANIES.map((c) => ({ c, v: on(c, "product", "vap") }));
  assert.equal(vapShares.reduce((a, b) => (a.v >= b.v ? a : b)).c, "VAP", "VAP比率が最大の会社はVAP社であるべき");
  const usShares = COMPANIES.map((c) => ({ c, v: on(c, "market", "US") }));
  assert.equal(usShares.reduce((a, b) => (a.v >= b.v ? a : b)).c, "VAP", "米国比率が最大の会社はVAP社であるべき");

  // CONSV: 欧州が5社で最大。
  const euShares = COMPANIES.map((c) => ({ c, v: on(c, "market", "EU") }));
  assert.equal(euShares.reduce((a, b) => (a.v >= b.v ? a : b)).c, "CONSV", "欧州比率が最大の会社はCONSVであるべき");

  // BAL: どの商品・市場でも単独最大にも単独最小にもならない（中立の意味）。
  for (const [kind, keys] of [
    ["product", ["hoso", "pd", "vap"]],
    ["market", ["CN", "US", "EU", "JP", "OTHER"]],
  ] as const) {
    for (const key of keys) {
      const values = COMPANIES.map((c) => on(c, kind, key));
      const bal = on("BAL", kind, key);
      assert.ok(bal <= Math.max(...values) && bal >= Math.min(...values), `BALの${kind}.${key}は中間にあるべき`);
    }
  }
});

test("SAI5B-5: 会社差はOFFではほぼ生じず、ONで明確に広がる（有効化の効果そのものの確認）", () => {
  const off = salesSharesAfterTurns("OFF", 4);
  const on = salesSharesAfterTurns(undefined, 4);
  const spread = (share: ReturnType<typeof salesSharesAfterTurns>, kind: "product" | "market", key: string) => {
    const values = COMPANIES.map((c) => share(c, kind, key));
    return Math.max(...values) - Math.min(...values);
  };
  assert.ok(spread(on, "product", "hoso") > spread(off, "product", "hoso") + 5, "HOSO比率の会社間ばらつきはONで5pt以上広がるべき");
  assert.ok(spread(on, "market", "CN") > spread(off, "market", "CN") + 3, "中国比率の会社間ばらつきはONで3pt以上広がるべき");
});

// ---------------------------------------------------------------------
// SAI5B-6: 明示的なOFF（ablation / diagnostic）は従来どおり無効化できる
// ---------------------------------------------------------------------

test("SAI5B-6: 明示的な standardAiProfileMode='OFF' は従来どおり会社差ゼロのまま（diagnostic経路の非破壊）", () => {
  let session: SimulationSession = createSimulationSession({
    simulationRunId: "sai5b-off",
    scenarioId: "baseline",
    seed: "sai5b-off-seed",
    requestedTurns: 2,
    startedAt: AT,
    standardAiProfileMode: "OFF",
  });
  assert.equal(session.state.config.standardAiProfileMode, "OFF");
  const outcome = advanceSimulationTurn(session, AT);
  assert.ok(outcome.advanced);
  session = outcome.session;
  for (const companyId of COMPANIES) {
    const profile = session.packCompanyTurns.find((c) => c.companyId === companyId && c.turn === 1)?.strategy?.profile;
    assert.equal(profile?.mode, "OFF", `${companyId}は明示OFFなのでOFFのまま`);
    assert.deepEqual(profile?.appliedBiasItems, [], `${companyId}は明示OFFなのでバイアスゼロ`);
  }
  // resolveStandardAiProfileForMode自身の契約（未指定=OFF）は変更していない。
  assert.equal(resolveStandardAiProfileForMode("MASS", undefined).params, STANDARD_AI_PARAMETERS_V1);
});
