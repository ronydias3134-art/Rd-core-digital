import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const ipHits = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const current = ipHits.get(ip);
  if (!current || now > current.resetAt) {
    ipHits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (current.count >= RATE_LIMIT_MAX) {
    return false;
  }
  current.count += 1;
  return true;
}

function verifyHmacIfConfigured(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.WEBHOOK_SECRET || process.env.API_HMAC_SECRET;
  if (!secret) return true;
  if (!signatureHeader) return false;

  const expectedHex = createHmac("sha256", secret).update(rawBody).digest("hex");
  const normalized = signatureHeader.replace(/^sha256=/i, "").trim();

  const a = Buffer.from(expectedHex, "utf8");
  const b = Buffer.from(normalized, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function getSupabaseUrl(): string | null {
  const raw = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const cleaned = raw.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
  if (!cleaned) return null;
  return cleaned;
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const rawBody = await req.text();
  const sig = req.headers.get("x-signature-256") || req.headers.get("x-hub-signature-256");
  if (!verifyHmacIfConfigured(rawBody, sig)) {
    return NextResponse.json({ error: "Invalid HMAC signature" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const nome = typeof body.nome === "string" ? body.nome.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const origem = typeof body.origem === "string" ? body.origem.trim() : "api";

  if (!nome || !email) {
    return NextResponse.json({ error: "Campos 'nome' e 'email' são obrigatórios" }, { status: 400 });
  }

  const supabaseUrl = getSupabaseUrl();
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json(
      { error: "Variáveis SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY em falta" },
      { status: 500 }
    );
  }

  const targetUrl = `${supabaseUrl}/rest/v1/leads`;

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify([{ nome, email, origem }]),
    });

    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: "Supabase REST error", status: res.status, details: text, targetUrl },
        { status: res.status }
      );
    }

    return NextResponse.json({ ok: true, data: JSON.parse(text) }, { status: 201 });
  } catch (err: unknown) {
    const e = err as { message?: string; cause?: { code?: string; message?: string; hostname?: string } };
    return NextResponse.json(
      {
        error: e?.message || "Fetch failed",
        cause: e?.cause?.message || null,
        causeCode: e?.cause?.code || null,
        targetHost: e?.cause?.hostname || supabaseUrl,
      },
      { status: 500 }
    );
  }
}
