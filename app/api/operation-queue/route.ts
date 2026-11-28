import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_INTERVAL_MS = 40_000; // Pausa mínima obrigatória de >= 40 segundos
const MAX_BATCH_SIZE = 10; // Blocos de 10 leads aprovadas
const MAX_DAILY_CAP = 30; // Ritmo diário máximo de 20-30 leads/dia

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
    confirmDispatch?: boolean; // Exige confirmação explícita Sim (true)
    allowWeekend?: boolean; // Bloqueado por padrão; só com autorização expressa
    intervalSeconds?: number; // Nunca inferior a 40s
    limit?: number; // Máximo de 10 por bloco
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  if (body.confirmDispatch !== true) {
    return NextResponse.json(
      {
        error:
          "Trava humana ativa: define confirmDispatch: true após o teu 'Sim' para iniciar a cadeia pausada.",
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
    typeof body.intervalSeconds === "number" && Number.isFinite(body.intervalSeconds)
      ? body.intervalSeconds
      : 40;
  const effectiveIntervalMs = Math.max(40, requestedSeconds) * 1000;

  const batchLimit = Math.min(
    MAX_BATCH_SIZE,
    Math.max(1, typeof body.limit === "number" ? Math.floor(body.limit) : MAX_BATCH_SIZE)
  );

  // Conta quantos itens já foram despachados hoje (UTC) para respeitar o teto diário de 20-30 leads/dia
  const startOfDayIso = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)
  ).toISOString();

  const approvedUrl = `${sb.url}/rest/v1/robot_action_queue?approval_status=eq.approved&order=operator_decision_at.asc&limit=50`;
  const appRes = await fetch(approvedUrl, { headers: sb.headers, cache: "no-store" });
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
    const dispatchedAt = typeof p.dispatched_at === "string" ? p.dispatched_at : "";
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

  const results: Array<{ id: string; status: string; dispatchedAt: string }> = [];

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

    const patchUrl = `${sb.url}/rest/v1/robot_action_queue?id=eq.${encodeURIComponent(item.id)}`;
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
