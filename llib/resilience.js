// lib/resilience.js

export async function executeWithResilience(taskFunction, maxRetries = 3) {
  let attempts = 0;
  let success = false;
  let lastError = null;

  while (!success && attempts < maxRetries) {
    attempts++;
    try {
      const result = await taskFunction();
      return { success: true, data: result, attempts };
    } catch (error) {
      lastError = error;
      console.warn(`[Autonomia] Tentativa ${attempts} falhou: ${error.message}`);

      if (attempts < maxRetries) {
        // Variação estocástica para evitar bloqueio do algoritmo
        const stochasticDelay = Math.floor(Math.random() * 5000) + 2000 * attempts;
        await new Promise(resolve => setTimeout(resolve, stochasticDelay));
      }
    }
  }

  console.error(`[Autonomia Crítica] Tarefa falhou definitivamente após ${maxRetries} tentativas.`);
  
  return { 
    success: false, 
    error: lastError?.message || 'Erro desconhecido', 
    needsHumanReview: true 
  };
}
