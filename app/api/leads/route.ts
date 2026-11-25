import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const operatorApiKey = process.env.OPERATOR_DECISION_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const ALLOWED_ACTIONS = [
  'lead_enrichment',
  'outreach_draft',
  'follow_up_draft',
  'sample_preparation',
] as const;

type AllowedAction = (typeof ALLOWED_ACTIONS)[number];

interface LeadMapInput {
  companyName: string;
  email: string;
  source?: string;
  initialAction?: AllowedAction;
  contextNotes?: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateLeadInput(rawInput: unknown): {
  valid: boolean;
  data?: LeadMapInput;
  error?: string;
} {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return { valid: false, error: 'Corpo do pedido inválido (esperado objeto JSON).' };
  }

  const raw = rawInput as Record<string, unknown>;
  const companyName =
    typeof raw.companyName === 'string' ? raw.companyName.trim() : '';
  const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
  const source =
    typeof raw.source === 'string' && raw.source.trim().length > 0
      ? raw.source.trim()
      : 'market_mapping';
  const contextNotes =
    typeof raw.contextNotes === 'string' && raw.contextNotes.trim().length > 0
      ? raw.contextNotes.trim()
      : undefined;

  const requestedAction = raw.initialAction;
  const initialAction: AllowedAction =
    typeof requestedAction === 'string' &&
    (ALLOWED_ACTIONS as readonly string[]).includes(requestedAction)
      ? (requestedAction as AllowedAction)
      : 'lead_enrichment';

  if (!companyName || companyName.length < 2) {
    return { valid: false, error: 'O campo companyName é obrigatório.' };
  }

  if (!email || !EMAIL_REGEX.test(email)) {
    return { valid: false, error: 'O campo email é obrigatório e deve ser válido.' };
  }

  if (contextNotes && contextNotes.length > 1000) {
    return { valid: false, error: 'contextNotes excede o limite de 1000 caracteres.' };
  }

  return {
    valid: true,
    data: {
      companyName,
      email,
      source,
      initialAction,
      contextNotes,
    },
  };
}

export async function POST(req: NextRequest) {
  try {
    // 1. Verificação de chave do operador
    const providedKey = req.headers.get('x-operator-key');
    if (!operatorApiKey || providedKey !== operatorApiKey) {
      return NextResponse.json({ error: 'Acesso não autorizado.' }, { status: 401 });
    }

    // 2. Parse e validação estrita de schema
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'JSON malformado.' }, { status: 400 });
    }

    const parsed = validateLeadInput(body);
    if (!parsed.valid || !parsed.data) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const { companyName, email, source, initialAction, contextNotes } = parsed.data;

    // 3. Inserir ou reutilizar lead na tabela b2b_leads
    const { data: insertedLead, error: leadError } = await supabase
      .from('b2b_leads')
      .insert({
        company_name: companyName,
        email,
        source,
        status: 'new',
      })
      .select('id, company_name, email, source, status')
      .single();

    if (leadError || !insertedLead) {
      return NextResponse.json(
        { error: 'Erro ao gravar lead na b2b_leads.', details: leadError?.message },
        { status: 500 }
      );
    }

    // 4. Criar ação na robot_action_queue sempre em pending_approval (sem envio automático)
    const { data: queuedAction, error: queueError } = await supabase
      .from('robot_action_queue')
      .insert({
        lead_id: insertedLead.id,
        action_type: initialAction,
        approval_status: 'pending_approval',
        operator_decision_at: null,
        payload: {
          company_name: insertedLead.company_name,
          email: insertedLead.email,
          source: insertedLead.source,
          auto_execute: false,
          requires_human_approval: true,
          ...(contextNotes ? { context_notes: contextNotes } : {}),
        },
      })
      .select('id, lead_id, action_type, approval_status, created_at')
      .single();

    if (queueError || !queuedAction) {
      return NextResponse.json(
        { error: 'Lead criada, mas falhou ao enfileirar ação.', details: queueError?.message },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        message: 'Lead registada e ação colocada em pending_approval para tua decisão.',
        lead: insertedLead,
        action: queuedAction,
      },
      { status: 201 }
    );
  } catch {
    return NextResponse.json({ error: 'Erro interno no servidor.' }, { status: 500 });
  }
}
