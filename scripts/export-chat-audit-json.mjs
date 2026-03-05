#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const processRef = globalThis.process;
const fetchRef = globalThis.fetch;
const URLSearchParamsRef = globalThis.URLSearchParams;

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      out[arg.slice(2)] = "1";
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return out;
}

function required(name, value) {
  if (!value) {
    throw new Error(`Missing required value: ${name}`);
  }
  return value;
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/$/, "");
}

function withJsonExt(filePath) {
  return filePath.endsWith(".json") ? filePath : `${filePath}.json`;
}

function parsePositiveInt(rawValue, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(rawValue ?? ""), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

async function loadResumeState(resumePath) {
  const abs = path.resolve(processRef.cwd(), resumePath);
  const raw = await fs.readFile(abs, "utf-8");
  const parsed = JSON.parse(raw);
  const existingRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const meta = parsed?.meta && typeof parsed.meta === "object" ? parsed.meta : {};
  const nextOffset = Number.parseInt(String(meta.next_offset ?? existingRows.length), 10);
  return {
    absPath: abs,
    rows: existingRows,
    nextOffset: Number.isNaN(nextOffset) ? existingRows.length : Math.max(0, nextOffset),
    hasMore: Boolean(meta.has_more),
    previousMeta: meta
  };
}

async function writeShards(outputFile, rows, meta, shardSize) {
  const base = withJsonExt(outputFile);
  const ext = path.extname(base) || ".json";
  const stem = base.slice(0, -ext.length);
  const shardCount = Math.ceil(rows.length / shardSize);
  const shards = [];

  for (let i = 0; i < shardCount; i += 1) {
    const start = i * shardSize;
    const end = Math.min(rows.length, start + shardSize);
    const partRows = rows.slice(start, end);
    const shardFile = `${stem}.part-${String(i + 1).padStart(4, "0")}${ext}`;
    const shardPath = path.resolve(processRef.cwd(), shardFile);
    await fs.writeFile(
      shardPath,
      JSON.stringify(
        {
          meta: {
            ...meta,
            shard_index: i + 1,
            shard_count: shardCount,
            shard_start: start,
            shard_end_exclusive: end
          },
          rows: partRows
        },
        null,
        2
      ),
      "utf-8"
    );
    shards.push({
      file: shardFile,
      row_count: partRows.length,
      start,
      end_exclusive: end
    });
  }

  const manifestPath = path.resolve(processRef.cwd(), base);
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        meta: {
          ...meta,
          shard_size: shardSize,
          shard_count: shardCount,
          total_rows: rows.length
        },
        shards
      },
      null,
      2
    ),
    "utf-8"
  );

  return {
    manifestPath,
    shardCount
  };
}

async function main() {
  if (!processRef) {
    throw new Error("process is not available in this runtime");
  }
  if (!fetchRef || !URLSearchParamsRef) {
    throw new Error("fetch/URLSearchParams is not available in this Node runtime");
  }

  const args = parseArgs(processRef.argv.slice(2));
  const appBaseUrl = normalizeBaseUrl(required("APP_BASE_URL or --base-url", args["base-url"] ?? processRef.env.APP_BASE_URL));
  const exportToken = required("CHAT_EXPORT_TOKEN or --token", args.token ?? processRef.env.CHAT_EXPORT_TOKEN);
  const orgId = required("--org-id", args["org-id"]);

  const limit = parsePositiveInt(args.limit ?? "1000", 1000, 10000);
  const maxPages = parsePositiveInt(args["max-pages"] ?? "1000", 1000);
  const status = args.status ?? "all";
  const scope = args.scope ?? "all";
  const intent = args.intent ?? "all";
  const includeResult = args["include-result"] === "0" ? "0" : "1";
  const outFile = withJsonExt(
    args.out ?? `chat-audit-export-${orgId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`
  );
  const resumeFrom = args["resume-from"] ?? "";
  const shardSize = args["shard-size"] ? parsePositiveInt(args["shard-size"], 0) : 0;
  const explicitOffset = Object.prototype.hasOwnProperty.call(args, "offset");
  const initialOffset = Number.parseInt(args.offset ?? "0", 10);
  let offset = Number.isNaN(initialOffset) ? 0 : Math.max(0, initialOffset);

  let page = 0;
  const allRows = [];
  let lastMeta = null;
  let resumeInfo = null;

  if (resumeFrom) {
    resumeInfo = await loadResumeState(resumeFrom);
    allRows.push(...resumeInfo.rows);
    if (!explicitOffset) {
      offset = resumeInfo.nextOffset;
    }
    processRef.stdout.write(`[export] resumed rows=${resumeInfo.rows.length} from=${resumeInfo.absPath} next_offset=${offset}\n`);
    if (!resumeInfo.hasMore && !explicitOffset) {
      processRef.stdout.write("[export] resume source indicates has_more=false; no additional fetch needed.\n");
    }
  }

  while (page < maxPages && (!resumeInfo || resumeInfo.hasMore || explicitOffset)) {
    const qp = new URLSearchParamsRef({
      org_id: orgId,
      format: "json",
      limit: String(limit),
      offset: String(offset),
      status,
      scope,
      intent,
      include_result: includeResult
    });

    const url = `${appBaseUrl}/api/chat/audit/export?${qp.toString()}`;
    const res = await fetchRef(url, {
      headers: {
        "x-export-token": exportToken
      }
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Export request failed: ${res.status} ${txt.slice(0, 500)}`);
    }

    const json = await res.json();
    const rows = Array.isArray(json.rows) ? json.rows : [];
    allRows.push(...rows);
    lastMeta = json.meta ?? null;

    const hasMore = Boolean(json.meta?.has_more);
    const nextOffset = Number.parseInt(String(json.meta?.next_offset ?? "-1"), 10);

    processRef.stdout.write(
      `[export] page=${page + 1} offset=${offset} rows=${rows.length} total_accumulated=${allRows.length}\n`
    );

    if (!hasMore || Number.isNaN(nextOffset) || nextOffset < 0) {
      break;
    }

    offset = nextOffset;
    page += 1;
  }

  const output = {
    meta: {
      ...(lastMeta ?? {}),
      fetched_pages: page + 1,
      fetched_rows: allRows.length,
      requested: {
        org_id: orgId,
        limit,
        status,
        scope,
        intent,
        include_result: includeResult === "1"
      }
    },
    rows: allRows
  };

  if (shardSize > 0) {
    const { manifestPath, shardCount } = await writeShards(outFile, allRows, output.meta, shardSize);
    processRef.stdout.write(
      `[export] wrote ${allRows.length} rows in ${shardCount} shard file(s); manifest=${manifestPath}\n`
    );
    return;
  }

  const absOut = path.resolve(processRef.cwd(), outFile);
  await fs.writeFile(absOut, JSON.stringify(output, null, 2), "utf-8");
  processRef.stdout.write(`[export] wrote ${allRows.length} rows to ${absOut}\n`);
}

main().catch((error) => {
  if (processRef) {
    processRef.stderr.write(`[export] error: ${error instanceof Error ? error.message : String(error)}\n`);
    processRef.exit(1);
  }
});
