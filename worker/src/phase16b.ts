import type { Env } from './index';
import { handler as phase16ReplayHandler } from './phase13';
import { handleReplayEvalRequest } from './phase16-eval';

export async function handler(request: Request, env: Env): Promise<Response> {
  const evalResponse = await handleReplayEvalRequest(request, env);
  if (evalResponse) return evalResponse;
  return phase16ReplayHandler(request, env);
}

export default { fetch: handler };
