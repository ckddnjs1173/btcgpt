import type { Env } from './index';
import { handleEvalV2PathQualityRequest } from './eval-v2-path-quality-route';
import { handler as phase20Handler } from './phase20';
import { handleResearchReadRequest } from './phase24-25-research';
import { capturePlanLeverageFromSnapshot } from './phase25-leverage';
import { handleResearchOpsRequest } from './research-ops';

export async function handler(request: Request, env: Env): Promise<Response> {
  const pathQualityResponse = await handleEvalV2PathQualityRequest(
    request,
    env,
  );
  if (pathQualityResponse) return pathQualityResponse;

  const researchOpsResponse = await handleResearchOpsRequest(request, env);
  if (researchOpsResponse) return researchOpsResponse;

  const researchResponse = await handleResearchReadRequest(request, env);
  if (researchResponse) return researchResponse;

  const url = new URL(request.url);
  const isSnapshotUpload =
    request.method === 'PUT' && url.pathname === '/v1/snapshot/latest';
  if (!isSnapshotUpload) return phase20Handler(request, env);

  const analyticsRequest = request.clone();
  const response = await phase20Handler(request, env);
  if (response.ok) {
    try {
      const snapshot = (await analyticsRequest.json()) as unknown;
      await capturePlanLeverageFromSnapshot(env, snapshot);
    } catch {
      // Leverage telemetry is analytics-only and must never block live uploads.
    }
  }
  return response;
}

export default { fetch: handler };
