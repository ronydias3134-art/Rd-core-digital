import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const globalForPg = globalThis as unknown as {
  enzoPgPool?: Pool;
};

function getPool(): Pool {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("Variável de ambiente SUPABASE_DB_URL não configurada.");
  }

  if (!globalForPg.enzoPgPool) {
    globalForPg.enzoPgPool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }

  return globalForPg.enzoPgPool;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-enzo-key",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  try {
    const expectedKey = process.env.ENZO_API_KEY;
    const providedKey = req.headers.get("x-enzo-key");

    if (!expectedKey) {
      return NextResponse.json(
        { ok: false, error: "ENZO_API_KEY não configurada no servidor." },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    if (!providedKey || providedKey !== expectedKey) {
      return NextResponse.json(
        { ok: false, error: "Não autorizado: chave x-enzo-key inválida." },
        { status: 401, headers: CORS_HEADERS }
      );
    }

    const body = await req.json().catch(() => null);
    const sql = typeof body?.sql === "string" ? body.sql.trim() : "";

    if (!sql) {
      return NextResponse.json(
        { ok: false, error: "Campo 'sql' obrigatório e não vazio." },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const pool = getPool();
    const result = await pool.query(sql);

    return NextResponse.json(
      {
        ok: true,
        command: result.command,
        rowCount: result.rowCount,
        rows: result.rows,
      },
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Erro interno ao executar SQL.";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
