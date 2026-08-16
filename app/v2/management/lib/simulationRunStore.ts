// ShrimpX V2 — 32Q Management Console: Simulation Run ストア（クライアント側）
//
// 【この層が解決する2つの課題（Phase 1の最大の残課題）】
//   A. ブラウザをリロードすると Simulation 結果が消える
//   B. Management Console と Analysis が同じ Simulation Run を共有していない
//
// どちらも「実行結果が simulationRunId を持つ1つの保存物になっていない」ことが原因
// だったため、保存・読み出し・現在選択中の実行の管理をこの1モジュールへ集約する。
// Console と Analysis は**同じ関数**を通してのみ Simulation Run に触れる。
//
// 【Persistence Architecture Phase 3・指示A/B】localStorageへ full StoredSimulationRun
// （dataset・packCapture・resumePayload込みで実測約3.6MB@Q32）を保存する設計を廃止した。
// 実stagingでTurn26付近、localStorage QuotaExceededErrorとserver dataset HTTP 403が
// 同時に発生した（後者は別途根本修正。後述）。QuotaExceededErrorの方は、そもそも
// localStorageが「大容量ゲーム状態の保存先」に向いていないという設計上の無理が
// 原因であり、上限を上げても五十歩百歩（指示§2「5MBが大きいわけではない」）。
//
// 新しい責務分担:
//   server（authoritative） … /api/v2/simulation-runs（Redis）。full StoredSimulationRun
//                             （dataset・packCapture・resumePayload）はここにしか無い。
//                             Turnを進められるかどうかは server 保存の成否だけで決まる
//                             （browser側の成否はゲーム進行をブロックしない。指示§6/§7/§8）。
//   browser（lightweight cache） … SimulationRunSummary（数百バイト）だけを持つ。
//                             オフラインでの完全なgameplay resumeを保証する層ではなく、
//                             「このブラウザで最近どのRunを触っていたか」の識別・
//                             一覧表示・鮮度参考情報のためだけの軽量キャッシュ。
//                             サーバーへ到達できない間は、このキャッシュから完全な
//                             StoredSimulationRun を組み立てることはできない
//                             （loadSimulationRunはその場合 null を返す。指示§22/§23
//                             「browserだけで32Q完全復元を無理に維持しない」）。

import { StoredSimulationRun, SimulationRunSummary, toSimulationRunSummary } from "../../../lib/v2/companyLab/simulation/persistence/types";

/**
 * 【Q25→Q26 authoritative persistence停止BLOCKER修正・指示§22/§23】
 * fetch()自体がタイムアウトせずハングし続けると、呼び出し元（Export/保存/読み込みの
 * どの経路でも）が「生成中」「保存中」のまま無限に固まって見える。AbortController で
 * 明示的にタイムアウトさせ、必ずエラーとして返す（無限待ちを許さない）。
 */
const FETCH_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/** localStorage のキー空間（他機能と衝突させない）。 */
const INDEX_KEY = "shrimpx:v2:simulationRun:index";
const ACTIVE_RUN_KEY = "shrimpx:v2:simulationRun:active";
/**
 * 【Persistence Architecture Phase 3・旧構造からの移行】旧実装（〜9b99db2）は
 * `shrimpx:v2:simulationRun:{id}` へ full StoredSimulationRun のJSONを直接保存して
 * いた。新実装はこのプレフィックスへ二度と書き込まないが、既にブラウザへ残っている
 * 旧エントリ（MB単位）が居座ってlocalStorage quotaを圧迫し続けないよう、初回アクセス時に
 * ベストエフォートで掃除する（指示§20/§21 migration/cleanup）。
 */
const LEGACY_FULL_RUN_KEY_PREFIX = "shrimpx:v2:simulationRun:";

/**
 * 【Persistence Architecture Phase 3】ブラウザに残すRun数の上限。
 * 以前はfull run（実測約3.6MB@Q32）を保存していたため1本に絞っていたが、
 * 新実装はSimulationRunSummary（数百バイト）だけを保持するため、サーバーの
 * 保存上限（SIMULATION_RUN_RETENTION_LIMIT=20、simulation-runs/persistence/
 * repository.ts参照）に合わせて増やしてよい（指示§19「Q32でもbrowser cacheは
 * 数百KB以下を目標」に対し、20件でも数十KB程度で十分収まる）。
 */
export const BROWSER_RUN_RETENTION_LIMIT = 20;

export type SimulationRunStorageLocation = "server" | "browser";

export interface SaveSimulationRunResult {
  readonly savedTo: readonly SimulationRunStorageLocation[];
  /** サーバー保存を試みて失敗した場合の理由（成功時・未試行時は null）。 */
  readonly serverError: string | null;
  /** ブラウザキャッシュ保存に失敗した場合の理由（成功時は null）。 */
  readonly browserError: string | null;
  /**
   * 【Save/Resume 長期永続化・鮮度整合 BLOCKER修正】browser・serverのどちらか一方でも
   * 保存に失敗していれば true（silent successを禁止する。指示§18/§19）。
   */
  readonly degraded: boolean;
  /**
   * 【Persistence Architecture Phase 3・指示§6/§8】サーバーがauthoritativeであるため、
   * 「このTurnを正本として進めてよいか」はこのフラグだけで判断する。browser cacheの
   * 成否はゲーム進行をブロックしない（degradedとしては表現するが、continue可能）。
   */
  readonly serverSaveSucceeded: boolean;
  /** この保存に採番されたpersistenceRevision。 */
  readonly persistenceRevision: number;
}

function hasWindow(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/**
 * 【指示§20/§21 migration/cleanup】旧形式（`shrimpx:v2:simulationRun:{id}` へ
 * full StoredSimulationRunを直接保存していた形式）のエントリを、index（現行の
 * summary一覧）に載っていないキー・または明らかに古い形式のキーとして検出し、
 * ベストエフォートで削除する。新実装のbrowser cacheは数十件のsummary（数百バイト）
 * だけしか持たないため、保存のたびに毎回走査しても軽い（1回のセッションで1回だけに
 * 絞る最適化は行わない）。失敗しても致命的ではない（単に居座り続けるだけ）ため、
 * 例外は握りつぶす。
 */
function cleanupLegacyFullRunEntries(): void {
  if (!hasWindow()) return;
  try {
    const knownKeys = new Set([INDEX_KEY, ACTIVE_RUN_KEY]);
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || knownKeys.has(key)) continue;
      if (!key.startsWith(LEGACY_FULL_RUN_KEY_PREFIX)) continue;
      // 新実装はこのプレフィックス配下へ何も書かないため、存在すること自体が
      // 旧形式（full run本体）の残留物だと判定できる。
      toRemove.push(key);
    }
    for (const key of toRemove) window.localStorage.removeItem(key);
  } catch {
    // ベストエフォート。失敗しても何もしない（次回起動時にまた試みる）。
  }
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

// ---------------------------------------------------------------------
// 1. ブラウザキャッシュ（軽量。SimulationRunSummaryだけを持つ）
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
 * 【Persistence Architecture Phase 3】ブラウザキャッシュへ保存する対象は
 * SimulationRunSummary（数百バイト）だけであり、dataset/packCapture/resumePayloadは
 * 一切含まない（指示§3/§4）。数百バイト×20件程度のため、QuotaExceededErrorは
 * 現実的にはほぼ起こらないはずだが、万一に備えて失敗を検知したら黙って諦めず理由を返す
 * （指示§18/§19の方針を維持）。
 */
function saveBrowserCache(stored: StoredSimulationRun): string | null {
  if (!hasWindow()) return "このブラウザには保存できません（localStorage が使えません）";
  cleanupLegacyFullRunEntries();
  const summary = toSimulationRunSummary(stored);
  const index = readBrowserIndex().filter((s) => s.simulationRunId !== summary.simulationRunId);
  index.unshift(summary);
  const kept = index.slice(0, BROWSER_RUN_RETENTION_LIMIT);
  try {
    writeBrowserIndex(kept);
    return null;
  } catch (e) {
    return `ブラウザキャッシュ保存に失敗しました（${e instanceof Error ? e.name : String(e)}）`;
  }
}

function loadBrowserCacheSummary(simulationRunId: string): SimulationRunSummary | null {
  return readBrowserIndex().find((s) => s.simulationRunId === simulationRunId) ?? null;
}

// ---------------------------------------------------------------------
// 2. サーバー保存（authoritative。使えない環境では静かに諦めず、理由を返す）
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

/**
 * 【Persistence Architecture Phase 3・指示§9/§10】HTTP 403は「保存先の認証セッションが
 * 切れている／確立していない」ことを意味する（app/api/v2/simulation-runs/_lib/context.ts
 * のwithSimulationRunApiContextが、Bearerトークンも有効なstagingセッションCookieも
 * 無い場合にこのstatusを返す）。413（body too large）等の他のエラーと区別し、
 * 再試行しても同じ理由で失敗し続けることをユーザーへ明示する
 * （単なる「HTTP 403」より再ログインという次のアクションが分かる文言にする）。
 */
function describeHttpError(status: number): string {
  if (status === 403) {
    return (
      "HTTP 403（認証セッションが無効です。staging管理ログイン " +
      "/v2/company-lab/play/login のセッションが切れている可能性があります。" +
      "別タブでログインし直してから、この画面で保存を再試行してください）"
    );
  }
  return `HTTP ${status}`;
}

/**
 * 【Persistence Architecture Phase 3・指示§10】HTTP statusだけでは403の原因
 * （認証セッション切れ／Vercel deployment protection／middleware／その他）を
 * 区別できない。失敗時はresponse bodyも読み、診断に使えるようにする
 * （このAPIのエラー応答は`{error:{code,message}}`形式で秘密情報を含まない設計
 * ―app/api/v2/simulation-runs/_lib/context.ts参照―のため、そのまま表示してよい）。
 */
async function readErrorBody(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return text.length > 0 ? text.slice(0, 500) : null;
  } catch {
    return null;
  }
}

async function postJson(body: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetchWithTimeout("/api/v2/simulation-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const bodyText = await readErrorBody(response);
      const base = describeHttpError(response.status);
      return { ok: false, error: bodyText ? `${base} — ${bodyText}` : base };
    }
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
    const response = await fetchWithTimeout(`/api/v2/simulation-runs/${encodeURIComponent(simulationRunId)}`);
    if (!response.ok) return null;
    return (await response.json()) as StoredSimulationRun;
  } catch {
    return null;
  }
}

async function listFromServer(): Promise<readonly SimulationRunSummary[]> {
  try {
    const response = await fetchWithTimeout("/api/v2/simulation-runs");
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
 *
 * 【Persistence Architecture Phase 3・指示§6/§7/§8】サーバーがauthoritative。
 * サーバー保存の成否だけが「このrevisionを正本として進めてよいか」を決める
 * （呼び出し側はresult.serverSaveSucceededを見てTurn進行の可否を判断する）。
 * ブラウザキャッシュ（軽量summaryのみ）の成否はdegraded表現には含めるが、
 * ゲーム進行はブロックしない。
 */
export async function saveSimulationRun(stored: StoredSimulationRun): Promise<SaveSimulationRunResult> {
  const persistenceRevision = nextRevisionFor(stored.run.simulationRunId);
  const stamped: StoredSimulationRun = { ...stored, persistenceRevision };
  const browserError = saveBrowserCache(stamped);
  const serverError = await saveToServer(stamped);
  const savedTo: SimulationRunStorageLocation[] = [];
  if (browserError === null) savedTo.push("browser");
  if (serverError === null) savedTo.push("server");
  return {
    savedTo,
    serverError,
    browserError,
    degraded: browserError !== null || serverError !== null,
    serverSaveSucceeded: serverError === null,
    persistenceRevision,
  };
}

/**
 * Simulation Run を読み込む。
 *
 * 【Persistence Architecture Phase 3・指示§22】サーバーがauthoritative。
 *   1. サーバーから読めれば、それを返す（persistenceRevisionカウンタもここで底上げする）。
 *   2. サーバーから読めなければ null を返す。ブラウザキャッシュは
 *      dataset/resumePayload/packCaptureを持たないため、ここから完全な
 *      StoredSimulationRunを組み立てることはできない
 *      （「browserだけで32Q完全復元」を無理に維持しない。指示§22/§23）。
 *      一覧・識別のためのSimulationRunSummaryはloadBrowserCacheSummaryFallback
 *      で別途取得できる（呼び出し側が「サーバー未接続だがこのRunは以前触ったことがある」
 *      という表示だけしたい場合に使う）。
 */
export async function loadSimulationRun(simulationRunId: string): Promise<StoredSimulationRun | null> {
  const server = await loadFromServer(simulationRunId);
  if (!server) return null;
  seedRevisionCounter(simulationRunId, server.persistenceRevision ?? 0);
  saveBrowserCache(server);
  return server;
}

/**
 * 【Persistence Architecture Phase 3】サーバーへ到達できない場合に、せめて
 * 「このブラウザで最近触っていたRun」の識別情報（軽量summary）だけを返す。
 * これは完全な StoredSimulationRun ではなく、resume（続きからプレイ）には使えない
 * （呼び出し側は「サーバーに接続できるまで続きはプレイできません」等の表示にとどめる）。
 */
export function loadBrowserCacheSummaryFallback(simulationRunId: string): SimulationRunSummary | null {
  return loadBrowserCacheSummary(simulationRunId);
}

/**
 * 保存済み実行の一覧（Run selector 用）。
 *
 * 【Persistence Architecture Phase 3・指示§24/§27】Run Historyもサーバーの
 * manifest（＝ここではlistFromServerが返す要約一覧）を正本とする。
 * ブラウザ側のindexはあくまでキャッシュであり、サーバーから取得できた実行は
 * 常にサーバー側の要約を優先する（ブラウザ側だけにしか無い実行――サーバーへ
 * 一度も保存できていない、またはサーバーが一時的に読めない場合――だけ
 * ブラウザのキャッシュ要約を補助的に載せる）。
 */
export async function listSimulationRuns(): Promise<readonly SimulationRunSummary[]> {
  const browser = readBrowserIndex();
  const server = await listFromServer();
  const merged = new Map<string, SimulationRunSummary>();
  // サーバーを常に正本として先に入れる。
  for (const s of server) merged.set(s.simulationRunId, s);
  // ブラウザにしか無い実行（サーバー未到達・未保存）だけを補助的に加える。
  for (const b of browser) {
    if (!merged.has(b.simulationRunId)) merged.set(b.simulationRunId, b);
  }
  return [...merged.values()].sort((a, b) => (a.savedAt === b.savedAt ? a.simulationRunId.localeCompare(b.simulationRunId) : a.savedAt < b.savedAt ? 1 : -1));
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
