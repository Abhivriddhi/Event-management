import assert from "node:assert/strict";
import test from "node:test";
import { buildDirectConnectionUri } from "../lib/dbConnect.js";
import { getJwtSecret } from "../lib/jwtConfig.js";

const srvRecords = [
  { priority: 0, weight: 0, port: 27017, name: "shard-00-00.example.mongodb.net." },
  { priority: 0, weight: 0, port: 27017, name: "shard-00-01.example.mongodb.net." },
  { priority: 0, weight: 0, port: 27017, name: "shard-00-02.example.mongodb.net." },
];

test("Atlas fallback preserves credentials, database, and URI and TXT options", () => {
  const uri = "mongodb+srv://admin:p%40ss%3Aword@cluster.example.mongodb.net/abhivriddhi?appName=admin&authSource=custom";
  const directUri = buildDirectConnectionUri(uri, srvRecords, [
    "\"authSource=admin&replicaSet=atlas-shard-0\"",
  ]);
  const [authorityAndPath, query] = directUri.slice("mongodb://".length).split("?");
  const [authority, path] = authorityAndPath.split("/");
  const at = authority.lastIndexOf("@");
  const credentials = authority.slice(0, at);
  const hosts = authority.slice(at + 1).split(",");
  const options = new URLSearchParams(query);

  assert.equal(credentials, "admin:p%40ss%3Aword");
  assert.equal(path, "abhivriddhi");
  assert.deepEqual(hosts.sort(), [
    "shard-00-00.example.mongodb.net:27017",
    "shard-00-01.example.mongodb.net:27017",
    "shard-00-02.example.mongodb.net:27017",
  ]);
  assert.equal(options.get("appName"), "admin");
  assert.equal(options.get("authSource"), "custom");
  assert.equal(options.get("replicaSet"), "atlas-shard-0");
  assert.equal(options.get("tls"), "true");
});

test("Atlas fallback handles TXT chunks and rejects missing or invalid SRV records", () => {
  const uri = "mongodb+srv://admin:password@cluster.example.mongodb.net/abhivriddhi";
  const directUri = buildDirectConnectionUri(uri, srvRecords, [
    "\"authSource=admin\" \"&replicaSet=atlas-shard-0\"",
  ]);

  assert.equal(new URLSearchParams(directUri.split("?")[1]).get("replicaSet"), "atlas-shard-0");
  assert.throws(() => buildDirectConnectionUri(uri, [], []), /no MongoDB SRV records/i);
  assert.throws(() => buildDirectConnectionUri(uri, [{ port: "bad", name: "" }], []), /invalid MongoDB SRV record/i);
  assert.throws(() => buildDirectConnectionUri(uri, [{ priority: 1, weight: 0, port: 27017, name: "shard.example.mongodb.net" }], []), /weighted SRV records/i);
});

test("JWT configuration fails closed for secrets shorter than 32 bytes", () => {
  const originalSecret = process.env.JWT_SECRET;
  try {
    process.env.JWT_SECRET = "short";
    assert.equal(getJwtSecret(), null);

    process.env.JWT_SECRET = "x".repeat(32);
    assert.equal(getJwtSecret(), "x".repeat(32));
  } finally {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  }
});
