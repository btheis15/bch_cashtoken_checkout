/**
 * The memory store, kept in a JSON file: enough for trying the kit out, or a small shop on one server.
 * Every change rewrites the file (atomically: a temporary file, then a rename). Use your database once
 * there's more than a handful of orders a day (docs/integration.md has a SQL schema).
 *
 *   const store = createFileStore("./data/bch.json");
 *
 * The file holds the shop token's state too, including the registry file whose hash is on chain: back
 * it up.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createMemoryStore } from "./memory-store.js";

export function createFileStore(path) {
  let initial = null;
  try {
    initial = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  mkdirSync(dirname(path), { recursive: true });
  return createMemoryStore({
    initial,
    onChange(data) {
      writeFileSync(`${path}.tmp`, JSON.stringify(data));
      renameSync(`${path}.tmp`, path);
    },
  });
}
