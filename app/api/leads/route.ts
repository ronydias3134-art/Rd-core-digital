import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !key) {
    throw new Error("Variáveis NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY em falta.");
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseClient();
    const body = await req.json();

    // Exemplo de inserção na tabela de leads (ajusta o nome da tabela/colunas conforme o teu schema)
    const { data, error } = await supabase
      .from("leads")
      .insert(body)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true, data }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro interno no servidor";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
