# PC-1.5 — Investment Portfolio Root Cause Audit Summary

branch: `feature/v2-32q-management-console` / 前提HEAD `8006fb6`。監査専用フェーズ、parameter/game behavior変更なし。

## A. VAP Product Development tier bang-bang

- 5 scenarios x 5 seeds x 5 companies x 32Q、VAP_DEV_CONSIDERED発火時点 4000件を対象に、
  decision/vapProductDevelopment.tsのaffordability式（`tierUsd / currentQuarterlyVapContributionUsd
  <= effectiveMaxAffordabilityQuarters`）を監査スクリプト側で独立に再現し、$100k/$250k/$500kの
  各tierについて個別pass/fail判定を行った（詳細: pc15_vap_tier.csv, pc15_vap_tier_audit.md）。
- 結果、**pass250k-only・pass100k-onlyはほぼ0%（5社中4社で完全に0%、MASSのみ0.4%/0.1%）**。
  中間tierが選ばれるのは理論上可能（アルゴリズムは正しく3段階の閾値を持つ）だが、
  VAP生産量が四半期ごとに大きく増減する中で、$100k〜$500kに対応する狭い生産量帯
  （currentQuarterlyVapContributionUsdでおよそ$33,333〜$166,667の帯、effectiveMaxAffordabilityQuarters=3の場合）
  を「たまたまその四半期の実績が通過する」確率が構造的に低い。
- **分類: A2（ranking/selection logic issue）主、A3（tier denomination issue）副**。
  tierの値自体（$100k/$250k/$500k）や閾値（vapProductDevelopmentMaxAffordabilityQuarters=3等）を
  変えなくても、「最高tierから順に最初に通るものを選ぶ」という選定方式が、実績ベースの
  affordability指標と組み合わさることで必然的にbang-bangになる設計上の帰結。

## B. MASS PD Mechanization 0件

- 5 scenarios x 5 seeds x 32Q、MASSのPD_MECH_*診断エントリ2924件を全数集計（pc15_mass_pd_mech.csv,
  pc15_mass_pd_mech_audit.md）。
- **considered: 1062件、candidate/proposed: 0件、finance-pass: 0件、completed: 0件。**
- **First blocker: PAYBACK_UNATTRACTIVE 81.7%、LOW_UTILIZATION 18.3%。FINANCE_BLOCKED・
  DUPLICATE・CRISISは1件も発生していない。**
- MASSのPD Mechanizationは、Finance GateやCAPEX ranking競合（他案件との資金の奪い合い）
  に到達する**手前**の、経済性（想定回収期間）と稼働率（対象条件）の2段階で常に止まっている。
  コード監査により、`effectiveMaxPaybackQuarters = (pdMechanizationMaxPaybackQuarters ×
  strategyFitMultiplier) / financialConservatismRatio`で、`strategyFitMultiplier =
  productOrientationPd / productOrientationHoso`がMASSのHOSO/scale志向プロファイルにより
  1未満（PD志向がHOSO志向より弱い）になっている可能性が高く、これがMASS自身の許容回収期間を
  他社より厳しくしている一因と推測される（本フェーズでは数値は変更せず、この構造のみ指摘する）。
- **分類: B2（Economics不足）主、B5（Profile bias）副。B1（Operational Need不足）も一部寄与（18.3%）。
  B3（Finance不足）・B4（Ranking competition）は今回の実測では一切観測されなかった。**

## C. JPQ / CONSV / VAP sustained backlog

- 5 scenarios x 5 seeds、8四半期以上連続でoverdueQuantity>0の期間を抽出（75期間、
  pc15_sustained_backlog_turns.csv, pc15_sustained_backlog_audit.md）。
- **JPQ・VAPは32Qのうち20〜22四半期、CONSVは15〜17四半期という長期backlogが、
  ほぼ全seed・全scenarioで再現性高く発生する（seed依存のノイズではなく構造的パターン）。**
- 期間中の平均`productionRequirement / effectiveCapacityTotal`比は **JPQ 1.42、CONSV 1.23、
  VAP 1.75** — 生産必要量が実効能力を継続的に大きく上回っている。一方、当期新規成約量
  （newContractedQuantity）自体は実効能力の範囲内（JPQ/CONSV/VAPともに能力の80〜85%程度）に
  収まっており、**「今期の新規契約が身の丈を超えている」というよりは、「一度発生したbacklogが
  次期以降のproductionRequirementへ繰り込まれ続け、能力拡張が起きない限り自己持続する」**
  という構図が実測から読み取れる。
- New Factory評価状況（strategy.newFactory.status）は3社で明確に異なる:
  - **JPQ**: DEFERRED 43%・MONITORING 34%・APPROVED 8%・READY_TO_BUILD 3% — 評価は活発に
    動いており、承認まで到達することもあるが、backlogは解消しない。
  - **CONSV**: MONITORING 63%・NOT_CONSIDERED 36%・DEFERRED <1% — 評価が MONITORING 段階で
    ほぼ滞留し、DEFERRED（＝一度提案されて見送られた）にすら至らない。
  - **VAP**: **NOT_CONSIDERED 100%（524/524件、全期間・全seed）** — New Factory評価が一度も
    始まらない。
- Line CAPEX（既存ライン増設）診断は3社ともCAPEX_DEFERRED優勢（JPQ 85.6%・CONSV 87.5%・
  VAP 85.1%）だが、CAPEX_PROPOSEDも一定割合（14〜15%）発生しており完全に凍結してはいない。
- 財務（現金$200M超・借入余力あり）・原料（rawMaterialShortfall≈0）はいずれの会社でも
  制約になっていない。労務不足（laborShortfall）はJPQのみ有意（平均181.5）、CONSV・VAPは
  ほぼ0。
- **会社別分類**:
  - **JPQ: C1（Forward Capacity Gap too weak）+ C2（CAPEX candidate threshold too strict）の
    複合、C6（labor bottleneck）も部分的に寄与**。New Factory評価は動いているが実行に至らず、
    労務不足シグナルも観測される。
  - **CONSV: C3（New Factory route too conservative）主**。評価がMONITORING段階で構造的に
    滞留し、DEFERREDにすら届かない＝そもそも真剣な検討ラウンドまで進んでいない。
  - **VAP: C7（strategy-consistent deliberate backlog）の可能性が高いが、C1/C3との複合の
    可能性も残る**。New Factory評価が100%未着手であることは、単なる機能不全というより
    VAPのVisionそのものが単一工場規模を志向している可能性を示唆するが、稼働率がJPQ/CONSVより
    低い（66.2%）にもかかわらずbacklogが最長（最大22Q）である点は、「意図的に数量を捨てて
    margin優先」という説明だけでは完全には説明しきれず、PC-2以前のさらなる確認が必要。

## 変更禁止事項の遵守

VAP affordability thresholds・tier values・PD Mechanization threshold・CAPEX ranking・
Forward Capacity Gap・New Factory rules・Commercial Commitment・Vision・Profile・Finance・
Procurement・Worker・Sales・Qualityのいずれも一切変更していない。本フェーズで追加した
コードは監査専用スクリプト（scripts/pc15RootCauseAudit.ts）1本のみで、production側の
実装ファイルは一切変更していない。
