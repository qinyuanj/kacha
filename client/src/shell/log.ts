// 脱敏日志类别：调用方只传结构化字段，不传提示词、图片、密钥与下载地址。
export type LogKind = "task" | "connection" | "download" | "system" | "board_save_failed" | "relocate" | "rate_limit" | "queue_dispatch" | "board_pack";
