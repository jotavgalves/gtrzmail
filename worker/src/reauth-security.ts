import type { AppEnv, SessionUser } from './env';
import {
  beginPasswordReauthAttempt,
  finishPasswordReauthAttempt
} from './ip-security';
import { json } from './http';
import { passwordStepUp } from './passkeys';

export async function passwordStepUpHardened(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  const started = await beginPasswordReauthAttempt(request, env, user);
  if (started.denied) return started.denied;
  if (!started.reservation) return json({ error: 'Não foi possível reservar a confirmação de senha.' }, 503);

  const releaseWithoutReset = async () => {
    await env.DB.prepare(
      `UPDATE password_reauth_limits
       SET verification_lock_until = 0, verification_nonce = NULL, updated_at = ?
       WHERE user_id = ? AND ip_hash = ? AND verification_nonce = ?`
    ).bind(
      Math.floor(Date.now() / 1000),
      started.reservation!.userId,
      started.reservation!.ipHash,
      started.reservation!.nonce
    ).run();
  };

  try {
    const response = await passwordStepUp(request, env, user);
    if (response.ok) {
      await finishPasswordReauthAttempt(env, started.reservation, true);
      return response;
    }

    if (response.status === 401) {
      const state = await finishPasswordReauthAttempt(env, started.reservation, false);
      if (state?.blocked) {
        return json({
          error: 'Três confirmações de senha incorretas. Tente novamente em 30 minutos.',
          code: 'REAUTH_COOLDOWN'
        }, 429, { 'retry-after': String(Math.max(1, state.retryAfterSeconds)) });
      }
      return response;
    }

    // Malformed requests and unrelated validation failures are not password
    // guesses and must not erase earlier failures or consume a new failure slot.
    await releaseWithoutReset();
    return response;
  } catch (error) {
    await releaseWithoutReset().catch(() => undefined);
    throw error;
  }
}
