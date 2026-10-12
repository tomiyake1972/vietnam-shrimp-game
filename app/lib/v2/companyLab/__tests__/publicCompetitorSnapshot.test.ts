// ShrimpX V2 — 公開競合情報スナップショットのテスト（PUBLIC-COMPETITOR-1）
//
// ここで固定したいのは次の3点。
//  (1) 帯・混雑度・概数の丸め方が仕様どおりであること
//  (2) 他社の正確な数値が DTO に現れないこと（自社だけ exactShare を持つ）
//  (3) 同じ入力からは必ず同じ出力になること（リプレイしても帯が変わらない）

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGameStartCompetitorSnapshot,
  buildPublicCompetitorSnapshot,
  classifyCrowdingBand,
  classifyShareBand,
  compareShareBand,
  CompetitorShareEntry,
} from "../publicCompetitorSnapshot";
import { CompanyQuarterRecord } from "../types";
import { SalesContract } from "../../sales/types";

const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;

/**
 * テスト用の最小 CompanyQuarterRecord。
 * スナップショットが読むのは salesRecord.allocations / crowdingDiagnostics /
 * decisions / turn だけなので、それ以外は空で足りる。
 */
function makeRecord(input: {
  readonly turn: number;
  /** [market, product, [[companyId, quantity], ...]] */
  readonly cells: readonly (readonly [string, string, readonly (readonly [string, number])[]])[];
  readonly crowdingRatioByCell?: Readonly<Record<string, number>>;
  readonly hires?: Readonly<Record<string, number>>;
  readonly layoffs?: Readonly<Record<string, number>>;
}): CompanyQuarterRecord {
  const allocations = input.cells.map(([market, product, companies]) => ({
    market,
    product,
    targetDemand: companies.reduce((s, [, q]) => s + q, 0),
    companies: companies.map(([companyId, quantity]) => ({ companyId, allocatedQuantity: quantity })),
  }));
  const buckets = Object.entries(input.crowdingRatioByCell ?? {}).map(([key, ratio]) => {
    const [market, product] = key.split("|");
    return { market, product, crowdingRatio: ratio };
  });
  const decisions = COMPANIES.map((companyId) => ({
    companyId,
    ...(input.hires?.[companyId] !== undefined ? { salesForceHireCount: input.hires[companyId] } : {}),
    ...(input.layoffs?.[companyId] !== undefined ? { salesForceLayoffCount: input.layoffs[companyId] } : {}),
  }));
  return {
    turn: input.turn,
    decisions,
    salesRecord: { allocations },
    ...(buckets.length > 0 ? { crowdingDiagnostics: { buckets } } : {}),
    companySummaries: [],
  } as unknown as CompanyQuarterRecord;
}

function makeContract(companyId: string, market: string, product: string, quantity: number): SalesContract {
  return { companyId, market, product, outstandingQuantity: quantity } as unknown as SalesContract;
}

const HEADCOUNTS = new Map<string, number>([
  ["BAL", 124],
  ["MASS", 100],
  ["JPQ", 76],
  ["VAP", 71],
  ["CONSV", 60],
]);

function entryFor(shares: readonly CompetitorShareEntry[], companyId: string): CompetitorShareEntry {
  const found = shares.find((s) => s.companyId === companyId);
  assert.ok(found, `${companyId} の行が無い`);
  return found;
}

// ---------------------------------------------------------------------

test("PC-1: シェア帯のしきい値は 40 / 25 / 10%。5社均等（20%）は「中」の内側に入る", () => {
  assert.equal(classifyShareBand(0.45), "leader");
  assert.equal(classifyShareBand(0.4), "leader");
  assert.equal(classifyShareBand(0.39), "large");
  assert.equal(classifyShareBand(0.25), "large");
  assert.equal(classifyShareBand(0.2), "medium", "5社均等は中であるはず");
  assert.equal(classifyShareBand(0.1), "medium");
  assert.equal(classifyShareBand(0.09), "small");
  assert.equal(classifyShareBand(0), "none");
});

test("PC-2: 混雑度は 0.8 未満が余裕、1.1 以上が混雑", () => {
  assert.equal(classifyCrowdingBand(0.79), "loose");
  assert.equal(classifyCrowdingBand(0.8), "normal");
  assert.equal(classifyCrowdingBand(1.09), "normal");
  assert.equal(classifyCrowdingBand(1.1), "tight");
  assert.equal(classifyCrowdingBand(2.5), "tight");
});

test("PC-3: 帯の↑↓は比較対象が無ければ null（flat と区別する）", () => {
  assert.equal(compareShareBand("large", null), null);
  assert.equal(compareShareBand("large", "medium"), "up");
  assert.equal(compareShareBand("medium", "large"), "down");
  assert.equal(compareShareBand("medium", "medium"), "flat");
});

test("PC-4: シェアは5社の中での割合で、帯へ丸められる", () => {
  const record = makeRecord({
    turn: 2,
    cells: [["US", "pd", [["BAL", 500], ["MASS", 100], ["JPQ", 250], ["VAP", 150]]]],
  });
  const snapshot = buildPublicCompetitorSnapshot({
    record,
    previousRecord: null,
    companyIds: [...COMPANIES],
    ownCompanyId: "BAL",
    salesForceHeadcountByCompanyId: HEADCOUNTS,
  });
  const cell = snapshot.cells.find((c) => c.market === "US" && c.product === "pd");
  assert.ok(cell);
  // 合計1,000t に対して BAL 50% / MASS 10% / JPQ 25% / VAP 15% / CONSV 0%
  assert.equal(entryFor(cell.shares, "BAL").band, "leader");
  assert.equal(entryFor(cell.shares, "MASS").band, "medium");
  assert.equal(entryFor(cell.shares, "JPQ").band, "large");
  assert.equal(entryFor(cell.shares, "VAP").band, "medium");
  assert.equal(entryFor(cell.shares, "CONSV").band, "none");
});

test("PC-5【情報境界】: 正確なシェアは自社の行にだけ付き、他社の行にはキー自体が無い", () => {
  const record = makeRecord({
    turn: 2,
    cells: [["JP", "vap", [["BAL", 274], ["MASS", 726]]]],
  });
  const snapshot = buildPublicCompetitorSnapshot({
    record,
    previousRecord: null,
    companyIds: [...COMPANIES],
    ownCompanyId: "BAL",
    salesForceHeadcountByCompanyId: HEADCOUNTS,
  });
  const cell = snapshot.cells[0];
  assert.ok(cell);

  const own = entryFor(cell.shares, "BAL");
  assert.ok(own.exactShare !== undefined, "自社には正確なシェアが付くはず");
  assert.ok(Math.abs(own.exactShare - 0.274) < 1e-9, `自社の正確なシェア: ${own.exactShare}`);

  for (const other of cell.shares.filter((s) => s.companyId !== "BAL")) {
    assert.ok(!("exactShare" in other), `他社 ${other.companyId} に exactShare のキーがある`);
  }

  // DTO 全体を文字列化しても、他社の正確なトン数（726 / 0.726）が現れないこと。
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes("726"), "他社の正確な数量・シェアが DTO に現れている");
});

test("PC-6: 混雑度はエンジンの crowding 診断がある四半期だけ出る。無い四半期は null（代理指標を作らない）", () => {
  const cells = [["US", "pd", [["BAL", 600], ["MASS", 400]]]] as const;
  const withDiagnostics = buildPublicCompetitorSnapshot({
    record: makeRecord({ turn: 2, cells: [...cells], crowdingRatioByCell: { "US|pd": 1.25 } }),
    previousRecord: null,
    companyIds: [...COMPANIES],
    ownCompanyId: "BAL",
    salesForceHeadcountByCompanyId: HEADCOUNTS,
  });
  assert.equal(withDiagnostics.cells[0]?.crowding, "tight");

  const withoutDiagnostics = buildPublicCompetitorSnapshot({
    record: makeRecord({ turn: 2, cells: [...cells] }),
    previousRecord: null,
    companyIds: [...COMPANIES],
    ownCompanyId: "BAL",
    salesForceHeadcountByCompanyId: HEADCOUNTS,
  });
  assert.equal(withoutDiagnostics.cells[0]?.crowding, null);
});

test("PC-7: 同じ市場×商品が複数の納期バケツに分かれる場合、最も混んだ値を採る", () => {
  const snapshot = buildPublicCompetitorSnapshot({
    record: {
      ...makeRecord({ turn: 2, cells: [["US", "pd", [["BAL", 600], ["MASS", 400]]]] }),
      crowdingDiagnostics: {
        buckets: [
          { market: "US", product: "pd", crowdingRatio: 0.5 },
          { market: "US", product: "pd", crowdingRatio: 1.4 },
        ],
      },
    } as unknown as CompanyQuarterRecord,
    previousRecord: null,
    companyIds: [...COMPANIES],
    ownCompanyId: "BAL",
    salesForceHeadcountByCompanyId: HEADCOUNTS,
  });
  assert.equal(snapshot.cells[0]?.crowding, "tight", "一部の納期だけ強く混んでいる状況が薄まって消えてはいけない");
});

test("PC-8: 営業人員は10人単位の概数。増減は実数の増減を丸めた値で、概数どうしの差ではない", () => {
  const snapshot = buildPublicCompetitorSnapshot({
    // BAL は前Turnに7人採用した（64 → 71人）。
    record: makeRecord({ turn: 2, cells: [["US", "pd", [["BAL", 100]]]], hires: { BAL: 7 }, layoffs: { MASS: 3 } }),
    previousRecord: null,
    companyIds: [...COMPANIES],
    ownCompanyId: "BAL",
    salesForceHeadcountByCompanyId: new Map([["BAL", 71], ["MASS", 100], ["JPQ", 76], ["VAP", 71], ["CONSV", 60]]),
  });
  const bal = snapshot.salesForce.find((s) => s.companyId === "BAL");
  assert.ok(bal);
  assert.equal(bal.approximateHeadcount, 70, "71人は約70人");
  assert.equal(bal.approximateChange, 10, "+7人は10人単位で +10人");

  const mass = snapshot.salesForce.find((s) => s.companyId === "MASS");
  assert.ok(mass);
  assert.equal(mass.approximateChange, 0, "-3人は10人単位では 0（±0）");
});

test("PC-9: Turn 1 は初期受注残を勢力図として出し、出所を GAME_START_BACKLOG と明示する", () => {
  const snapshot = buildGameStartCompetitorSnapshot({
    contracts: [
      makeContract("BAL", "US", "pd", 400),
      makeContract("MASS", "US", "pd", 600),
      makeContract("JPQ", "JP", "vap", 1000),
    ],
    companyIds: [...COMPANIES],
    ownCompanyId: "BAL",
    salesForceHeadcountByCompanyId: HEADCOUNTS,
  });

  assert.equal(snapshot.source, "GAME_START_BACKLOG");
  assert.equal(snapshot.sourceTurn, 1);

  const usPd = snapshot.cells.find((c) => c.market === "US" && c.product === "pd");
  assert.ok(usPd);
  // 400 / (400+600) = 40% ちょうど＝しきい値の下限なので首位級。
  assert.equal(entryFor(usPd.shares, "BAL").band, "leader");
  assert.equal(entryFor(usPd.shares, "MASS").band, "leader", "600/1000 = 60%");
  const jpVap = snapshot.cells.find((c) => c.market === "JP" && c.product === "vap");
  assert.ok(jpVap);
  assert.equal(entryFor(jpVap.shares, "JPQ").band, "leader", "JP/VAP は JPQ の独占（100%）");
  assert.equal(entryFor(jpVap.shares, "BAL").band, "none", "BAL は JP/VAP に出していない");
});

test("PC-10: Turn 1 は比較対象が無いので帯の↑↓は全て null、混雑度も null", () => {
  const snapshot = buildGameStartCompetitorSnapshot({
    contracts: [makeContract("BAL", "US", "pd", 400), makeContract("MASS", "US", "pd", 600)],
    companyIds: [...COMPANIES],
    ownCompanyId: "BAL",
    salesForceHeadcountByCompanyId: HEADCOUNTS,
  });
  for (const cell of snapshot.cells) {
    assert.equal(cell.crowding, null, "開始時点では提示が一度も行われていないので混雑度は存在しない");
    for (const share of cell.shares) assert.equal(share.trend, null);
  }
  for (const entry of snapshot.salesForce) assert.equal(entry.approximateChange, null);
});

test("PC-11【決定論】: 同じ入力からは必ず同じスナップショットが返る", () => {
  const args = {
    record: makeRecord({
      turn: 5,
      cells: [
        ["US", "pd", [["BAL", 500], ["MASS", 300], ["JPQ", 200]]],
        ["JP", "vap", [["VAP", 800], ["JPQ", 200]]],
      ],
      crowdingRatioByCell: { "US|pd": 1.3 },
      hires: { BAL: 20 },
    }),
    previousRecord: makeRecord({ turn: 4, cells: [["US", "pd", [["BAL", 100], ["MASS", 900]]]] }),
    companyIds: [...COMPANIES],
    ownCompanyId: "BAL",
    salesForceHeadcountByCompanyId: HEADCOUNTS,
  };
  const first = buildPublicCompetitorSnapshot(args);
  const second = buildPublicCompetitorSnapshot(args);
  assert.deepEqual(first, second);
});

test("PC-12: 前四半期と比べて帯が上がったマスは up になる", () => {
  const snapshot = buildPublicCompetitorSnapshot({
    // BAL は 10% → 50% へ上昇、MASS は 90% → 30% へ下落。
    record: makeRecord({ turn: 5, cells: [["US", "pd", [["BAL", 500], ["MASS", 300], ["JPQ", 200]]]] }),
    previousRecord: makeRecord({ turn: 4, cells: [["US", "pd", [["BAL", 100], ["MASS", 900]]]] }),
    companyIds: [...COMPANIES],
    ownCompanyId: "BAL",
    salesForceHeadcountByCompanyId: HEADCOUNTS,
  });
  const cell = snapshot.cells[0];
  assert.ok(cell);
  assert.equal(entryFor(cell.shares, "BAL").trend, "up");
  assert.equal(entryFor(cell.shares, "MASS").trend, "down");
});
