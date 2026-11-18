import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);
const HMAC_SECRET = process.env.RONNY_HMAC_SECRET || 'chave_seguranca_padrao';

export async function POST(request: Request) {
    try {
        const rawBody = await request.text();
        const body = JSON.parse(rawBody);
        const signature = request.headers.get('x-ronny-signature') || request.headers.get('x-signature');

        // 1. Validação de Segurança HMAC (se enviada no cabeçalho)
        if (signature) {
            const expectedSignature = crypto
                .createHmac('sha256', HMAC_SECRET)
                .update(rawBody)
                .digest('hex');

            if (signature !== expectedSignature) {
                return NextResponse.json(
                    { success: false, error: 'Acesso negado: Assinatura HMAC inválida.' },
                    { status: 403 }
                );
            }
        }

        const { client_name, company_name, company_domain, decision_maker, deal_value, email } = body;

        if (!email) {
            return NextResponse.json(
                { success: false, error: 'O campo email é obrigatório.' },
                { status: 400 }
            );
        }

        // 2. Inserir na tabela crm_leads (alinhado com o worker.py)
        const { data, error } = await supabase
            .from('crm_leads')
            .insert([
                {
                    client_name: client_name || decision_maker || 'Lead B2B',
                    company_name: company_name || company_domain || 'Empresa Alvo',
                    decision_maker: decision_maker || client_name || 'Decisor',
                    email: email,
                    deal_value: deal_value || 300000,
                    status: 'Prospecting'
                }
            ])
            .select();

        if (error) {
            throw new Error(error.message);
        }

        return NextResponse.json({
            success: true,
            message: 'Lead injetada na tabela crm_leads com sucesso.',
            lead: data,
            timestamp: new Date().toISOString()
        }, { status: 200 });

    } catch (err: any) {
        console.error('[ERRO CRÍTICO NO MOTOR]:', err.message);
        return NextResponse.json(
            { success: false, error: err.message },
            { status: 500 }
        );
    }
}
