import type { AppEnv, SessionUser } from './env';
import {
  clearPasswordReauthFailures,
  enforcePasswordReauthLimit,
  recordPasswordReauthFailure
} from './ip-security';
import { passwordStepUp } from './passkeys';

export async function passwordStepUpHardened(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  const denied = await enforcePasswordReauthLimit(request, env, user);
  if (denied) return denied;

  const response = await passwordStepUp(request, env, user);
  if (response.ok) {
    await clearPasswordReauthFailures(request, env, user);
  } else if (response.status === 401) {
    await recordPasswordReauthFailure(request, env, user);
  }
  return response;
}
