import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// Inicializa o cliente Supabase usando a chave de serviço privada
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Mapa em memória para Rate Limiting (proteção contra flood/spam)
const rateLimitMap = new Map();
const LIMIT_WINDOW_MS = 60 * 1000; // 1 minuto
const MAX_REQUESTS = 10; // Máximo 10 pedidos por minuto por IP

function isRateLimited(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, startTime: now };

  if (now - record.startTime > LIMIT_WINDOW_MS) {
    record.count = 1;
    record.startTime = now;
  } else {
    record.count += 1;
  }

  rateLimitMap.set(ip, record);
  return record.count > MAX_REQUESTS;
}

export default async function handler(req, res) {
  // 1. Apenas permite método POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 2. Verificação de Rate Limiting por IP
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: 'Too Many Requests. Slow down.' });
  }

  // 3. Validação de Segurança (Chave Secreta / Token no Header)
  const incomingSecret = req.headers['x-api-secret'];
  const expectedSecret = process.env.RD_API_SECRET;

  if (!expectedSecret || !incomingSecret) {
    return res.status(401).json({ error: 'Unauthorized: Missing security token' });
  }

  // Comparação segura contra timing attacks
  const isValid = crypto.timingSafeEqual(
    Buffer.from(incomingSecret),
    Buffer.from(expectedSecret)
  );

  if (!isValid) {
    return res.status(403).json({ error: 'Forbidden: Invalid security token' });
  }

  // 4. Validação dos dados recebidos
  const { company_name, decision_maker, email, website, notes } = req.body;

  if (!company_name || !email) {
    return res.status(400).json({ error: 'Bad Request: company_name and email are required' });
  }

  // 5. Inserção segura no cofre do Supabase
  try {
    const { data, error } = await supabase
      .from('leads')
      .insert([
        {
          company_name: company_name.trim(),
          decision_maker: decision_maker ? decision_maker.trim() : null,
          email: email.trim().toLowerCase(),
          website: website ? website.trim() : null,
          notes: notes ? notes.trim() : null,
          status: 'pending'
        }
      ])
      .select();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Lead already exists in database' });
      }
      throw error;
    }

    return res.status(201).json({
      success: true,
      message: 'Lead securely ingested',
      lead: data[0]
    });
  } catch (err) {
    console.error('Supabase Ingestion Error:', err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
