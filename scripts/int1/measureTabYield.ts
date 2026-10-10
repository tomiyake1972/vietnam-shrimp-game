/**
 * 【裏タブ進行遅延】「ブラウザへ制御を戻す待機」の方式ごとの実測。
 *
 * Management Console の Turn 進行ループは、1Turn ごとに進捗表示を描画させるため
 * ブラウザへ制御を戻している。その待機を何で行うかによって、
 * タブが非表示のときの所要時間が大きく変わる。
 * ゲームのコードは一切使わず、待機機構そのものの性質だけを測る。
 *
 * 共有DB・Preview へは接続しない（about:blank 上で測る）。
 */
import { chromium } from "@playwright/test";

/** 32Turn ぶんに相当する回数。 */
const ITERATIONS = 32;

interface Measurement {
  readonly visibility: string;
  readonly rafMs: number;
  readonly channelMs: number;
  readonly timeoutMs: number;
}

const MEASURE_IN_PAGE = `(async (iterations) => {
  const raf = async () => {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    return performance.now() - t0;
  };
  const channel = async () => {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      await new Promise((r) => {
        const c = new MessageChannel();
        c.port1.onmessage = () => { c.port1.close(); c.port2.close(); r(null); };
        c.port2.postMessage(null);
      });
    }
    return performance.now() - t0;
  };
  const timeout = async () => {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      await new Promise((r) => setTimeout(() => r(null), 0));
    }
    return performance.now() - t0;
  };
  return {
    visibility: document.visibilityState,
    rafMs: await raf(),
    channelMs: await channel(),
    timeoutMs: await timeout(),
  };
})(${ITERATIONS})`;

function report(label: string, m: Measurement): void {
  console.log(`## ${label}（visibilityState=${m.visibility}）`);
  console.log(`   requestAnimationFrame  ${m.rafMs.toFixed(1)} ms`);
  console.log(`   MessageChannel         ${m.channelMs.toFixed(1)} ms`);
  console.log(`   setTimeout(0)          ${m.timeoutMs.toFixed(1)} ms`);
  console.log("");
}

async function main(): Promise<void> {
  console.log(`# 1回の待機を ${ITERATIONS} 回繰り返したときの合計時間（32Turn ぶんに相当）`);
  console.log("");
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("about:blank");

    const front = (await page.evaluate(MEASURE_IN_PAGE)) as Measurement;
    report("前面タブ", front);

    console.log("## 1Turn あたりの待機（前面タブ）");
    console.log(`   requestAnimationFrame  ${(front.rafMs / ITERATIONS).toFixed(1)} ms`);
    console.log(`   MessageChannel         ${(front.channelMs / ITERATIONS).toFixed(1)} ms`);
    console.log(`   setTimeout(0)          ${(front.timeoutMs / ITERATIONS).toFixed(1)} ms`);
    console.log("");

    // 非表示タブの実測を試みる。別タブを前面に出しても、この環境（headless Chromium）では
    // visibilityState が hidden にならない。CDP でも強制できないことを確認した
    // （Emulation.setPageVisibilityOverride は存在せず、Page.setWebLifecycleState と
    //   Emulation.setFocusEmulationEnabled は visibilityState を変えない）。
    const other = await context.newPage();
    await other.goto("about:blank");
    await other.bringToFront();
    let hiddenAchieved = false;
    try {
      await page.waitForFunction(() => document.visibilityState === "hidden", null, { timeout: 10_000 });
      hiddenAchieved = true;
    } catch {
      hiddenAchieved = false;
    }

    if (hiddenAchieved) {
      const hidden = (await page.evaluate(MEASURE_IN_PAGE)) as Measurement;
      report("裏タブ", hidden);
      console.log("## 1Turn あたりの待機（裏タブ）");
      console.log(`   requestAnimationFrame  ${(hidden.rafMs / ITERATIONS).toFixed(1)} ms`);
      console.log(`   MessageChannel         ${(hidden.channelMs / ITERATIONS).toFixed(1)} ms`);
      console.log(`   setTimeout(0)          ${(hidden.timeoutMs / ITERATIONS).toFixed(1)} ms`);
    } else {
      console.log("## 裏タブ: この環境では実測できなかった（取得不能）");
      console.log("   headless Chromium は別タブを前面に出しても visibilityState が visible のままで、");
      console.log("   CDP にも visibilityState を hidden へ強制する手段が無い（上記コメント参照）。");
      console.log("   よって裏タブでの改善幅は、この環境では **未実測** である。");
      console.log("   裏タブで requestAnimationFrame が止まること自体は、");
      console.log("   三宅さんの実測（1Turn 約110秒／前面なら数秒）が示している。");
      console.log("   配備後に実機ブラウザで再確認が必要。");
    }
  } finally {
    await browser.close();
  }
}

void main();
