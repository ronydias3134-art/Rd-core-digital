import { NextResponse } from "next/server";

export async function GET() {
  const rawSupa = process.env.SUPABASE_URL ?? "";
  const rawPubSupa = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const rawKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  const chosen = (rawSupa || rawPubSupa).trim();
  let parsedHost: string | null = null;
  let parseError: string | null = null;

  try {
    parsedHost = chosen ? new URL(chosen).host : null;
  } catch (err: unknown) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json({
    ok: true,
    cwd: process.cwd(),
    nodeVersion: process.version,
    hasSupabaseUrl: Boolean(rawSupa.trim()),
    hasNextPublicSupabaseUrl: Boolean(rawPubSupa.trim()),
    hasServiceRoleKey: Boolean(rawKey.trim()),
    serviceKeyLength: rawKey.trim().length,
    chosenLength: chosen.length,
    parsedHost,
    parseError,
  });
}
