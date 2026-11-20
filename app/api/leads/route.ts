import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_SUPABASE_URL = "https://uadnfsmlabucptikpgpo.supabase.co";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function cleanEnv(value: string | undefined): string {
  if (!value) return "";
  return value.trim().replace(/^["']+|["']+$/g, "").trim();
}

function resolveSupabaseUrl(): string {
  const raw =
    cleanEnv(process.env.SUPABASE_URL) ||
    cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL) ||
    DEFAULT_SUPABASE_URL;

  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) {
    return raw.replace(/\/+$/, "");
  }
  return `https://${raw.replace(/\/+$/, "")}`;
}

function resolveServiceKey(): string {
  return (
    cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY) ||
    cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) ||
    ""
  );
}

function getClientIp(req: NextRequest): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const current = rateLimitStore.get(ip);

  if (!current || now > current.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  current.count += 1;
  return true;
}

function verifyHmacSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !secret) return false;

  const providedHex = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7).trim()
    : signatureHeader.trim();

  if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) {
    return false;
  }

  const expectedHex = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");

  const providedBuf = Buffer.from(providedHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");

  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

function getSupabaseClient() {
  const url = resolveSupabaseUrl();
  const key = resolveServiceKey();

  if (!url || !key) {
    throw new Error(
      `Configuração Supabase incompleta (hasUrl=${Boolean(url)}, hasKey=${Boolean(key)}).`
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function extractErrorDetails(err: unknown, supabaseUrl: string) {
  let message = "Erro interno no servidor.";
  let name = "Error";
  let code: string | null = null;
  let causeMessage: string | null = null;
  let causeCode: string | null = null;

  if (err instanceof Error) {
    message = err.message;
    name = err.name;
    const errWithMeta = err as Error & { code?: unknown; cause?: unknown };
    if (typeof errWithMeta.code === "string") {
      code = errWithMeta.code;
    }

    if (errWithMeta.cause && typeof errWithMeta.cause === "object") {
      const c = errWithMeta.cause as { message?: unknown; code?: unknown };
      if (typeof c.message === "string") causeMessage = c.message;
      if (typeof c.code === "string") causeCode = c.code;
    } else if (typeof errWithMeta.cause === "string") {
      causeMessage = errWithMeta.cause;
    }
  } else if (typeof err === "string") {
    message = err;
  }

  let hostname: string | null = null;
  try {
    hostname = supabaseUrl ? new URL(supabaseUrl).hostname : null;
  } catch {
    hostname = "invalid-url";
  }

  return {
    error: `${name}: ${message}`,
    code,
    cause: causeMessage,
    causeCode,
    targetHost: hostname,
  };
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Limite de pedidos excedido. Tenta novamente em breve." },
      { status: 429 }
    );
  }

  const supabaseUrl = resolveSupabaseUrl();

  try {
    const rawBody = await req.text();
    const signatureHeader = req.headers.get("x-signature");
    const webhookSecret = cleanEnv(process.env.WEBHOOK_HMAC_SECRET);

    if (signatureHeader) {
      if (!webhookSecret) {
        return NextResponse.json(
          { error: "WEBHOOK_HMAC_SECRET não configurado no servidor." },
          { status: 500 }
        );
      }
      if (!verifyHmacSignature(rawBody, signatureHeader, webhookSecret)) {
        return NextResponse.json(
          { error: "Assinatura HMAC inválida." },
          { status: 401 }
        );
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { error: "Corpo JSON inválido." },
        { status: 400 }
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json(
        { error: "Corpo JSON inválido." },
        { status: 400 }
      );
    }

    const payload = parsed as Record<string, unknown>;
    const nome = typeof payload.nome === "string" ? payload.nome.trim() : "";
    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    const origem = typeof payload.origem === "string" ? payload.origem.trim() : "api";

    if (!nome && !email) {
      return NextResponse.json(
        { error: "Campos obrigatórios em falta: nome ou email." },
        { status: 400 }
      );
    }

    const rowToInsert: Record<string, unknown> = {
      ...payload,
      ...(nome ? { nome } : {}),
      ...(email ? { email } : {}),
      origem: origem || "api",
    };

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("leads")
      .insert(rowToInsert)
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code ?? null,
          details: error.details ?? null,
          hint: error.hint ?? null,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ ok: true, data }, { status: 201 });
  } catch (err: unknown) {
    const details = extractErrorDetails(err, supabaseUrl);
    return NextResponse.json(details, { status: 500 });
  }
}
