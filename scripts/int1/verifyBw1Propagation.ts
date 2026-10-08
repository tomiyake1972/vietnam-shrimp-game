/**
 * 【BW-1】本物の API route を通した「取りこぼしが無いこと」の検証と、
 * HTTP 1回ごとの Redis GET 対象・転送量の実測。
 *
 * 接続先は、このスクリプトのために起動した隔離ローカル Redis の前に置いた
 * Upstash REST 互換シムだけ。停止中の共有 DB（Staging / Production）へは
 * 一切接続しない。
 *
 * 進める順番（すべて実際の HTTP）
 *   1. Run を保存（part×3 ＋ manifest commit。保存APIをそのまま使う）
 *   2. GM Seat 一覧：初回 → 変化なし（unchanged）
 *   3. 参加link発行 → 同じ known で再取得（Seat 変更が必ず現れる）
 *   4. PLAYER が参加（Cookie）→ 意思決定context取得 → 変化なし（unchanged）
 *   5. PLAYER 提出 → 提出が GM 側・PLAYER 側の両方へ現れる
 *   6. Turn 進行（completedTurns+1 の保存）→ 両方へ現れる
 *
 * ゲーム計算・保存形式・保存競合対策（CAS）は変更していない。
 */
import { createSimulationSession, advanceSimulationTurn } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildResumePayload } from "../../app/lib/v2/companyLab/simulation/persistence/resume";
import { buildDatasetFromSession } from "../../app/lib/v2/companyLab/simulation/analytics/dataset";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../app/lib/v2/companyLab/simulation/persistence/types";
import type { CompanyControlMode, SimulationSession } from "../../app/lib/v2/companyLab/simulation/types";

const BASE = process.env.INT1_APP_URL ?? "http://127.0.0.1:3401";
const SHIM = process.env.INT1_SHIM_URL ?? "http://127.0.0.1:6407";
const ADMIN = process.env.STAGING_ADMIN_TOKEN ?? "";
const RUN_ID = process.env.INT1_RUN_ID ?? `bw1-prop-${Date.now()}`;
const PLAYER_COMPANY = "BAL";
const TURNS = Number(process.env.BW1_TURNS ?? 8);
const AT = "2026-10-08T00:00:00.000Z";

interface ShimEntry {
  readonly command: string;
  readonly key: string;
  readonly bytes: number;
}

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function shimReset(): Promise<void> {
  await fetch(`${SHIM}/__shim/reset`);
}

async function shimLog(): Promise<readonly ShimEntry[]> {
  return (await (await fetch(`${SHIM}/__shim/log`)).json()) as ShimEntry[];
}


function kindOf(key: string): string {
  if (key.includes(":dataset:")) return "dataset";
  if (key.includes(":resume:")) return "resume";
  if (key.includes(":pack:")) return "pack";
  if (key.includes(":manifest")) return "manifest";
  if (key.includes(":seat")) return "seat";
  if (key.includes(":session")) return "session";
  if (key.includes(":summary")) return "summary";
  return "other";
}

function describeGets(label: string, gets: readonly ShimEntry[]): number {
  const bytes = gets.reduce((s, g) => s + g.bytes, 0);
  const parts = gets.map((g) => `${kindOf(g.key)} ${g.bytes.toLocaleString()}B`).join(" + ");
  console.log(`    ${label.padEnd(40)} GET ${String(gets.length).padStart(2)}回 ${bytes.toLocaleString().padStart(10)} B  ${parts || "(なし)"}`);
  return bytes;
}

/** 計測つき HTTP。cookie は呼び出し側が渡す。 */
async function measured(
  label: string,
  path: string,
  init: RequestInit & { readonly cookie?: string } = {}
): Promise<{ readonly status: number; readonly body: Record<string, unknown>; readonly setCookie: string | null; readonly bytes: number; readonly commands: number }> {
  await shimReset();
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  const text = await res.text();
  const all = await shimLog();
  const gets = all.filter((e) => e.command === "GET");
  const bytes = label === "" ? gets.reduce((s, g) => s + g.bytes, 0) : describeGets(label, gets);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { _raw: text.slice(0, 300) };
  }
  return { status: res.status, body, setCookie: res.headers.get("set-cookie"), bytes, commands: all.length };
}

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
}

async function savePart(part: string, value: unknown, revision: number, writeToken: string, expectedBaseRevision: number): Promise<number> {
  const r = await measured(
    `保存 part=${part}`,
    "/api/v2/simulation-runs",
    { method: "POST", headers: adminHeaders(), body: JSON.stringify({ simulationRunId: RUN_ID, revision, part, value, expectedBaseRevision, writeToken }) }
  );
  check(`part=${part} の保存が成功する`, r.status === 200, `status=${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  return r.bytes;
}

async function commitManifest(session: SimulationSession, revision: number, writeToken: string, expectedBaseRevision: number): Promise<number> {
  const r = await measured(
    "保存 manifest commit",
    "/api/v2/simulation-runs",
    {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        manifestOnly: true,
        schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
        run: session.run,
        savedAt: new Date().toISOString(),
        persistenceRevision: revision,
        hasResumePayload: true,
        hasPackCapture: true,
        expectedBaseRevision,
        writeToken,
      }),
    }
  );
  check(`manifest commit revision=${revision} が成功する`, r.status === 200, `status=${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.bytes;
}

async function saveRevision(session: SimulationSession, revision: number, expectedBaseRevision: number): Promise<number> {
  const writeToken = `bw1-prop-${revision}-${Math.random().toString(36).slice(2, 10)}`;
  const dataset = buildDatasetFromSession(session);
  // companyControlModes は resumePayload にも入る（submit 側はこちらを見る）。
  const resumePayload = buildResumePayload(session, { [PLAYER_COMPANY]: "PLAYER" }, {});
  let bytes = 0;
  bytes += await savePart("dataset", dataset, revision, writeToken, expectedBaseRevision);
  bytes += await savePart("resume", resumePayload, revision, writeToken, expectedBaseRevision);
  bytes += await savePart("pack", { note: "BW1 propagation placeholder pack" }, revision, writeToken, expectedBaseRevision);
  bytes += await commitManifest(session, revision, writeToken, expectedBaseRevision);
  return bytes;
}

async function main(): Promise<void> {
  if (!ADMIN) throw new Error("STAGING_ADMIN_TOKEN が未設定です。");
  console.log("# BW-1 本物の API route を通した取りこぼし検証（隔離ローカル Redis ＋ Upstash REST シムのみ）");
  console.log(`# app=${BASE} / shim=${SHIM} / runId=${RUN_ID} / PLAYER=${PLAYER_COMPANY} / ${TURNS}Turn`);

  // ---- 1. Run を保存する ----
  console.log("\n## 1. Run の保存（保存APIをそのまま使う）");
  let session = createSimulationSession({
    simulationRunId: RUN_ID,
    scenarioId: "baseline",
    seed: "bw1-prop",
    requestedTurns: 32,
    startedAt: AT,
    sourceCommit: "BW1",
    companyControlModes: { [PLAYER_COMPANY]: "PLAYER" },
    salesModelId: "tiered-v200-crowding-v1",
  });
  for (let i = 0; i < TURNS; i += 1) {
    const outcome = advanceSimulationTurn(session, AT, {}, "BW1");
    if (!outcome.session) break;
    session = outcome.session;
  }
  const saveBytes = await saveRevision(session, 1, 0);
  console.log(`    保存1回ぶん（part×3 ＋ manifest commit）の読み取り合計 ${saveBytes.toLocaleString()} B`);

  // ---- 2. GM Seat 一覧 ----
  console.log("\n## 2. GM Seat 一覧（初回 → 変化なし）");
  const first = await measured("Seat一覧 初回（known なし）", `/api/v2/management/player-seats/${RUN_ID}`, { headers: adminHeaders() });
  check("初回は完全な一覧が返る", first.status === 200 && first.body.unchanged === false, `status=${first.status}`);
  const rev1 = Number(first.body.persistenceRevision);
  const seatsVersion1 = String(first.body.seatsVersion);
  const companies = (first.body.companies as { companyId: string; controlMode: string; joinIssued: boolean; joined: boolean; hasSubmittedThisTurn: boolean }[]) ?? [];
  const companyIds = companies.map((c) => c.companyId).join(",");
  check(`PLAYER 会社 ${PLAYER_COMPANY} が PLAYER として出る`, companies.find((c) => c.companyId === PLAYER_COMPANY)?.controlMode === "PLAYER");
  check(`currentTurn が返る`, typeof first.body.currentTurn === "number", `currentTurn=${String(first.body.currentTurn)}`);

  const knownQuery = (rev: number, sv: string): string => `?knownRevision=${rev}&knownSeatsVersion=${encodeURIComponent(sv)}&knownCompanyIds=${encodeURIComponent(companyIds)}`;

  const unchanged = await measured("Seat一覧 変化なし", `/api/v2/management/player-seats/${RUN_ID}${knownQuery(rev1, seatsVersion1)}`, { headers: adminHeaders() });
  check("変化が無ければ unchanged=true", unchanged.body.unchanged === true, JSON.stringify(unchanged.body).slice(0, 160));
  check("変化が無いときは dataset / resume / pack を読まない", unchanged.bytes < first.bytes, `${unchanged.bytes} B < ${first.bytes} B`);

  // ---- 3. 参加link発行（Run の revision は変わらない） ----
  console.log("\n## 3. 参加link発行（Seat だけが変わる → 取りこぼさない）");
  const issued = await measured("参加link発行", `/api/v2/management/player-seats/${RUN_ID}/${PLAYER_COMPANY}`, { method: "POST", headers: adminHeaders() });
  check("参加linkが発行できる", issued.status === 200 && typeof issued.body.joinUrl === "string", `status=${issued.status}`);
  const joinUrl = String(issued.body.joinUrl ?? "");
  const joinSecret = joinUrl.split("/").pop() ?? "";

  const afterIssue = await measured("Seat一覧（発行前の known で再取得）", `/api/v2/management/player-seats/${RUN_ID}${knownQuery(rev1, seatsVersion1)}`, { headers: adminHeaders() });
  check("Seat が変わったので unchanged=false", afterIssue.body.unchanged === false, JSON.stringify(afterIssue.body).slice(0, 120));
  const afterIssueCompanies = (afterIssue.body.companies as { companyId: string; joinIssued: boolean }[]) ?? [];
  check("発行が一覧に現れる（joinIssued=true）", afterIssueCompanies.find((c) => c.companyId === PLAYER_COMPANY)?.joinIssued === true);
  check("Run の revision は変わっていない", Number(afterIssue.body.persistenceRevision) === rev1, `${String(afterIssue.body.persistenceRevision)} vs ${rev1}`);
  const seatsVersion2 = String(afterIssue.body.seatsVersion);

  // ---- 4. PLAYER が参加して意思決定context を取る ----
  console.log("\n## 4. PLAYER の参加と意思決定context（初回 → 変化なし）");
  const claim = await measured("参加link claim", `/api/v2/play/join/${joinSecret}`, { method: "POST" });
  check("参加できる", claim.status === 200, `status=${claim.status} ${JSON.stringify(claim.body).slice(0, 160)}`);
  const cookie = (claim.setCookie ?? "").split(";")[0];
  check("Player Session Cookie が発行される", cookie.length > 0);

  const ctx1 = await measured("意思決定context 初回（known なし）", "/api/v2/play/session", { cookie });
  check("context が返る", ctx1.status === 200 && ctx1.body.unchanged === false, `status=${ctx1.status} ${JSON.stringify(ctx1.body).slice(0, 160)}`);
  const playerRev1 = Number(ctx1.body.persistenceRevision);
  const turn1 = Number(ctx1.body.turn);
  check("自社のcontextである", ctx1.body.companyId === PLAYER_COMPANY);
  check("提出前は hasSubmittedThisTurn=false", ctx1.body.hasSubmittedThisTurn === false);

  const ctxUnchanged = await measured("意思決定context 変化なし", `/api/v2/play/session?knownRevision=${playerRev1}`, { cookie });
  check("変化が無ければ unchanged=true", ctxUnchanged.body.unchanged === true, JSON.stringify(ctxUnchanged.body).slice(0, 120));
  check("変化が無いときは dataset / resume / pack を読まない", ctxUnchanged.bytes < ctx1.bytes, `${ctxUnchanged.bytes} B < ${ctx1.bytes} B`);

  // ---- 5. PLAYER 提出 ----
  console.log("\n## 5. PLAYER 提出の反映");
  const submit = await measured("提出", "/api/v2/play/submit", {
    method: "POST",
    cookie,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turn: turn1, draft: ctx1.body.draftSeed }),
  });
  check("提出できる", submit.status === 200, `status=${submit.status} ${JSON.stringify(submit.body).slice(0, 240)}`);

  const ctxAfterSubmit = await measured("意思決定context（提出前の known で再取得）", `/api/v2/play/session?knownRevision=${playerRev1}`, { cookie });
  check("提出で unchanged=false になる", ctxAfterSubmit.body.unchanged === false, JSON.stringify(ctxAfterSubmit.body).slice(0, 120));
  check("提出済みが自分の画面へ現れる", ctxAfterSubmit.body.hasSubmittedThisTurn === true);
  const playerRev2 = Number(ctxAfterSubmit.body.persistenceRevision);
  check("提出で revision が上がる", playerRev2 > playerRev1, `${playerRev1} → ${playerRev2}`);

  const seatsAfterSubmit = await measured("Seat一覧（提出前の known で再取得）", `/api/v2/management/player-seats/${RUN_ID}${knownQuery(rev1, seatsVersion2)}`, { headers: adminHeaders() });
  check("提出で unchanged=false になる", seatsAfterSubmit.body.unchanged === false, JSON.stringify(seatsAfterSubmit.body).slice(0, 120));
  const submitted = (seatsAfterSubmit.body.companies as { companyId: string; hasSubmittedThisTurn: boolean; joined: boolean }[]) ?? [];
  check("提出済みが GM の一覧へ現れる", submitted.find((c) => c.companyId === PLAYER_COMPANY)?.hasSubmittedThisTurn === true);
  check("参加済みが GM の一覧へ現れる", submitted.find((c) => c.companyId === PLAYER_COMPANY)?.joined === true);
  const rev2 = Number(seatsAfterSubmit.body.persistenceRevision);
  const seatsVersion3 = String(seatsAfterSubmit.body.seatsVersion);

  // ---- 6. Turn 進行 ----
  console.log("\n## 6. Turn 進行の反映");
  const advanced = advanceSimulationTurn(session, AT, {}, "BW1");
  if (!advanced.session) throw new Error("Turn を進められませんでした。");
  session = advanced.session;
  const turnSaveBytes = await saveRevision(session, rev2 + 1, rev2);
  console.log(`    Turn進行の保存1回ぶんの読み取り合計 ${turnSaveBytes.toLocaleString()} B`);

  const ctxAfterTurn = await measured("意思決定context（進行前の known で再取得）", `/api/v2/play/session?knownRevision=${playerRev2}`, { cookie });
  check("Turn 進行で unchanged=false になる", ctxAfterTurn.body.unchanged === false, JSON.stringify(ctxAfterTurn.body).slice(0, 120));
  check("新しい Turn が PLAYER 画面へ現れる", Number(ctxAfterTurn.body.turn) > turn1, `${turn1} → ${String(ctxAfterTurn.body.turn)}`);

  const seatsAfterTurn = await measured("Seat一覧（進行前の known で再取得）", `/api/v2/management/player-seats/${RUN_ID}${knownQuery(rev2, seatsVersion3)}`, { headers: adminHeaders() });
  check("Turn 進行で unchanged=false になる", seatsAfterTurn.body.unchanged === false, JSON.stringify(seatsAfterTurn.body).slice(0, 120));
  check("新しい Turn が GM の一覧へ現れる", Number(seatsAfterTurn.body.currentTurn) > Number(first.body.currentTurn), `${String(first.body.currentTurn)} → ${String(seatsAfterTurn.body.currentTurn)}`);
  const afterTurnCompanies = (seatsAfterTurn.body.companies as { companyId: string; hasSubmittedThisTurn: boolean }[]) ?? [];
  check("新しい Turn では未提出へ戻る", afterTurnCompanies.find((c) => c.companyId === PLAYER_COMPANY)?.hasSubmittedThisTurn === false);

  // ---- 7. 失効 ----
  console.log("\n## 7. 参加取り消し（失効）の反映");
  const revAfterTurn = Number(seatsAfterTurn.body.persistenceRevision);
  const svAfterTurn = String(seatsAfterTurn.body.seatsVersion);
  const revoke = await measured("参加取り消し", `/api/v2/management/player-seats/${RUN_ID}/${PLAYER_COMPANY}`, { method: "DELETE", headers: adminHeaders() });
  check("取り消せる", revoke.status === 200, `status=${revoke.status}`);
  const seatsAfterRevoke = await measured("Seat一覧（取り消し前の known で再取得）", `/api/v2/management/player-seats/${RUN_ID}${knownQuery(revAfterTurn, svAfterTurn)}`, { headers: adminHeaders() });
  check("取り消しで unchanged=false になる", seatsAfterRevoke.body.unchanged === false, JSON.stringify(seatsAfterRevoke.body).slice(0, 120));
  const revoked = (seatsAfterRevoke.body.companies as { companyId: string; joinIssued: boolean; joined: boolean }[]) ?? [];
  check("取り消しが一覧へ現れる", revoked.find((c) => c.companyId === PLAYER_COMPANY)?.joinIssued === false);

  // ---- 8. 実プレイ1Turn ぶんの転送量（PLAYER 5社 ＋ GM 1） ----
  await measureFullTurnCycle();

  console.log(`\n## 結果  ${checks - failures}/${checks} PASS`);
  if (failures > 0) process.exit(1);
}

/**
 * 【費用見積りのため】待機時ではなく「実際に1Turn遊んだとき」の読み取り転送量を測る。
 *
 * 1Turn で起きること（研修の実運用）
 *   - PLAYER 5社がそれぞれ1回提出する（提出ごとに revision が上がる）
 *   - revision が上がるたび、開いている全クライアントが次の取得で完全な内容を取り直す
 *     （GM Seat 一覧 1人 ＋ PLAYER 意思決定context 5人）
 *   - 最後に GM が Turn を1つ進める（保存）＋その反映でもう一巡取り直す
 * これらをすべて実際の HTTP で行い、シムが数えた GET のバイト数を合計する。
 */
async function measureFullTurnCycle(): Promise<void> {
  console.log("\n## 8. 実プレイ1Turn ぶんの読み取り転送量（PLAYER 5社 ＋ GM 1）");
  const runId = `${RUN_ID}-cycle`;
  const companyIds = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
  const controlModes: Readonly<Record<string, CompanyControlMode>> = Object.fromEntries(companyIds.map((c) => [c, "PLAYER" as CompanyControlMode]));

  let session = createSimulationSession({
    simulationRunId: runId,
    scenarioId: "baseline",
    seed: "bw1-cycle",
    requestedTurns: 32,
    startedAt: AT,
    sourceCommit: "BW1",
    companyControlModes: controlModes,
    salesModelId: "tiered-v200-crowding-v1",
  });
  for (let i = 0; i < TURNS; i += 1) {
    const outcome = advanceSimulationTurn(session, AT, {}, "BW1");
    if (!outcome.session) break;
    session = outcome.session;
  }

  const saveRevisionFor = async (revision: number, expectedBaseRevision: number): Promise<number> => {
    const writeToken = `bw1-cycle-${revision}-${Math.random().toString(36).slice(2, 10)}`;
    const dataset = buildDatasetFromSession(session);
    const resumePayload = buildResumePayload(session, controlModes, {});
    let bytes = 0;
    for (const [part, value] of [["dataset", dataset], ["resume", resumePayload], ["pack", { note: "BW1 cycle placeholder pack" }]] as const) {
      const r = await measured("", "/api/v2/simulation-runs", {
        method: "POST", headers: adminHeaders(),
        body: JSON.stringify({ simulationRunId: runId, revision, part, value, expectedBaseRevision, writeToken }),
      });
      if (r.status !== 200) throw new Error(`cycle 保存に失敗 part=${part} status=${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      bytes += r.bytes;
    }
    const m = await measured("", "/api/v2/simulation-runs", {
      method: "POST", headers: adminHeaders(),
      body: JSON.stringify({
        manifestOnly: true, schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION, run: session.run,
        savedAt: new Date().toISOString(), persistenceRevision: revision,
        hasResumePayload: true, hasPackCapture: true, expectedBaseRevision, writeToken,
      }),
    });
    if (m.status !== 200) throw new Error(`cycle manifest commit に失敗 status=${m.status} ${JSON.stringify(m.body).slice(0, 200)}`);
    return bytes + m.bytes;
  };

  const total = await saveRevisionFor(1, 0);
  console.log(`    Run の初回保存                        ${total.toLocaleString().padStart(12)} B`);

  // 5社ぶん参加させる。
  const cookies: Record<string, string> = {};
  let joinBytes = 0;
  for (const companyId of companyIds) {
    const issued = await measured("", `/api/v2/management/player-seats/${runId}/${companyId}`, { method: "POST", headers: adminHeaders() });
    if (issued.status !== 200) throw new Error(`cycle 参加link発行に失敗 ${companyId} status=${issued.status}`);
    const secret = String(issued.body.joinUrl ?? "").split("/").pop() ?? "";
    const claim = await measured("", `/api/v2/play/join/${secret}`, { method: "POST" });
    if (claim.status !== 200) throw new Error(`cycle 参加に失敗 ${companyId} status=${claim.status}`);
    cookies[companyId] = (claim.setCookie ?? "").split(";")[0];
    joinBytes += issued.bytes + claim.bytes;
  }
  console.log(`    参加link発行＋参加（5社・Turn毎には発生しない）  ${joinBytes.toLocaleString().padStart(12)} B`);

  // ここから1Turn ぶんを数える。
  let cycle = 0;
  let cycleCommands = 0;
  // 各社が初回の context を取る（画面を開く）。
  // 画面は受け取った draftSeed と turn を手元に持つので、以後 unchanged が返っても
  // それを使って提出できる。ここでも同じように持ち回る。
  const known: Record<string, number> = {};
  const draftByCompany: Record<string, unknown> = {};
  const turnByCompany: Record<string, number> = {};
  for (const companyId of companyIds) {
    const ctx = await measured("", "/api/v2/play/session", { cookie: cookies[companyId] });
    if (ctx.status !== 200) throw new Error(`cycle context 取得に失敗 ${companyId} status=${ctx.status}`);
    known[companyId] = Number(ctx.body.persistenceRevision);
    draftByCompany[companyId] = ctx.body.draftSeed;
    turnByCompany[companyId] = Number(ctx.body.turn);
    cycle += ctx.bytes;
    cycleCommands += ctx.commands;
  }
  let gmKnownRevision = 0;
  let gmKnownSeats = "";
  let gmCommands = 0;
  const gmFetch = async (unconditional: boolean): Promise<number> => {
    const q = unconditional
      ? ""
      : `?knownRevision=${gmKnownRevision}&knownSeatsVersion=${encodeURIComponent(gmKnownSeats)}&knownCompanyIds=${encodeURIComponent(companyIds.join(","))}`;
    const r = await measured("", `/api/v2/management/player-seats/${runId}${q}`, { headers: adminHeaders() });
    if (r.status !== 200) throw new Error(`cycle Seat一覧に失敗 status=${r.status}`);
    if (r.body.unchanged === false) {
      gmKnownRevision = Number(r.body.persistenceRevision);
      gmKnownSeats = String(r.body.seatsVersion);
    }
    gmCommands += r.commands;
    return r.bytes;
  };
  cycle += await gmFetch(true);

  // 5社が順に提出する。提出ごとに revision が上がり、開いている全員が取り直す。
  let submitBytes = 0;
  let refetchBytes = 0;
  for (const companyId of companyIds) {
    const ctx = await measured("", `/api/v2/play/session?knownRevision=${known[companyId]}`, { cookie: cookies[companyId] });
    refetchBytes += ctx.bytes;
    if (ctx.body.unchanged === false) {
      known[companyId] = Number(ctx.body.persistenceRevision);
      draftByCompany[companyId] = ctx.body.draftSeed;
      turnByCompany[companyId] = Number(ctx.body.turn);
    }
    const submit = await measured("", "/api/v2/play/submit", {
      method: "POST", cookie: cookies[companyId], headers: { "content-type": "application/json" },
      body: JSON.stringify({ turn: turnByCompany[companyId], draft: draftByCompany[companyId] }),
    });
    if (submit.status !== 200) throw new Error(`cycle 提出に失敗 ${companyId} status=${submit.status} ${JSON.stringify(submit.body).slice(0, 240)}`);
    submitBytes += submit.bytes;
    cycleCommands += ctx.commands + submit.commands;
    // 提出で revision が上がったので、他の全員と GM が次の取得で取り直す。
    for (const other of companyIds) {
      if (other === companyId) continue;
      const r = await measured("", `/api/v2/play/session?knownRevision=${known[other]}`, { cookie: cookies[other] });
      if (r.body.unchanged === false) {
        known[other] = Number(r.body.persistenceRevision);
        draftByCompany[other] = r.body.draftSeed;
        turnByCompany[other] = Number(r.body.turn);
      }
      refetchBytes += r.bytes;
      cycleCommands += r.commands;
    }
    refetchBytes += await gmFetch(false);
  }

  // GM が Turn を1つ進める。
  const advanced = advanceSimulationTurn(session, AT, {}, "BW1");
  if (!advanced.session) throw new Error("cycle で Turn を進められなかった");
  session = advanced.session;
  const baseRevision = Number(gmKnownRevision);
  const turnSaveBytes = await saveRevisionFor(baseRevision + 1, baseRevision);
  // 進行の反映で全員が取り直す。
  let advanceRefetch = 0;
  for (const companyId of companyIds) {
    const r = await measured("", `/api/v2/play/session?knownRevision=${known[companyId]}`, { cookie: cookies[companyId] });
    if (r.body.unchanged === false) known[companyId] = Number(r.body.persistenceRevision);
    advanceRefetch += r.bytes;
    cycleCommands += r.commands;
  }
  advanceRefetch += await gmFetch(false);

  const perTurn = refetchBytes + submitBytes + turnSaveBytes + advanceRefetch;
  console.log(`    画面を開く初回取得（PLAYER5＋GM・Turn毎には発生しない） ${cycle.toLocaleString().padStart(12)} B`);
  console.log(`    提出 5回（保存側の読み取り）              ${submitBytes.toLocaleString().padStart(12)} B`);
  console.log(`    提出による取り直し（PLAYER4人＋GM）×5回   ${refetchBytes.toLocaleString().padStart(12)} B`);
  console.log(`    Turn進行の保存                        ${turnSaveBytes.toLocaleString().padStart(12)} B`);
  console.log(`    Turn進行による取り直し（PLAYER5＋GM）    ${advanceRefetch.toLocaleString().padStart(12)} B`);
  console.log(`    1Turn 合計                           ${perTurn.toLocaleString().padStart(12)} B  = ${(perTurn / 1024 / 1024).toFixed(1)} MB`);
  console.log(`    32Turn 換算                                        ${((perTurn * 32) / 1024 / 1024 / 1024).toFixed(2)} GB`);
  const perTurnCommands = cycleCommands + gmCommands;
  console.log(`    1Turn のコマンド数                        ${perTurnCommands.toLocaleString().padStart(12)} 回`);
  console.log(`    32Turn 換算                               ${(perTurnCommands * 32).toLocaleString().padStart(12)} 回`);
  console.log("    ※ 待機（誰も操作していない）ぶんは別。上は操作に伴う必要な取り直しのみ。");
  console.log("    ※ pack は計測用の小さい代替値。本番の pack はこれより大きいので実際は増える。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
