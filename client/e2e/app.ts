// spec 侧辅助（旧假壳）：带场景启动应用。PNG / 画板构造与 web project 共用，见 common/boards.ts。
import type { Page } from "@playwright/test";
import { OUTPUT_ROOT, scenario, type Scenario } from "./scenario";
import { MODELS } from "./common/boards";

export { png, promptNode, referenceNode, taskNode, edge, board, MODELS, task } from "./common/boards";

export const boardPath = (title: string) => `${OUTPUT_ROOT}/画板/${title}.ugcboard.json`;
export const GW = "http://localhost:1421/gw";

/** 打开单个画板的场景：画板文件 + ui_state + 网关设置 + 模型缓存 + API 密钥。 */
export function boardScenario(title: string, boardText: string, partial: Partial<Scenario> = {}): Scenario {
  const path = boardPath(title);
  return scenario({
    settings: JSON.stringify({ format_version: 1, base_url: GW, output_root: null, concurrency: 4 }),
    modelsCache: JSON.stringify({ base_url: GW, model_ids: MODELS, fetched_at: new Date().toISOString() }),
    uiState: JSON.stringify({ window: null, open_boards: [path], active_board: path }),
    secret: "sk-e2e",
    ...partial,
    files: { [path]: { text: boardText }, ...partial.files },
  });
}

export async function openApp(page: Page, scn: Scenario) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // 网关默认：模型列表；更新检查等其他请求一律 404。
  await page.route(`${GW}/**`, (route) => {
    if (route.request().url().endsWith("/v1/models")) return route.fulfill({ json: { data: MODELS.map((id) => ({ id })) } });
    return route.fulfill({ status: 404, body: "not mocked" });
  });
  await page.addInitScript((s) => ((window as unknown as { __E2E_SCENARIO__: Scenario }).__E2E_SCENARIO__ = s), scn);
  await page.goto("/e2e/app.html");
  return errors;
}
