import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getOperatorSecret(): string {
  return (
    process.env.OPERATOR_DECISION_KEY?.trim() ||
    process.env.API_HMAC_SECRET?.trim() ||
    ""
  );
}

function isAuthorized(req: NextRequest): boolean {
  const secret = getOperatorSecret();
  if (!secret) return false;
  const provided = req.headers.get("x-operator-key")?.trim() || "";
  return safeEqual(provided, secret);
}

function getSupabaseHeaders() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) return null;
  return {
    url,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
  };
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  }

  const sb = getSupabaseHeaders();
  if (!sb) {
    return NextResponse.json(
      { error: "Configuração do Supabase em falta no servidor." },
      { status: 500 }
    );
  }

  const statusFilter = req.nextUrl.searchParams.get("status")?.trim() || "pending_approval";
  const allowedStatuses = new Set(["pending_approval", "approved", "rejected"]);
  const safeStatus = allowedStatuses.has(statusFilter) ? statusFilter : "pending_approval";

  const queueUrl = `${sb.url}/rest/v1/robot_action_queue?approval_status=eq.${encodeURIComponent(
    safeStatus
  )}&order=created_at.desc&limit=25`;

  const qRes = await fetch(queueUrl, { headers: sb.headers, cache: "no-store" });
  if (!qRes.ok) {
    const errText = await qRes.text();
    return NextResponse.json(
      { error: "Falha ao ler a fila de aprovação.", details: errText },
      { status: 502 }
    );
  }

  const queueItems = (await qRes.json()) as Array<{
    id: string;
    lead_id: string | null;
    action_type: string;
    approval_status: string;
    operator_decision_at: string | null;
    payload: Record<string, unknown> | null;
    created_at: string;
  }>;

  const leadIds = Array.from(
    new Set(queueItems.map((item) => item.lead_id).filter((id): id is string => Boolean(id)))
  );

  let leadsById: Record<
    string,
    { id: string; company_name: string | null; email: string | null; source: string | null; status: string | null }
  > = {};

  if (leadIds.length > 
