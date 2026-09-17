// Snowflake ids, row-key padding and virtual-time timestamps. Pure and deterministic: no host clock, no host time zone.

/** First millisecond of 2015, the epoch Discord snowflakes count from. */
export const DISCORD_EPOCH_MS = 1420070400000n;
const MAX_U64 = 18446744073709551615n;
const SNOWFLAKE = /^(0|[1-9][0-9]{0,19})$/;

export function isSnowflake(value) {
  return typeof value === "string" && SNOWFLAKE.test(value) && BigInt(value) <= MAX_U64;
}

/** Row keys pad snowflakes to 20 digits so string order equals numeric order. */
export function pad(id) {
  return id.padStart(20, "0");
}

export function compareIds(a, b) {
  const left = pad(a);
  const right = pad(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Next id: the snowflake of the current virtual millisecond (worker/process 0, increment 1), or one more than the
 * last generated id when virtual time has not advanced far enough. Ids are therefore unique and strictly increasing.
 */
export function nextSnowflake(nowUs, lastSnowflake) {
  const ms = BigInt(Math.floor(nowUs / 1000));
  let candidate = ms > DISCORD_EPOCH_MS ? ((ms - DISCORD_EPOCH_MS) << 22n) | 1n : 1n;
  const following = (isSnowflake(lastSnowflake) ? BigInt(lastSnowflake) : 0n) + 1n;
  if (following > candidate) candidate = following;
  return candidate.toString();
}

function two(value) {
  return String(value).padStart(2, "0");
}

/** `YYYY-MM-DDTHH:MM:SS.ffffff+00:00` in UTC from integer microseconds (civil-from-days arithmetic). */
export function isoFromUs(us) {
  const total = Math.max(0, Math.floor(us));
  const days = Math.floor(total / 86400000000);
  let rest = total - days * 86400000000;
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  const hours = Math.floor(rest / 3600000000);
  rest -= hours * 3600000000;
  const minutes = Math.floor(rest / 60000000);
  rest -= minutes * 60000000;
  const seconds = Math.floor(rest / 1000000);
  const micros = rest - seconds * 1000000;
  return `${String(year).padStart(4, "0")}-${two(month)}-${two(day)}T${two(hours)}:${two(minutes)}:${two(seconds)}.${String(micros).padStart(6, "0")}+00:00`;
}

const ISO_WITH_ZONE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,6})?(Z|[+-]([0-9]{2}):([0-9]{2}))$/;

/** Accepts only ISO 8601 date-times with an explicit zone and valid calendar fields; zone-less input is rejected. */
export function isIsoWithZone(value) {
  if (typeof value !== "string") return false;
  const match = ISO_WITH_ZONE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > lengths[month - 1]) return false;
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return false;
  if (match[9] !== undefined && (Number(match[9]) > 23 || Number(match[10]) > 59)) return false;
  return true;
}
