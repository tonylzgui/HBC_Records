import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

// Always load env from .env.local by default (or from DOTENV_CONFIG_PATH if provided)
const ENV_PATH = process.env.DOTENV_CONFIG_PATH || ".env.local";
dotenv.config({ path: ENV_PATH });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
console.log("[ingest] using env file:", ENV_PATH);
console.log("[ingest] script version: documents insert uses pdf_url/json_url");

if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

function pageKeyToNumber(pageKey) {
  const m = pageKey.match(/_page_(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function flattenLines(pageObj) {
  const out = [];
  const paragraphs = pageObj?.paragraphs ?? [];
  paragraphs.forEach((par, pIdx) => {
    const lines = par?.lines ?? [];
    lines.forEach((l, lIdx) => {
      out.push({
        uid: `${pIdx}-${lIdx}`,
        line_id: l.line_id ?? null,
        transcription: l.transcription ?? "",
        bbox: l.bbox,
      });
    });
  });
  return out;
}

async function main() {
  const [, , jsonFile, pdfPathInBucket] = process.argv;

  if (!jsonFile || !pdfPathInBucket) {
    console.error("Usage:");
    console.error("  node scripts/ingest_one_doc.mjs <local_json_path> <pdf_path_in_bucket>");
    console.error("Example:");
    console.error("  node scripts/ingest_one_doc.mjs ./data/1M17_B23-A-1.json 1M17_B23-A-1.pdf");
    process.exit(1);
  }

  const raw = fs.readFileSync(jsonFile, "utf8");
  const docJson = JSON.parse(raw);

  // You said you store JSONs too. We'll infer json_path as the filename by default.
  const jsonPathInBucket = path.basename(jsonFile);

  // 1) Insert documents row
  const title = path.basename(pdfPathInBucket, path.extname(pdfPathInBucket));

  const { data: docRow, error: docErr } = await supabase
    .from("documents")
    .insert({
      title,
      pdf_url: pdfPathInBucket,
      json_url: jsonPathInBucket,
    })
    .select("id")
    .single();

  if (docErr) throw docErr;
  const document_id = docRow.id;

  // 2) Build lines rows
  const pageKeys = Object.keys(docJson).sort((a, b) => (pageKeyToNumber(a) ?? 0) - (pageKeyToNumber(b) ?? 0));

  const rows = [];
  for (const pk of pageKeys) {
    const pageObj = docJson[pk];
    const lines = flattenLines(pageObj);

    for (const l of lines) {
      const [x1, y1, x2, y2] = l.bbox;
      const allFinite = [x1, y1, x2, y2].every((v) => Number.isFinite(v));
      if (!allFinite) continue;

      // `lines.bbox` is int4[] in Postgres, but OCR bboxes are often floats.
      // Convert deterministically to integers (rounded) before insert.
      const ix1 = Math.round(x1);
      const iy1 = Math.round(y1);
      const ix2 = Math.round(x2);
      const iy2 = Math.round(y2);

      rows.push({
        document_id,
        page_key: pk,
        uid: l.uid,
        bbox: [ix1, iy1, ix2, iy2],
        original_text: String(l.transcription ?? ""),
      });
    }
  }

  if (rows.length === 0) throw new Error("No lines found to insert.");

  // 3) Bulk insert in chunks
  const CHUNK = 1000;
  try {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);

      const { error } = await supabase
        .from("lines")
        .insert(chunk, { returning: "minimal" });

      if (error) throw error;

      console.log(`Inserted lines ${i + 1}-${i + chunk.length} / ${rows.length}`);
    }

    console.log("Done.");
    console.log("document_id:", document_id);
  } catch (e) {
    // If lines insertion fails, remove the documents row so we don't leave an orphan.
    await supabase.from("documents").delete().eq("id", document_id);
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});