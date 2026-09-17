// Fixed-offset time zones (no daylight saving) and the provider's date formats, rendered from virtual time.

export const TIMEZONES = new Map([
  ["Etc/UTC", 0], ["UTC", 0], ["Europe/London", 0], ["Europe/Dublin", 0], ["Europe/Lisbon", 0], ["Africa/Lagos", 60], ["Europe/Paris", 60],
  ["Europe/Berlin", 60], ["Europe/Madrid", 60], ["Europe/Rome", 60], ["Europe/Amsterdam", 60], ["Europe/Brussels", 60], ["Europe/Stockholm", 60],
  ["Europe/Warsaw", 60], ["Europe/Zurich", 60], ["Europe/Athens", 120], ["Europe/Helsinki", 120], ["Europe/Kyiv", 120], ["Africa/Cairo", 120],
  ["Africa/Johannesburg", 120], ["Europe/Istanbul", 180], ["Europe/Moscow", 180], ["Asia/Dubai", 240], ["Asia/Karachi", 300], ["Asia/Kolkata", 330],
  ["Asia/Dhaka", 360], ["Asia/Bangkok", 420], ["Asia/Jakarta", 420], ["Asia/Singapore", 480], ["Asia/Shanghai", 480], ["Asia/Hong_Kong", 480],
  ["Asia/Tokyo", 540], ["Asia/Seoul", 540], ["Australia/Sydney", 600], ["Pacific/Auckland", 720], ["America/Sao_Paulo", -180],
  ["America/Argentina/Buenos_Aires", -180], ["America/New_York", -300], ["America/Toronto", -300], ["America/Chicago", -360],
  ["America/Mexico_City", -360], ["America/Denver", -420], ["America/Los_Angeles", -480], ["America/Anchorage", -540], ["Pacific/Honolulu", -600],
]);

export const DATE_FORMATS = new Set(["yyyy-MM-dd hh:mm a", "yyyy-MM-dd", "dd/MM/yyyy hh:mm a", "MM/dd/yyyy hh:mm a", "yyyy-MM-dd HH:mm",
  "yy-MM-dd hh:mm a", "yyyy-MM-dd HH:mm:ss", "MMMM dd, yyyy hh:mm a", "EEEE, MMMM dd, yyyy hh:mm a", "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"]);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const two = (n) => String(n).padStart(2, "0");

/** Formats virtual time `us` with one of DATE_FORMATS in a bundled fixed-offset zone. */
export function formatDate(us, format, timezone) {
  const offset = TIMEZONES.get(timezone) ?? 0;
  const d = new Date(Math.floor(us / 1000) + offset * 60000);
  const hours12 = d.getUTCHours() % 12 === 0 ? 12 : d.getUTCHours() % 12;
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const tokens = new Map([
    ["yyyy", String(d.getUTCFullYear())], ["yy", String(d.getUTCFullYear()).slice(-2)], ["MMMM", MONTHS[d.getUTCMonth()]],
    ["MM", two(d.getUTCMonth() + 1)], ["dd", two(d.getUTCDate())], ["EEEE", DAYS[d.getUTCDay()]], ["hh", two(hours12)],
    ["HH", two(d.getUTCHours())], ["mm", two(d.getUTCMinutes())], ["ss", two(d.getUTCSeconds())],
    ["SSS", String(d.getUTCMilliseconds()).padStart(3, "0")], ["a", d.getUTCHours() < 12 ? "AM" : "PM"],
    ["XXX", offset === 0 ? "Z" : `${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`],
  ]);
  let out = "";
  let i = 0;
  while (i < format.length) {
    const ch = format[i];
    if (ch === "'") {
      const end = format.indexOf("'", i + 1);
      out += format.slice(i + 1, end < 0 ? format.length : end);
      i = end < 0 ? format.length : end + 1;
    } else if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < format.length && format[j] === ch) j += 1;
      const run = format.slice(i, j);
      out += tokens.get(run) ?? run;
      i = j;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}
