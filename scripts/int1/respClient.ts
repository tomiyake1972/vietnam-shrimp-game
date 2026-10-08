/**
 * 【INT-1 §5】隔離ローカルRedis専用の最小RESPクライアント。
 *
 * 本番/staging/共有Redisへは接続しない。接続先は呼び出し側が渡すhost:portのみで、
 * このスクリプトはINT-1の検証にしか使わない（productコードからは参照されない）。
 * node_modulesにTCP Redisクライアントが無いため、RESP2を自前で話す。
 */
import net from "node:net";
import { CompanyLabRedisClient, CompanyLabRedisSetOptions } from "../../app/lib/v2/redis/companyLabTypes";

type Reply = string | number | null | Reply[];

function encode(args: (string | number)[]): string {
  let out = `*${args.length}\r\n`;
  for (const a of args) {
    const s = String(a);
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  return out;
}

class Parser {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
  }
  /** 1件ぶんパースできたら [reply, consumed] を返す。足りなければ null。 */
  private parseAt(off: number): [Reply, number] | null {
    const nl = this.buf.indexOf("\r\n", off);
    if (nl < 0) return null;
    const type = String.fromCharCode(this.buf[off]);
    const head = this.buf.toString("utf8", off + 1, nl);
    const after = nl + 2;
    if (type === "+") return [head, after];
    if (type === ":") return [Number(head), after];
    if (type === "-") throw new Error(`Redis error reply: ${head}`);
    if (type === "$") {
      const len = Number(head);
      if (len === -1) return [null, after];
      if (this.buf.length < after + len + 2) return null;
      return [this.buf.toString("utf8", after, after + len), after + len + 2];
    }
    if (type === "*") {
      const n = Number(head);
      if (n === -1) return [null, after];
      const items: Reply[] = [];
      let cur = after;
      for (let i = 0; i < n; i += 1) {
        const r = this.parseAt(cur);
        if (r === null) return null;
        items.push(r[0]);
        cur = r[1];
      }
      return [items, cur];
    }
    throw new Error(`未対応のRESP型: ${type}`);
  }
  next(): Reply | undefined {
    if (this.buf.length === 0) return undefined;
    const r = this.parseAt(0);
    if (r === null) return undefined;
    this.buf = this.buf.subarray(r[1]);
    return r[0];
  }
}

export interface IsolatedRedis extends CompanyLabRedisClient {
  raw(...args: (string | number)[]): Promise<Reply>;
  close(): Promise<void>;
}

export async function connectIsolatedRedis(port: number, host = "127.0.0.1"): Promise<IsolatedRedis> {
  const socket = net.createConnection({ port, host });
  const parser = new Parser();
  const waiters: { resolve: (r: Reply) => void; reject: (e: Error) => void }[] = [];

  socket.on("data", (c) => {
    parser.push(c);
    for (;;) {
      let reply: Reply | undefined;
      try {
        reply = parser.next();
      } catch (e) {
        const w = waiters.shift();
        if (w) w.reject(e as Error);
        continue;
      }
      if (reply === undefined) break;
      const w = waiters.shift();
      if (w) w.resolve(reply);
    }
  });
  await new Promise<void>((res, rej) => {
    socket.once("connect", () => res());
    socket.once("error", rej);
  });

  function raw(...args: (string | number)[]): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      waiters.push({ resolve, reject });
      socket.write(encode(args));
    });
  }

  return {
    raw,
    async get(key) {
      return raw("GET", key);
    },
    async set(key, value, options?: CompanyLabRedisSetOptions) {
      const args: (string | number)[] = ["SET", key, value];
      if (options?.pxMilliseconds !== undefined) args.push("PX", options.pxMilliseconds);
      if (options?.nx) args.push("NX");
      return raw(...args);
    },
    async exists(key) {
      return Number(await raw("EXISTS", key));
    },
    async del(key) {
      return raw("DEL", key);
    },
    async eval(script, keys, args) {
      return (await raw("EVAL", script, keys.length, ...keys, ...(args as (string | number)[]))) as never;
    },
    async zrange(key, start, end) {
      return (await raw("ZRANGE", key, start, end)) as unknown[];
    },
    async close() {
      socket.destroy();
    },
  };
}
