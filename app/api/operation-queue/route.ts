import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_INTERVAL_MS = 40_000; // Pausa mínima obrigatória de >= 40 segundos
const MAX_BATCH_SIZE = 10; // Blocos máximos de 10 leads aprovadas
const MAX_DAILY_CAP = 30; // Teto diário máximo de 20-30 leads/dia

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

function isWeekendUTC(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6; // Domingo (0) ou Sábado (6)
}

function sleep(ms: number): Promise<void> {
  const safeMs = Math.max(ms, MIN_INTERVAL_MS);
  return new Promise((resolve) => setTimeout(resolve, safeMs));
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

  const statusFilter =
    req.nextUrl.searchParams.get("status")?.trim() || "pending_approval";
  const allowedStatuses = new Set(["pending_approval", "approved", "rejected"]);
  const safeStatus = allowedStatuses.has(statusFilter)
    ? statusFilter
    : "pending_approval";

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
    new Set(
      queueItems
        .map((item) => item.lead_id)
        .filter((id): id is string => Boolean(id))
    )
  );

  let leadsById: Record<
    string,
    {
      id: string;
      company_name: string | null;
      email: string | null;
      source: string | null;
      status: string | null;
    }
  > = {};

  if (leadIds.length > 0) {
    const inList = leadIds.map((id) => `"${id}"`).join(",");
    const leadsUrl = `${sb.url}/rest/v1/b2b_leads?id=in.(${encodeURIComponent(
      inList
    )})&select=id,company_name,email,source,status`;
    const lRes = await fetch(leadsUrl, { headers: sb.headers, cache: "no-store" });
    if (lRes.ok) {
      const leads = (await lRes.json()) as Array<{
        id: string;
        company_name: string | null;
        email: string | null;
        source: string | null;
        status: string | null;
      }>;
      leadsById = Object.fromEntries(leads.map((l) => [l.id, l]));
    }
  }

  const items = queueItems.map((item) => ({
    ...item,
    lead: item.lead_id ? leadsById[item.lead_id] || null : null,
  }));

  return NextResponse.json({ status: safeStatus, items });
}

export async function POST(req: NextRequest) {
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

  let body: {
    id?: string;
    decision?: string;
    note?: string;
    confirmDispatch?: boolean;
    allowWeekend?: boolean;
    intervalSeconds?: number;
    limit?: number;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  // Ramo A: Registo de decisão humana (approved / rejected) sobre um item da fila
  if (typeof body.decision === "string" && body.decision.trim().length > 0) {
    const id = body.id?.trim() || "";
    const decision = body.decision.trim();
    const note = body.note?.trim() || "";

    if (!id) {
      return NextResponse.json(
        { error: "ID da linha é obrigatório." },
        { status: 400 }
      );
    }
    if (decision !== "approved" && decision !== "rejected") {
      return NextResponse.json(
        { error: "Decisão inválida. Usa apenas 'approved' ou 'rejected'." },
        { status: 400 }
      );
    }

    const currentUrl = `${sb.url}/rest/v1/robot_action_queue?id=eq.${encodeURIComponent(
      id
    )}&select=id,payload,approval_status`;
    const curRes = await fetch(currentUrl, {
      headers: sb.headers,
      cache: "no-store",
    });
    if (!curRes.ok) {
      return NextResponse.json(
        { error: "Falha ao consultar item da fila." },
        { status: 502 }
      );
    }

    const existingRows = (await curRes.json()) as Array<{
      id: string;
      payload: Record<string, unknown> | null;
      approval_status: string;
    }>;
    if (existingRows.length === 0) {
      return NextResponse.json(
        { error: "Item não encontrado na fila." },
        { status: 404 }
      );
    }

    const nextPayload: Record<string, unknown> = {
      ...(existingRows[0].payload || {}),
      human_decision: decision === "approved" ? "Sim" : "Não",
      decided_by: "Ronny Dias",
      ...(note ? { operator_note: note } : {}),
    };

    const patchUrl = `${sb.url}/rest/v1/robot_action_queue?id=eq.${encodeURIComponent(
      id
    )}`;
    const patchRes = await fetch(patchUrl, {
      method: "PATCH",
      headers: {
        ...sb.headers,
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        approval_status: decision,
        operator_decision_at: new Date().toISOString(),
        payload: nextPayload,
      }),
    });

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      return NextResponse.json(
        { error: "Falha ao registar decisão na fila.", details: errText },
        { status: 502 }
      );
    }

    const updated = await patchRes.json();
    return NextResponse.json({ ok: true, item: updated[0] || null });
  }

  // Ramo B: Despacho cadenciado de itens já aprovados
  if (body.confirmDispatch !== true) {
    return NextResponse.json(
      {
        error:
          "Trava humana ativa: define confirmDispatch: true após o teu 'Sim' para iniciar a cadeia pausada ou indica 'decision'.",
      },
      { status: 423 }
    );
  }

  const now = new Date();
  if (isWeekendUTC(now) && body.allowWeekend !== true) {
    return NextResponse.json(
      {
        error:
          "Despacho bloqueado no fim de semana. A janela operacional está reservada para a segunda-feira no horário do mercado-alvo.",
      },
      { status: 423 }
    );
  }

  const requestedSeconds =
    typeof body.intervalSeconds === "number" &&
    Number.isFinite(body.intervalSeconds)
      ? body.intervalSeconds
      : 40;
  const effectiveIntervalMs = Math.max(40, requestedSeconds) * 1000;

  const batchLimit = Math.min(
    MAX_BATCH_SIZE,
    Math.max(
      1,
      typeof body.limit === "number" ? Math.floor(body.limit) : MAX_BATCH_SIZE
    )
  );

  const startOfDayIso = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)
  ).toISOString();

  const approvedUrl = `${sb.url}/rest/v1/robot_action_queue?approval_status=eq.approved&order=operator_decision_at.asc&limit=50`;
  const appRes = await fetch(approvedUrl, {
    headers: sb.headers,
    cache: "no-store",
  });
  if (!appRes.ok) {
    return NextResponse.json(
      { error: "Falha ao consultar itens aprovados na fila." },
      { status: 502 }
    );
  }

  const allApproved = (await appRes.json()) as Array<{
    id: string;
    lead_id: string | null;
    action_type: string;
    approval_status: string;
    operator_decision_at: string | null;
    payload: Record<string, unknown> | null;
  }>;

  const dispatchedTodayCount = allApproved.filter((row) => {
    const p = row.payload || {};
    const dispatchedAt =
      typeof p.dispatched_at === "string" ? p.dispatched_at : "";
    return p.dispatch_state === "dispatched" && dispatchedAt >= startOfDayIso;
  }).length;

  const remainingDailyQuota = Math.max(0, MAX_DAILY_CAP - dispatchedTodayCount);
  if (remainingDailyQuota === 0) {
    return NextResponse.json({
      ok: true,
      dispatchedCount: 0,
      reason: `Teto diário de ${MAX_DAILY_CAP} leads/dia atingido.`,
    });
  }

  const eligible = allApproved
    .filter((row) => {
      const p = row.payload || {};
      return p.dispatch_state !== "dispatched";
    })
    .slice(0, Math.min(batchLimit, remainingDailyQuota));

  const results: Array<{ id: string; status: string; dispatchedAt: string }> =
    [];

  for (let i = 0; i < eligible.length; i++) {
    if (i > 0) {
      await sleep(effectiveIntervalMs);
    }

    const item = eligible[i];
    const dispatchedAt = new Date().toISOString();
    const nextPayload: Record<string, unknown> = {
      ...(item.payload || {}),
      dispatch_state: "dispatched",
      dispatched_at: dispatchedAt,
      cadence_interval_seconds: effectiveIntervalMs / 1000,
      batch_size_cap: MAX_BATCH_SIZE,
      dispatched_by: "Enzo Dias / Ronny Dias (OaaS)",
    };

    const patchUrl = `${sb.url}/rest/v1/robot_action_queue?id=eq.${encodeURIComponent(
      item.id
    )}`;
    const patchRes = await fetch(patchUrl, {
      method: "PATCH",
      headers: {
        ...sb.headers,
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        payload: nextPayload,
      }),
    });

    if (patchRes.ok) {
      results.push({ id: item.id, status: "dispatched", dispatchedAt });
    } else {
      results.push({ id: item.id, status: "dispatch_failed", dispatchedAt });
    }
  }

  return NextResponse.json({
    ok: true,
    intervalSeconds: effectiveIntervalMs / 1000,
    batchLimit,
    dispatchedTodayBefore: dispatchedTodayCount,
    dispatchedInThisRun: results.length,
    results,
  });
}
