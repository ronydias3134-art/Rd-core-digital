import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ status: "OK", message: "API de leads online e operacional!" });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return NextResponse.json({ 
      success: true, 
      message: "Dados recebidos com sucesso no ecossistema!",
      dadosRecebidos: body 
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: "Erro ao processar JSON" }, { status: 400 });
  }
}
