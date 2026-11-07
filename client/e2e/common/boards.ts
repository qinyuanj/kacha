// e2e 夹具：画板 JSON 构造（不涉及服务端）；PNG 生成在 core/testing，与 core 单测共用。
import type { Page } from "@playwright/test";

export { png } from "../../src/core/testing/png";

type Json = Record<string, unknown>;

export const promptNode = (id: string, text: string, pos: [number, number] = [0, 0]) => ({ id, type: "prompt", pos, size: [240, 140], text });
export const referenceNode = (id: string, path: string, pos: [number, number] = [0, 200]) => ({
  id, type: "reference", pos, size: [200, 200], path, sha256: "0".repeat(64), display_name: path.split("/").pop(),
});
export const taskNode = (id: string, over: Json = {}, pos: [number, number] = [400, 0]) => ({
  id, type: "task", pos, size: [320, 360], model: "qwen-image-3.0-pro",
  size_spec: { tier: "1K", ratio: "1:1", width: null, height: null },
  image_ports: 0, layer_decomposition: false, transparent_background: false, last_submitted: null, ...over,
});
export const edge = (from: string, to: string, port: string, over: Json = {}) => ({ from: [from, "out"], to: [to, port], source_layer: null, region: null, ...over });

export function board(title: string, nodes: unknown[], edges: unknown[]) {
  return JSON.stringify({ format_version: 1, title, viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges }, null, 2);
}

export const MODELS = ["qwen-image-3.0-pro", "qwen-image-3.0", "doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-lite-260128", "doubao-seedream-5-0-flash-260915"];

export const task = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
