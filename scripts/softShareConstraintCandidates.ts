// ShrimpX V2 — ソフト市場シェア制約の候補式・数値比較（設計のみ、実装なし）
// 三宅さんovernight指示Part C/Dへの対応。
//
// 【重要】本スクリプトはproduction coreコード（allocation.ts等）を一切
// 変更・呼び出ししない。純粋な数式候補を、現行の実測値（B-2/B-3の実際の
// allocateMarketProduct実行結果）を較正点として使い、独立に計算するだけの
// 設計検討用ツールである。ここで計算した数式はどれも本番コードへ実装
// されていない。
//
// 使い方: npx tsx scripts/softShareConstraintCandidates.ts

// 【較正点】marketShareMechanismAnalysis.tsのB-2実測: 現実的な5社競争
// （4社が標準的な競争力を持つ状態）で、対象会社の相対競争力を1.0x
// （headcount=80、標準baseline）としたときの実測シェアは18.066%。
// これを x=1.0 → share=0.18066 の較正点として使う。
const CALIBRATION_X = 1.0;
const CALIBRATION_SHARE = 0.18066;

// 【安全上限の候補】現行の35%はhard capとして機能している（B-3bで確認）。
// ソフト制約の漸近上限Smaxは、現行の35%を「参考水準」として残しつつ、
// もう少し上（45%）に置く案を基本形として使う（C-2の検討に対応）。
const S_MAX = 0.45;

function fmtPct(x: number): string {
  return (x * 100).toFixed(3) + "%";
}

// ===== 候補1: Michaelis-Menten型飽和曲線（既存のsalesForce.tsと同じ関数形） =====
// share(x) = baseline + (Smax - baseline) * x / (x + k)
// baseline: x=0でのシェア（既存顧客ぶんの最低限のシェア、0でも良い）
// k: 半飽和点（較正点から逆算）
const MM_BASELINE = 0.05; // x=0でも一定の最低限シェアが残る、という設計（既存coverageのbaselineCoverageと同じ考え方）
function candidateMM(x: number, k: number): number {
  return MM_BASELINE + (S_MAX - MM_BASELINE) * (x / (x + k));
}
// 較正点から k を逆算: CALIBRATION_SHARE = MM_BASELINE + (S_MAX-MM_BASELINE)*x/(x+k) を k について解く
function solveMmK(): number {
  const target = CALIBRATION_SHARE - MM_BASELINE;
  const numerator = S_MAX - MM_BASELINE;
  // target = numerator * x/(x+k)  =>  k = x*(numerator/target - 1)
  return CALIBRATION_X * (numerator / target - 1);
}
const MM_K = solveMmK();

// ===== 候補2: 指数漸近（「既存シェアが高いほど抵抗が増す」抵抗コスト型） =====
// share(x) = Smax * (1 - exp(-x/k))
function candidateExp(x: number, k: number): number {
  return S_MAX * (1 - Math.exp(-x / k));
}
function solveExpK(): number {
  // CALIBRATION_SHARE = Smax*(1-exp(-x/k)) => k = -x / ln(1 - share/Smax)
  return -CALIBRATION_X / Math.log(1 - CALIBRATION_SHARE / S_MAX);
}
const EXP_K = solveExpK();

// ===== 候補3: ロジスティック（シグモイド）曲線 =====
// share(x) = Smax / (1 + exp(-slope*(ln(x+eps) - ln(x0))))  ※xの対数スケールで中心化
// 較正点1つだけでは2パラメータ(slope, x0)を一意に決められないため、
// 「x=0近傍でbaselineに近い値から始まる」という制約をもう1つ課して解く。
const LOGISTIC_SLOPE = 1.5; // 【暫定・要検討】急峻さ。他候補と傾向を比較するための代表値。
function candidateLogistic(x: number, x0: number): number {
  const eps = 1e-6;
  return S_MAX / (1 + Math.exp(-LOGISTIC_SLOPE * (Math.log(x + eps) - Math.log(x0))));
}
function solveLogisticX0(): number {
  // CALIBRATION_SHARE = Smax/(1+exp(-slope*(ln(X)-ln(x0)))) を x0 について解く
  // 1+exp(-slope*(lnX-lnx0)) = Smax/share
  // exp(-slope*(lnX-lnx0)) = Smax/share - 1
  // -slope*(lnX-lnx0) = ln(Smax/share - 1)
  // lnx0 = lnX + ln(Smax/share-1)/slope
  const lnX0 = Math.log(CALIBRATION_X) + Math.log(S_MAX / CALIBRATION_SHARE - 1) / LOGISTIC_SLOPE;
  return Math.exp(lnX0);
}
const LOGISTIC_X0 = solveLogisticX0();

console.log(`較正点: x=${CALIBRATION_X} → share=${fmtPct(CALIBRATION_SHARE)}（B-2実測: 標準5社競争下でのheadcount=80のシェア）`);
console.log(`Smax（漸近的安全上限の候補）= ${fmtPct(S_MAX)}`);
console.log(`候補1(MM) k=${MM_K.toFixed(4)}  候補2(Exp) k=${EXP_K.toFixed(4)}  候補3(Logistic) x0=${LOGISTIC_X0.toFixed(4)}, slope=${LOGISTIC_SLOPE}\n`);

// ===== D: 競争力倍率0.5x〜10xでのシェア比較 =====
console.log("========== D-1: 競争力倍率ごとのシェア比較（3候補 + 現行方式の参考値） ==========");
console.log("倍率(x) | 候補1:MM型 | 候補2:指数漸近型 | 候補3:ロジスティック型 | (参考)現行35%hard cap方式");
const MULTIPLIERS = [0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0];
for (const x of MULTIPLIERS) {
  const mm = candidateMM(x, MM_K);
  const exp = candidateExp(x, EXP_K);
  const logi = candidateLogistic(x, LOGISTIC_X0);
  // 現行方式の参考値: B-2実測データから外挿（線形補間、あくまで参考。35%が絶対の壁）
  const currentRef = Math.min(0.35, CALIBRATION_SHARE * (1 + 0.02 * Math.log2(x + 0.001))); // 実測の緩やかな増加を模した参考カーブ（近似）
  console.log(`${x.toString().padStart(7)}x | ${fmtPct(mm).padStart(10)} | ${fmtPct(exp).padStart(16)} | ${fmtPct(logi).padStart(22)} | ${fmtPct(Math.min(currentRef, 0.35)).padStart(24)}`);
}

// ===== D-2: シェア水準10/15/20/25/30/35%における「競争力+10%」でのΔshare =====
console.log("\n\n========== D-2: 現在シェア水準ごとの限界効果（競争力を+10%した場合のΔshare） ==========");
console.log("現在シェア相当のx | 候補1:MM型のΔshare | 候補2:指数漸近型のΔshare | 候補3:ロジスティック型のΔshare");

function invertMM(share: number, k: number): number {
  // share = baseline + (Smax-baseline)*x/(x+k) → x = k*(share-baseline)/(Smax-share)
  return (k * (share - MM_BASELINE)) / (S_MAX - share);
}
function invertExp(share: number, k: number): number {
  return -k * Math.log(1 - share / S_MAX);
}
function invertLogistic(share: number, x0: number): number {
  const lnX = Math.log(x0) + Math.log(S_MAX / share - 1) / -LOGISTIC_SLOPE;
  return Math.exp(lnX);
}

const SHARE_LEVELS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35];
for (const s of SHARE_LEVELS) {
  if (s >= S_MAX) continue;
  const xMM = invertMM(s, MM_K);
  const xExp = invertExp(s, EXP_K);
  const xLogi = invertLogistic(s, LOGISTIC_X0);
  const dMM = candidateMM(xMM * 1.1, MM_K) - s;
  const dExp = candidateExp(xExp * 1.1, EXP_K) - s;
  const dLogi = candidateLogistic(xLogi * 1.1, LOGISTIC_X0) - s;
  console.log(
    `share=${fmtPct(s).padStart(7)} (x=${xMM.toFixed(2)}/${xExp.toFixed(2)}/${xLogi.toFixed(2)}) | Δ=${fmtPct(dMM).padStart(9)} | Δ=${fmtPct(dExp).padStart(9)} | Δ=${fmtPct(dLogi).padStart(9)}`
  );
}

console.log(
  "\n[読み方] 競争力を同じ+10%だけ増やしても、シェア水準が上がるほどΔshareが" +
    "小さくなっていれば、3候補ともに『シェアが高いほど追加投資の効果が逓減する』" +
    "という設計目標を満たしている。数値がゼロに近づく速さ・カーブの形が候補間の違い。"
);
