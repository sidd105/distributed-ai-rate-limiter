export interface RetrievalResult {
  context: string;
  estimatedContextTokens: number;
}

export interface LlmResult {
  answer: string;
  actualTokens?: number;
}

export async function simulateRetrieval(question: string): Promise<RetrievalResult> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return {
    context: `Authorized payment-support context for: ${question.slice(0, 120)}`,
    estimatedContextTokens: Math.ceil(Math.min(question.length, 120) / 4) + 20,
  };
}

export async function simulateLlm(
  question: string,
  requestedActualTokens: number,
  reportUsage: boolean,
): Promise<LlmResult> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return {
    answer: `Simulated support answer for “${question.slice(0, 80)}”`,
    ...(reportUsage ? { actualTokens: requestedActualTokens } : {}),
  };
}
