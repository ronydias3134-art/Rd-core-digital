import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

interface LeadPayload {
  name?: unknown;
  nome?: unknown;
  email?: unknown;
  origem?: unknown;
}

function verifyHmacSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader) return false;

  const providedHex = signatureHeader.trim().replace(/^sha256=/i, "");
  const expectedHex = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");

  const providedBuf = Buffer.from(providedHex, "utf8");
  const expectedBuf = Buffer.from(expectedHex, "utf8");

  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

export async function POST(req: NextRequest) {
  try {
    const hmacSecret = process.env.API_HMAC_SECRET;
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!hmacSecret || !supabaseUrl || !serviceRoleKey) {
      return NextResponse.json(
        {
          error: "Configuração do servidor incompleta.",
          missing: {
            API_HMAC_SECRET: !hmacSecret,
            SUPABASE_URL: !supabaseUrl,
            SUPABASE_SERVICE_ROLE_KEY: !serviceRoleKey,
          },
        },
        { status: 500 }
      );
    }

    const rawBody = await req.text();
    const signature = req.headers.get("x-signature-hmac-sha256");

    if (!verifyHmacSignature(rawBody, signature, hmacSecret)) {
      return NextResponse.json(
        { error: "Assinatura HMAC inválida." },
        { status: 401 }
      );
    }

    let body: LeadPayload;
    try {
      body = JSON.parse(rawBody) as LeadPayload;
    } catch {
      return NextResponse.json(
        { error: "JSON inválido no corpo do pedido." },
        { status: 400 }
      );
    }

    const rawName = body.name ?? body.nome;
    const nome = typeof rawName === "string" ? rawName.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const origem =
      typeof body.origem === "string" && body.origem.trim().length > 0
        ? body.origem.trim()
        : "api_leads";

    if (!nome || !email) {
      return NextResponse.json(
        { error: "Os campos 'name' (ou 'nome') e 'email' são obrigatórios." },
        { status: 400 }
      );
    }

    const cleanSupabaseUrl = supabaseUrl.replace(/\/+$/, "");
    const insertUrl = `${cleanSupabaseUrl}/rest/v1/leads`;

    const supaRes = await fetch(insertUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify([{ nome, email, origem }]),
    });

    const supaText = await supaRes.text();
    let supaData: unknown = supaText;
    try {
      supaData = supaText ? JSON.parse(supaText) : null;
    } catch {
      // mantém texto bruto caso não seja JSON
    }

    if (!supaRes.ok) {
      return NextResponse.json(
        {
          error: "Falha ao registar lead no Supabase.",
          supabaseStatus: supaRes.status,
          detail: supaData,
        },
        { status: supaRes.status >= 400 && supaRes.status < 500 ? 400 : 502 }
      );
    }

    const createdRecord = Array.isArray(supaData) ? supaData[0] : supaData;
    return NextResponse.json(
      { ok: true, lead: createdRecord },
      { status: 201 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro desconhecido";
    return NextResponse.json(
      { error: "Erro interno do servidor.", detail: message },
      { status: 500 }
    );
  }
}
