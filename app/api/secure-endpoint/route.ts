import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

function verifyHmacStrict(rawBody: string, signatureHeader: string | null): boolean {
  const secret = (process.env.API_HMAC_SECRET || process.env.WEBHOOK_SECRET || "").trim();
  if (!secret || !signatureHeader) {
    return false;
  }

  const expectedHex = createHmac("sha256", secret).update(rawBody).digest("hex");
  const normalized = signatureHeader.replace(/^sha256=/i, "").trim();

  const a = Buffer.from(expectedHex, "utf8");
  const b = Buffer.from(normalized, "utf8");

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}

function getSupabaseUrl(): string | null {
  const raw = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const cleaned = raw.replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
  return cleaned || null;
}

export async function POST(req: NextRequest) {
  try {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";

    if (!checkRateLimit(ip)) {
      return NextResponse.json({ error: "Rate limit exceeded." }, { status: 429 });
    }

    const rawBody = await req.text();
    const sig =
      req.headers.get("x-signature-256") || req.headers.get("x-hub-signature-256");

    if (!verifyHmacStrict(rawBody, sig)) {
      return NextResponse.json({ error: "Invalid HMAC signature." }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const nome = typeof body.nome === "string" ? body.nome.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const origem =
      typeof body.origem === "string" && body.origem.trim()
        ? body.origem.trim()
        : "secure-endpoint";

    if (!nome || !email) {
      return NextResponse.json(
        { error: "Campos 'nome' e 'email' são obrigatórios." },
        { status: 400 }
      );
    }

    const supabaseUrl = getSupabaseUrl();
    const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

    if (!supabaseUrl || !serviceKey) {
      return NextResponse.json(
        { error: "Variáveis de ambiente do Supabase em falta." },
        { status: 500 }
      );
    }

    const res = await fetch(`${supabaseUrl}/rest/v1/leads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify({ nome, email, origem }),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error("[secure-endpoint] Supabase REST error:", res.status, text);
      return NextResponse.json(
        { error: "Falha ao processar registo no Supabase." },
        { status: res.status >= 400 && res.status < 600 ? res.status : 502 }
      );
    }

    let parsedData: unknown = null;
    try {
      parsedData = text ? JSON.parse(text) : null;
    } catch {
      parsedData = text;
    }

    return NextResponse.json({ ok: true, data: parsedData }, { status: 201 });
  } catch (err) {
    console.error("[secure-endpoint] Unexpected error:", err);
    return NextResponse.json({ error: "Erro interno do servidor." }, { status: 500 });
  }
}
