import { mailApi, type BrowserPushSubscription } from './api';

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

function subscriptionPayload(subscription: PushSubscription): BrowserPushSubscription {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error('O navegador retornou uma inscrição push incompleta.');
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime,
    keys: {
      p256dh: json.keys.p256dh,
      auth: json.keys.auth
    }
  };
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export async function syncExistingPushSubscription(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  const subscription = await currentPushSubscription();
  if (!subscription) return false;
  await mailApi.pushSubscribe(subscriptionPayload(subscription));
  return true;
}

export async function enableWebPush(): Promise<void> {
  if (!pushSupported()) throw new Error('Este navegador não oferece Web Push.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('As notificações não foram autorizadas neste navegador.');

  const { configured, publicKey } = await mailApi.pushPublicKey();
  if (!configured || !publicKey) throw new Error('O servidor ainda não possui as chaves de Web Push configuradas.');

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
  }
  await mailApi.pushSubscribe(subscriptionPayload(subscription));
}

export async function disableWebPushForCurrentAccount(): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  await mailApi.pushUnsubscribe(subscription.endpoint);
}
