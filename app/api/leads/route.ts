import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

interface LeadPayload {
  nome?: unknown;
  name?: unknown;
  company_name?: unknown;
  decision_maker?: unknown;
  email?: unknown;
  country?: unknown;
  niche?: unknown;
  status?: unknown;
  origem?: unknown;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

const rateLimitStore = new Map<string, RateLimitEntry>();

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded && forwarded.trim().length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const current = rateLimitStore.get(key);

  if (!current || now > current.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  current.count += 1;
  return true;
}

function verifyHmacSignature(
  rawBody: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader || !timestampHeader) return false;

  const timestampNum = Number(timestampHeader.trim());
  if (!Number.isFinite(timestampNum)) return false;

  const now = Date.now();
  if (Math.abs(now - timestampNum) > MAX_TIMESTAMP_DRIFT_MS) {
    return false;
  }

  const payloadToSign = `${timestampNum}.${rawBody}`;
  const expectedHex = crypto
    .createHmac("sha256", secret)
    .update(payloadToSign)
    .digest("hex");

  const providedHex = signatureHeader.replace(/^sha256=/i, "").trim();
  const providedBuf = Buffer.from(providedHex, "utf8");
  const expectedBuf = Buffer.from(expectedHex, "utf8");

  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  if (!checkRateLimit(`leads:get:${ip}`)) {
    return NextResponse.json(
      { error: "Limite de pedidos excedido. Tenta novamente em breve." },
      { status: 429 }
    );
  }

  const hmacSecret = process.env.API_HMAC_SECRET;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
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

  const rawBody = "";
  const timestamp = req.headers.get("x-timestamp");
  const signature = req.headers.get("x-signature-hmac-sha256");

  if (!verifyHmacSignature(rawBody, timestamp, signature, hmacSecret)) {
    return NextResponse.json(
      { error: "Assinatura HMAC inválida ou expirada." },
      { status: 401 }
    );
  }

  try {
    const cleanSupabaseUrl = supabaseUrl.replace(/\/+$/, "");
    const selectUrl = `${cleanSupabaseUrl}/rest/v1/b2b_leads?select=id,company_name,email,country,niche,status,send_count,last_error,updated_at&order=updated_at.desc&limit=50`;

    const supaRes = await fetch(selectUrl, {
      method: "GET",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
    });

    const supaText = await supaRes.text();
    let supaData: unknown = null;
    try {
      supaData = supaText ? JSON.parse(supaText) : null;
    } catch {
      supaData = supaText;
    }

    if (!supaRes.ok) {
      return NextResponse.json(
        {
          error: "Falha ao consultar leads no Supabase.",
          supabaseStatus: supaRes.status,
          detail: supaData,
        },
        { status: supaRes.status >= 400 && supaRes.status < 500 ? 400 : 502 }
      );
    }

    return NextResponse.json({ ok: true, leads: supaData }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro desconhecido";
    return NextResponse.json(
      { error: "Erro interno do servidor.", detail: message },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!checkRateLimit(`leads:post:${ip}`)) {
    return NextResponse.json(
      { error: "Limite de pedidos excedido. Tenta novamente em breve." },
      { status: 429 }
    );
  }

  try {
    const hmacSecret = process.env.API_HMAC_SECRET;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
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
    const timestamp = req.headers.get("x-timestamp");
    const signature = req.headers.get("x-signature-hmac-sha256");

    if (!verifyHmacSignature(rawBody, timestamp, signature, hmacSecret)) {
      return NextResponse.json(
        { error: "Assinatura HMAC inválida ou expirada." },
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

    const rawCompany = body.company_name ?? body.nome ?? body.name;
    const companyName = typeof rawCompany === "string" ? rawCompany.trim() : "";

    const rawDecisionMaker = body.decision_maker;
    const decisionMaker =
      typeof rawDecisionMaker === "string" && rawDecisionMaker.trim().length > 0
        ? rawDecisionMaker.trim()
        : null;

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const country =
      typeof body.country === "string" && body.country.trim().length > 0
        ? body.country.trim()
        : "PT";
    const niche =
      typeof body.niche === "string" && body.niche.trim().length > 0
        ? body.niche.trim()
        : null;
    const status =
      typeof body.status === "string" && body.status.trim().length > 0
        ? body.status.trim()
        : "new";

    if (!companyName || !email || !email.includes("@")) {
      return NextResponse.json(
        {
          error: "Os campos 'company_name' (ou 'nome'/'name') e 'email' válido são obrigatórios.",
        },
        { status: 400 }
      );
    }

    const cleanSupabaseUrl = supabaseUrl.replace(/\/+$/, "");

    const rowToInsert: Record<string, unknown> = {
      company_name: companyName,
      email,
      country,
      niche,
      status,
      updated_at: new Date().toISOString(),
    };

    if (decisionMaker) {
      rowToInsert.decision_maker = decisionMaker;
    }

    const insertLeadUrl = `${cleanSupabaseUrl}/rest/v1/b2b_leads?on_conflict=email`;
    const supaRes = await fetch(insertLeadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify([rowToInsert]),
    });

    const supaText = await supaRes.text();
    let supaData: unknown = null;
    try {
      supaData = supaText ? JSON.parse(supaText) : null;
    } catch {
      supaData = supaText;
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

    const createdList = Array.isArray(supaData) ? supaData : [];
    const createdRecord = (createdList[0] ?? supaData) as { id?: string } | null;

    // Enfileira ação para validação humana ("Sim" / "Não") sem executar envio externo automaticamente
    const queueUrl = `${cleanSupabaseUrl}/rest/v1/robot_action_queue`;
    const queueRes = await fetch(queueUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify([
        {
          lead_id: createdRecord?.id ?? null,
          action_type: "outreach_draft",
          payload: {
            company_name: companyName,
            email,
            decision_maker: decisionMaker,
            country,
            niche,
            operator: "Ronilson — RD Cor Digital",
            requires_human_approval: true,
          },
          approval_status: "pending_approval",
        },
      ]),
    });

    if (!queueRes.ok) {
      const queueErrText = await queueRes.text();
      return NextResponse.json(
        {
          error: "Lead gravada em b2b_leads, mas falhou ao criar item na fila robot_action_queue.",
          lead: createdRecord,
          detail: queueErrText,
        },
        { status: 502 }
      );
    }

    return NextResponse.json(
      { ok: true, lead: createdRecord, queued_for_approval: true },
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
