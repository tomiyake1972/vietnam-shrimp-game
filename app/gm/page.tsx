import { appEnvironment, isProduction } from "../lib/env";
import GmConsole from "./GmConsole";

// 動的レンダリングの強制は app/layout.tsx（ルートレイアウト）で一括して行っている。

export default function GmPage() {
  return <GmConsole isProduction={isProduction} appEnvironment={appEnvironment} />;
}
