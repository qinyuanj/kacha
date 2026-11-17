import { useContext, type Context } from "react";

/** 必需的宿主能力或画板能力必须由上层显式提供。 */
export function useRequiredContext<T>(context: Context<T | null>, message: string): T {
  const value = useContext(context);
  if (value === null) throw new Error(message);
  return value;
}
