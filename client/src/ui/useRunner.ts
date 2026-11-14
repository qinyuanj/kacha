// 任务运行器的 React 接线：创建运行器（core 端口由壳端口给出），订阅快照，把并发上限同步进去。编排本身在 core/runner.ts（ADR 0015）。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRunner, type Runner, type RunnerChange } from "../core/runner";
import { useShell } from "./shell";

export function useRunner(apply: (boardKey: string, change: RunnerChange) => unknown, concurrency: number) {
  const port = useShell();
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const [runner] = useState<Runner>(() =>
    createRunner({
      deps: port.core.runDeps,
      apply: (boardKey, change) => void applyRef.current(boardKey, change),
      log: (kind, fields) => port.ui.log(kind, fields),
      concurrency,
    }),
  );
  const snapshot = useSyncExternalStore(runner.subscribe, runner.getSnapshot);
  // 并发上限调大后立即补派发。
  useEffect(() => runner.setConcurrency(concurrency), [runner, concurrency]);
  return { runner, snapshot };
}
