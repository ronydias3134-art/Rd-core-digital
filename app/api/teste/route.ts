import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ 
    status: "OK", 
    message: "Rota de diagnóstico a funcionar perfeitamente!" 
  });
}
