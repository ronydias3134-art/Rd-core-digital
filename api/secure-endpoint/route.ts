import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

// Rate limiting simples em memória
const rateLimitMap = new Map<string, { count: number; lastReset: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minuto
const MAX_REQUESTS = 20;

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const now = Date.now();
    
    // Controlo de Rate Limiting
    const userLimit = rateLimitMap.get(ip) || { count: 0, lastReset: now };
    if (now - userLimit.lastReset > RATE_LIMIT_WINDOW) {
      userLimit.count = 1;
      userLimit.lastReset = now;
    } else {
      userLimit.count++;
      if (userLimit.count > MAX_REQUESTS) {
        return NextResponse.json({ error: 'Demasiados pedidos. Tente mais tarde.' }, { status: 429 });
      }
    }
    rateLimitMap.set(ip, userLimit);

    // Validação de Assinatura HMAC-SHA256
    const signature = req.headers.get('x-signature');
    const bodyText = await req.text();
    const secret = process.env.HMAC_SECRET || 'chave-secreta-padrao';
    
    const computedSignature = crypto
      .createHmac('sha256', secret)
      .update(bodyText)
      .digest('hex');

    if (!signature || signature !== computedSignature) {
      return NextResponse.json({ error: 'Assinatura inválida ou não autorizada.' }, { status: 401 });
    }

    const data = JSON.parse(bodyText);

    // Processamento bem-sucedido da requisição
    return NextResponse.json({ success: true, message: 'Endpoint seguro operando com sucesso.', received: data });
  } catch (err) {
    return NextResponse.json({ error: 'Erro interno no processamento.' }, { status: 500 });
  }
}
