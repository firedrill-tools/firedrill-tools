import assert from "node:assert/strict";
import { test } from "node:test";

import { balancedPublisherAssignments, childBatches } from "./publish-all-packages.mjs";

const publishers = [
  { slot: "A", username: "a", tokenVariable: "A" },
  { slot: "B", username: "b", tokenVariable: "B" },
  { slot: "C", username: "c", tokenVariable: "C" },
];

test("31 packages are assigned to three accounts as 11, 10, and 10", () => {
  const assignments = balancedPublisherAssignments(31, publishers);
  assert.deepEqual(
    assignments.map(({ username, offset, count }) => ({ username, offset, count })),
    [
      { username: "a", offset: 0, count: 11 },
      { username: "b", offset: 11, count: 10 },
      { username: "c", offset: 21, count: 10 },
    ],
  );
  assert.ok(assignments.every(({ count }) => count <= 25));
});

test("an eleven-package publisher assignment is split into child batches of ten and one", () => {
  assert.deepEqual(childBatches({ offset: 0, count: 11 }), [
    { offset: 0, count: 10 },
    { offset: 10, count: 1 },
  ]);
});

test("the publisher plan refuses to exceed the per-account safety limit", () => {
  assert.throws(() => balancedPublisherAssignments(76, publishers), /exceeding 25 publishes per account/);
});
