import { AdminPanel } from './SettingsPanels';
import { StepUpGate } from './PasskeySecurityPanel';

export default function SecureAdminPanel({ onNotice }: { onNotice: (message: string) => void }) {
  return <StepUpGate
    onNotice={onNotice}
    title="Administração protegida"
    description="Criar contas, alterar senhas, criar caixas e ativar/desativar usuários exige uma confirmação recente. Use sua senha ou uma passkey."
  >
    <AdminPanel onNotice={onNotice} />
  </StepUpGate>;
}
