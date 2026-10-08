/**
 * 【BW-1 検証用】隔離ローカル Redis の前に置く Upstash REST 互換シム。
 *
 * なぜ必要か: 製品コード（companyLabClient.ts）は @upstash/redis の REST
 * クライアントで接続する。したがって「本物の API route を本物のクライアントで
 * 動かす」には、Upstash の REST を話す口が必要になる。ここでそれを用意し、
 * 受けたコマンドを隔離ローカル Redis（RESP）へそのまま流す。
 *
 * 停止中の共有 DB（Staging / Production）へは一切接続しない。接続先は
 * このシムが起動したローカル Redis の host:port のみ。検証専用であり、
 * 製品コードからは参照されない。
 */
import http from "node:http";
import { connectIsolatedRedis, IsolatedRedis } from "./respClient";

export interface UpstashRestShim {
  readonly url: string;
  readonly token: string;
  readonly redis: IsolatedRedis;
  /** 受けたコマンド名の履歴（GET の偏りを見るのに使う）。 */
  readonly log: readonly { readonly command: string; readonly key: string; readonly bytes: number }[];
  resetLog(): void;
  close(): Promise<void>;
}

/** Upstash は Upstash-Encoding: base64 を付けてくると base64 で返す。 */
function encodeReply(value: unknown, base64: boolean): unknown {
  if (!base64) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8").toString("base64");
  if (Array.isArray(value)) return value.map((v) => encodeReply(v, base64));
  return value;
}

export async function startUpstashRestShim(redisPort: number, token = "shim-token", listenPort = 0): Promise<UpstashRestShim> {
  const redis = await connectIsolatedRedis(redisPort);
  const log: { command: string; key: string; bytes: number }[] = [];

  async function runCommand(args: unknown[]): Promise<unknown> {
    const parts = args.map((a) => (typeof a === "number" ? a : String(a)));
    const result = await redis.raw(...(parts as (string | number)[]));
    const command = String(parts[0] ?? "").toUpperCase();
    const bytes = typeof result === "string" ? Buffer.byteLength(result, "utf8") : 0;
    log.push({ command, key: String(parts[1] ?? ""), bytes });
    return result;
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      // 検証用エンドポイント（このシム自身の計測値の読み出し）。127.0.0.1 のみに bind している。
      const pathOnly = (req.url ?? "/").split("?")[0];
      if (pathOnly === "/__shim/log") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(log));
        return;
      }
      if (pathOnly === "/__shim/reset") {
        log.length = 0;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const base64 = String(req.headers["upstash-encoding"] ?? "").toLowerCase() === "base64";
      const raw = Buffer.concat(chunks).toString("utf8");
      const path = (req.url ?? "/").split("?")[0];
      try {
        let body: unknown;
        if (path === "/pipeline" || path === "/multi-exec") {
          const commands = JSON.parse(raw) as unknown[][];
          const results: unknown[] = [];
          for (const c of commands) results.push({ result: encodeReply(await runCommand(c), base64) });
          body = results;
        } else if (path === "/" || path === "") {
          body = { result: encodeReply(await runCommand(JSON.parse(raw) as unknown[]), base64) };
        } else {
          // パス形式（/get/<key> など）。body があれば最後の引数として足す。
          const segments = path.split("/").filter((s) => s.length > 0).map((s) => decodeURIComponent(s));
          const args: unknown[] = [...segments];
          if (raw.length > 0) {
            try {
              const parsed = JSON.parse(raw);
              args.push(typeof parsed === "string" ? parsed : JSON.stringify(parsed));
            } catch {
              args.push(raw);
            }
          }
          body = { result: encodeReply(await runCommand(args), base64) };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
  });

  const port: number = await new Promise((resolve) => {
    server.listen(listenPort, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    redis,
    log,
    resetLog: () => {
      log.length = 0;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await redis.close();
    },
  };
}

/**
 * 単体起動モード。
 *   INT1_REDIS_PORT（接続先ローカル Redis）/ INT1_SHIM_PORT（listen）/ INT1_SHIM_TOKEN
 * を読み、起動したことだけを標準出力へ出す。検証スクリプトが別プロセスで使う。
 */
if (process.argv[1] !== undefined && process.argv[1].endsWith("upstashRestShim.ts")) {
  const redisPort = Number(process.env.INT1_REDIS_PORT ?? 6406);
  const shimPort = Number(process.env.INT1_SHIM_PORT ?? 6407);
  const shimToken = process.env.INT1_SHIM_TOKEN ?? "shim-token";
  startUpstashRestShim(redisPort, shimToken, shimPort)
    .then((shim) => {
      console.log(`[shim] ${shim.url} -> 127.0.0.1:${redisPort}`);
    })
    .catch((e) => {
      console.error("[shim] 起動に失敗:", e);
      process.exit(1);
    });
}
