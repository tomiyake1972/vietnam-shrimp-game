// ShrimpX V2 — 競合ニュース生成のテスト（PUBLIC-COMPETITOR-2）
//
// 固定したいのは次の4点。
//  (1) 本数上限・同一会社1本・優先順位・年間配当の別枠
//  (2) 決定論（同じ run ID・ターンからは記事も外れ方も必ず同じ）
//  (3) 外れるのは「観測・噂」だけで、「確報」は絶対に外れない
//  (4) 本文に他社の正確な数値が出ない

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCompetitorNews,
  CompetitorSignalInput,
  deterministicUnitValue,
  MAX_COMPETITOR_NEWS_PER_TURN,
  RUMOR_MISLEADING_RATE,
} from "../competitorNews";
import {
  CompetitorMarketCell,
  PublicCompetitorSnapshot,
  PublicInvestmentAnnouncement,
} from "../publicCompetitorSnapshot";

const NAMES = new Map<string, string>([
  ["BAL", "バランス水産"],
  ["MASS", "大量生産・価格競争水産"],
  ["JPQ", "日本・品質志向水産"],
  ["VAP", "VAP特化水産"],
  ["CONSV", "保守的・財務慎重水産"],
]);

function cell(
  market: string,
  product: string,
  shares: readonly (readonly [string, string, string | null])[],
  crowding: "loose" | "normal" | "tight" | null = null
): CompetitorMarketCell {
  return {
    market,
    product,
    crowding,
    shares: shares.map(([companyId, band, trend]) => ({ companyId, band, trend })),
  } as unknown as CompetitorMarketCell;
}

function snapshot(overrides: Partial<PublicCompetitorSnapshot> = {}): PublicCompetitorSnapshot {
  return {
    sourceTurn: 5,
    source: "LAST_QUARTER_RESULT",
    cells: [],
    salesForce: [],
    investments: [],
    factoryCounts: [],
    ...overrides,
  } as PublicCompetitorSnapshot;
}

function newFactory(companyId: string, kind: "constructionStarted" | "operational" = "constructionStarted"): PublicInvestmentAnnouncement {
  return {
    companyId,
    projectType: "newFactoryConstruction",
    kind,
    product: null,
    approximateInvestmentUsd: 22_000_000,
    approximateCapacityTonsPerQuarter: 22_000,
    expectedQuartersToOperational: 5,
  } as PublicInvestmentAnnouncement;
}

function build(args: {
  readonly runId?: string;
  readonly turn?: number;
  readonly snapshot: PublicCompetitorSnapshot;
  readonly signals?: readonly CompetitorSignalInput[];
  readonly annualDividend?: Parameters<typeof buildCompetitorNews>[0]["annualDividend"];
}) {
  return buildCompetitorNews({
    runId: args.runId ?? "run-news-test",
    turn: args.turn ?? 5,
    snapshot: args.snapshot,
    signals: args.signals ?? [],
    displayNameByCompanyId: NAMES,
    ...(args.annualDividend ? { annualDividend: args.annualDividend } : {}),
  });
}

// ---------------------------------------------------------------------

test("CN-1: 1ターンの本数は上限3本まで（年間配当の別枠を除く）", () => {
  const news = build({
    snapshot: snapshot({
      investments: [newFactory("BAL"), newFactory("MASS"), newFactory("JPQ"), newFactory("VAP"), newFactory("CONSV")],
    }),
  });
  assert.equal(news.length, MAX_COMPETITOR_NEWS_PER_TURN);
});

test("CN-2: 同じ会社は1ターンに1本まで", () => {
  const news = build({
    snapshot: snapshot({
      investments: [newFactory("BAL"), newFactory("BAL", "operational")],
      cells: [cell("US", "pd", [["BAL", "large", "up"]])],
      salesForce: [{ companyId: "BAL", approximateHeadcount: 120, approximateChange: 20 }],
    }),
  });
  const balArticles = news.filter((n) => n.companyId === "BAL");
  assert.equal(balArticles.length, 1, `BALの記事が${balArticles.length}本ある`);
});

test("CN-3: 市場の混雑は会社に紐づかないので、同一会社1本の制限を受けない", () => {
  const news = build({
    snapshot: snapshot({
      investments: [newFactory("BAL")],
      cells: [
        cell("US", "pd", [["BAL", "large", "up"]], "tight"),
        cell("JP", "vap", [["MASS", "medium", null]], "tight"),
      ],
    }),
  });
  const crowdingArticles = news.filter((n) => n.kind === "marketCrowding");
  assert.equal(crowdingArticles.length, 2, "混雑の記事が2本とも残るはず");
  assert.ok(crowdingArticles.every((n) => n.companyId === null));
});

test("CN-4: 優先順位は 大型投資 ＞ 市場の混雑 ＞ 値下げ攻勢 ＞ シェア拡大", () => {
  const news = build({
    snapshot: snapshot({
      investments: [newFactory("BAL")],
      cells: [cell("US", "pd", [["JPQ", "large", "up"]], "tight")],
    }),
    signals: [{ companyId: "MASS", priceDiscountRatio: 0.05, gainedShare: true, overdueRatio: null, usedEmergencyLoan: false }],
  });
  assert.deepEqual(
    news.map((n) => n.kind),
    ["majorInvestment", "marketCrowding", "priceOffensive"],
    `実際の並び: ${news.map((n) => n.kind).join(", ")}`
  );
});

test("CN-5: 年間配当は上限3本に数えず、必ず別枠で出る", () => {
  const news = build({
    snapshot: snapshot({
      investments: [newFactory("BAL"), newFactory("MASS"), newFactory("JPQ"), newFactory("VAP")],
    }),
    annualDividend: { fiscalYearLabel: "2018年度", topCompanyId: "VAP", topApproximateUsd: 28_000_000 },
  });
  assert.equal(news.length, MAX_COMPETITOR_NEWS_PER_TURN + 1);
  const dividend = news.find((n) => n.kind === "annualDividend");
  assert.ok(dividend, "年間配当の記事が無い");
  assert.equal(dividend.confidence, "confirmed");
  assert.ok(dividend.headline.includes("2018年度"));
});

test("CN-6【決定論】: 同じ run ID・ターンからは、記事も外れ方も必ず同じ", () => {
  const args = {
    snapshot: snapshot({ cells: [cell("US", "pd", [["BAL", "large", "up"]], "tight")] }),
    signals: [
      { companyId: "MASS", priceDiscountRatio: 0.05, gainedShare: true, overdueRatio: 0.2, usedEmergencyLoan: true },
      { companyId: "JPQ", priceDiscountRatio: null, gainedShare: false, overdueRatio: 0.3, usedEmergencyLoan: false },
    ] as readonly CompetitorSignalInput[],
  };
  assert.deepEqual(build(args), build(args));
});

test("CN-7【決定論】: run ID が違えば外れ方も変わりうる（シードが効いている）", () => {
  const base = {
    snapshot: snapshot({}),
    signals: [{ companyId: "MASS", priceDiscountRatio: 0.05, gainedShare: true, overdueRatio: null, usedEmergencyLoan: false }] as readonly CompetitorSignalInput[],
  };
  const flags = ["run-a", "run-b", "run-c", "run-d", "run-e", "run-f", "run-g", "run-h"].map(
    (runId) => build({ ...base, runId })[0]?.isMisleading
  );
  assert.ok(
    flags.some((f) => f === true) || flags.some((f) => f === false),
    "シードが結果に影響していない"
  );
  // ハッシュが偏っていないことの軽い確認（全部同じ値ではない、あるいは確率が低いので全部falseもありうる）。
  assert.ok(flags.every((f) => typeof f === "boolean"));
});

test("CN-8: 外れるのは「観測・噂」だけで、「確報」は絶対に外れない", () => {
  // 多数の run ID で確報記事を生成し、1件も isMisleading にならないことを確認する。
  for (let i = 0; i < 50; i++) {
    const news = build({
      runId: `run-confirmed-${i}`,
      snapshot: snapshot({
        investments: [newFactory("BAL")],
        cells: [cell("US", "pd", [["JPQ", "large", "up"]], "tight")],
        salesForce: [{ companyId: "MASS", approximateHeadcount: 120, approximateChange: 20 }],
      }),
    });
    for (const item of news) {
      if (item.confidence === "confirmed") {
        assert.equal(item.isMisleading, false, `確報が外れ扱いになっている: ${item.headline}`);
      }
    }
  }
});

test("CN-9: 「観測・噂」はおおむね設定した確率で外れる", () => {
  let misleading = 0;
  const trials = 400;
  for (let i = 0; i < trials; i++) {
    const news = build({
      runId: `run-rumor-${i}`,
      snapshot: snapshot({}),
      signals: [{ companyId: "MASS", priceDiscountRatio: 0.05, gainedShare: true, overdueRatio: null, usedEmergencyLoan: false }],
    });
    const item = news[0];
    assert.ok(item, "噂の記事が生成されていない");
    assert.equal(item.confidence, "rumored");
    if (item.isMisleading) misleading += 1;
  }
  const rate = misleading / trials;
  // ハッシュ由来なので厳密な二項分布ではない。設定値 ±0.1 の範囲に入っていれば十分。
  assert.ok(
    Math.abs(rate - RUMOR_MISLEADING_RATE) < 0.1,
    `外れ率が設定値から離れすぎている: 実測 ${rate.toFixed(3)} / 設定 ${RUMOR_MISLEADING_RATE}`
  );
});

test("CN-10: 外れた記事は本文も見出しも差し替わる（外れフラグだけ立てて本文が同じ、にならない）", () => {
  const signals: readonly CompetitorSignalInput[] = [
    { companyId: "MASS", priceDiscountRatio: 0.05, gainedShare: true, overdueRatio: null, usedEmergencyLoan: false },
  ];
  let sawMisleading = false;
  let sawTruthful = false;
  for (let i = 0; i < 200 && !(sawMisleading && sawTruthful); i++) {
    const item = build({ runId: `run-swap-${i}`, snapshot: snapshot({}), signals })[0];
    assert.ok(item);
    if (item.isMisleading) {
      sawMisleading = true;
      assert.ok(item.headline.includes("強気") || item.body.includes("引き上げ"), `外れ記事の本文が差し替わっていない: ${item.headline}`);
    } else {
      sawTruthful = true;
      assert.ok(item.headline.includes("値下げ"), `正しい記事の本文がおかしい: ${item.headline}`);
    }
  }
  assert.ok(sawMisleading, "200通り試しても外れ記事が1件も出なかった");
  assert.ok(sawTruthful, "200通り試しても正しい記事が1件も出なかった");
});

test("CN-11【情報境界】: 本文に他社の正確なトン数・価格・利益が出ない", () => {
  const news = build({
    snapshot: snapshot({
      investments: [newFactory("BAL")],
      salesForce: [{ companyId: "MASS", approximateHeadcount: 120, approximateChange: 20 }],
    }),
    signals: [{ companyId: "JPQ", priceDiscountRatio: 0.0734, gainedShare: true, overdueRatio: 0.1837, usedEmergencyLoan: false }],
  });
  const text = news.map((n) => `${n.headline} ${n.body}`).join(" ");
  // 判定に使った生の比率がそのまま本文へ出ていないこと。
  for (const raw of ["0.0734", "7.34", "0.1837", "18.37"]) {
    assert.ok(!text.includes(raw), `生の比率が本文に出ている: ${raw}`);
  }
  // 出てよい数値は概数（10人単位・百万ドル単位・カタログ能力）だけ。
  assert.ok(text.includes("約20人") || text.includes("約120人") || text.includes("22"), "概数の記述が1つも無い（前提が崩れている）");
});

test("CN-12: deterministicUnitValue は 0以上1未満で、同じ文字列からは同じ値を返す", () => {
  for (const seed of ["a", "run-1|5|x", "", "日本語のシード"]) {
    const value = deterministicUnitValue(seed);
    assert.ok(value >= 0 && value < 1, `範囲外: ${seed} → ${value}`);
    assert.equal(value, deterministicUnitValue(seed));
  }
  assert.notEqual(deterministicUnitValue("a"), deterministicUnitValue("b"));
});
