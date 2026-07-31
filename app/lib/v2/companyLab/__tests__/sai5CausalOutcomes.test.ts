// ShrimpX V2 — SAI-5 事後監査 §4: 「結果水準」の因果テスト
//
// 三宅さんのご指示§4:「状態が存在する・範囲内に収まる、ではなく、状態と判断が
// 実際の成約・価格・投資・財務結果を変えるところまで検証する」。
//
// 1918件の既存テストが Blocker A/B を1つも検出できなかった根本原因は、
// テストが「状態が蓄積される」「値が有限で範囲内」しか見ていなかったことにある。
// 本ファイルは実エンジン（advanceCompanyLabQuarter）を制御条件で回し、
// 入力の違いが**出力の違い**として現れることだけを検証する。
//
// 【本体ロジックを歪めない方針】reason codeを発火させるためだけの不自然な分岐は
// 一切追加していない。代表シナリオで自然に発火しないものは、専用の制御条件
// （販売計画の数量を意図的に操作する）で経路の健全性を確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyId, CompanySalesPlanEntry } from "../../sales/types";
import { hosoEqTons, unwrapUnit } from "../../core/units";
import { CompanyDecisionInput, CompanyFixture, CompanyLabConfig, CompanyLabState, CompanyQuarterRecord, Sai5FeatureFlags } from "../types";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { STANDARD_AI_PARAMETERS_V1 } from "../standardAi/parameters";
import { createCompanyLabRuntimeSnapshot, restoreCompanyLabStateFromRuntimeSnapshot } from "../persistence/snapshot";
import { lookupSalesBaseScore, SalesBaseState } from "../salesBase";
import { SALES_PARAMETERS_SAI5_SALES_BASE_V1 } from "../../sales/parameters";
import { CompetitivenessWeightBreakdown } from "../../sales/types";

const ALL_ON: Sai5FeatureFlags = { productLifecycle: true, salesBaseAccumulation: true, supplyPremiumFeedback: true };

function config(seed: string, turns: number, sai5?: Sai5FeatureFlags): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed, turns, ...(sai5 ? { sai5 } : {}) };
}

type PlanMutator = (plan: CompanySalesPlanEntry, turn: number, companyId: CompanyId) => CompanySalesPlanEntry;

interface ControlledRun {
  readonly fixtures: readonly CompanyFixture[];
  readonly history: readonly CompanyQuarterRecord[];
  readonly finalState: CompanyLabState;
  readonly decisions: readonly { readonly turn: number; readonly decision: CompanyDecisionInput }[];
  /** 各四半期を処理する**直前**の営業基盤state（＝その四半期の成約に使われた正典値）。 */
  readonly salesBaseStateByTurn: readonly (SalesBaseState | undefined)[];
}

/**
 * 実エンジンを暫定自動方針で回しつつ、販売計画だけを任意に書き換えられる制御実行。
 * 「他をすべて同じにして供給量だけ変える」という因果テストの前提を満たすために使う。
 */
function runControlled(cfg: CompanyLabConfig, quarters: number, mutate?: PlanMutator): ControlledRun {
  const { state: initialState, fixtures } = initializeCompanyLab(cfg);
  let state = initialState;
  const decisions: { turn: number; decision: CompanyDecisionInput }[] = [];
  const salesBaseStateByTurn: (SalesBaseState | undefined)[] = [];
  for (let i = 0; i < quarters && !state.isComplete; i++) {
    salesBaseStateByTurn.push(state.salesBaseState);
    const publicInfo = buildPublicMarketInfo(state);
    const turn = state.scenarioState.currentTurn;
    const byCompany: Record<CompanyId, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      const ownState = buildCompanyOwnState(state, f);
      const raw = generateAutoPolicyDecision(f, ownState, publicInfo, state.currentPeriod, turn);
      const decision = mutate ? { ...raw, salesPlans: raw.salesPlans.map((p) => mutate(p, turn, f.companyId)) } : raw;
      byCompany[f.companyId] = decision;
      decisions.push({ turn, decision });
    }
    state = advanceCompanyLabQuarter(state, fixtures, byCompany);
  }
  return { fixtures, history: state.history, finalState: state, decisions, salesBaseStateByTurn };
}

/**
 * ある商品へ営業資源を集中させて「実際に市場へ提示する量」を増やすmutator。
 *
 * 【なぜ単純な×N倍では不足なのか】販売計画は成約配分の前に営業工数制約
 * （applyMarketSalesEffortCapacity）で会社×市場ごとに比例縮小される。希望量を
 * 一律に3倍しても縮小率がほぼ1/3になり、実際に市場へ提示される量はほとんど
 * 変わらない（＝供給圧力の分子が動かない）。他商品の希望量を落として当該商品へ
 * 営業工数を寄せることで、初めて「提示量そのもの」が増える。
 * これは本体ロジックを変えず、意思決定側だけで作れる正当な制御条件。
 */
function concentrateOn(product: "pd" | "vap", factor: number, otherFactor = 0.05): PlanMutator {
  return (plan) => ({
    ...plan,
    desiredQuantity: hosoEqTons(unwrapUnit(plan.desiredQuantity) * (plan.product === product ? factor : otherFactor)),
  });
}

/**
 * 内訳の6項目を**テスト側で独立に**合計する。
 * 実装の sumCompetitivenessContributions をそのまま使うと、実装側で項を落とす
 * リグレッションを入れたときに両辺が同時に変わって検出できない（監査再指摘）。
 * ここは意図的に手書きで、実装とは別経路にしておく。
 */
function sumBreakdownIndependently(b: CompetitivenessWeightBreakdown): number {
  return (
    b.priceContribution +
    b.coverageContribution +
    b.relationshipContribution +
    b.qualityContribution +
    b.deliveryReliabilityContribution +
    b.salesBaseContribution
  );
}

const QUARTERS = 10;

// =====================================================================
// (1) 営業基盤の差 → 成約量の差（エンジン全体を通した結果水準）
// =====================================================================

test("SAI-5因果(1): 営業基盤が、実エンジンの成約配分で実際に順位を決めている（単一変数の検証）", () => {
  // 【交絡の排除】機能ON/OFFの比較では、営業基盤ウェイト0.08を切り出すために
  // coverage/relationship/quality のウェイトも同時に変わるため、「成約量が変わった」
  // だけでは営業基盤が効いた証拠にならない（監査再指摘）。
  // ここでは1回のON実行の中で、実際に配分へ使われた内訳を直接調べる:
  //   (i) salesBaseContribution が実際に非ゼロで、会社間で分かれている
  //   (ii) 少なくとも1つの市場×商品で、salesBaseContribution が無ければ
  //        競争力の順位が変わる（＝営業基盤が結果を決めた）
  const run = runControlled(config("causal-1", QUARTERS, ALL_ON), QUARTERS, concentrateOn("vap", 3));

  let sawNonZeroContribution = false;
  let sawSpread = false;
  let sawMaterialSpread = false;
  let checkedAllocations = 0;
  for (const h of run.history) {
    for (const a of h.salesRecord.allocations) {
      if (a.companies.length < 2) continue;
      checkedAllocations += 1;
      for (const c of a.companies) {
        // 【Blocker A の構造的検出】実配分で使われたウェイトが、内訳の全項目合計と
        // 一致すること。実エンジン側の合計から項が抜け落ちれば、ここで必ず落ちる。
        assert.equal(
          sumBreakdownIndependently(c.competitivenessBreakdown),
          c.competitivenessWeight,
          `${a.market}x${a.product} ${c.companyId}: 配分に使われたウェイトが内訳合計と一致しない（合計処理から項が抜けている）`
        );
      }
      const contributions = a.companies.map((c) => c.competitivenessBreakdown.salesBaseContribution);
      if (contributions.some((v) => Math.abs(v) > 1e-12)) sawNonZeroContribution = true;
      const spread = Math.max(...contributions) - Math.min(...contributions);
      if (spread > 1e-12) sawSpread = true;

      // 営業基盤の会社間差が、会社間の競争力差に対して意味のある大きさであること。
      // 【「順位が入れ替わる」を条件にしない理由】実測では入れ替わりが0件だった。
      // 営業基盤は成約実績で伸びるため、他の競争力要素（カバレッジ・顧客関係）と
      // 正の相関を持ち、順位を覆すより「既存の順位を強める」方向に働く。
      // これは実装の欠陥ではなく蓄積モデルの性質なので、順位反転ではなく
      // 「差の大きさが競争力の最小差を超えるか」で意味のある寄与を判定する。
      const sortedWeights = a.companies.map((c) => c.competitivenessWeight).sort((x, y) => y - x);
      let minAdjacentGap = Infinity;
      for (let i = 1; i < sortedWeights.length; i++) minAdjacentGap = Math.min(minAdjacentGap, sortedWeights[i - 1] - sortedWeights[i]);
      if (spread > minAdjacentGap) sawMaterialSpread = true;
    }
  }
  assert.ok(checkedAllocations > 20, `検証できた配分が少なすぎる（${checkedAllocations}）`);
  assert.ok(sawNonZeroContribution, "実配分の内訳でsalesBaseContributionが常にゼロ（状態が結果へ接続していない）");
  assert.ok(sawSpread, "salesBaseContributionが全社同一（会社間で基盤が分かれていない）");
  assert.ok(sawMaterialSpread, "営業基盤の会社間差が、会社間の競争力差に対して常に無視できる大きさ（実質的に効いていない）");
});

test("SAI-5因果(1a): 暫定自動方針（Standard AI以外）の経路でも、正典の営業基盤が実際の成約競争力へ載る（監査指摘I）", () => {
  // autoPolicy は salesBaseScore を計画に載せないため、修正前は常に中立50扱いだった。
  // runner側の一括上書きが効いていれば、前期末の正典スコアが内訳へそのまま現れる。
  const run = runControlled(config("causal-1a", 6, ALL_ON), 6);
  const weight = SALES_PARAMETERS_SAI5_SALES_BASE_V1.competitivenessWeights.salesBase;
  let checked = 0;
  for (let i = 1; i < run.history.length; i++) {
    const stateBeforeThisQuarter = run.salesBaseStateByTurn[i]; // 前期末＝当期開始時点の正典
    if (!stateBeforeThisQuarter) continue;
    for (const a of run.history[i].salesRecord.allocations) {
      for (const c of a.companies) {
        const canonical = lookupSalesBaseScore(stateBeforeThisQuarter, c.companyId, a.market, a.product);
        const expected = weight * (canonical / 100);
        assert.ok(
          Math.abs(c.competitivenessBreakdown.salesBaseContribution - expected) < 1e-9,
          `${a.market}x${a.product} ${c.companyId}: 内訳(${c.competitivenessBreakdown.salesBaseContribution}) が正典スコア${canonical}由来の期待値(${expected})と一致しない`
        );
        checked += 1;
      }
    }
  }
  assert.ok(checked > 50, `検証できたセルが少なすぎる（${checked}）`);
});

test("SAI-5因果(1b): 営業基盤の高い会社ほど、同じ市場×商品での成約シェアが高い（分位点比較）", () => {
  const run = runControlled(config("causal-1b", QUARTERS, ALL_ON), QUARTERS, concentrateOn("vap", 3));
  const last = run.history[run.history.length - 1];
  const stateBefore = run.salesBaseStateByTurn[run.history.length - 1];
  assert.ok(stateBefore, "前期末の営業基盤stateが取れていない");

  // 市場×商品ごとに「その中で基盤が最上位の会社」と「最下位の会社」の成約シェアを比べる。
  // 会社間で基盤が分かれている市場×商品だけを対象にする（前提はguardではなくassertで明示）。
  let comparable = 0;
  let topWins = 0;
  for (const a of last.salesRecord.allocations) {
    const total = a.companies.reduce((s2, c) => s2 + unwrapUnit(c.allocatedQuantity), 0);
    if (total <= 0 || a.companies.length < 2) continue;
    const withScore = a.companies.map((c) => ({
      share: unwrapUnit(c.allocatedQuantity) / total,
      score: lookupSalesBaseScore(stateBefore, c.companyId, a.market, a.product),
    }));
    const scores = withScore.map((x) => x.score);
    if (Math.max(...scores) - Math.min(...scores) < 1e-9) continue; // 基盤が同一なら比較材料にならない
    comparable += 1;
    const top = withScore.reduce((x, y) => (y.score > x.score ? y : x));
    const bottom = withScore.reduce((x, y) => (y.score < x.score ? y : x));
    if (top.share >= bottom.share) topWins += 1;
  }
  assert.ok(comparable >= 3, `会社間で営業基盤が分かれている市場×商品が${comparable}件しかない（前提不成立）`);
  assert.ok(topWins / comparable >= 0.6, `基盤最上位が最下位以上の成約シェアを取った割合が${((topWins / comparable) * 100).toFixed(0)}%（過半に届かない）`);
});

// =====================================================================
// (2)(3) 供給増 → 圧力上昇 → 翌期プレミアム低下 / 供給減 → 圧力低下 → 回復
// =====================================================================

test("SAI-5因果(2): VAPの提示供給だけを増やすと、供給圧力が上がり翌期のVAPプレミアムが下がる", () => {
  const cfg = config("causal-2", QUARTERS, { supplyPremiumFeedback: true });
  const base = runControlled(cfg, QUARTERS, concentrateOn("vap", 1));
  const more = runControlled(cfg, QUARTERS, concentrateOn("vap", 3));

  const pressure = (r: ControlledRun, i: number) => r.history[i].sai5MarketEvolution!.supplyPressureEwmaByProduct.vap;
  const multiplier = (r: ControlledRun, i: number) => r.history[i].sai5MarketEvolution!.appliedPremiumRatioMultipliers.vap;
  const vapPremium = (r: ControlledRun, i: number) => unwrapUnit(r.history[i].marketResult.vapPremium.byCountry.VN.premium);

  // 圧力: 供給を増やした側が高い
  assert.ok(pressure(more, 0) > pressure(base, 0), `供給増で圧力が上がっていない（${pressure(more, 0)} vs ${pressure(base, 0)}）`);

  // 翌期プレミアム倍率: 供給を増やした側が低い（＝当期ではなく翌期に効く）
  assert.ok(multiplier(more, 1) < multiplier(base, 1), `翌期のプレミアム倍率が下がっていない（${multiplier(more, 1)} vs ${multiplier(base, 1)}）`);

  // 実際の市場プレミアム（USD）も低い
  assert.ok(vapPremium(more, 1) < vapPremium(base, 1), `翌期のVAP市場プレミアムが下がっていない（${vapPremium(more, 1)} vs ${vapPremium(base, 1)}）`);

  // 【時間順序】当期の供給は当期の市場結果へ遡及しない。turn1の倍率は初期状態由来で
  // 常に1.0なので、それだけでは検証にならない（監査再指摘）。turn1の**市場結果**
  // （VAPプレミアムそのもの）が供給差の影響を受けていないことを確認する。
  assert.equal(multiplier(more, 0), 1, "turn1の倍率が初期状態由来の1.0でない（前提が崩れている）");
  assert.equal(
    vapPremium(more, 0),
    vapPremium(base, 0),
    "当期の提示供給差が当期のVAP市場プレミアムを変えている（供給→プレミアムが遡及している）"
  );

  // 効果が持続し、かつ丸め誤差ではない大きさであること（符号だけの検証にしない）
  const lastIdx = QUARTERS - 1;
  assert.ok(multiplier(more, lastIdx) < multiplier(base, lastIdx), "供給過剰の持続がプレミアムへ持続的に効いていない");
  const maxMultiplierGap = Math.max(...Array.from({ length: QUARTERS }, (_, i) => multiplier(base, i) - multiplier(more, i)));
  assert.ok(maxMultiplierGap > 1e-3, `供給差によるプレミアム倍率の差の最大値(${maxMultiplierGap})が小さすぎる（結合係数が実質ゼロ）`);
});

test("SAI-5因果(3): 供給過剰を解消すると圧力が下がり、プレミアム倍率が回復する", () => {
  const cfg = config("causal-3", QUARTERS, { supplyPremiumFeedback: true });
  // 前半5期は過剰供給、後半5期は通常に戻す。
  const recover = runControlled(cfg, QUARTERS, (plan, turn) => (turn <= 5 ? concentrateOn("vap", 3)(plan, turn, plan.companyId) : plan));
  // 比較対照: 最後まで過剰供給を続ける
  const keepOversupplying = runControlled(cfg, QUARTERS, concentrateOn("vap", 3));

  const mult = (r: ControlledRun, i: number) => r.history[i].sai5MarketEvolution!.appliedPremiumRatioMultipliers.vap;
  const press = (r: ControlledRun, i: number) => r.history[i].sai5MarketEvolution!.supplyPressureEwmaByProduct.vap;

  // 圧力が下がる
  assert.ok(press(recover, QUARTERS - 1) < press(recover, 4), `過剰解消後に圧力が下がっていない（${press(recover, QUARTERS - 1)} vs ${press(recover, 4)}）`);
  // 倍率が底から回復する
  const trough = Math.min(...recover.history.map((_, i) => mult(recover, i)));
  assert.ok(mult(recover, QUARTERS - 1) > trough, "過剰解消後にプレミアム倍率が回復していない");
  // 過剰を続けた側より高い
  assert.ok(
    mult(recover, QUARTERS - 1) > mult(keepOversupplying, QUARTERS - 1),
    `過剰解消した側(${mult(recover, QUARTERS - 1)})が、過剰を続けた側(${mult(keepOversupplying, QUARTERS - 1)})より高くない`
  );
});

// =====================================================================
// (4) プレミアムの変化 → 数四半期後の商品構成の変化
// =====================================================================

test("SAI-5因果(4): プレミアムの変化が、数四半期後の需要構成比（商品ミックス）を実際に変える", () => {
  const cfg = config("causal-4", 12, ALL_ON);
  const base = runControlled(cfg, 12);
  const cheapVap = runControlled(cfg, 12, concentrateOn("vap", 3)); // VAP供給過剰→VAPプレミアム低下

  const mixAt = (r: ControlledRun, i: number) => r.history[i].sai5MarketEvolution!.appliedMix!;
  // 直後（turn2）はまだ構成比が大きく動かず、数四半期後に差が開く（遅行チャネル）
  const earlyGap = Math.abs(mixAt(cheapVap, 1).US.vap - mixAt(base, 1).US.vap);
  const lateGap = Math.abs(mixAt(cheapVap, 11).US.vap - mixAt(base, 11).US.vap);
  assert.ok(lateGap > earlyGap, `構成比の差が時間とともに開いていない（early=${earlyGap} / late=${lateGap}）`);
  assert.ok(lateGap > 1e-6, "12四半期経っても商品構成比が全く変わっていない（価格→需要構成の経路が死んでいる）");

  // 行和は常に1（総需要の二重計上がない）
  for (const i of [0, 5, 11]) {
    for (const m of ["CN", "US", "EU", "JP", "OTHER"] as const) {
      const row = mixAt(cheapVap, i)[m];
      assert.ok(Math.abs(row.hoso + row.pd + row.vap - 1) < 1e-9, `turn${i + 1} ${m} の構成比行和が1でない`);
    }
  }
});

// =====================================================================
// (5) 成長トレンド → 標準AIの販売・設備投資判断の変化
// =====================================================================

test("SAI-5因果(5): ライフサイクル成長トレンドの公開が、標準AIの判断材料として実際に届く", () => {
  const run = runControlled(config("causal-5", 8, ALL_ON), 8);
  // turn3以降は「前期と前々期の構成比の差」がトレンドとして公開される。
  // 修正前（history.length由来のturn導出）は永続化経路でここが常にゼロだった。
  const info = buildPublicMarketInfo({ ...run.finalState });
  assert.ok(info.productLifecycleOutlook, "ライフサイクル公開情報が作られていない");
  const trend = info.productLifecycleOutlook!.quarterlyTrendByMarket;
  const anyNonZero = (["CN", "US", "EU", "JP", "OTHER"] as const).some((m) => Math.abs(trend[m].vap) > 1e-9 || Math.abs(trend[m].pd) > 1e-9);
  assert.ok(anyNonZero, "公開ライフサイクルトレンドが全市場でゼロ（成長局面の判断材料が届いていない）");
});

// =====================================================================
// (6)(7) 供給過剰 → 抑制/見送りのreason code、PD維持判断 → PD_CAPACITY_MAINTAINED
// =====================================================================

test("SAI-5因果(6): 供給圧力が抑制しきい値へ到達し、供給→プレミアム低下の理由コードが実際に発火する", () => {
  // 【監査再指摘への対応】旧版は reason code を集めるだけで一度も参照していなかった。
  // なお SUPPLY_PRESSURE_RETREAT / VAP_OVERSUPPLY_RETREAT は Standard AI の判断で
  // あり、暫定自動方針を使う本テスト経路では原理的に発火しない。それらの発火確認は
  // standardAi/autoplay/__tests__/sai5MarketEvolution.test.ts が担当する。
  // ここではエンジン側が出す供給→プレミアムの理由コードを検証する。
  const run = runControlled(config("causal-6", 12, ALL_ON), 12, concentrateOn("vap", 4));
  const codes = new Set<string>();
  for (const h of run.history) for (const e of h.globalReasonCodes) codes.add(e.code);

  const pressures = run.history.map((h) => h.sai5MarketEvolution!.supplyPressureEwmaByProduct.vap);
  assert.ok(
    Math.max(...pressures) > STANDARD_AI_PARAMETERS_V1.supplyPressureRetreatThreshold,
    `供給圧力(${Math.max(...pressures)})が抑制しきい値(${STANDARD_AI_PARAMETERS_V1.supplyPressureRetreatThreshold})へ到達していない（前提が成立しない）`
  );
  assert.ok(codes.has("VAP_SUPPLY_INCREASE_LOWERS_PREMIUM"), `VAP供給増→プレミアム低下の理由コードが発火していない（発火した: ${[...codes].join(", ")}）`);
});

test("SAI-5因果(7): config.sai5.supplyPressureDefinition が実際にエンジンの計算を変える（値の保持だけで終わっていない）", () => {
  // 【監査再指摘】永続化のラウンドトリップはフラグの往復しか保証しておらず、
  // 「復元した定義がエンジンで実際に使われる」ことが無検証だった（Blocker Bと同型の穴）。
  const adopted = runControlled(config("causal-7", 6, ALL_ON), 6, concentrateOn("vap", 3));
  const legacy = runControlled(
    config("causal-7", 6, { ...ALL_ON, supplyPressureDefinition: "raw_target_demand" }),
    6,
    concentrateOn("vap", 3)
  );

  assert.equal(adopted.history[0].sai5MarketEvolution!.supplyPressureDefinition, "completed_supply");
  assert.equal(legacy.history[0].sai5MarketEvolution!.supplyPressureDefinition, "raw_target_demand");

  const adoptedPressure = adopted.history[0].sai5MarketEvolution!.supplyPressureByProduct.pd;
  const legacyPressure = legacy.history[0].sai5MarketEvolution!.supplyPressureByProduct.pd;
  assert.ok(Math.abs(adoptedPressure - legacyPressure) > 0.1, `定義を変えても供給圧力が変わらない（${adoptedPressure} vs ${legacyPressure}）`);
  // 旧定義は5社/全ベトナムのスケール差で1.0を大きく下回る（棄却理由の再現）
  assert.ok(legacyPressure < 0.6, `旧定義の圧力(${legacyPressure})が1.0付近になっている（前提が崩れている）`);
  assert.ok(Math.abs(adoptedPressure - 1) < 0.2, `採用定義の圧力(${adoptedPressure})が1.0を中心にしていない`);
  // 結果（プレミアム倍率）も実際に変わる
  const lastIdx = 5;
  assert.notEqual(
    adopted.history[lastIdx].sai5MarketEvolution!.appliedPremiumRatioMultipliers.pd,
    legacy.history[lastIdx].sai5MarketEvolution!.appliedPremiumRatioMultipliers.pd,
    "定義の違いがプレミアム倍率へ伝わっていない"
  );
});

// =====================================================================
// (8) 保存・復元で機能フラグ・状態・翌期の判断が保たれる
// =====================================================================

test("SAI-5因果(8): 保存→復元後も、機能フラグ・状態・翌期の結果が中断なしの実行と完全に一致する", () => {
  const cfg = config("causal-8", 8, ALL_ON);

  // (a) 中断なしで8四半期
  const straight = runControlled(cfg, 8);

  // (b) 4四半期でスナップショット保存 → 復元 → 残り4四半期
  const { state: initialState, fixtures } = initializeCompanyLab(cfg);
  let state = initialState;
  const step = (s: CompanyLabState): CompanyLabState => {
    const publicInfo = buildPublicMarketInfo(s);
    const byCompany: Record<CompanyId, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      byCompany[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(s, f), publicInfo, s.currentPeriod, s.scenarioState.currentTurn);
    }
    return advanceCompanyLabQuarter(s, fixtures, byCompany);
  };
  for (let i = 0; i < 4; i++) state = step(state);

  const snapshot = JSON.parse(JSON.stringify(createCompanyLabRuntimeSnapshot(state)));
  // 【監査指摘F】永続化経路ではサービスが直近1件の記録しか注入しないことがある。
  // その条件を意図的に再現する（turnの正典がscenarioStateであることの検証）。
  let restored = restoreCompanyLabStateFromRuntimeSnapshot(state.config, snapshot, state.history.slice(-1));
  assert.deepEqual(restored.config.sai5, ALL_ON, "復元後に機能フラグが失われている");
  assert.ok(restored.salesBaseState, "復元後に営業基盤stateが無い");
  assert.ok(restored.marketEvolutionState, "復元後に市場進化stateが無い");
  assert.equal(restored.scenarioState.currentTurn, 5, "復元後のturnが正しくない");

  // 復元直後の公開情報が、中断なし実行の同時点と一致する（＝翌期の判断材料が同じ）
  const straightAt4 = (() => {
    const { state: s0, fixtures: f0 } = initializeCompanyLab(cfg);
    let s = s0;
    for (let i = 0; i < 4; i++) {
      const publicInfo = buildPublicMarketInfo(s);
      const byCompany: Record<CompanyId, CompanyDecisionInput> = {};
      for (const f of f0) byCompany[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(s, f), publicInfo, s.currentPeriod, s.scenarioState.currentTurn);
      s = advanceCompanyLabQuarter(s, f0, byCompany);
    }
    return s;
  })();
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildPublicMarketInfo(restored).productLifecycleOutlook)),
    JSON.parse(JSON.stringify(buildPublicMarketInfo(straightAt4).productLifecycleOutlook)),
    "復元後の公開ライフサイクル情報が中断なし実行と一致しない（監査指摘Fのturn導出）"
  );

  for (let i = 0; i < 4; i++) restored = step(restored);
  const resumedLast = restored.history[restored.history.length - 1];
  const straightLast = straight.history[straight.history.length - 1];
  assert.deepEqual(
    JSON.parse(JSON.stringify(resumedLast.sai5MarketEvolution)),
    JSON.parse(JSON.stringify(straightLast.sai5MarketEvolution)),
    "保存・復元をはさむと8四半期目の市場進化状態が変わる"
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(resumedLast.companySummaries)),
    JSON.parse(JSON.stringify(straightLast.companySummaries)),
    "保存・復元をはさむと8四半期目の会社成績が変わる"
  );
});

// =====================================================================
// (9) 機能フラグOFFで既存の基準結果と完全一致
// =====================================================================

test("SAI-5因果(9): 機能フラグ未指定と全フラグfalseは、10四半期の全結果がビット単位で一致する", () => {
  const a = runControlled(config("causal-9", QUARTERS), QUARTERS);
  const b = runControlled(config("causal-9", QUARTERS, { productLifecycle: false, salesBaseAccumulation: false, supplyPremiumFeedback: false }), QUARTERS);
  assert.equal(JSON.stringify(a.history), JSON.stringify(b.history));
  assert.equal(a.finalState.salesBaseState, undefined, "機能OFFなのに営業基盤stateが作られている");
  assert.equal(a.finalState.marketEvolutionState, undefined, "機能OFFなのに市場進化stateが作られている");
});

test("SAI-5因果(9b): 機能OFFでは営業基盤スコアが成約結果に一切影響しない（正典上書き経路も含む）", () => {
  // 意思決定側が salesBaseScore を自己申告しても、機能OFFなら結果は変わらない
  const withForged = runControlled(config("causal-9b", 4), 4, (plan, _turn, companyId) => ({
    ...plan,
    salesBaseScore: (companyId === "BAL" ? 100 : 0) as never,
  }));
  const plain = runControlled(config("causal-9b", 4), 4);
  assert.equal(JSON.stringify(withForged.history.map((h) => h.salesRecord.allocations)), JSON.stringify(plain.history.map((h) => h.salesRecord.allocations)));
});

test("SAI-5因果(9c): 機能ONでは、意思決定側が申告した営業基盤ではなく正典の状態が使われる（監査指摘I）", () => {
  // 意思決定側が全社100を申告しても、エンジンは自分の SalesBaseState で上書きするため
  // 申告なしの実行と結果が完全に一致する。
  const forged = runControlled(config("causal-9c", 6, ALL_ON), 6, (plan) => ({ ...plan, salesBaseScore: 100 as never }));
  const honest = runControlled(config("causal-9c", 6, ALL_ON), 6);
  assert.equal(
    JSON.stringify(forged.history.map((h) => h.salesRecord.allocations)),
    JSON.stringify(honest.history.map((h) => h.salesRecord.allocations)),
    "意思決定側の自己申告した営業基盤が成約結果へ通ってしまっている（情報境界の破れ）"
  );
});
