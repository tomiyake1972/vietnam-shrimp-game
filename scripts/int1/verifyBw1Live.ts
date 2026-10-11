/**
 * 【BW-1 §5】配備済み Preview ＋ 共有 Redis での実機検証。
 *
 * 隔離環境ではなく、実際に配備された Preview の HTTP API と共有 DB を使う。
 * 既存 Run は読まない・書かない・消さない。このスクリプト専用の新しい Run だけを作る。
 * Redis の GET バイト数は外から見えないため、ここで測るのは HTTP 応答のバイト数。
 * 「変化が無いときに応答が小さい」ことが BW-1 が効いている外からの証拠になる。
 *
 * 確認する順番
 *   1. 共有 DB が読めること（Active であること）
 *   2. 保存（part×3 ＋ manifest commit）
 *   3. 再開（保存したものを読み直して Run が復元できる）
 *   4. GM Seat 一覧: 初回 → 変化なし（unchanged）→ 参加link発行で必ず変化が現れる
 *   5. PLAYER 参加 → 意思決定context（初回 → 変化なし）
 *   6. PLAYER 提出 → PLAYER 側・GM 側の両方へ現れる
 *   7. Turn 進行 → 両方へ現れる・未提出へ戻る
 *   8. 後片付け（作った検証 Run を消す）
 *
 * ゲーム計算・保存形式・保存競合対策（CAS）は変更していない。
 */
import { createSimulationSession, advanceSimulationTurn } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildResumePayload } from "../../app/lib/v2/companyLab/simulation/persistence/resume";
import { buildDatasetFromSession } from "../../app/lib/v2/companyLab/simulation/analytics/dataset";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../app/lib/v2/companyLab/simulation/persistence/types";
import type { SimulationSession } from "../../app/lib/v2/companyLab/simulation/types";

const BASE = process.env.INT1_APP_URL ?? "";
const ADMIN = process.env.STAGING_ADMIN_TOKEN ?? "";
const RUN_ID = process.env.INT1_RUN_ID ?? `bw1-live-verify-${new Date().toISOString().replace(/[:.]/g, "")}`;
const PLAYER_COMPANY = "BAL";
const TURNS = Number(process.env.BW1_TURNS ?? 4);
const AT = "2026-10-09T00:00:00.000Z";
const KEEP = process.env.INT1_KEEP_RUN === "1";

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

interface Res {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly setCookie: string | null;
  readonly bytes: number;
  readonly ms: number;
}

/** HTTP 1回。応答バイト数と所要時間を記録する（Redis のバイト数は外からは見えない）。 */
async function call(label: string, path: string, init: RequestInit & { readonly cookie?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  const text = await res.text();
  const ms = Date.now() - started;
  const bytes = Buffer.byteLength(text, "utf8");
  if (label) {
    console.log(`    ${label.padEnd(44)} ${String(res.status)} ${bytes.toLocaleString().padStart(10)} B  ${String(ms).padStart(5)} ms`);
  }
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { _raw: text.slice(0, 300) };
  }
  return { status: res.status, body, setCookie: res.headers.get("set-cookie"), bytes, ms };
}

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
}

async function savePart(part: string, value: unknown, revision: number, writeToken: string, expectedBaseRevision: number): Promise<void> {
  const r = await call(`保存 part=${part}`, "/api/v2/simulation-runs", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ simulationRunId: RUN_ID, revision, part, value, expectedBaseRevision, writeToken }),
  });
  check(`part=${part} の保存が成功する`, r.status === 200, `status=${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
}

async function saveRevision(session: SimulationSession, revision: number, expectedBaseRevision: number): Promise<void> {
  const writeToken = `bw1-live-${revision}-${Math.random().toString(36).slice(2, 10)}`;
  await savePart("dataset", buildDatasetFromSession(session), revision, writeToken, expectedBaseRevision);
  await savePart("resume", buildResumePayload(session, { [PLAYER_COMPANY]: "PLAYER" }, {}), revision, writeToken, expectedBaseRevision);
  await savePart("pack", { note: "BW1 live verification placeholder pack" }, revision, writeToken, expectedBaseRevision);
  const r = await call("保存 manifest commit", "/api/v2/simulation-runs", {
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
  });
  check(`manifest commit revision=${revision} が成功する`, r.status === 200, `status=${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
}

async function main(): Promise<void> {
  if (!BASE) throw new Error("INT1_APP_URL が未設定です。");
  if (!ADMIN) throw new Error("STAGING_ADMIN_TOKEN が未設定です。");
  console.log("# BW-1 実機検証（配備済み Preview ＋ 共有 Redis）");
  console.log(`# app=${BASE}`);
  console.log(`# 検証用 runId=${RUN_ID} / PLAYER=${PLAYER_COMPANY} / ${TURNS}Turn 進めた状態から開始`);
  console.log("# 既存 Run は読み書きしない。作った検証 Run は最後に消す。");

  // ---- 1. 共有 DB が読めるか（Active か） ----
  console.log("\n## 1. 共有 DB の疎通（Active かどうか）");
  const list = await call("Run 一覧 1件（読み取りのみ）", "/api/v2/simulation-runs?limit=1", { headers: adminHeaders() });
  check("共有 DB から読み取れる（＝停止していない）", list.status === 200, `status=${list.status} ${JSON.stringify(list.body).slice(0, 200)}`);
  if (list.status !== 200) {
    console.log("\n## 共有 DB が読めないため、ここで中止する（契約変更は行わない）。");
    console.log(`## 応答: ${JSON.stringify(list.body).slice(0, 500)}`);
    process.exit(2);
  }
  const existing = (list.body.runs as unknown[] | undefined)?.length ?? 0;
  console.log(`    既存 Run は読み取りのみ（1件だけ取得して疎通確認に使用。件数=${existing}）`);

  // ---- 2. 保存 ----
  console.log("\n## 2. 保存（part×3 ＋ manifest commit）");
  let session = createSimulationSession({
    simulationRunId: RUN_ID,
    scenarioId: "baseline",
    seed: "bw1-live",
    requestedTurns: 32,
    startedAt: AT,
    sourceCommit: "BW1-live",
    companyControlModes: { [PLAYER_COMPANY]: "PLAYER" },
    salesModelId: "tiered-v200-crowding-v1",
  });
  for (let i = 0; i < TURNS; i += 1) {
    const outcome = advanceSimulationTurn(session, AT, {}, "BW1-live");
    if (!outcome.session) break;
    session = outcome.session;
  }
  const savedTurns = session.run.completedTurns;
  await saveRevision(session, 1, 0);

  // ---- 3. 再開 ----
  console.log("\n## 3. 再開（保存したものを読み直して復元できる）");
  const reload = await call("Run 1件を読み直す", `/api/v2/simulation-runs/${RUN_ID}`, { headers: adminHeaders() });
  check("保存した Run が読める", reload.status === 200, `status=${reload.status}`);
  // 応答の body が StoredSimulationRun そのもの（handleLoadSimulationRun は stored を直接返す）。
  const stored = reload.body;
  const run = (stored.run ?? {}) as Record<string, unknown>;
  check("completedTurns が保存した値と一致する", Number(run.completedTurns) === savedTurns, `${String(run.completedTurns)} vs ${savedTurns}`);
  check("persistenceRevision が 1 である", Number(stored.persistenceRevision) === 1, String(stored.persistenceRevision));
  const resume = stored.resumePayload as Record<string, unknown> | undefined;
  check("resumePayload が復元される", resume !== undefined && resume !== null);
  const modes = (resume?.companyControlModes ?? {}) as Record<string, string>;
  check(`${PLAYER_COMPANY} が PLAYER として復元される`, modes[PLAYER_COMPANY] === "PLAYER", JSON.stringify(modes));
  check("dataset が復元される", stored.dataset !== undefined && stored.dataset !== null);

  // ---- 4. GM Seat 一覧 ----
  console.log("\n## 4. GM Seat 一覧（初回 → 変化なし → 参加link発行）");
  const first = await call("Seat一覧 初回（known なし）", `/api/v2/management/player-seats/${RUN_ID}`, { headers: adminHeaders() });
  check("初回は完全な一覧が返る", first.status === 200 && first.body.unchanged === false, `status=${first.status}`);
  const rev1 = Number(first.body.persistenceRevision);
  const sv1 = String(first.body.seatsVersion);
  const companies = (first.body.companies as { companyId: string; controlMode: string; joinIssued: boolean; joined: boolean; hasSubmittedThisTurn: boolean }[]) ?? [];
  const companyIds = companies.map((c) => c.companyId).join(",");
  check(`${PLAYER_COMPANY} が PLAYER として出る`, companies.find((c) => c.companyId === PLAYER_COMPANY)?.controlMode === "PLAYER");
  const knownQuery = (rev: number, sv: string): string =>
    `?knownRevision=${rev}&knownSeatsVersion=${encodeURIComponent(sv)}&knownCompanyIds=${encodeURIComponent(companyIds)}`;

  const unchanged = await call("Seat一覧 変化なし", `/api/v2/management/player-seats/${RUN_ID}${knownQuery(rev1, sv1)}`, { headers: adminHeaders() });
  check("変化が無ければ unchanged=true", unchanged.body.unchanged === true, JSON.stringify(unchanged.body).slice(0, 160));
  // 外から見えるのは HTTP 応答のサイズだけ。Redis 側の読み取り削減（3,251,246 B → 771 B）は
  // 隔離環境での実測であり、ここでは「変化が無いときは完全な一覧を返さない」ことを確認する。
  check("変化が無いときは完全な一覧を返さない", unchanged.bytes < first.bytes / 2 && unchanged.body.companies === undefined, `${unchanged.bytes} B vs 初回 ${first.bytes} B`);

  const issued = await call("参加link発行", `/api/v2/management/player-seats/${RUN_ID}/${PLAYER_COMPANY}`, { method: "POST", headers: adminHeaders() });
  check("参加linkが発行できる", issued.status === 200 && typeof issued.body.joinUrl === "string", `status=${issued.status}`);
  const joinSecret = String(issued.body.joinUrl ?? "").split("/").pop() ?? "";

  const afterIssue = await call("Seat一覧（発行前の known で再取得）", `/api/v2/management/player-seats/${RUN_ID}${knownQuery(rev1, sv1)}`, { headers: adminHeaders() });
  check("Seat が変わったので unchanged=false", afterIssue.body.unchanged === false, JSON.stringify(afterIssue.body).slice(0, 120));
  check("発行が一覧に現れる", (afterIssue.body.companies as { companyId: string; joinIssued: boolean }[] ?? []).find((c) => c.companyId === PLAYER_COMPANY)?.joinIssued === true);
  check("Run の revision は変わっていない", Number(afterIssue.body.persistenceRevision) === rev1, `${String(afterIssue.body.persistenceRevision)} vs ${rev1}`);
  const sv2 = String(afterIssue.body.seatsVersion);

  // ---- 5. PLAYER 参加と意思決定context ----
  console.log("\n## 5. PLAYER の参加と意思決定context（初回 → 変化なし）");
  const claim = await call("参加link claim", `/api/v2/play/join/${joinSecret}`, { method: "POST" });
  check("参加できる", claim.status === 200, `status=${claim.status} ${JSON.stringify(claim.body).slice(0, 200)}`);
  const cookie = (claim.setCookie ?? "").split(";")[0];
  check("Player Session Cookie が発行される", cookie.length > 0);

  const ctx1 = await call("意思決定context 初回（known なし）", "/api/v2/play/session", { cookie });
  check("context が返る", ctx1.status === 200 && ctx1.body.unchanged === false, `status=${ctx1.status} ${JSON.stringify(ctx1.body).slice(0, 200)}`);
  const playerRev1 = Number(ctx1.body.persistenceRevision);
  const turn1 = Number(ctx1.body.turn);
  check("自社のcontextである", ctx1.body.companyId === PLAYER_COMPANY);
  check("提出前は hasSubmittedThisTurn=false", ctx1.body.hasSubmittedThisTurn === false);

  const ctxUnchanged = await call("意思決定context 変化なし", `/api/v2/play/session?knownRevision=${playerRev1}`, { cookie });
  check("変化が無ければ unchanged=true", ctxUnchanged.body.unchanged === true, JSON.stringify(ctxUnchanged.body).slice(0, 120));
  check("変化が無いときは完全な context を返さない", ctxUnchanged.bytes < ctx1.bytes / 10 && ctxUnchanged.body.fixture === undefined, `${ctxUnchanged.bytes} B vs 初回 ${ctx1.bytes} B`);

  // ---- 6. PLAYER 提出 ----
  console.log("\n## 6. PLAYER 提出の反映");
  const submit = await call("提出", "/api/v2/play/submit", {
    method: "POST",
    cookie,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turn: turn1, draft: ctx1.body.draftSeed }),
  });
  check("提出できる", submit.status === 200, `status=${submit.status} ${JSON.stringify(submit.body).slice(0, 300)}`);

  const ctxAfterSubmit = await call("意思決定context（提出前の known で再取得）", `/api/v2/play/session?knownRevision=${playerRev1}`, { cookie });
  check("提出で unchanged=false になる", ctxAfterSubmit.body.unchanged === false, JSON.stringify(ctxAfterSubmit.body).slice(0, 120));
  check("提出済みが自分の画面へ現れる", ctxAfterSubmit.body.hasSubmittedThisTurn === true);
  const playerRev2 = Number(ctxAfterSubmit.body.persistenceRevision);
  check("提出で revision が上がる", playerRev2 > playerRev1, `${playerRev1} → ${playerRev2}`);

  const seatsAfterSubmit = await call("Seat一覧（提出前の known で再取得）", `/api/v2/management/player-seats/${RUN_ID}${knownQuery(rev1, sv2)}`, { headers: adminHeaders() });
  check("提出で unchanged=false になる", seatsAfterSubmit.body.unchanged === false, JSON.stringify(seatsAfterSubmit.body).slice(0, 120));
  const submitted = (seatsAfterSubmit.body.companies as { companyId: string; hasSubmittedThisTurn: boolean; joined: boolean }[]) ?? [];
  check("提出済みが GM の一覧へ現れる", submitted.find((c) => c.companyId === PLAYER_COMPANY)?.hasSubmittedThisTurn === true);
  check("参加済みが GM の一覧へ現れる", submitted.find((c) => c.companyId === PLAYER_COMPANY)?.joined === true);
  const rev2 = Number(seatsAfterSubmit.body.persistenceRevision);
  const sv3 = String(seatsAfterSubmit.body.seatsVersion);

  // ---- 7. Turn 進行 ----
  console.log("\n## 7. Turn 進行の反映");
  const advanced = advanceSimulationTurn(session, AT, {}, "BW1-live");
  if (!advanced.session) throw new Error("Turn を進められませんでした。");
  session = advanced.session;
  await saveRevision(session, rev2 + 1, rev2);

  const ctxAfterTurn = await call("意思決定context（進行前の known で再取得）", `/api/v2/play/session?knownRevision=${playerRev2}`, { cookie });
  check("Turn 進行で unchanged=false になる", ctxAfterTurn.body.unchanged === false, JSON.stringify(ctxAfterTurn.body).slice(0, 120));
  check("新しい Turn が PLAYER 画面へ現れる", Number(ctxAfterTurn.body.turn) > turn1, `${turn1} → ${String(ctxAfterTurn.body.turn)}`);

  const seatsAfterTurn = await call("Seat一覧（進行前の known で再取得）", `/api/v2/management/player-seats/${RUN_ID}${knownQuery(rev2, sv3)}`, { headers: adminHeaders() });
  check("Turn 進行で unchanged=false になる", seatsAfterTurn.body.unchanged === false, JSON.stringify(seatsAfterTurn.body).slice(0, 120));
  check("新しい Turn が GM の一覧へ現れる", Number(seatsAfterTurn.body.currentTurn) > Number(first.body.currentTurn), `${String(first.body.currentTurn)} → ${String(seatsAfterTurn.body.currentTurn)}`);
  check("新しい Turn では未提出へ戻る", (seatsAfterTurn.body.companies as { companyId: string; hasSubmittedThisTurn: boolean }[] ?? []).find((c) => c.companyId === PLAYER_COMPANY)?.hasSubmittedThisTurn === false);

  // ---- 8. 後片付け ----
  console.log("\n## 8. 後片付け（作った検証 Run を消す）");
  if (KEEP) {
    console.log(`    INT1_KEEP_RUN=1 のため ${RUN_ID} は残す。`);
  } else {
    const del = await call("検証 Run の削除", `/api/v2/simulation-runs/${RUN_ID}`, { method: "DELETE", headers: adminHeaders() });
    check("検証 Run を消せる", del.status === 200 || del.status === 204, `status=${del.status} ${JSON.stringify(del.body).slice(0, 160)}`);
    const gone = await call("削除後に読めないこと", `/api/v2/simulation-runs/${RUN_ID}`, { headers: adminHeaders() });
    check("削除後は読めない", gone.status === 404, `status=${gone.status}`);
  }

  console.log(`\n## 結果  ${checks - failures}/${checks} PASS`);
  if (failures > 0) process.exit(1);
}

void main().catch((e: unknown) => {
  console.error(`\n## 実行が例外で止まった: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(3);
});
