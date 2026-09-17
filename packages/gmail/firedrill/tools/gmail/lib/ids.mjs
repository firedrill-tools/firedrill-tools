// Identifier rendering and fixed vocabulary shared by behavior, codecs and data generators.
// Pure, deterministic, no Node built-ins.

/** Gmail system labels. They are constants, never rows in the labels namespace. */
export const SYSTEM_LABELS = [
  { id: "INBOX", messageListVisibility: "show", labelListVisibility: "labelShow" },
  { id: "SENT", messageListVisibility: "show", labelListVisibility: "labelShow" },
  { id: "DRAFT", messageListVisibility: "show", labelListVisibility: "labelShow" },
  { id: "TRASH", messageListVisibility: "hide", labelListVisibility: "labelHide" },
  { id: "SPAM", messageListVisibility: "hide", labelListVisibility: "labelHide" },
  { id: "UNREAD", messageListVisibility: "hide", labelListVisibility: "labelHide" },
  { id: "STARRED", messageListVisibility: "show", labelListVisibility: "labelShow" },
  { id: "IMPORTANT", messageListVisibility: "show", labelListVisibility: "labelShow" },
  { id: "CHAT", messageListVisibility: "hide", labelListVisibility: "labelHide" },
  { id: "CATEGORY_PERSONAL", messageListVisibility: "hide", labelListVisibility: "labelHide" },
  { id: "CATEGORY_SOCIAL", messageListVisibility: "hide", labelListVisibility: "labelHide" },
  { id: "CATEGORY_PROMOTIONS", messageListVisibility: "hide", labelListVisibility: "labelHide" },
  { id: "CATEGORY_UPDATES", messageListVisibility: "hide", labelListVisibility: "labelHide" },
  { id: "CATEGORY_FORUMS", messageListVisibility: "hide", labelListVisibility: "labelHide" },
];

export const SYSTEM_LABEL_IDS = SYSTEM_LABELS.map((label) => label.id);

/** Labels Gmail refuses to add or remove through modify-style calls. */
export const IMMUTABLE_LABEL_IDS = ["DRAFT", "SENT"];

/**
 * Lower-case names accepted by `label:` and `in:` search operators. A null-prototype frozen map: callers look names up
 * with `systemLabelByName`, so `constructor`, `__proto__` or `toString` never resolve to inherited Object members.
 */
export const SYSTEM_LABEL_BY_NAME = Object.freeze(
  Object.assign(Object.create(null), {
    inbox: "INBOX",
    sent: "SENT",
    draft: "DRAFT",
    drafts: "DRAFT",
    trash: "TRASH",
    spam: "SPAM",
    unread: "UNREAD",
    starred: "STARRED",
    important: "IMPORTANT",
    chat: "CHAT",
  }),
);

/** System label id for a lower-case search name, or null. Own keys only. */
export function systemLabelByName(name) {
  return Object.hasOwn(SYSTEM_LABEL_BY_NAME, name) ? SYSTEM_LABEL_BY_NAME[name] : null;
}

export function isSystemLabel(id) {
  return SYSTEM_LABEL_IDS.includes(id);
}

/** Message and thread ids: 16 lower-case hex characters. Generated ids start with "19" so they never collide with authored "18f…" rows. */
export function messageId(sequence) {
  return `19${sequence.toString(16).padStart(14, "0")}`;
}

/** Draft ids: "r" followed by 19 digits. Generated ids start with "r59". */
export function draftId(sequence) {
  return `r59${String(sequence).padStart(17, "0")}`;
}

export function labelId(sequence) {
  return `Label_${String(sequence)}`;
}

/** Row ids are "<mailbox>:<id>" so a bounded prefix scan yields exactly one mailbox. */
export function rowId(mailbox, id) {
  return `${mailbox}:${id}`;
}

const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Plain addresses only ("Name <addr>" is rejected, as in Google's own MCP contract). */
export function isPlainAddress(value) {
  return typeof value === "string" && value.length <= 254 && ADDRESS.test(value);
}

export function normalizeAddress(value) {
  return String(value).trim().toLowerCase();
}

/** FNV-1a 32-bit hash rendered as 8 hex characters; binds page tokens to their listing scope. */
export function scopeHash(parts) {
  const text = JSON.stringify(parts);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function compareDesc(left, right) {
  const leftTime = Number(left.internalDate);
  const rightTime = Number(right.internalDate);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

export function compareAsc(left, right) {
  return -compareDesc(left, right);
}
