import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Inicializa o cliente do Supabase utilizando as variáveis de ambiente da Vercel
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

export async function GET() {
  return NextResponse.json({ status: "OK", ecossistema: "RD Cor Digital a operar com Supabase" });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { nome, contacto, interesse, origem } = body;

    // Insere os dados diretamente na tabela leads_rd criada no Supabase
    const { data, error } = await supabase
      .from('leads_rd')
      .insert([
        { 
          nome: nome || 'Não fornecido', 
          contacto: contacto || 'Não fornecido', 
          interesse: interesse || 'Geral', 
          origem: origem || 'Google Colab' 
        }
      ])
      .select();

    if (error) {
      console.error("Erro ao inserir no Supabase:", error);
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    return NextResponse.json({ 
      success: true, 
      message: "Lead gravada com sucesso na base de dados SQL!",
      dadosInseridos: data 
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message || "Erro interno ao processar lead" }, { status: 500 });
  }
}
