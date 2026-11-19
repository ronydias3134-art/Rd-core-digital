import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function getSupabaseClient() {
  const url = (
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    ""
  ).trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!url || !key) {
    throw new Error(
      "Variáveis SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY em falta."
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseClient();
    const body = await req.json();

    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Corpo JSON inválido." },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from("leads")
      .insert(body)
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { error: error.message, code: error.code ?? null },
        { status: 400 }
      );
    }

    return NextResponse.json({ ok: true, data }, { status: 201 });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Erro interno no servidor.";
    const cause =
      err instanceof Error && "cause" in err && err.cause instanceof Error
        ? err.cause.message
        : null;

    return NextResponse.json(
      { error: message, cause },
      { status: 400 }
    );
  }
}
