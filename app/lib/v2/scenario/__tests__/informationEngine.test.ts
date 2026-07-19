import { test } from "node:test";
import assert from "node:assert/strict";
import { getAvailableInformation } from "../informationEngine";
import { InformationRelease } from "../types";

function release(overrides: Partial<InformationRelease>): InformationRelease {
  return {
    informationId: "id",
    availableFromTurn: 1,
    informationLevel: "public",
    headlineTemplate: "headline",
    structuredFacts: [],
    isRumor: false,
    ...overrides,
  };
}

const RELEASES: readonly InformationRelease[] = [
  release({ informationId: "pub-1", informationLevel: "public", availableFromTurn: 1 }),
  release({ informationId: "std-1", informationLevel: "standard", availableFromTurn: 1 }),
  release({ informationId: "adv-1", informationLevel: "advanced", availableFromTurn: 1 }),
  release({ informationId: "gm-1", informationLevel: "gm", availableFromTurn: 1 }),
  release({ informationId: "pub-future", informationLevel: "public", availableFromTurn: 100 }),
  release({
    informationId: "post-1",
    informationLevel: "postGame",
    availableFromTurn: 1,
    postGameTruth: [{ key: "truth", label: "真実", value: 42 }],
  }),
];

test("publicレベルはpublicの公開済みリリースのみ返す", () => {
  const result = getAvailableInformation(RELEASES, 5, "public");
  assert.deepEqual(
    result.map((r) => r.informationId),
    ["pub-1"]
  );
});

test("standardレベルはpublic+standardの累積アクセス", () => {
  const result = getAvailableInformation(RELEASES, 5, "standard");
  assert.deepEqual(
    result.map((r) => r.informationId).sort(),
    ["pub-1", "std-1"]
  );
});

test("advancedレベルはpublic+standard+advancedの累積アクセス", () => {
  const result = getAvailableInformation(RELEASES, 5, "advanced");
  assert.deepEqual(
    result.map((r) => r.informationId).sort(),
    ["adv-1", "pub-1", "std-1"]
  );
});

test("gmレベルはpostGame以外の全レベルを、現在ターンまでの公開分だけ返す", () => {
  const result = getAvailableInformation(RELEASES, 5, "gm");
  assert.deepEqual(
    result.map((r) => r.informationId).sort(),
    ["adv-1", "gm-1", "pub-1", "std-1"]
  );
});

test("未来のリリース（availableFromTurn > turn）はどの通常レベルでも一切返らない", () => {
  for (const level of ["public", "standard", "advanced", "gm"] as const) {
    const result = getAvailableInformation(RELEASES, 5, level);
    assert.ok(!result.some((r) => r.informationId === "pub-future"));
  }
});

test("postGameレベルはゲーム終了前は空配列", () => {
  const result = getAvailableInformation(RELEASES, 5, "postGame", false);
  assert.deepEqual(result, []);
});

test("postGameレベルはゲーム終了後のみ、availableFromTurnを無視して全リリース＋真実を返す", () => {
  const result = getAvailableInformation(RELEASES, 5, "postGame", true);
  const ids = result.map((r) => r.informationId).sort();
  assert.deepEqual(ids, ["adv-1", "gm-1", "post-1", "pub-1", "pub-future", "std-1"]);
  const post = result.find((r) => r.informationId === "post-1");
  assert.ok(post?.postGameTruth);
  assert.equal(post!.postGameTruth![0].value, 42);
});

test("postGame以外のレベルではpostGameTruthフィールドが常に取り除かれる（多重防御）", () => {
  const withTruth: readonly InformationRelease[] = [
    release({
      informationId: "gm-with-truth",
      informationLevel: "gm",
      availableFromTurn: 1,
      postGameTruth: [{ key: "leak", label: "漏洩してはいけない値", value: 1 }],
    }),
  ];
  const result = getAvailableInformation(withTruth, 5, "gm");
  assert.equal(result.length, 1);
  assert.equal(result[0].postGameTruth, undefined);
});

test("入力配列・要素は変更しない", () => {
  const before = JSON.parse(JSON.stringify(RELEASES));
  getAvailableInformation(RELEASES, 5, "gm");
  getAvailableInformation(RELEASES, 5, "postGame", true);
  assert.deepEqual(JSON.parse(JSON.stringify(RELEASES)), before);
});
