import type { Env } from './index';
import { handler as phase20Handler } from './phase20';
import { handleResearchReadRequest } from './phase24-25-research';

export async function handler(request: Request, env: Env): Promise<Response> {
  const researchResponse = await handleResearchReadRequest(request, env);
  if (researchResponse) return researchResponse;
  return phase20Handler(request, env);
}

export default { fetch: handler };
