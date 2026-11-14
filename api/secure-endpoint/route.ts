import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const signature = req.headers['x-signature'];
  const payload = JSON.stringify(req.body);
  
  // Validação HMAC-SHA256
  const hmac = crypto.createHmac('sha256', process.env.HMAC_SECRET);
  const digest = hmac.update(payload).digest('hex');

  if (!signature || signature !== digest) {
    return res.status(401).json({ error: 'Unauthorized: Invalid signature' });
  }

  try {
    const { client_name, company, project_value } = req.body;

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

    return res.status(200).json({ success: true, contract_id: contract.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
