import mongoose from "mongoose";
import dns from "node:dns/promises";

const DNS_OVER_HTTPS_ENDPOINT = "https://dns.google/resolve";
const MONGODB_OPTIONS = { serverSelectionTimeoutMS: 15000 };

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

function isSrvDnsError(error) {
  return error?.code === "EBADRESP"
    || /query(?:Srv|Txt) EBADRESP/i.test(error?.message || "");
}

function describeConnectionError(error) {
  const details = [error?.name, error?.code, error?.message];
  const servers = error?.reason?.servers;

  if (servers && typeof servers.values === "function") {
    for (const server of servers.values()) {
      details.push(server.error?.name, server.error?.code, server.error?.message);
    }
  }

  const message = details.filter(Boolean).join(" ").toLowerCase();

  if (/bad auth|authentication failed|code.?8000/.test(message)) {
    return "authentication";
  }
  if (/querysrv|ebadresp|eai_again|enotfound|enodata|dns/i.test(message)) {
    return "DNS";
  }
  if (/tls|ssl|certificate|cert_/.test(message)) {
    return "TLS";
  }
  if (/mongoserverselectionerror|server selection timed out/.test(message)) {
    return "server selection";
  }
  if (/etimedout|econnrefused|ehostunreach|enetunreach|econnreset/.test(message)) {
    return "network timeout";
  }

  return "connection";
}

async function queryDnsOverHttps(name, type) {
  const url = new URL(DNS_OVER_HTTPS_ENDPOINT);
  url.searchParams.set("name", name);
  url.searchParams.set("type", type);

  const response = await fetch(url, {
    headers: { accept: "application/dns-json" },
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Atlas DNS-over-HTTPS ${type} lookup returned HTTP ${response.status}.`);
  }

  const result = await response.json();
  if (result.Status !== 0) {
    throw new Error(`Atlas DNS-over-HTTPS ${type} lookup returned DNS status ${result.Status}.`);
  }

  return (result.Answer || []).filter((answer) => answer.type === (type === "SRV" ? 33 : 16));
}

function parseTxtAnswer(data) {
  const chunks = data.match(/"[^"]*"/g);
  const value = chunks
    ? chunks.map((chunk) => chunk.slice(1, -1)).join("")
    : data;

  return new URLSearchParams(value);
}

export function buildDirectConnectionUri(uri, srvRecords, txtRecords) {
  const parsed = new URL(uri);
  if (parsed.protocol !== "mongodb+srv:") {
    throw new Error("A mongodb+srv URI is required to build the Atlas fallback URI.");
  }
  if (!srvRecords.length) {
    throw new Error("Atlas DNS returned no MongoDB SRV records.");
  }

  const hosts = srvRecords.map(({ priority = 0, weight = 0, port, name }) => {
    const hostname = String(name || "").replace(/\.$/, "");
    const numericPort = Number(port);

    if (Number(priority) !== 0 || Number(weight) !== 0) {
      throw new Error("Atlas DNS returned weighted SRV records that cannot be represented safely in a direct URI.");
    }
    if (!hostname || !Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      throw new Error("Atlas DNS returned an invalid MongoDB SRV record.");
    }

    return `${hostname}:${numericPort}`;
  });

  const options = new URLSearchParams(parsed.search);
  for (const record of txtRecords) {
    for (const [key, value] of parseTxtAnswer(record)) {
      if (!options.has(key)) options.set(key, value);
    }
  }
  if (!options.has("tls")) options.set("tls", "true");

  const path = parsed.pathname || "/";
  const query = options.toString();
  const credentials = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
    : "";
  return `mongodb://${credentials}${hosts.join(",")}${path}${query ? `?${query}` : ""}`;
}

async function getFallbackConnectionUri(uri) {
  const parsed = new URL(uri);
  const serviceName = `_mongodb._tcp.${parsed.hostname}`;
  const [srvAnswers, txtAnswers] = await Promise.all([
    queryDnsOverHttps(serviceName, "SRV"),
    queryDnsOverHttps(parsed.hostname, "TXT"),
  ]);
  const srvRecords = srvAnswers.map(({ data }) => {
    const [priority, weight, port, name] = data.trim().split(/\s+/);
    return { priority: Number(priority), weight: Number(weight), port: Number(port), name };
  });

  return buildDirectConnectionUri(
    uri,
    srvRecords,
    txtAnswers.map(({ data }) => data)
  );
}

async function getConnectionUri(uri) {
  if (!uri.startsWith("mongodb+srv://")) return uri;

  const parsed = new URL(uri);
  const serviceName = `_mongodb._tcp.${parsed.hostname}`;

  try {
    await Promise.all([
      dns.resolveSrv(serviceName),
      dns.resolveTxt(parsed.hostname).catch((error) => {
        if (error?.code === "ENODATA") return [];
        throw error;
      }),
    ]);
    return uri;
  } catch (error) {
    if (!isSrvDnsError(error)) throw error;
    console.warn("Node.js Atlas SRV resolution returned EBADRESP; retrying with validated Atlas DNS-over-HTTPS records.");
  }

  return getFallbackConnectionUri(uri);
}

async function dbConnect() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error("MONGODB_URI is not configured.");
  }
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = (async () => {
      const connectionUri = await getConnectionUri(mongoUri);
      try {
        return await mongoose.connect(connectionUri, MONGODB_OPTIONS);
      } catch (error) {
        if (connectionUri !== mongoUri || !isSrvDnsError(error)) throw error;

        console.warn("Node.js Atlas SRV resolution returned EBADRESP; retrying with validated Atlas DNS-over-HTTPS records.");
        const fallbackUri = await getFallbackConnectionUri(mongoUri);
        return mongoose.connect(fallbackUri, MONGODB_OPTIONS);
      }
    })();
  }

  try {
    cached.conn = await cached.promise;
    console.info("MongoDB connection established.");
    return cached.conn;
  } catch (error) {
    cached.promise = null;
    const category = describeConnectionError(error);
    console.error(`MongoDB ${category} failure (${error?.code || error?.name || "unknown error"}).`);
    throw error;
  }
}

export default dbConnect;
