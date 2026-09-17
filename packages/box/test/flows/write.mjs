// Write flow for Maya Chen: folders, file updates, trash and restore, copies, uploads and versions.
import assert from "node:assert/strict";
import { F, FI, MAYA, del, get, names, post, put, sha1, upload, uploadVersion } from "../client.mjs";
import { sharing } from "./write-sharing.mjs";

const DENIED = [403, "access_denied_insufficient_permissions"];
const LONG = "n".repeat(256);

async function folderWrites() {
  const created = await post("/2.0/folders", { name: "Launch Retro", parent: { id: F(2) } });
  assert.equal(created.body.parent.id, F(2));
  assert.equal(created.body.owned_by.id, MAYA);
  const conflict = await post("/2.0/folders", { name: "launch retro", parent: { id: F(2) } }, [409, "item_name_in_use"]);
  assert.equal(conflict.body.context_info.conflicts.id, created.body.id);
  await post("/2.0/folders", { name: "a/b", parent: { id: "0" } }, [400, "item_name_invalid"]);
  await post("/2.0/folders", { name: LONG, parent: { id: "0" } }, [400, "item_name_too_long"]);
  await post("/2.0/folders", { name: "Nope", parent: { id: "999" } }, [404, "not_found"]);
  await post("/2.0/folders", { name: "Nope", parent: { id: F(9) } }, [404, "trashed"]);
  await post("/2.0/folders", { name: "Nope", parent: { id: F(8) } }, DENIED);

  const id = created.body.id;
  await put(`/2.0/folders/${id}`, { name: "Retro" }, [412, "precondition_failed"], { headers: { "if-match": "7" } });
  const renamed = await put(`/2.0/folders/${id}`, { name: "Q3 Retro", tags: ["retro"], description: "Lessons learned" }, 200, { headers: { "if-match": "0" } });
  assert.deepEqual([renamed.body.name, renamed.body.etag, renamed.body.description], ["Q3 Retro", "1", "Lessons learned"]);
  const unchanged = await put(`/2.0/folders/${id}`, { name: "Q3 Retro" });
  assert.equal(unchanged.body.etag, "1", "an unchanged body writes nothing");
  await put(`/2.0/folders/${id}`, { name: "Brand Assets" }, 200);
  await put(`/2.0/folders/${id}`, { parent: { id: F(1) } }, [409, "item_name_in_use"]);
  await put(`/2.0/folders/${F(2)}`, { parent: { id: id } }, [400, "bad_request"]);
  await put(`/2.0/folders/${id}`, { name: ".." }, [400, "item_name_invalid"]);
  await put(`/2.0/folders/${id}`, { name: LONG }, [400, "item_name_too_long"]);
  await put("/2.0/folders/0", { name: "Everything" }, DENIED);
  await put(`/2.0/folders/${F(9)}`, { name: "x" }, [404, "trashed"]);
  await put("/2.0/folders/404", { name: "x" }, [404, "not_found"]);
  const moved = await put(`/2.0/folders/${id}`, { name: "Retro", parent: { id: F(1) } });
  assert.deepEqual(names(moved.body.path_collection.entries), ["All Files", "Marketing"]);

  const scratch = await post("/2.0/folders", { name: "Scratch", parent: { id: id } });
  await upload({ name: "notes.txt", parent: { id: scratch.body.id } }, "retro notes");
  await del(`/2.0/folders/${id}`, [400, "folder_not_empty"]);
  await del(`/2.0/folders/${id}?recursive=true`, [412, "precondition_failed"], { headers: { "if-match": "0" } });
  await del("/2.0/folders/0", DENIED);
  await del("/2.0/folders/123", [404, "not_found"]);
  await del(`/2.0/folders/${id}?recursive=true`);
  await del(`/2.0/folders/${id}`, [404, "trashed"]);
  await get(`/2.0/folders/${scratch.body.id}`, [404, "trashed"]);
  const trash = await get("/2.0/folders/trash/items");
  assert.deepEqual(names(trash.body.entries), ["Retro", "obsolete-budget.csv", "Old Drafts"], "only directly trashed items appear");

  const brandCopy = await post(`/2.0/folders/${F(4)}/copy`, { parent: { id: F(7) } });
  assert.deepEqual(names((await get(`/2.0/folders/${brandCopy.body.id}/items`)).body.entries), ["brand-guidelines.md", "color-palette.json", "README.md"]);
  assert.equal(brandCopy.body.size, 411);
  await post(`/2.0/folders/${F(4)}/copy`, { parent: { id: F(1) } }, [409, "item_name_in_use"]);
  await post(`/2.0/folders/${F(4)}/copy`, { parent: { id: F(1) }, name: "bad\\name" }, [400, "item_name_invalid"]);
  await post(`/2.0/folders/${F(4)}/copy`, { parent: { id: F(1) }, name: LONG }, [400, "item_name_too_long"]);
  await post(`/2.0/folders/${F(1)}/copy`, { parent: { id: F(4) } }, [400, "bad_request"]);
  await post(`/2.0/folders/${F(4)}/copy`, { parent: { id: F(8) } }, DENIED);
  await post(`/2.0/folders/${F(9)}/copy`, { parent: { id: F(7) } }, [404, "trashed"]);
  await post("/2.0/folders/777/copy", { parent: { id: F(7) } }, [404, "not_found"]);
}

async function fileWrites() {
  const tagged = await put(`/2.0/files/${FI(4)}`, { tags: ["palette", "brand"], description: "Palette v3" }, 200, { headers: { "if-match": "0" } });
  assert.equal(tagged.body.etag, "1");
  await put(`/2.0/files/${FI(4)}`, { name: "palette.json" }, [412, "precondition_failed"], { headers: { "if-match": "0" } });
  await put(`/2.0/files/${FI(4)}`, { name: "README.md" }, [409, "item_name_in_use"]);
  await put(`/2.0/files/${FI(4)}`, { name: " padded.json" }, [400, "item_name_invalid"]);
  await put(`/2.0/files/${FI(4)}`, { name: LONG }, [400, "item_name_too_long"]);
  await put(`/2.0/files/${FI(21)}`, { name: "mine.txt" }, DENIED);
  await put(`/2.0/files/${FI(19)}`, { name: "x.csv" }, [404, "trashed"]);
  await put("/2.0/files/1", { name: "x.csv" }, [404, "not_found"]);
  const renamed = await put(`/2.0/files/${FI(4)}`, { name: "palette.yaml", parent: { id: F(7) } });
  assert.deepEqual([renamed.body.extension, renamed.body.parent.id], ["yaml", F(7)]);

  await del(`/2.0/files/${FI(21)}`, DENIED);
  await del(`/2.0/files/${FI(2)}`, [412, "precondition_failed"], { headers: { "if-match": "3" } });
  await del(`/2.0/files/${FI(19)}`, [404, "trashed"]);
  await del("/2.0/files/2", [404, "not_found"]);
  await del(`/2.0/files/${FI(2)}`);
  assert.equal((await get(`/2.0/files/${FI(2)}`, [404, "trashed"])).body.code, "trashed");

  const oldVersion = (await get(`/2.0/files/${FI(1)}/versions`)).body.entries[1];
  const copy = await post(`/2.0/files/${FI(1)}/copy`, { parent: { id: F(7) }, name: "launch-plan-v1.md", version: oldVersion.id });
  assert.equal(copy.body.sha1, oldVersion.sha1);
  await post(`/2.0/files/${FI(1)}/copy`, { parent: { id: F(3) } }, [409, "item_name_in_use"]);
  await post(`/2.0/files/${FI(1)}/copy`, { parent: { id: F(7) }, name: "." }, [400, "item_name_invalid"]);
  await post(`/2.0/files/${FI(1)}/copy`, { parent: { id: F(7) }, name: LONG }, [400, "item_name_too_long"]);
  await post(`/2.0/files/${FI(23)}/copy`, { parent: { id: F(7) } }, DENIED);
  await post(`/2.0/files/${FI(19)}/copy`, { parent: { id: F(7) } }, [404, "trashed"]);
  await post("/2.0/files/3/copy", { parent: { id: F(7) } }, [404, "not_found"]);

  // Restore: a directly trashed file comes back; a file trashed with its folder needs a new parent.
  await upload({ name: "obsolete-budget.csv", parent: { id: "0" } }, "line,amount_eur\n");
  await post(`/2.0/files/${FI(19)}`, {}, [409, "item_name_in_use"]);
  await post(`/2.0/files/${FI(19)}`, { name: "bad/name.csv" }, [400, "item_name_invalid"]);
  await post(`/2.0/files/${FI(19)}`, { name: LONG }, [400, "item_name_too_long"]);
  await post(`/2.0/files/${FI(20)}`, {}, [400, "bad_request"]);
  await post(`/2.0/files/${FI(1)}`, {}, [404, "not_found"]);
  const restored = await post(`/2.0/files/${FI(19)}`, { name: "budget-2026-restored.csv" });
  assert.deepEqual([restored.body.item_status, restored.body.parent.id], ["active", "0"]);
  const rehomed = await post(`/2.0/files/${FI(20)}`, { parent: { id: F(7) } });
  assert.equal(rehomed.body.parent.id, F(7));
}

async function uploads() {
  const content = "# Retro agenda\n- What went well\n- Größte Hürden 🚧\n";
  const created = await upload({ name: "retro-agenda.md", parent: { id: F(7) }, content_modified_at: "2026-09-14T09:00:00+02:00" }, content);
  const file = created.body.entries[0];
  assert.equal(file.sha1, sha1(Buffer.from(content, "utf8")));
  assert.equal(file.size, Buffer.byteLength(content, "utf8"));
  assert.equal(file.content_modified_at, "2026-09-14T07:00:00-00:00");
  const again = await upload({ name: "retro-agenda.md", parent: { id: F(7) } }, "dup", [409, "item_name_in_use"]);
  assert.equal(again.body.context_info.conflicts[0].id, file.id);
  await upload({ name: "", parent: { id: F(7) } }, "x", [400, "item_name_invalid"]);
  await upload({ name: LONG, parent: { id: F(7) } }, "x", [400, "item_name_too_long"]);
  await upload({ name: "x.txt", parent: { id: "4040" } }, "x", [404, "not_found"]);
  await upload({ name: "x.txt", parent: { id: F(9) } }, "x", [404, "trashed"]);
  await upload({ name: "x.txt", parent: { id: F(8) } }, "x", DENIED);
  await upload({ name: "x.txt", parent: { id: F(7) }, content_created_at: "2026-09-14T09:00:00" }, "x", [400, "bad_request"]);
  await upload({ name: "big.txt", parent: { id: F(7) } }, "b".repeat(262145), [403, "file_size_limit_exceeded"]);

  const v2 = "# Retro agenda\n- Decisions\n";
  await uploadVersion(file.id, {}, v2, [412, "precondition_failed"], { "if-match": "9" });
  await uploadVersion(file.id, { name: "palette.yaml" }, v2, [409, "item_name_in_use"]);
  await uploadVersion(file.id, { name: "a/b.md" }, v2, [400, "item_name_invalid"]);
  await uploadVersion(file.id, { name: LONG }, v2, [400, "item_name_too_long"]);
  await uploadVersion(FI(21), {}, v2, DENIED);
  await uploadVersion(FI(2), {}, v2, [404, "trashed"]);
  await uploadVersion("5", {}, v2, [404, "not_found"]);
  const updated = await uploadVersion(file.id, { name: "retro-agenda-v2.md" }, v2, 201, { "if-match": "0" });
  assert.deepEqual([updated.body.entries[0].etag, updated.body.entries[0].name], ["1", "retro-agenda-v2.md"]);
  const downloaded = await get(`/2.0/files/${file.id}/content`, 200, { raw: true });
  assert.equal(downloaded.bytes.toString("utf8"), v2);
  const versions = await get(`/2.0/files/${file.id}/versions`);
  assert.equal(versions.body.entries[0].sha1, file.sha1);
}

export const FLOWS = {};
FLOWS["write-flow"] = async () => {
  await folderWrites();
  await fileWrites();
  await uploads();
  await sharing();
};
