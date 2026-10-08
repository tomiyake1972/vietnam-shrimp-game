/**
 * 【INT-1 §5 対照実験】試験7が vacuous でないことの確認。
 *
 * productのLua（SIMULATION_RUN_SAVE_MANIFEST_SCRIPT）から PERSIST 行だけを外した
 * 変種を隔離Redis上で走らせ、「PERSISTが無ければ短縮TTL経過後にcanonicalが消える」
 * ことを実測する。productコードは一切変更しない（ここで作った変種は実行時だけの
 * 文字列であり、productのexportには触らない）。
 */
import { connectIsolatedRedis } from "./respClient";
import { SIMULATION_RUN_SAVE_MANIFEST_SCRIPT } from "../../app/lib/v2/companyLab/simulation/persistence/redisRepository";

const PORT = Number(process.env.INT1_REDIS_PORT ?? 6401);

async function main(): Promise<void> {
  const c = await connectIsolatedRedis(PORT);
  await c.raw("FLUSHALL");

  const removed = SIMULATION_RUN_SAVE_MANIFEST_SCRIPT.split("\n").filter((l) => !/redis\.call\('PERSIST'/.test(l));
  const withoutPersist = removed.join("\n");
  const persistLines = SIMULATION_RUN_SAVE_MANIFEST_SCRIPT.split("\n").filter((l) => /redis\.call\('PERSIST'/.test(l)).length;
  console.log(`# productのLuaから外したPERSIST行数 = ${persistLines}`);

  const P = "staging:v2:simulationRun:";
  const id = "neg-control";
  const SHORT = 1500;
  const stag = (p: string) => `${P}${id}:staging:negtok:${p}`;
  const canon = (p: string) => `${P}${id}:${p}:1`;
  const manifestKey = `${P}${id}`;
  const summaryKey = `${P}${id}:summary`;
  const indexKey = `${P}index`;

  for (const p of ["dataset", "resume", "pack"]) {
    await c.raw("SET", stag(p), JSON.stringify({ marker: `neg-${p}` }), "PX", SHORT);
  }
  const manifestJson = JSON.stringify({ schemaVersion: 9, run: { simulationRunId: id }, persistenceRevision: 1, savedAt: "2026-10-06T00:00:00.000Z", hasResumePayload: true, hasPackCapture: true });

  // productのcommitと同じKEYS/ARGV形状で、PERSISTだけを外したLuaを実行する。
  const keys = [manifestKey, summaryKey, indexKey, stag("dataset"), stag("resume"), stag("pack"), canon("dataset"), canon("resume"), canon("pack")];
  // ARGV: 1 manifestJson, 2 summaryJson, 3 score, 4 runId, 5 limit,
  //       6 expectedBaseRevision, 7 hasResume, 8 hasPack
  const args = [manifestJson, JSON.stringify({ simulationRunId: id }), "1", id, "20", "0", "1", "1"];
  const reply = await c.eval(withoutPersist, keys, args);
  console.log(`# PERSIST無しLuaの戻り値: ${JSON.stringify(reply)}`);

  const pttl = async (k: string) => Number(await c.raw("PTTL", k));
  console.log(`# 昇格直後 canonical PTTL = ${await pttl(canon("dataset"))} / ${await pttl(canon("resume"))} / ${await pttl(canon("pack"))}`);
  await new Promise((r) => setTimeout(r, SHORT + 1200));
  const ex =
    Number(await c.exists(canon("dataset"))) + Number(await c.exists(canon("resume"))) + Number(await c.exists(canon("pack")));
  const mf = Number(await c.exists(manifestKey));
  console.log(`# ${SHORT + 1200}ms 後: canonical EXISTS合計 = ${ex}/3, manifest EXISTS = ${mf}`);
  const verdict = ex === 0 && mf === 1;
  console.log(verdict ? "PASS  対照実験: PERSISTが無いとcanonicalが消え、manifestだけが残る（＝試験7はvacuousでない）" : "FAIL  対照実験が期待どおりにならなかった");
  await c.raw("FLUSHALL");
  await c.close();
  process.exit(verdict ? 0 : 1);
}
void main();
