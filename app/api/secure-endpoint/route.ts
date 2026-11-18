import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// Inicializar o cliente do Supabase com as chaves de ambiente seguras
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const signature = request.headers.get('x-signature');
    const secretKey = process.env.API_SECRET_KEY || 'chave-seguranca-padrao';

    // 1. Validação de segurança HMAC para blindar o endpoint
    if (!signature) {
      return NextResponse.json({ error: 'Acesso negado: Assinatura em falta.' }, { status: 401 });
    }

    const expectedSignature = crypto
      .createHmac('sha256', secretKey)
      .update(JSON.stringify(body))
      .digest('hex');

    if (signature !== expectedSignature) {
      return NextResponse.json({ error: 'Acesso negado: Assinatura inválida.' }, { status: 403 });
    }

    // 2. Inserir os dados da lead diretamente na tabela do Supabase
    const { data, error } = await supabase
      .from('leads_b2b')
      .insert([
        { 
          company_name: body.company_name, 
          contact_email: body.contact_email, 
          phone: body.phone, 
          status: 'nova_lead',
          created_at: new Date().toISOString()
        }
      ]);

    if (error) {
      return NextResponse.json({ error: 'Erro ao gravar lead no Supabase: ' + error.message }, { status: 500 });
    }

    return NextResponse.json({ 
      success: true, 
      message: 'Lead validada via HMAC e guardada com sucesso no Supabase!',
      data 
    }, { status: 200 });

  } catch (error) {
    return NextResponse.json({ error: 'Erro interno no processamento do endpoint.' }, { status: 500 });
  }
}
