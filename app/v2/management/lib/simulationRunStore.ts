// ShrimpX V2 — 32Q Management Console Phase 2: Simulation Run ストア（クライアント側）
//
// 【この層が解決する2つの課題（Phase 1の最大の残課題）】
//   A. ブラウザをリロードすると Simulation 結果が消える
//   B. Management Console と Analysis が同じ Simulation Run を共有していない
//
// どちらも「実行結果が simulationRunId を持つ1つの保存物になっていない」ことが原因
// だったため、保存・読み出し・現在選択中の実行の管理をこの1モジュールへ集約する。
// Console と Analysis は**同じ関数**を通してのみ Simulation Run に触れる。
//
// 【保存先は2系統。どちらに保存されたかを必ず呼び出し側へ返す】
//   server  … /api/v2/simulation-runs（Redis）。他のブラウザ・他の端末からも読める。
//   browser … このブラウザの localStorage。サーバー保存が使えない環境でも
//             リロードで消えないようにするための確実な足場。
// サーバー保存が失敗したことを黙って握りつぶさない（画面に保存先を出す）。

import { StoredSimulationRun, SimulationRunSummary, toSimulationRunSummary } from "../../../lib/v2/companyLab/simulation/persistence/types";

/** localStorage のキー空間（他機能と衝突させない）。 */
const RUN_KEY_PREFIX = "shrimpx:v2:simulationRun:";
const INDEX_KEY = "shrimpx:v2:simulationRun:index";
const ACTIVE_RUN_KEY = "shrimpx:v2:simulationRun:active";

/**
 * ブラウザ内に残す実行数の上限。
 *
 * 32Q 1本の保存物は実測で約3.6MB（analytics dataset ＋ AI Analysis Pack 用の
 * per-turn capture。Vision・新工場判断の記録を含む。scripts/aiAnalysisPackProbe.ts）。
 * localStorage の一般的な上限は
 * オリジンあたり約5MBのため、ブラウザ側では**最新の1本だけ**を確実に残す方針にする
 * （2本入れると保存に失敗し、結局古い方を捨てて入れ直すことになる）。
 * 複数 run を保持したい場合はサーバー保存（Redis、上限20本）を使う。
 */
export const BROWSER_RUN_RETENTION_LIMIT = 1;

export type SimulationRunStorageLocation = "server" | "browser";

export interface SaveSimulationRunResult {
  readonly savedTo: readonly SimulationRunStorageLocation[];
  /** サーバー保存を試みて失敗した場合の理由（成功時・未試行時は null）。 */
  readonly serverError: string | null;
  /** ブラウザ保存に失敗した場合の理由（容量超過など。成功時は null）。 */
  readonly browserError: string | null;
  /**
   * 【Save/Resume 長期永続化・鮮度整合 BLOCKER修正】browser・serverのどちらか一方でも
   * 保存に失敗していれば true（silent successを禁止する。指示§18/§19）。
   */
  readonly degraded: boolean;
  /** この保存に採番されたpersistenceRevision。 */
  readonly persistenceRevision: number;
}

function hasWindow(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

// ---------------------------------------------------------------------
// 0. persistenceRevision（browser/server保存物の鮮度比較。指示§11/§12のSSoT）
// ---------------------------------------------------------------------

/**
 * タブ内でのみ有効な単調増加カウンタ（simulationRunId ごと）。
 * サーバー側の原子的カウンタは持たない（指示§48「大規模なlockingは今回必須ではない」）。
 * resumeで既存の保存物を読んだ時点でその値へ底上げしておくことで、reload後の採番が
 * 既存の保存物より古くならないようにする（seedRevisionCounter）。
 */
const revisionCounters = new Map<string, number>();

function nextRevisionFor(id: string): number {
  const next = (revisionCounters.get(id) ?? 0) + 1;
  revisionCounters.set(id, next);
  return next;
}

/** 保存物を読んだ側（loadSimulationRun）が、以後の採番をその保存物より古くしないために呼ぶ。 */
function seedRevisionCounter(id: string, knownRevision: number): void {
  const current = revisionCounters.get(id) ?? 0;
  if (knownRevision > current) revisionCounters.set(id, knownRevision);
}

/**
 * browser保存物・server保存物のどちらが新しいかを決める、唯一の比較ルール（指示§12 SSoT）。
 * 優先順位: (1) persistenceRevision（無ければ0） (2) completedTurns (3) savedAt（ISO文字列は
 * 辞書式比較＝時系列比較と一致する）。
 */
function pickFresher(a: StoredSimulationRun | null, b: StoredSimulationRun | null): StoredSimulationRun | null {
  if (!a) return b;
  if (!b) return a;
  const revA = a.persistenceRevision ?? 0;
  const revB = b.persistenceRevision ?? 0;
  if (revA !== revB) return revA > revB ? a : b;
  if (a.run.completedTurns !== b.run.completedTurns) return a.run.completedTurns > b.run.completedTurns ? a : b;
  return a.savedAt >= b.savedAt ? a : b;
}

// ---------------------------------------------------------------------
// 1. ブラウザ保存
// ---------------------------------------------------------------------

function readBrowserIndex(): SimulationRunSummary[] {
  if (!hasWindow()) return [];
  try {
    const raw = window.localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SimulationRunSummary[]) : [];
  } catch {
    return [];
  }
}

function writeBrowserIndex(summaries: readonly SimulationRunSummary[]): void {
  if (!hasWindow()) return;
  window.localStorage.setItem(INDEX_KEY, JSON.stringify(summaries));
}

/**
 * ブラウザへ保存する。容量超過（QuotaExceededError）で失敗した場合は、
 * **黙って諦めない** — 古い実行を消して再試行し、それでも入らなければ理由を返す。
 */
function saveToBrowser(stored: StoredSimulationRun): string | null {
  if (!hasWindow()) return "このブラウザには保存できません（localStorage が使えません）";
  const id = stored.run.simulationRunId;
  const payload = JSON.stringify(stored);

  const index = readBrowserIndex().filter((s) => s.simulationRunId !== id);
  index.unshift(toSimulationRunSummary(stored));
  // 上限を超えた古い実行は本体ごと消す（index だけ消して本体を残すと孤児になる）。
  for (const evicted of index.slice(BROWSER_RUN_RETENTION_LIMIT)) {
    window.localStorage.removeItem(RUN_KEY_PREFIX + evicted.simulationRunId);
  }
  const kept = index.slice(0, BROWSER_RUN_RETENTION_LIMIT);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      window.localStorage.setItem(RUN_KEY_PREFIX + id, payload);
      writeBrowserIndex(kept);
      return null;
    } catch (e) {
      // 1回目の失敗では、今回保存する1本を除く既存の実行をすべて捨てて再試行する。
      if (attempt === 0) {
        for (const other of kept.filter((s) => s.simulationRunId !== id)) {
          window.localStorage.removeItem(RUN_KEY_PREFIX + other.simulationRunId);
        }
        // 【実ブラウザE2Eで発見】ここで index を新しい（まだ本体保存に成功していない）
        // summaryへ書き換えてはならない。書き換えてしまうと、2回目の試行も失敗した場合に
        // 「index（Run Historyの一覧・現在状態表示）は新しいcompletedTurnsを指しているのに、
        // 本体（loadFromBrowserが返す実データ）は古いturnのまま」という不整合が生まれる
        // （実測: confirm直後にQuota超過で本体保存が失敗した際、画面上部の概要が
        // 「Current: 28/32Q」を指す一方、実際に復元されるstateはQ12のままという食い違いを
        // 確認した）。indexの更新は、本体保存が実際に成功した場合（下のtryブロック内）だけに限る。
        continue;
      }
      return `ブラウザ保存に失敗しました（${e instanceof Error ? e.name : String(e)}。保存物は約${Math.round(payload.length / 1024)}KBです）`;
    }
  }
  return null;
}

function loadFromBrowser(simulationRunId: string): StoredSimulationRun | null {
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(RUN_KEY_PREFIX + simulationRunId);
    if (!raw) return null;
    return JSON.parse(raw) as StoredSimulationRun;
  } catch {
    return null;
  }
}

/**
 * 【指示§20 stale browser cleanup】serverの方が新しく、かつそのbrowserキャッシュ更新にも
 * 失敗した場合に、古いbrowserエントリを残さず消す（indexからも消す＝孤児を作らない）。
 */
function removeFromBrowser(simulationRunId: string): void {
  if (!hasWindow()) return;
  window.localStorage.removeItem(RUN_KEY_PREFIX + simulationRunId);
  writeBrowserIndex(readBrowserIndex().filter((s) => s.simulationRunId !== simulationRunId));
}

// ---------------------------------------------------------------------
// 2. サーバー保存（使えない環境では静かに諦めず、理由を返す）
// ---------------------------------------------------------------------

/**
 * 【指示§31-35】Vercel Functionsのrequest body上限（既定約4.5MB）に対して、
 * 413を受けてから気づくのではなく、送信前にサイズを検査して安全側で止める。
 * 4.5MBの実測値ちょうどではなく、将来のfield追加等の余裕を見て4MBを閾値にする
 * （§32 safety margin）。
 */
const PERSISTENCE_PAYLOAD_TOO_LARGE_THRESHOLD_BYTES = 4 * 1024 * 1024;

function checkPartSize(part: string, value: unknown): string | null {
  const bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(JSON.stringify(value)).length : JSON.stringify(value).length;
  if (bytes <= PERSISTENCE_PAYLOAD_TOO_LARGE_THRESHOLD_BYTES) return null;
  return (
    `PERSISTENCE_PAYLOAD_TOO_LARGE: ${part}が${(bytes / 1024 / 1024).toFixed(2)}MBあり、安全threshold` +
    `（${(PERSISTENCE_PAYLOAD_TOO_LARGE_THRESHOLD_BYTES / 1024 / 1024).toFixed(1)}MB）を超えています。送信を中止しました。`
  );
}

async function postJson(body: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch("/api/v2/simulation-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 【Turn14以降Save/Resume停止BLOCKER修正】dataset/resumePayload/packCaptureを
 * 1回のrequest bodyへ束ねない。実測でこの束ねた形がVercel Functionsのrequest body
 * 上限（既定約4.5MB）にTurn10〜15あたりで到達し、それ以降のserver保存が
 * プラットフォーム側で拒否されていた（アプリケーションコードにすら到達しない失敗
 * のため、以前はHTTPエラーとして観測しづらかった）。
 *
 * ここでは各パートを個別のPOST requestとして送り（dataset/pack単体はO(turns)で
 * 成長し続けても32Qまで4.5MBに到達しない。resumePayloadはrolling windowで既に
 * 小さい）、すべて成功した場合にだけ最後にmanifestをcommitする（＝このrevisionを
 * 「読み込み可能な完全な状態」として公開する。指示§21/§22 atomic save / manifest方式）。
 * 途中のパートが失敗したら、manifestは古いrevisionを指したままになる
 * （部分的に書けた新しいパートは「未公開」のまま＝次にこのrevisionで再送すれば
 * 上書きされる。孤立した未公開パートがユーザーに見えることはない）。
 */
async function saveToServer(stored: StoredSimulationRun): Promise<string | null> {
  const simulationRunId = stored.run.simulationRunId;
  const revision = stored.persistenceRevision;
  if (typeof revision !== "number") {
    return "サーバー保存に失敗しました（persistenceRevisionが未設定です。呼び出し側の実装ミスの可能性があります）。";
  }

  const datasetSizeError = checkPartSize("dataset", stored.dataset);
  if (datasetSizeError) return `サーバー保存に失敗しました（${datasetSizeError}）`;
  const datasetResult = await postJson({ simulationRunId, revision, part: "dataset", value: stored.dataset });
  if (!datasetResult.ok) return `サーバー保存に失敗しました（dataset: ${datasetResult.error}）`;

  if (stored.resumePayload !== undefined) {
    const resumeSizeError = checkPartSize("resume", stored.resumePayload);
    if (resumeSizeError) return `サーバー保存に失敗しました（${resumeSizeError}）`;
    const resumeResult = await postJson({ simulationRunId, revision, part: "resume", value: stored.resumePayload });
    if (!resumeResult.ok) return `サーバー保存に失敗しました（resume: ${resumeResult.error}）`;
  }

  if (stored.packCapture !== undefined) {
    const packSizeError = checkPartSize("pack", stored.packCapture);
    if (packSizeError) return `サーバー保存に失敗しました（${packSizeError}）`;
    const packResult = await postJson({ simulationRunId, revision, part: "pack", value: stored.packCapture });
    if (!packResult.ok) return `サーバー保存に失敗しました（pack: ${packResult.error}）`;
  }

  const manifestResult = await postJson({
    manifestOnly: true,
    run: stored.run,
    savedAt: stored.savedAt,
    persistenceRevision: revision,
    hasResumePayload: stored.resumePayload !== undefined,
    hasPackCapture: stored.packCapture !== undefined,
  });
  if (!manifestResult.ok) return `サーバー保存に失敗しました（manifest: ${manifestResult.error}）`;
  return null;
}

async function loadFromServer(simulationRunId: string): Promise<StoredSimulationRun | null> {
  try {
    const response = await fetch(`/api/v2/simulation-runs/${encodeURIComponent(simulationRunId)}`);
    if (!response.ok) return null;
    return (await response.json()) as StoredSimulationRun;
  } catch {
    return null;
  }
}

async function listFromServer(): Promise<readonly SimulationRunSummary[]> {
  try {
    const response = await fetch("/api/v2/simulation-runs");
    if (!response.ok) return [];
    const body = (await response.json()) as { runs?: SimulationRunSummary[] };
    return body.runs ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// 3. 公開API（Console と Analysis はここだけを使う）
// ---------------------------------------------------------------------

/**
 * Simulation Run を保存する。
 * ブラウザ保存を**必ず**行い、そのうえでサーバー保存を試みる
 * （サーバーが使えない環境でもリロードで結果が消えないことを保証するため）。
 *
 * 【Save/Resume 長期永続化・鮮度整合 BLOCKER修正】persistenceRevision はここで
 * 唯一採番する（呼び出し側は組み立てない＝SSoT。指示§12）。browser・serverの
 * どちらか一方でも失敗すれば degraded=true を返し、silent successにしない（指示§18/§19）。
 */
export async function saveSimulationRun(stored: StoredSimulationRun): Promise<SaveSimulationRunResult> {
  const persistenceRevision = nextRevisionFor(stored.run.simulationRunId);
  const stamped: StoredSimulationRun = { ...stored, persistenceRevision };
  const browserError = saveToBrowser(stamped);
  const serverError = await saveToServer(stamped);
  const savedTo: SimulationRunStorageLocation[] = [];
  if (browserError === null) savedTo.push("browser");
  if (serverError === null) savedTo.push("server");
  return { savedTo, serverError, browserError, degraded: browserError !== null || serverError !== null, persistenceRevision };
}

/**
 * Simulation Run を読み込む。
 *
 * 【Save/Resume 長期永続化・鮮度整合 BLOCKER修正】旧実装は
 * `loadFromBrowser(id) ?? loadFromServer(id)` で「browserにnon-nullな値さえあれば
 * 無条件にそれを使う」設計だった。ブラウザ保存が容量超過で古いまま失敗し続けても
 * その古い値が消えないため、より新しいserver保存物へ絶対にフォールスルーしない
 * という実バグがあった（reload後にcompletedTurnsが後退する。指示§1参照）。
 *
 * ここではbrowser・serverの両方を取得し、pickFresher（persistenceRevision→
 * completedTurns→savedAtの順）で選ぶ。選んだ側の revision を以後の採番の
 * 底上げに使う（seedRevisionCounter）ことで、reload後に続けて保存しても
 * revisionが逆行しない。
 *
 * serverの方が新しかった場合、browserのキャッシュも最新へ更新を試みる
 * （失敗時は黙って古いままにしない＝古いbrowserキャッシュだけが残る状態を解消する。
 * 指示§20「stale browser cleanup」）。
 */
export async function loadSimulationRun(simulationRunId: string): Promise<StoredSimulationRun | null> {
  const browser = loadFromBrowser(simulationRunId);
  const server = await loadFromServer(simulationRunId);
  const chosen = pickFresher(browser, server);
  if (!chosen) return null;
  seedRevisionCounter(simulationRunId, chosen.persistenceRevision ?? 0);

  const browserRevision = browser?.persistenceRevision ?? 0;
  const serverRevision = server?.persistenceRevision ?? 0;
  if (server && serverRevision > browserRevision) {
    const refreshError = saveToBrowser(server);
    if (refreshError) removeFromBrowser(simulationRunId);
  }
  return chosen;
}

/**
 * 保存済み実行の一覧（Run selector 用）。
 * ブラウザ保存とサーバー保存を simulationRunId で統合し、保存が新しい順に並べる。
 * 同じ実行が両方にある場合は、より新しい方の要約を採る
 * （persistenceRevision→completedTurns→savedAtの順。loadSimulationRunと同じ
 * pickFresherの考え方を要約レベルへ適用し、一覧表示がQ8のような古い方の
 * completedTurnsを出さないようにする。指示§27）。
 */
export async function listSimulationRuns(): Promise<readonly SimulationRunSummary[]> {
  const browser = readBrowserIndex();
  const server = await listFromServer();
  const merged = new Map<string, SimulationRunSummary>();
  for (const s of server) merged.set(s.simulationRunId, s);
  for (const b of browser) {
    const existing = merged.get(b.simulationRunId);
    merged.set(b.simulationRunId, existing && !isSummaryFresher(b, existing) ? existing : b);
  }
  return [...merged.values()].sort((a, b) => (a.savedAt === b.savedAt ? a.simulationRunId.localeCompare(b.simulationRunId) : a.savedAt < b.savedAt ? 1 : -1));
}

function isSummaryFresher(a: SimulationRunSummary, b: SimulationRunSummary): boolean {
  const revA = a.persistenceRevision ?? 0;
  const revB = b.persistenceRevision ?? 0;
  if (revA !== revB) return revA > revB;
  if (a.completedTurns !== b.completedTurns) return a.completedTurns > b.completedTurns;
  return a.savedAt >= b.savedAt;
}

/** 現在選択中の Simulation Run。Console と Analysis はこれで同じ実行を見る。 */
export function getActiveSimulationRunId(): string | null {
  if (!hasWindow()) return null;
  return window.localStorage.getItem(ACTIVE_RUN_KEY);
}

export function setActiveSimulationRunId(simulationRunId: string): void {
  if (!hasWindow()) return;
  window.localStorage.setItem(ACTIVE_RUN_KEY, simulationRunId);
}

export function clearActiveSimulationRunId(): void {
  if (!hasWindow()) return;
  window.localStorage.removeItem(ACTIVE_RUN_KEY);
}

/**
 * URLの `?run=` を最優先、無ければ現在選択中の実行を返す。
 * Analysis へのリンクに run を付けておけば、**A/B比較のために2つのタブで
 * 別々の実行を開いても互いに壊れない**（選択状態がURL側にあるため）。
 */
export function resolveRequestedRunId(search: string | null | undefined): string | null {
  if (search) {
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    const fromUrl = params.get("run");
    if (fromUrl) return fromUrl;
  }
  return getActiveSimulationRunId();
}
