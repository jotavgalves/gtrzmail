export type SecretBindings = {
  MASTER_KEY_B64?: string;
  MASTER_KEY_SLOT_B_B64?: string;
  KEY_ROTATION_TOKEN?: string;
  RESEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
};

export type AppEnv = Env & SecretBindings;

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
};
