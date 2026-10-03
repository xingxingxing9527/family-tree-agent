import type { PartialDate } from "../../../../shared/domain";

export function formatApproximateAge(
  birth: PartialDate | null,
  death: PartialDate | null,
  now = new Date()
): string | null {
  if (!birth) return null;
  const endpointYear = death?.year ?? now.getFullYear();
  const endpointMonth = death?.month ?? now.getMonth() + 1;
  const age = endpointYear - birth.year - (endpointMonth < birth.month ? 1 : 0);
  if (age < 0) return null;
  return death ? `享年约 ${age} 岁` : `约 ${age} 岁`;
}
