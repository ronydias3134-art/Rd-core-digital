import time
from supabase import create_client

# Configurações do Supabase (substitui pelos teus dados reais)
SUPABASE_URL = "A_TUA_SUPABASE_URL"
SUPABASE_KEY = "A_TUA_SUPABASE_KEY"
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

def process_workers():
    try:
        # 1. Processar Comandos Pendentes
        commands = supabase.table("commands").select("*").eq("status", "pending").execute()
        for cmd in (commands.data or []):
            print(f"[COMANDO] A processar ID: {cmd['id']}")
            
            # Atualizar estado para em processamento
            supabase.table("commands").update({"status": "processing"}).eq("id", cmd["id"]).execute()
            
            # Execução da lógica do comando (aqui entra a IA ou script do agente)
            time.sleep(2)
            
            # Marcar como concluído
            supabase.table("commands").update({"status": "completed"}).eq("id", cmd["id"]).execute()
            print(f"[COMANDO] Concluído ID: {cmd['id']}")

        # 2. Processar Fila de Produção (Fábrica de Conteúdos)
        tasks = supabase.table("production_queue").select("*").eq("status", "queued").execute()
        for task in (tasks.data or []):
            print(f"[PRODUÇÃO] A produzir tarefa ID: {task['id']}")
            
            # Atualizar estado para em processamento
            supabase.table("production_queue").update({"status": "processing"}).eq("id", task["id"]).execute()
            
            # Simulação ou integração de geração de conteúdo
            time.sleep(3)
            
            # Marcar como concluído e gravar link do resultado
            supabase.table("production_queue").update({
                "status": "completed",
                "result_url": "https://exemplo.com/conteudo-gerado.mp4"
            }).eq("id", task["id"]).execute()
            print(f"[PRODUÇÃO] Concluída tarefa ID: {task['id']}")

    except Exception as e:
        print(f"[ERRO NO WORKER]: {e}")

if __name__ == "__main__":
    print("Worker do RD Core Digital iniciado. A escutar Supabase...")
    while True:
        process_workers()
        time.sleep(10) # Verifica novos pedidos a cada 10 segundos
