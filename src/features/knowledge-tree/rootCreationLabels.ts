import { rootFolderName } from "../../lib/rootDisplay";
import type { useT } from "../../lib/i18n";

export function rootCreationLabels(
  rootPath: string | null | undefined,
  t: ReturnType<typeof useT>,
) {
  const name = rootFolderName(rootPath);
  const root = name ? t("{name}（ルート）", { name }) : t("ルート");
  return {
    root,
    initialRoot: t("{root}直下を作成先の初期選択にします", { root }),
    selection: t("選択フォルダー内／HTMLの親、未選択時は{root}に作成します", { root }),
  };
}
