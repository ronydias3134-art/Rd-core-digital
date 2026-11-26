import { NextRequest, NextResponse } from "next/server";
import { Client } from "pg";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-enzo-key",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  const providedKey = req.headers.get("x-enzo-key");
  if (!process.env.ENZO_API_KEY || providedKey !== process.env.ENZO_API_KEY) {
    return NextResponse.json(
      { ok: false, error: "Chave de acesso inválida." },
      { status: 401, headers: CORS_HEADERS }
    );
  }

  let body: { sql?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "JSON inválido no corpo do pedido." },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const sql = body?.sql;
  if (!sql || typeof sql !== "string" || !sql.trim()) {
    return NextResponse.json(
      { ok: false, error: "O campo 'sql' é obrigatório." },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (/\bDROP\s+DATABASE\b/i.test(sql)) {
    return NextResponse.json(
      { ok: false, error: "Comando DROP DATABASE bloqueado por segurança." },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const client = new Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const result = await client.query(sql);
    return NextResponse.json(
      {
        ok: true,
        command: result.command,
        rowCount: result.rowCount,
        rows: result.rows ?? [],
      },
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erro desconhecido ao executar SQL.";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500, headers: CORS_HEADERS }
    );
  } finally {
    await client.end().catch(() => {});
  }
}
