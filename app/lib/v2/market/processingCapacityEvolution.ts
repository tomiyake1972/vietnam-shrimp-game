// ShrimpX V2 — 産地別PD/VAP加工能力の時間発展（加工品市場進化 §a）
//
// 【背景・監査結果】docs/v2/design/processed_market_evolution_audit.md §8 のとおり、
// 従来は全4産地（EC/IN/ID/VN）とも「PD加工能力 = 生産量 × 0.30」「VAP加工能力 =
// 生産量 × 0.10」という同一の固定比率フォールバック（scenario/parameters.ts の
// defaultPdCapacityRatioOfProduction / defaultVapCapacityRatioOfProduction）しか
// 存在せず、
//   - ベトナムの加工優位（序盤）
//   - エクアドル・インドのPD加工参入（後半）
//   - VAP参入がPD参入より遅れること
// のいずれも表現できなかった。その結果、PD世界稼働率は終盤にかけて**上昇**し、
// 意図する「後半のプレーンPDプレミアム圧縮」と逆方向に動いていた
// （characterization テスト CHAR-5 が固定していた性質）。
//
// 【このモジュールの役割】産地×商品ごとの「加工能力 ÷ 当該国生産量」比率を、
// 参入時期つきのS字カーブ（market/productLifecycle.ts と同じ smoothstep）で
// 時間発展させ、MarketQuarterInput.countries[*].pdProcessingCapacity /
// vapProcessingCapacity を置き換える純粋関数を提供する。
// 価格形成（hosoPricing.ts）・プレミアム算出（productPremium.ts）の式は
// **一切変更しない**。productPremium.ts は既に
//     世界稼働率 = 世界PD(VAP)需要 ÷ 4か国のPD(VAP)加工能力合計
//     プレミアム倍率 = clamp(1 + (稼働率 - 基準0.85) × 感応度0.8, 0.5, 1.8)
// という構造を持っているため、**分母を動かすだけ**で「他産地の参入 → 供給増 →
// プレミアム圧縮」が自然に発生する（監査 §8 の結論）。
//
// 【シナリオ定義のトレンドではなくアダプターにした理由（コーディネーター判断1）】
// scenario/definitions/*.ts へ PD_PROCESSING_CAPACITY トレンドを足す方法も
// あり得たが、それをすると baseline シナリオを使う**既存のTest15ラボの数値が
// 変わってしまう**（Test15の環境・データを壊さないことが上位の制約）。
// そこで market/productLifecycle.ts（SAI-5C）と同じ「入力を書き換える
// opt-in アダプター」の形にし、config で明示的に有効化したラボだけが
// この挙動になるようにする。既存ラボは従来どおり固定比率のまま。
//
// 【決定論】状態を持たない純粋関数のみ。乱数は使わない。シナリオ／シード差は
// entryTurnShift（±四半期、上下限つき）という入力として外から与える
// （deriveProcessingEntryTurnShift 参照）。参入そのものが起きるか否かは
// シフトの上下限で保証され、**運で消えることはない**（物語の再現性）。

import { CountryId, COUNTRY_IDS, MarketQuarterInput } from "./types";
import { hosoEqTons, unwrapUnit } from "../core/units";

/** 加工能力の時間発展を持つ商品（HOSOは加工不要のため対象外）。 */
export type ProcessedProduct = "pd" | "vap";
export const PROCESSED_PRODUCTS: readonly ProcessedProduct[] = ["pd", "vap"];

/**
 * 1産地×1商品ぶんの加工能力比率カーブ。
 * 値はすべて「加工能力 ÷ 当該国の当期生産量（HOSO換算）」の比率（無次元、0以上）。
 */
export interface ProcessingCapacityCurve {
  /** ゲーム開始時点（turn=1）の加工能力比率。 */
  readonly initialRatio: number;
  /** 参入・拡張が完了した後の到達比率。 */
  readonly matureRatio: number;
  /** 参入（S字の立ち上がり）開始turn。 */
  readonly entryStartTurn: number;
  /** 参入から成熟までにかける四半期数（ランプ速度）。 */
  readonly rampDurationQuarters: number;
  /** 参入前の毎四半期の微成長（比率pt/四半期。既存設備の漸進的な改善）。 */
  readonly preEntryGrowthPerQuarter: number;
}

export interface CountryProcessingCapacityConfig {
  readonly pd: ProcessingCapacityCurve;
  readonly vap: ProcessingCapacityCurve;
}

export interface ProcessingCapacityEvolutionParameters {
  readonly byCountry: Readonly<Record<CountryId, CountryProcessingCapacityConfig>>;
  /** 参入時期のシナリオ／シード差の上限（±四半期）。 */
  readonly maxEntryTurnShift: number;
  /** ランプ速度のシナリオ／シード差の上限（倍率の±幅。0.2なら0.8〜1.2倍）。 */
  readonly maxRampSpeedVariation: number;
}

/**
 * 【加工品市場進化 v1 初期値・要校正】
 *
 * すべての値の単位は「加工能力 ÷ 当該国の当期生産量」の比率（無次元）。
 * turnは四半期（32四半期＝8年が標準シナリオ長）。
 *
 * 【設計意図と根拠】
 *
 * ベトナム(VN): 序盤から突出した加工優位を持つ（PD 0.36 / VAP 0.14。EC比で12倍）。人手のかかる
 *   剥き身・加熱加工の集積地であり、原料生産量に対する加工能力の比が他産地より
 *   構造的に大きい。後半も緩やかに伸びるが、他産地の参入ほど急ではない
 *   （既に成熟しているため伸びしろが小さい）。
 *
 * エクアドル(EC): 世界最大の原料供給国だが、序盤の加工能力は極めて小さい
 *   （PD 0.03 / VAP 0.005）。大規模養殖に特化し、加工は輸入国側で行われてきたため。
 *   turn 14 からPD加工へ本格参入し、12四半期かけて 0.38 まで拡大する（大規模投資が
 *   一気に立ち上がるため、matureRatio は VN に次ぐ水準まで到達する）。VAPはさらに
 *   遅れて turn 24 から、到達も 0.07 と限定的（VAPは製品開発・顧客対応の蓄積が
 *   必要で、原料優位だけでは追いつけない）。
 *
 * インド(IN): エクアドルより早く（turn 10）PD加工へ参入するが、規模は中程度
 *   （0.10 → 0.30）。既に一定のPD加工基盤を持つため立ち上がりが早い。
 *   VAPは turn 20 から 0.08 まで。
 *
 * インドネシア(ID): 中規模。PDは turn 16 から 0.26、VAPは turn 26 から 0.07。
 *   国内消費比率が高く輸出加工への転換が遅い。
 *
 * 【この配置が生む物語（実測値は docs/v2/design/processed_market_evolution_audit.md
 *  の追記・および CHAR-5 の反転で確認）】
 *   序盤: 世界のPD加工能力が需要に対して小さい → PD世界稼働率が高い →
 *         PDプレミアム拡大（＝投資準備期に入った会社が中盤に報われる下地）
 *   中盤: VNの優位が最大限に効く「PD黄金期」
 *   終盤: EC/INの参入で世界PD能力が急増 → PD世界稼働率が低下 →
 *         プレーンPDプレミアムが圧縮される。一方VAPは参入が遅く到達も低いため
 *         VAP稼働率は高いまま＝競争軸がVAP・営業力・品質へ移る
 */
export const PROCESSING_CAPACITY_EVOLUTION_PARAMETERS_V1: ProcessingCapacityEvolutionParameters = {
  byCountry: {
    VN: {
      pd: { initialRatio: 0.36, matureRatio: 0.42, entryStartTurn: 6, rampDurationQuarters: 16, preEntryGrowthPerQuarter: 0.002 },
      vap: { initialRatio: 0.14, matureRatio: 0.22, entryStartTurn: 6, rampDurationQuarters: 16, preEntryGrowthPerQuarter: 0.001 },
    },
    IN: {
      pd: { initialRatio: 0.1, matureRatio: 0.3, entryStartTurn: 10, rampDurationQuarters: 12, preEntryGrowthPerQuarter: 0.002 },
      vap: { initialRatio: 0.02, matureRatio: 0.08, entryStartTurn: 20, rampDurationQuarters: 10, preEntryGrowthPerQuarter: 0.0005 },
    },
    ID: {
      pd: { initialRatio: 0.11, matureRatio: 0.26, entryStartTurn: 16, rampDurationQuarters: 10, preEntryGrowthPerQuarter: 0.002 },
      vap: { initialRatio: 0.03, matureRatio: 0.07, entryStartTurn: 26, rampDurationQuarters: 6, preEntryGrowthPerQuarter: 0.0005 },
    },
    EC: {
      pd: { initialRatio: 0.03, matureRatio: 0.38, entryStartTurn: 14, rampDurationQuarters: 12, preEntryGrowthPerQuarter: 0.001 },
      vap: { initialRatio: 0.005, matureRatio: 0.07, entryStartTurn: 24, rampDurationQuarters: 8, preEntryGrowthPerQuarter: 0.0002 },
    },
  },
  maxEntryTurnShift: 3,
  maxRampSpeedVariation: 0.2,
};

/** 産地×商品ごとの参入時期・ランプ速度のシナリオ／シード差。 */
export interface ProcessingCapacityVariation {
  /** 参入turnのシフト（正=遅延、負=前倒し）。maxEntryTurnShiftでclampされる。 */
  readonly entryTurnShiftByCountryProduct?: Readonly<
    Partial<Record<CountryId, Readonly<Partial<Record<ProcessedProduct, number>>>>>
  >;
  /** ランプ期間の倍率（>1で遅い、<1で速い）。maxRampSpeedVariationでclampされる。 */
  readonly rampSpeedMultiplierByCountryProduct?: Readonly<
    Partial<Record<CountryId, Readonly<Partial<Record<ProcessedProduct, number>>>>>
  >;
}

function smoothstep(p: number): number {
  const t = Math.max(0, Math.min(1, p));
  return t * t * (3 - 2 * t);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 1産地×1商品の、指定turnにおける加工能力比率。
 * 参入前は preEntryGrowthPerQuarter による緩やかな線形成長、参入後は
 * rampDurationQuarters かけて matureRatio へS字で漸近する
 * （market/productLifecycle.ts の adoptionShare と同一の形。意図的に同じ形に
 * そろえてある＝需要側の普及曲線と供給側の参入曲線を同じ語彙で読めるようにする）。
 */
export function processingCapacityRatio(
  curve: ProcessingCapacityCurve,
  turn: number,
  entryTurnShift = 0,
  rampSpeedMultiplier = 1,
  params: ProcessingCapacityEvolutionParameters = PROCESSING_CAPACITY_EVOLUTION_PARAMETERS_V1
): number {
  const shift = clamp(entryTurnShift, -params.maxEntryTurnShift, params.maxEntryTurnShift);
  const speed = clamp(rampSpeedMultiplier, 1 - params.maxRampSpeedVariation, 1 + params.maxRampSpeedVariation);
  const entryTurn = curve.entryStartTurn + shift;
  const duration = Math.max(1, curve.rampDurationQuarters * speed);

  const preEntry = Math.min(curve.matureRatio, curve.initialRatio + curve.preEntryGrowthPerQuarter * Math.max(0, turn - 1));
  const progress = (turn - entryTurn) / duration;
  const ratio = preEntry + (curve.matureRatio - preEntry) * smoothstep(progress);
  return clamp(ratio, 0, curve.matureRatio);
}

/** 産地×商品の加工能力比率行列（診断・レポート出力用）。 */
export type ProcessingCapacityRatioMatrix = Readonly<Record<CountryId, Readonly<Record<ProcessedProduct, number>>>>;

/** 指定turnの産地×商品の加工能力比率をまとめて計算する。 */
export function computeProcessingCapacityRatios(
  turn: number,
  params: ProcessingCapacityEvolutionParameters = PROCESSING_CAPACITY_EVOLUTION_PARAMETERS_V1,
  variation?: ProcessingCapacityVariation
): ProcessingCapacityRatioMatrix {
  assertProcessingCapacityParametersValid(params);
  const out = {} as Record<CountryId, Record<ProcessedProduct, number>>;
  for (const country of COUNTRY_IDS) {
    const config = params.byCountry[country];
    const perProduct = {} as Record<ProcessedProduct, number>;
    for (const product of PROCESSED_PRODUCTS) {
      perProduct[product] = processingCapacityRatio(
        config[product],
        turn,
        variation?.entryTurnShiftByCountryProduct?.[country]?.[product] ?? 0,
        variation?.rampSpeedMultiplierByCountryProduct?.[country]?.[product] ?? 1,
        params
      );
    }
    out[country] = perProduct;
  }
  return out;
}

/**
 * MarketQuarterInput の各国PD/VAP加工能力を、時間発展させた比率 × 当該国の
 * 当期生産量へ置き換えた新しい入力を返す（元の入力は変更しない）。
 *
 * 生産量そのものは一切変更しない（養殖・供給側のモデルには触れない）。
 * 変えるのは「その生産量のうちどれだけを加工できるか」の比率だけ。
 */
export function applyProcessingCapacityEvolutionToMarketInput(
  input: MarketQuarterInput,
  ratios: ProcessingCapacityRatioMatrix
): MarketQuarterInput {
  const countries = {} as Record<CountryId, MarketQuarterInput["countries"][CountryId]>;
  for (const country of COUNTRY_IDS) {
    const source = input.countries[country];
    const production = unwrapUnit(source.production);
    countries[country] = {
      ...source,
      pdProcessingCapacity: hosoEqTons(Math.max(0, production * ratios[country].pd)),
      vapProcessingCapacity: hosoEqTons(Math.max(0, production * ratios[country].vap)),
    };
  }
  return { ...input, countries: countries as MarketQuarterInput["countries"] };
}

/**
 * シード文字列から、産地×商品ごとの参入時期シフト・ランプ速度差を決定論的に導く。
 *
 * 【運任せにしないための設計（コーディネーター判断・実装指示）】
 *  - シフトは常に ±maxEntryTurnShift（既定±3四半期）に収まる。したがって
 *    「EC が PD 加工へ参入する」という事実そのものは**どのシードでも必ず起きる**。
 *    変わるのは turn 11〜17 のどこで始まるか、というタイミングだけ。
 *  - ランプ速度も 0.8〜1.2 倍に収まる。到達比率（matureRatio）は変わらない。
 *  - つまり物語の骨格（序盤の希少 → 中盤の黄金期 → 終盤の圧縮）は不変で、
 *    その山谷の時期と鋭さだけがシナリオ／シードで変わる。
 */
export function deriveProcessingCapacityVariation(
  seed: string,
  params: ProcessingCapacityEvolutionParameters = PROCESSING_CAPACITY_EVOLUTION_PARAMETERS_V1
): ProcessingCapacityVariation {
  const entryTurnShiftByCountryProduct = {} as Record<CountryId, Record<ProcessedProduct, number>>;
  const rampSpeedMultiplierByCountryProduct = {} as Record<CountryId, Record<ProcessedProduct, number>>;
  for (const country of COUNTRY_IDS) {
    const entry = {} as Record<ProcessedProduct, number>;
    const ramp = {} as Record<ProcessedProduct, number>;
    for (const product of PROCESSED_PRODUCTS) {
      const h = stableHash(`${seed}::${country}::${product}`);
      // [0,1) の2つの独立した値へ分解する（下位ビットと上位ビット）。
      const u1 = (h % 1000) / 1000;
      const u2 = (Math.floor(h / 1000) % 1000) / 1000;
      entry[product] = Math.round((u1 * 2 - 1) * params.maxEntryTurnShift);
      ramp[product] = 1 + (u2 * 2 - 1) * params.maxRampSpeedVariation;
    }
    entryTurnShiftByCountryProduct[country] = entry;
    rampSpeedMultiplierByCountryProduct[country] = ramp;
  }
  return { entryTurnShiftByCountryProduct, rampSpeedMultiplierByCountryProduct };
}

/** 決定論的な文字列ハッシュ（FNV-1a 32bit）。乱数ストリームを消費しない。 */
function stableHash(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

/** パラメータの健全性検証（比率が非負・成熟比率が初期比率以上・参入turnが1以上）。 */
export function assertProcessingCapacityParametersValid(params: ProcessingCapacityEvolutionParameters): void {
  for (const country of COUNTRY_IDS) {
    const config = params.byCountry[country];
    for (const product of PROCESSED_PRODUCTS) {
      const curve = config[product];
      if (curve.initialRatio < 0 || curve.matureRatio < 0) {
        throw new Error(`[processingCapacityEvolution] ${country}.${product}: 比率は0以上である必要があります`);
      }
      if (curve.matureRatio < curve.initialRatio) {
        throw new Error(
          `[processingCapacityEvolution] ${country}.${product}: matureRatio(${curve.matureRatio}) < initialRatio(${curve.initialRatio})`
        );
      }
      if (curve.entryStartTurn < 1 || curve.rampDurationQuarters < 1) {
        throw new Error(`[processingCapacityEvolution] ${country}.${product}: 参入turn・ランプ期間は1以上である必要があります`);
      }
    }
    // VAP参入はPD参入より遅れる（実装指示「VAP entry lags PD entry」の構造的保証）。
    if (config.vap.entryStartTurn < config.pd.entryStartTurn) {
      throw new Error(
        `[processingCapacityEvolution] ${country}: VAP参入turn(${config.vap.entryStartTurn})がPD参入turn(${config.pd.entryStartTurn})より早くなっています`
      );
    }
  }
  if (params.maxEntryTurnShift < 0 || params.maxRampSpeedVariation < 0 || params.maxRampSpeedVariation >= 1) {
    throw new Error("[processingCapacityEvolution] 変動幅の上限が不正です（0以上、ランプ変動は1未満）");
  }
}
