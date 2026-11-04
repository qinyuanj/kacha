// 手测清单 #21–#26 中设置与重新定位相关的验收（#17–#20 已迁到新接缝 e2e/web/generation.spec.ts）。
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { board, boardPath, boardScenario, edge, GW, openApp, png, promptNode, referenceNode, task, taskNode } from "../app";
import { OUTPUT_ROOT } from "../scenario";
import type { E2eControl } from "../harness";

const e2e = <T>(page: Page, fn: (c: E2eControl) => T) => page.evaluate(`(${fn.toString()})(window.__e2e)`) as Promise<T>;
const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => window.__e2e.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd) as Promise<Record<string, unknown>[]>;
const sha256 = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
const toast = (page: Page) => page.locator(".toast");

test.describe("#21–#24 高级设置", () => {
  const title = "设置";
  const openSettings = async (page: Page) => {
    await page.getByRole("button", { name: "⚙ 高级设置" }).click();
    const dialog = page.getByRole("dialog", { name: "高级设置" });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  const keyInput = (dialog: ReturnType<Page["getByRole"]>) => dialog.locator("label.form-row", { hasText: "API 密钥" }).locator("input");

  test("#21 保存密钥：UI 调用 secret_set（真 Keychain 仍需手测）", async ({ page }) => {
    await openApp(page, boardScenario(title, board(title, [], []), { secret: null }));
    const dialog = await openSettings(page);
    await keyInput(dialog).fill("sk-new-key");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await calls(page, "secret_set")).toEqual([{ key: "sk-new-key" }]);
    const reopened = await openSettings(page);
    await expect(reopened.locator(".notice", { hasText: "系统凭据库不可用" })).toHaveCount(0);
  });

  test("#22 测试连接：成功显示模型数，失败显示错误并回落缓存", async ({ page }) => {
    await openApp(page, boardScenario(title, board(title, [], [])));
    const dialog = await openSettings(page);
    const testButton = dialog.getByRole("button", { name: "测试连接并刷新模型" });
    await testButton.click();
    await expect(dialog.locator(".ok-text")).toHaveText("连接成功，网关提供 5 个模型");
    await expect(dialog).toContainText("模型列表：已从网关获取");

    await page.route(`${GW}/v1/models`, (route) => route.fulfill({ status: 401, json: { error: { message: "invalid key" } } }));
    await testButton.click();
    const error = dialog.locator(".form-row", { hasText: "连接测试" }).locator(".form-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveText(/^鉴权失败：HTTP 401：invalid key/);
    await expect(dialog).toContainText("模型列表：离线，使用缓存");
  });

  test("#23 settings.json 由更新版本写入：提示、只存密钥、不覆盖文件", async ({ page }) => {
    const newer = JSON.stringify({ format_version: 99, base_url: GW, future_field: true });
    // 更新版本的文件按默认设置运行，默认网关地址不可达：一律 404。
    await page.route("http://lzxsvn:3001/**", (route) => route.fulfill({ status: 404, body: "" }));
    await openApp(page, boardScenario(title, board(title, [], []), { settings: newer }));
    const dialog = await openSettings(page);
    await expect(dialog.locator(".notice", { hasText: "更新版本" })).toContainText("由更新版本的工具写入（format_version 99）");
    await keyInput(dialog).fill("sk-only-key");
    await dialog.getByRole("button", { name: "仅保存密钥" }).click();
    await expect(dialog).toBeHidden();
    expect(await calls(page, "secret_set")).toEqual([{ key: "sk-only-key" }]);
    expect(await calls(page, "write_settings")).toEqual([]);
    expect(await e2e(page, (c) => c.readText("/e2e/appdata/settings.json"))).toBe(newer);
  });

  test("#24 凭据库不可用：保存后显示「密钥未持久化」提示", async ({ page }) => {
    await openApp(page, boardScenario(title, board(title, [], []), { secret: null, secretBroken: { set: true } }));
    const dialog = await openSettings(page);
    await keyInput(dialog).fill("sk-session");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toBeHidden();
    const reopened = await openSettings(page);
    await expect(reopened.locator(".notice", { hasText: "系统凭据库不可用" })).toHaveText("系统凭据库不可用：密钥未持久化，重启需重填。");
    await expect(keyInput(reopened)).toHaveValue("sk-session");
  });
});
