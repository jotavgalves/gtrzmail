export type SecretBindings = {
  MASTER_KEY_B64: string;
  RESEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET: string;
};

export type AppEnv = Env & SecretBindings;

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
};
