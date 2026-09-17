// Bounded state scans: a namespace larger than its bound fails loudly instead of returning a truncated view.
import { boundExceeded } from "./errors.mjs";

/** Every row of `namespace` (values only, in row-id order); fails INTERNAL_ERROR past `bound` rows. */
export function scanAll(context, namespace, bound) {
  const out = [];
  let after;
  for (;;) {
    const batch = context.state.scan(namespace, after === undefined ? { limit: 1000 } : { afterRowId: after, limit: 1000 });
    for (const record of batch) {
      out.push(record.value);
      if (out.length > bound) boundExceeded(context, namespace, bound);
    }
    if (batch.length < 1000) return out;
    after = batch[batch.length - 1].rowId;
  }
}

/** Rows of a namespace whose row ids start with `prefix` (children keyed `<parent>:<child>`), bounded. */
export function scanPrefix(context, namespace, prefix, bound) {
  const out = [];
  let after = prefix;
  for (;;) {
    const batch = context.state.scan(namespace, { afterRowId: after, limit: 1000 });
    for (const record of batch) {
      if (!record.rowId.startsWith(prefix)) return out;
      out.push(record.value);
      if (out.length > bound) boundExceeded(context, namespace, bound);
    }
    if (batch.length < 1000) return out;
    after = batch[batch.length - 1].rowId;
  }
}
