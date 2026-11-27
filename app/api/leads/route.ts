import crypto from "node:crypto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const ALLOWED_ACTIONS = [
  "lead_enrichment",
  "outreach_draft",
  "follow_up_draft",
  "sample_preparation",
] as const;

type AllowedAction = (typeof ALLOWED_ACTIONS)[number];

interface LeadMapInput {
  companyName: string;
  email: string;
  source: string;
  initialAction: AllowedAction;
  contextNotes?: string;
}

type ValidationResult =
  | { valid: true; data: LeadMapInput; error?: never }
  | { valid: false; error: string; data?: never };

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_REQUESTS = 8;

function timingSafeEqualUtf8(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length || bufA.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyHmacSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!secret || !signatureHeader) {
    return false;
  }

  const normalizedHeader = signatureHeader
    .trim()
    .replace(/^sha256=/i, "")
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedHeader)) {
    return false;
  }

  const expectedHex = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex")
    .toLowerCase();

  return timingSafeEqualUtf8(normalizedHeader, expectedHex);
}

function isAuthorizedRequest(req: NextRequest, rawBody: string): boolean {
  const hmacSecret = (
    process.env.API_HMAC_SECRET ||
    process.env.WEBHOOK_HMAC_SECRET ||
    process.env.WEBHOOK_SECRET ||
    ""
  ).trim();
  const operatorKey = (process.env.OPERATOR_DECISION_KEY || "").trim();

  const signatureHeader =
    req.headers.get("x-signature-256") || req.headers.get("x-hmac-signature");
  const providedOperatorKey = req.headers.get("x-operator-key");

  const hmacValid = hmacSecret
    ? verifyHmacSignature(rawBody, signatureHeader, hmacSecret)
    : false;
  const operatorValid =
    operatorKey && providedOperatorKey
      ? timingSafeEqualUtf8(providedOperatorKey.trim(), operatorKey)
      : false;

  return hmacValid || operatorValid;
}

function getClientRateLimitKey(req: NextRequest): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  const firstForwardedIp = forwardedFor ? forwardedFor.split(",")[0]?.trim() : "";
  const realIp = req.headers.get("x-real-ip")?.trim() || "";
  const ip = firstForwardedIp || realIp || "unknown-client";
  return `leads:${ip}`;
}

function getSupabaseAdminClient(): SupabaseClient | null {
  const supabaseUrl = (
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    ""
  ).trim();
  const supabaseServiceKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  ).trim();

  if (!supabaseUrl || !supabaseServiceKey) {
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function consumePersistentRateLimit(
  supabase: SupabaseClient,
  rateKey: string
): Promise<{
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
  dbError: boolean;
}> {
  const { data, error } = await supabase.rpc("consume_rate_limit", {
    p_rate_key: rateKey,
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
    p_max_requests: RATE_LIMIT_MAX_REQUESTS,
  });

  if (error || !data) {
    return {
      allowed: false,
      retryAfterSeconds: RATE_LIMIT_WINDOW_SECONDS,
      remaining: 0,
      dbError: true,
    };
  }

  const row = Array.isArray(data) ? data[0] : data;
  const currentCount =
    typeof row?.current_count === "number"
      ? row.current_count
      : RATE_LIMIT_MAX_REQUESTS + 1;
  const allowed = Boolean(row?.allowed);
  const retryAfterSeconds =
    typeof row?.retry_after_seconds === "number" && row.retry_after_seconds > 0
      ? row.retry_after_seconds
      : RATE_LIMIT_WINDOW_SECONDS;
  const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - currentCount);

  return {
    allowed,
    retryAfterSeconds,
    remaining,
    dbError: false,
  };
}

function validateLeadInput(rawInput: unknown): ValidationResult {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return {
      valid: false,
      error: "Corpo do pedido inválido (esperado objeto JSON).",
    };
  }

  const raw = rawInput as Record<string, unknown>;
  const companyName =
    typeof raw.companyName === "string"
      ? raw.companyName.trim()
      : typeof raw.company_name === "string"
      ? raw.company_name.trim()
      : "";
  const email =
    typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  const source =
    typeof raw.source === "string" && raw.source.trim().length > 0
      ? raw.source.trim()
      : "market_mapping";
  const contextNotes =
    typeof raw.contextNotes === "string" && raw.contextNotes.trim().length > 0
      ? raw.contextNotes.trim()
      : typeof raw.context_notes === "string" && raw.context_notes.trim().length > 0
      ? raw.context_notes.trim()
      : undefined;

  const requestedAction = raw.initialAction;
  const initialAction: AllowedAction =
    typeof requestedAction === "string" &&
    (ALLOWED_ACTIONS as readonly string[]).includes(requestedAction)
      ? (requestedAction as AllowedAction)
      : "lead_enrichment";

  if (!companyName || companyName.length < 2) {
    return {
      valid: false,
      error: "O campo companyName é obrigatório.",
    };
  }

  if (!email || !EMAIL_REGEX.test(email)) {
    return {
      valid: false,
      error: "O campo email é obrigatório e deve ser válido.",
    };
  }

  if (contextNotes && contextNotes.length > 1000) {
    return {
      valid: false,
      error: "contextNotes excede o limite de 1000 caracteres.",
    };
  }

  return {
    valid: true,
    data: {
      companyName,
      email,
      source,
      initialAction,
      contextNotes,
    },
  };
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      Allow: "OPTIONS, POST",
    },
  });
}

export async function GET() {
  return NextResponse.json(
    { error: "Método não permitido." },
    {
      status: 405,
      headers: {
        Allow: "OPTIONS, POST",
      },
    }
  );
}

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "Configuração de base de dados incompleta no servidor." },
        { status: 500 }
      );
    }

    const rateKey = getClientRateLimitKey(req);
    const rateResult = await consumePersistentRateLimit(supabase, rateKey);

    if (rateResult.dbError) {
      return NextResponse.json(
        { error: "Falha ao validar limite de pedidos na base de dados." },
        { status: 502 }
      );
    }

    if (!rateResult.allowed) {
      return NextResponse.json(
        {
          error:
            "Limite de pedidos excedido (rate limit). Tenta novamente em instantes.",
          retry_after_seconds: rateResult.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(rateResult.retryAfterSeconds),
            "X-RateLimit-Limit": String(RATE_LIMIT_MAX_REQUESTS),
            "X-RateLimit-Remaining": "0",
          },
        }
      );
    }

    const rawBodyBytes = Buffer.from(await req.arrayBuffer());
    const rawBody = rawBodyBytes.toString("utf8");

    if (!isAuthorizedRequest(req, rawBody)) {
      return NextResponse.json(
        { error: "Acesso não autorizado." },
        { status: 401 }
      );
    }

    let body: unknown;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      return NextResponse.json(
        { error: "JSON malformado." },
        { status: 400 }
      );
    }

    const parsed: ValidationResult = validateLeadInput(body);
    if (!parsed.valid) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const { companyName, email, source, initialAction, contextNotes } =
      parsed.data;

    let leadRecord: {
      id: string;
      company_name: string;
      email: string;
      source: string;
      status: string;
    } | null = null;
    let createdNewLead = false;

    const { data: existingLead, error: lookupError } = await supabase
      .from("b2b_leads")
      .select("id, company_name, email, source, status")
      .eq("email", email)
      .maybeSingle();

    if (lookupError) {
      return NextResponse.json(
        {
          error: "Erro ao consultar lead na b2b_leads.",
          details: lookupError.message,
        },
        { status: 500 }
      );
    }

    if (existingLead) {
      leadRecord = existingLead;
    } else {
      const { data: insertedLead, error: leadError } = await supabase
        .from("b2b_leads")
        .insert({
          company_name: companyName,
          email,
          source,
          status: "new",
        })
        .select("id, company_name, email, source, status")
        .single();

      if (leadError || !insertedLead) {
        return NextResponse.json(
          {
            error: "Erro ao gravar lead na b2b_leads.",
            details: leadError?.message,
          },
          { status: 500 }
        );
      }

      leadRecord = insertedLead;
      createdNewLead = true;
    }

    const { data: queuedAction, error: queueError } = await supabase
      .from("robot_action_queue")
      .insert({
        lead_id: leadRecord.id,
        action_type: initialAction,
        approval_status: "pending_approval",
        operator_decision_at: null,
        payload: {
          company_name: leadRecord.company_name,
          email: leadRecord.email,
          source: leadRecord.source,
          auto_execute: false,
          requires_human_approval: true,
          ...(contextNotes ? { context_notes: contextNotes } : {}),
        },
      })
      .select("id, lead_id, action_type, approval_status, created_at")
      .single();

    if (queueError || !queuedAction) {
      if (createdNewLead) {
        await supabase.from("b2b_leads").delete().eq("id", leadRecord.id);
      }
      return NextResponse.json(
        {
          error: "Falha ao enfileirar ação na robot_action_queue.",
          details: queueError?.message,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        deduplicated_lead: !createdNewLead,
        message:
          "Lead registada e ação colocada em pending_approval para tua decisão.",
        lead: leadRecord,
        action: queuedAction,
      },
      {
        status: 201,
        headers: {
          "X-RateLimit-Limit": String(RATE_LIMIT_MAX_REQUESTS),
          "X-RateLimit-Remaining": String(rateResult.remaining),
        },
      }
    );
  } catch {
    return NextResponse.json(
      { error: "Erro interno no servidor." },
      { status: 500 }
    );
  }
}
