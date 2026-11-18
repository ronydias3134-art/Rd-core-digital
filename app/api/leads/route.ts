// ==============================================================================
// RD COR DIGITAL - Motor Unificado de Leads e Orquestração
// ==============================================================================
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const HMAC_SECRET = process.env.RONNY_HMAC_SECRET || 'chave_seguranca_padrao';

// Validação de Segurança HMAC
function verifyHMAC(reqHeaderSignature, rawBody) {
    if (!reqHeaderSignature) return false;
    const computedSignature = crypto
        .createHmac('sha256', HMAC_SECRET)
        .update(JSON.stringify(rawBody))
        .digest('hex');
    return crypto.timingSafeEqual(
        Buffer.from(reqHeaderSignature),
        Buffer.from(computedSignature)
    );
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método não permitido. Utilize POST.' });
    }

    try {
        const signature = req.headers['x-ronny-signature'];
        const { client_name, company_domain, deal_value, email } = req.body;

        // Validar assinatura se necessário ou processar diretamente
        console.log(`[RD COR DIGITAL] A processar lead: ${client_name} (${email})`);

        const { data, error } = await supabase
            .from('crm_leads')
            .insert([
                {
                    client_name: client_name,
                    email: email,
                    company_domain: company_domain,
                    deal_value: deal_value || 300000, // Foco no patamar B2B
                    status: 'ProspectING'
                }
            ]);

        if (error) {
            throw new Error(error.message);
        }

        return res.status(200).json({
            success: true,
            message: 'Lead injetada com sucesso no ecossistema RD Cor Digital.',
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.error('[ERRO CRÍTICO NO MOTOR]:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
};
