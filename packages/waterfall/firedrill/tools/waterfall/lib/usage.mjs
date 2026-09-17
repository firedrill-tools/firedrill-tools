// Inline usage accounting shared by job completion and result computers. Money is integer micro-USD in state and a
// USD number on the wire.
import { usd } from "./core.mjs";

export const zeroUsage = () => ({ persons_count: 0, persons_micros: 0, phones_count: 0, phones_micros: 0, companies_count: 0, companies_micros: 0 });

export function totalMicros(usage) {
  return usage.persons_micros + usage.phones_micros + usage.companies_micros;
}

export function usageWire(usage) {
  return {
    total_usd: usd(totalMicros(usage)),
    persons_count: usage.persons_count,
    persons_usd: usd(usage.persons_micros),
    phones_count: usage.phones_count,
    phones_usd: usd(usage.phones_micros),
    companies_count: usage.companies_count,
    companies_usd: usd(usage.companies_micros),
  };
}
