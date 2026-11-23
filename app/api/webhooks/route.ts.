import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
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
  const secret = (process.env.WEBHOOK_SECRET || process.env.API_HMAC_SECRET || "").trim();
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

    let payload: unknown;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    console.log("[webhooks] Valid webhook received at:", new Date().toISOString());

    return NextResponse.json({ ok: true, received: true }, { status: 200 });
  } catch (err) {
    console.error("[webhooks] Unexpected error:", err);
    return NextResponse.json({ error: "Erro interno do servidor." }, { status: 500 });
  }
}
 
