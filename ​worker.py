import os
import time
import requests
from supabase import create_client, Client

# Carregar variáveis de ambiente seguras
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def run_replacement_outworker():
    print("A executar o worker autónomo de substituição (sem Make.com)...")
    
    # 1. Buscar lote de leads pendentes na tabela crm_leads
    response = supabase.table("crm_leads").select("*").eq("status", "Prospecting").limit(5).execute()
    leads = response.data
    
    if not leads:
        print("Nenhum lead pendente encontrado com status 'Prospecting'.")
        return

    for lead in leads:
        lead_id = lead["id"]
        email = lead["email"]
        company = lead["company_name"]
        decision_maker = lead["decision_maker"]
        
        try:
            # 2. Enviar e-mail via Resend API
            headers = {
                "Authorization": f"Bearer {RESEND_API_KEY}",
                "Content-Type": "application/json"
            }
            payload = {
                "from": "Engineering Boutique <outreach@teu-dominio.com>",
                "to": [email],
                "subject": f"Backend capacity & workflow automation for {company}",
                "html": f"""
                <p>Hello {decision_maker},</p>
                <p>We help high-growth digital agencies like {company} scale their backend architecture and eliminate workflow bottlenecks using secure Supabase and Vercel infrastructure.</p>
                <p>Would you be open to a brief technical overview this week?</p>
                <p>Best regards,<br>Ronilson Lopes<br>Engineering Boutique</p>
                """
            }
            
            res = requests.post("https://api.resend.com/emails", json=payload, headers=headers)
            
            if res.status_code in [200, 201]:
                # 3. Atualizar estado no Supabase para 'Contacted'
                supabase.table("crm_leads").update({"status": "Contacted"}).eq("id", lead_id).execute()
                print(f"[SUCESSO] E-mail enviado e registado para: {email}")
            else:
                print(f"[ERRO] Falha ao enviar para {email}: {res.text}")
                
            # 4. Pausa de segurança (jitter) entre envios para proteger o domínio
            time.sleep(5)
            
        except Exception as e:
            print(f"[EXCEÇÃO] Erro ao processar {email}: {str(e)}")

if __name__ == "__main__":
    run_replacement_outworker()
