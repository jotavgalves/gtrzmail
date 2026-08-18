import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { mailApi } from './api';

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && Boolean(window.PublicKeyCredential) && window.isSecureContext;
}

export async function loginWithPasskey(email: string) {
  if (!passkeysSupported()) throw new Error('Este navegador não oferece suporte a passkeys.');
  if (!email.trim()) throw new Error('Informe o e-mail antes de usar a passkey.');
  const request = await mailApi.passkeyLoginOptions(email.trim().toLowerCase());
  const response = await startAuthentication({ optionsJSON: request.options });
  return mailApi.passkeyLoginVerify(request.challengeId, response);
}

export async function stepUpWithPasskey() {
  if (!passkeysSupported()) throw new Error('Este navegador não oferece suporte a passkeys.');
  const request = await mailApi.passkeyStepUpOptions();
  if (!request.available) throw new Error('Nenhuma passkey está cadastrada nesta conta.');
  const response = await startAuthentication({ optionsJSON: request.options });
  return mailApi.passkeyStepUpVerify(request.challengeId, response);
}

export async function registerPasskey(name: string) {
  if (!passkeysSupported()) throw new Error('Este navegador não oferece suporte a passkeys.');
  const request = await mailApi.passkeyRegistrationOptions();
  const response = await startRegistration({ optionsJSON: request.options });
  return mailApi.passkeyRegistrationVerify(request.challengeId, response, name.trim() || 'Passkey');
}
