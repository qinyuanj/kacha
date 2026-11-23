// 集合的小工具：多选、展开这类「点一下加上、再点一下去掉」的切换在多处出现，形状只写一处。
// 全都是纯函数：返回新集合，不改调用方手里的那个。

/** 勾选集合的切换：有就删、没有就加。 */
export function toggled<T>(selected: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(selected);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
