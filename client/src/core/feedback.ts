// 反馈能力的共享契约：界面显示中文，提交与 Go/中继只认稳定英文 code。
// Go 侧 desktop/internal/feedbackrelay 与 desktop/internal/feedbackservice 的对应常量
// 由 packaging/tests/test_feedback_contract_sync.py 机械核对；改这里必须同步改 Go。
export const DEFAULT_FEEDBACK_RELAY_URL = "http://lzxsvn:3005";
export const FEEDBACK_MAX_SCREENSHOTS = 5;
export const FEEDBACK_MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

export const FEEDBACK_CATEGORIES = [
  { code: "bug", label: "缺陷" },
  { code: "feature", label: "需求" },
  { code: "suggestion", label: "建议" },
  { code: "other", label: "其他" },
] as const;

/** 预览、复制与回执里仍然给用户看中文标签，不把内部 code 露出来。 */
export function feedbackCategoryLabel(code: string): string {
  return FEEDBACK_CATEGORIES.find((item) => item.code === code)?.label ?? code;
}

/** 失败文案的客户端单一来源；与 Go feedbackservice 的 Message* 常量逐字一致。 */
export const FEEDBACK_FAILURE_MESSAGES = {
  unreachable: "反馈中继不可达，请稍后再试",
  rejected: "反馈被中继拒绝，请稍后再试",
  invalid: "反馈内容不合法，请修改后重试",
  too_large: "反馈内容过大，请精简后重试",
  duplicate: "刚刚已提交过，请勿重复提交。",
  unavailable: "反馈暂不可用：未配置中继地址",
} as const;

