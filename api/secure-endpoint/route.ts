import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const signature = req.headers.get('x-signature');
    const rawBody = await req.text();

    // Validação HMAC-SHA256
    const hmac = crypto.createHmac('sha256', process.env.HMAC_SECRET!);
    const digest = hmac.update(rawBody).digest('hex');

    if (!signature || signature !== digest) {
      return Response.json({ error: 'Unauthorized: Invalid signature' }, { status: 401 });
    }

    const { client_name, company, project_value } = JSON.parse(rawBody);

    // 1. Inserir contrato na tabela b2b_contracts
    const { data: contract, error: contractError } = await supabase
      .from('b2b_contracts')
      .insert([{ client_name, company, project_value, status: 'ativo' }])
      .select()
      .single();

    if (contractError) throw contractError;

    // 2. Aplicar automaticamente a Regra 30/70 no financial_ledger
    const warChest30 = project_value * 0.30;
    const dividends70 = project_value * 0.70;

    const { error: ledgerError } = await supabase
      .from('financial_ledger')
      .insert([
        { contract_id: contract.id, type: 'retencao_caixa_30', amount: warChest30 },
        { contract_id: contract.id, type: 'dividendo_70', amount: dividends70 }
      ]);

    if (ledgerError) throw ledgerError;

    return Response.json({ success: true, contract_id: contract.id }, { status: 200 });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
