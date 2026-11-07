/** 捕获值的可读文案：Error 取 message，其余转成字符串。 */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
