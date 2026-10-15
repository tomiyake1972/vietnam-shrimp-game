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
import {
  SIMULATION_RUN_BODY_ENCODING_GZIP,
  SIMULATION_RUN_BODY_ENCODING_HEADER,
  SIMULATION_RUN_DELTA_BASE_MISMATCH,
  maxTurnOfSimulationRunPart,
  sliceSimulationRunPartAfterTurn,
} from "../../../lib/v2/companyLab/simulation/persistence/partWire";

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
  /**
   * 【O1】他のwriterが先に公開していたため拒否された（409 STALE_PERSISTENCE_REVISION）。
   * 保存内容が壊れたわけではないので、呼び出し側は最新を読み直し、自分の変更を
   * 安全に再適用できる場合だけ作り直して保存し直す（revisionだけ上げた再送は禁止）。
   */
  readonly conflict: boolean;
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
 * 【O1・意味を変更】以前は「タブ内でのみ有効な単調増加カウンタ」だった。
 * それが原因で、GMは他のwriter（Independent Player）のrevision bumpを知らないまま
 * 採番し、古い内容で新しい正本を上書きできてしまっていた。
 *
 * いまは「このタブが最後に確認した、サーバーで公開中のrevision」を保持する。
 * 保存はこの値を expectedBaseRevision として申告し、サーバーが公開中revisionと
 * 一致しなければ 409 で拒否する。保存に成功したとき・サーバーから読んだとき・
 * 409で現在値を教えられたときに、この値を更新する。
 */
const revisionCounters = new Map<string, number>();

/** このタブが最後に確認した「サーバーで公開中のrevision」。未確認なら0（＝旧Run相当）。 */
function knownPublishedRevision(id: string): number {
  return revisionCounters.get(id) ?? 0;
}

/** 公開中revisionの確認値を更新する（保存成功・読み込み・409通知のいずれでも呼ぶ）。 */
function rememberPublishedRevision(id: string, publishedRevision: number): void {
  revisionCounters.set(id, publishedRevision);
}

/** 保存物を読んだ側（loadSimulationRun）が、以後の採番をその保存物より古くしないために呼ぶ。 */
function seedRevisionCounter(id: string, knownRevision: number): void {
  const current = revisionCounters.get(id) ?? 0;
  if (knownRevision > current) revisionCounters.set(id, knownRevision);
}

/** 保存attemptごとに一意なwriteToken（未公開パートを他writerと混ぜない）。 */
function newWriteToken(): string {
  return `gm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

function checkPartSize(part: string, sentBytes: number): string | null {
  if (sentBytes <= PERSISTENCE_PAYLOAD_TOO_LARGE_THRESHOLD_BYTES) return null;
  return (
    `PERSISTENCE_PAYLOAD_TOO_LARGE: ${part}が${(sentBytes / 1024 / 1024).toFixed(2)}MBあり、安全threshold` +
    `（${(PERSISTENCE_PAYLOAD_TOO_LARGE_THRESHOLD_BYTES / 1024 / 1024).toFixed(1)}MB）を超えています。送信を中止しました。`
  );
}

// ---------------------------------------------------------------------
// 2-a. 【FOT-1】送信量の削減（圧縮・再利用・差分追記）と実測
// ---------------------------------------------------------------------

/**
 * 【FOT-1】ブラウザ→サーバーの送信量（Vercel Fast Origin Transfer）が Hobby 上限
 * 10GB を超えてアカウントが停止した。原因はこの層が、保存のたびに dataset / resume /
 * pack を丸ごと・無圧縮で送っていたこと。
 *
 * 実測（5社PLAYER×32Turn・tiered-v200-crowding-v1、scripts/int1/measureSavePayload.ts）:
 *   T32 の1保存 … dataset 4,002,162 B / resume 3,075,443 B / pack 1,682,483 B / manifest 937 B
 *   1Run 合計   … 979.96 MB（1Turnあたり6回保存 × 32Turn）
 *
 * 対策は3つで、いずれも**送り方だけ**を変える（Redis の保存形式は不変）:
 *   1. gzip 圧縮して送る（実測で約10〜12%まで縮む）
 *   2. 変わっていないパートは送らない（reuse）。5社PLAYERの6回の保存のうち5回
 *      （PLAYER意思決定の確定）は dataset / pack を一切変えない。
 *   3. pack は増えた turn の行だけ送る（append）。dataset は append を使わない
 *      （後述）。
 *
 * 【dataset に append を使わない理由】差分マージ（mergeAnalyticsDatasets）の結果は
 * 行の**集合**としては全量ビルドと完全に一致するが、marketMetrics の**行順**が
 * 変わる（全量ビルドは visibility ごとにまとめ、マージは turn ごとに積む）。
 * aiPack/workbook.ts は dataset.marketMetrics を並べ替えずにそのまま Excel の行へ
 * 落とすため、行順が変わると AI Analysis Pack の出力が改修前と一致しなくなる
 * （依頼書の受け入れ条件）。pack は append でもバイト単位で一致することを
 * scripts/int1/probeDeltaEquivalence.ts で実測確認したため append を使う。
 */

/** 【FOT-1】このタブが「公開中revisionに入っている」と把握しているパートの最大turn。 */
interface PublishedPartTurns {
  readonly dataset: number;
  readonly pack: number;
}

const publishedPartTurns = new Map<string, PublishedPartTurns>();

function knownPublishedPartTurns(runId: string): PublishedPartTurns | null {
  return publishedPartTurns.get(runId) ?? null;
}

function rememberPublishedPartTurns(runId: string, turns: PublishedPartTurns): void {
  publishedPartTurns.set(runId, turns);
}

/** 保存1回ぶんの送信量の記録（開発ログと計測テスト用）。 */
export interface SavePartTransfer {
  readonly part: "dataset" | "resume" | "pack" | "manifest";
  /** value / reuse / append のどれで送ったか。 */
  readonly mode: "value" | "reuse" | "append";
  /** 圧縮前のJSONバイト数。 */
  readonly rawBytes: number;
  /** 実際にネットワークへ出たバイト数（圧縮後。圧縮できなかった場合は rawBytes と同じ）。 */
  readonly sentBytes: number;
}

let lastSaveTransfers: readonly SavePartTransfer[] = [];

/**
 * 直近1回の保存で実際に送ったバイト数の明細。
 * 【§5 計測】改修前後の比較と、T1/T16/T32 の実測をテストから取るために公開する。
 */
export function getLastSaveTransfers(): readonly SavePartTransfer[] {
  return lastSaveTransfers;
}

function isDevLoggingEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

function logSaveTransfers(runId: string, revision: number, transfers: readonly SavePartTransfer[]): void {
  if (!isDevLoggingEnabled()) return;
  const raw = transfers.reduce((a, t) => a + t.rawBytes, 0);
  const sent = transfers.reduce((a, t) => a + t.sentBytes, 0);
  const detail = transfers.map((t) => `${t.part}:${t.mode}=${t.sentBytes}B`).join(" ");
  const ratio = raw > 0 ? `${((sent / raw) * 100).toFixed(1)}%` : "-";
  console.info(
    `[simulationRunStore] 保存送信量 run=${runId} revision=${revision} ` + `圧縮前=${raw}B 送信=${sent}B (${ratio}) ${detail}`
  );
}

/**
 * JSON文字列を gzip 圧縮する。`CompressionStream` が無い環境（古いブラウザ・
 * 一部のテスト環境）では null を返し、呼び出し側が無圧縮で送る（後方互換）。
 */
async function gzipUtf8(json: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined" || typeof Blob === "undefined" || typeof Response === "undefined") return null;
  try {
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

function utf8Length(text: string): number {
  return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text).length : text.length;
}

/**
 * パートの最大turn。形が想定と違えば null を返す（例外にしない）。
 * null の場合は reuse / append を使わず、従来どおり完全な値で送る＝
 * 「判定できないときは確実に動く方へ倒す」。
 */
function safeMaxTurn(part: "dataset" | "pack", value: unknown): number | null {
  try {
    return maxTurnOfSimulationRunPart(part, value);
  } catch {
    return null;
  }
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

type PostJsonResult =
  | { ok: true; rawBytes: number; sentBytes: number }
  | { ok: false; error: string; stale: boolean; deltaBaseMismatch: boolean; currentPublishedRevision: number | null; rawBytes: number; sentBytes: number };

/**
 * 保存リクエストを1本送る。
 *
 * 【FOT-1】送信前に gzip 圧縮し、`x-shrimpx-body-encoding: gzip` を付ける。
 * サーバー側（simulation-runs/_lib/context.ts の parseJsonBody）が展開する。
 * 圧縮できない環境では従来どおり無圧縮のJSONを送る（後方互換）。
 */
async function postJson(body: unknown, sizeGuardLabel?: string): Promise<PostJsonResult> {
  const json = JSON.stringify(body);
  const rawBytes = utf8Length(json);
  const compressed = await gzipUtf8(json);
  const sentBytes = compressed ? compressed.byteLength : rawBytes;
  /**
   * 【指示§31-35】413 を受けてから気づくのではなく、送信前に止める。
   * 【FOT-1】閾値は「実際に送るバイト数」＝圧縮後で見る。プラットフォームの
   * request body 上限にかかるのは圧縮後の大きさだからである。
   */
  if (sizeGuardLabel !== undefined) {
    const sizeError = checkPartSize(sizeGuardLabel, sentBytes);
    if (sizeError) {
      return { ok: false, error: sizeError, stale: false, deltaBaseMismatch: false, currentPublishedRevision: null, rawBytes, sentBytes };
    }
  }
  try {
    const response = await fetchWithTimeout("/api/v2/simulation-runs", {
      method: "POST",
      headers: compressed
        ? { "Content-Type": "application/octet-stream", [SIMULATION_RUN_BODY_ENCODING_HEADER]: SIMULATION_RUN_BODY_ENCODING_GZIP }
        : { "Content-Type": "application/json" },
      // 【型】BodyInit は ArrayBufferView を受け付ける。Uint8Array をそのまま渡す。
      body: compressed ? (compressed as unknown as BodyInit) : json,
    });
    if (!response.ok) {
      const bodyText = await readErrorBody(response);
      const base = describeHttpError(response.status);
      /**
       * 【O1】409 STALE_PERSISTENCE_REVISION は「他のwriterが先に公開した」という意味で、
       * 保存内容が壊れたわけではない。呼び出し側が最新を読み直して作り直すための情報
       * （現在公開中のrevision）をここで拾っておく。
       */
      let stale = false;
      let currentPublishedRevision: number | null = null;
      if (response.status === 409 && (bodyText ?? "").includes("STALE_PERSISTENCE_REVISION")) {
        stale = true;
        const matched = (bodyText ?? "").match(/"currentPublishedRevision"\s*:\s*(\d+)/);
        if (matched) currentPublishedRevision = Number(matched[1]);
      }
      /**
       * 【FOT-1】reuse / append の土台がずれていた。保存内容が壊れたわけではなく、
       * 同じ内容を完全な値で送り直せば解決する（呼び出し側が1回だけ再送する）。
       */
      const deltaBaseMismatch = response.status === 409 && (bodyText ?? "").includes(SIMULATION_RUN_DELTA_BASE_MISMATCH);
      return { ok: false, error: bodyText ? `${base} — ${bodyText}` : base, stale, deltaBaseMismatch, currentPublishedRevision, rawBytes, sentBytes };
    }
    return { ok: true, rawBytes, sentBytes };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      stale: false,
      deltaBaseMismatch: false,
      currentPublishedRevision: null,
      rawBytes,
      sentBytes,
    };
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
type SaveToServerOutcome = { ok: true } | { ok: false; error: string; stale: boolean };

async function saveToServer(stored: StoredSimulationRun, attempt: { expectedBaseRevision: number; writeToken: string }): Promise<SaveToServerOutcome> {
  const simulationRunId = stored.run.simulationRunId;
  const revision = stored.persistenceRevision;
  if (typeof revision !== "number") {
    return { ok: false, error: "サーバー保存に失敗しました（persistenceRevisionが未設定です。呼び出し側の実装ミスの可能性があります）。", stale: false };
  }

  const transfers: SavePartTransfer[] = [];
  /**
   * 【FOT-1】このattemptで実際に正本へ入る turn。保存成功後にこの値を
   * 「公開中revisionが含んでいる最大turn」として覚え、次の保存の reuse / append の
   * 基準にする。捏造を避けるため、送った内容から計算した値だけを使う。
   */
  let committedDatasetTurn: number | null = null;
  let committedPackTurn: number | null = null;

  /**
   * 1パートを送る。変わっていなければ reuse、pack で増分だけ送れるなら append、
   * それ以外は従来どおり完全な値（value）。
   * DELTA_BASE_MISMATCH が返ったときは、同じパートを完全な値で1回だけ送り直す。
   */
  async function sendPart(part: "dataset" | "resume" | "pack", fullValue: unknown): Promise<SaveToServerOutcome> {
    const base = knownPublishedPartTurns(simulationRunId);
    const canReference = attempt.expectedBaseRevision > 0 && base !== null;
    let body: Record<string, unknown> | null = null;
    let mode: SavePartTransfer["mode"] = "value";

    if (canReference && part !== "resume") {
      const publishedTurn = part === "dataset" ? base.dataset : base.pack;
      const liveTurn = safeMaxTurn(part, fullValue);
      /**
       * liveTurn が null（形を判定できない）か publishedTurn < 0（基準が無い）なら
       * 何も組み立てず、下の body === null 経路で完全な値を送る
       * ＝判定できないときは確実に動く方へ倒す。
       */
      if (liveTurn !== null && publishedTurn >= 0) {
        if (liveTurn === publishedTurn) {
          // 変わっていない ⇒ 送らない（サーバーがRedis内でコピーする）。
          body = { simulationRunId, revision, part, reuseFromRevision: attempt.expectedBaseRevision, ...attempt };
          mode = "reuse";
        } else if (liveTurn > publishedTurn && part === "pack") {
          // pack は差分追記でもバイト単位で全量ビルドと一致する（実測確認済み）。
          body = {
            simulationRunId,
            revision,
            part,
            value: sliceSimulationRunPartAfterTurn(part, fullValue, publishedTurn),
            appendFromRevision: attempt.expectedBaseRevision,
            expectedMaxTurn: liveTurn,
            ...attempt,
          };
          mode = "append";
        }
      }
    }
    if (body === null) {
      body = { simulationRunId, revision, part, value: fullValue, ...attempt };
      mode = "value";
    }

    let result = await postJson(body, part);
    if (!result.ok && result.deltaBaseMismatch && mode !== "value") {
      // 土台がずれていた ⇒ 完全な値で送り直す（自己修復。1回だけ）。
      transfers.push({ part, mode, rawBytes: result.rawBytes, sentBytes: result.sentBytes });
      mode = "value";
      result = await postJson({ simulationRunId, revision, part, value: fullValue, ...attempt }, part);
    }
    if (!result.ok) {
      transfers.push({ part, mode, rawBytes: result.rawBytes, sentBytes: result.sentBytes });
      return { ok: false, error: `サーバー保存に失敗しました（${part}: ${result.error}）`, stale: result.stale };
    }
    transfers.push({ part, mode, rawBytes: result.rawBytes, sentBytes: result.sentBytes });
    if (part === "dataset") committedDatasetTurn = safeMaxTurn("dataset", fullValue);
    if (part === "pack") committedPackTurn = safeMaxTurn("pack", fullValue);
    return { ok: true };
  }

  const datasetOutcome = await sendPart("dataset", stored.dataset);
  if (!datasetOutcome.ok) return datasetOutcome;

  if (stored.resumePayload !== undefined) {
    const resumeOutcome = await sendPart("resume", stored.resumePayload);
    if (!resumeOutcome.ok) return resumeOutcome;
  }

  if (stored.packCapture !== undefined) {
    const packOutcome = await sendPart("pack", stored.packCapture);
    if (!packOutcome.ok) return packOutcome;
  }

  const manifestResult = await postJson({
    manifestOnly: true,
    run: stored.run,
    savedAt: stored.savedAt,
    persistenceRevision: revision,
    hasResumePayload: stored.resumePayload !== undefined,
    hasPackCapture: stored.packCapture !== undefined,
    ...attempt,
  });
  transfers.push({ part: "manifest", mode: "value", rawBytes: manifestResult.rawBytes, sentBytes: manifestResult.sentBytes });
  lastSaveTransfers = transfers;
  logSaveTransfers(simulationRunId, revision, transfers);
  if (!manifestResult.ok) return { ok: false, error: `サーバー保存に失敗しました（manifest: ${manifestResult.error}）`, stale: manifestResult.stale };

  // 公開に成功したので、次回の reuse / append の基準を更新する。
  rememberPublishedPartTurns(simulationRunId, {
    dataset: committedDatasetTurn ?? -1,
    pack: stored.packCapture !== undefined ? committedPackTurn ?? -1 : -1,
  });
  return { ok: true };
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
  const runId = stored.run.simulationRunId;
  /**
   * 【O1】このタブが最後に確認した公開中revisionを基準として申告する。
   * 新しいrevisionは「基準 + 1」。サーバーが公開中revisionと基準の不一致を見つければ
   * 409 STALE_PERSISTENCE_REVISION で拒否され、古い内容が正本化されることはない。
   */
  const expectedBaseRevision = knownPublishedRevision(runId);
  const persistenceRevision = expectedBaseRevision + 1;
  const attempt = { expectedBaseRevision, writeToken: newWriteToken() };
  const stamped: StoredSimulationRun = { ...stored, persistenceRevision };
  const browserError = saveBrowserCache(stamped);
  const outcome = await saveToServer(stamped, attempt);
  const serverError = outcome.ok ? null : outcome.error;
  const conflict = outcome.ok ? false : outcome.stale;
  if (outcome.ok) rememberPublishedRevision(runId, persistenceRevision);
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
    conflict,
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
  /**
   * 【FOT-1】読み込んだ正本が「どの turn まで含んでいるか」を覚える。
   * これが次の保存で reuse / append の基準になる。読み込み直後に覚えておかないと、
   * resume 直後やページ再読み込み直後の保存が毎回全量送信に戻ってしまう。
   * 【捏造しない】実際に読めたパートから計算する。読んでいないパートは -1
   * （＝基準なし。完全な値で送る）。
   */
  rememberPublishedPartTurns(simulationRunId, {
    dataset: server.dataset !== undefined ? safeMaxTurn("dataset", server.dataset) ?? -1 : -1,
    pack: server.packCapture !== undefined ? safeMaxTurn("pack", server.packCapture) ?? -1 : -1,
  });
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
