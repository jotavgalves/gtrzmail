import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const wranglerBin = path.resolve(here, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const EXPECTED_NAME = 'GTRZ Mail Login';
const EXPECTED_HOSTNAME = 'mail.gtrz.com.br';
const WORKER_NAME = 'gtrz-mail';

const safeEnv = {
  ...process.env,
  WRANGLER_WRITE_LOGS: 'false',
  WRANGLER_LOG: 'log',
  WRANGLER_LOG_SANITIZE: 'true'
};

function runWrangler(args, { input, capture = true } = {}) {
  return spawnSync(process.execPath, [wranglerBin, ...args], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    env: safeEnv,
    stdio: capture
      ? [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
      : [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit']
  });
}

function fail(message, result) {
  console.error(message);
  if (result?.stderr) console.error(result.stderr.trim());
  process.exit(result?.status || 1);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text || 'null');
  } catch {
    console.error(`Não foi possível interpretar o JSON retornado por ${label}.`);
    process.exit(1);
  }
}

function widgetArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.result)) return value.result;
  if (Array.isArray(value?.widgets)) return value.widgets;
  if (Array.isArray(value?.result?.widgets)) return value.result.widgets;
  return [];
}

function domainArray(widget) {
  const value = widget?.domains ?? widget?.hostnames ?? widget?.domain;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  return [];
}

console.log('Consultando o widget Turnstile diretamente na conta Cloudflare, sem exibir chaves...');

const listed = runWrangler(['turnstile', 'widget', 'list', '--json']);
if (listed.error) fail(`Falha ao iniciar Wrangler: ${listed.error.message}`, listed);
if (listed.status !== 0) fail('Não foi possível listar os widgets Turnstile.', listed);

const widgets = widgetArray(parseJson(listed.stdout, 'turnstile widget list'));
let widget = widgets.find((item) => item?.name === EXPECTED_NAME && domainArray(item).includes(EXPECTED_HOSTNAME));
if (!widget) widget = widgets.find((item) => domainArray(item).includes(EXPECTED_HOSTNAME));
if (!widget) {
  console.error(`Nenhum widget Turnstile para ${EXPECTED_HOSTNAME} foi encontrado. Confirme que o widget “${EXPECTED_NAME}” existe nessa conta.`);
  process.exit(1);
}

const sitekey = String(widget.sitekey || widget.siteKey || '').trim();
if (!sitekey || /\s/.test(sitekey)) {
  console.error('O widget encontrado não retornou uma sitekey válida.');
  process.exit(1);
}

const detailResult = runWrangler(['turnstile', 'widget', 'get', sitekey, '--json']);
if (detailResult.error) fail(`Falha ao iniciar Wrangler: ${detailResult.error.message}`, detailResult);
if (detailResult.status !== 0) fail('Não foi possível consultar os detalhes do widget Turnstile.', detailResult);

const detailRaw = parseJson(detailResult.stdout, 'turnstile widget get');
const detail = detailRaw?.result && !Array.isArray(detailRaw.result) ? detailRaw.result : detailRaw;
const returnedSitekey = String(detail?.sitekey || detail?.siteKey || sitekey).trim();
const secret = String(detail?.secret || detail?.secret_key || detail?.secretKey || '').trim();
const domains = domainArray(detail).length ? domainArray(detail) : domainArray(widget);

if (returnedSitekey !== sitekey) {
  console.error('A sitekey retornada pelos detalhes não coincide com o widget selecionado. Nada foi alterado.');
  process.exit(1);
}
if (!domains.includes(EXPECTED_HOSTNAME)) {
  console.error(`O widget selecionado não autoriza ${EXPECTED_HOSTNAME}. Nada foi alterado.`);
  process.exit(1);
}
if (!secret || /\s/.test(secret)) {
  console.error('A Cloudflare não retornou uma secret key válida para o widget. Nada foi alterado.');
  process.exit(1);
}

const existing = runWrangler(['secret', 'list', '--format', 'json']);
if (existing.error) fail(`Falha ao iniciar Wrangler: ${existing.error.message}`, existing);
if (existing.status !== 0) fail('Não foi possível confirmar o Worker antes de atualizar os bindings.', existing);
const secretList = parseJson(existing.stdout, 'secret list');
const secretNames = Array.isArray(secretList) ? secretList.map((item) => item?.name).filter(Boolean) : [];
if (!secretNames.includes('MASTER_KEY_B64')) {
  console.error(`O Worker ${WORKER_NAME} não parece ser a instalação esperada do GTRZ Mail. Nada foi alterado.`);
  process.exit(1);
}

console.log('Widget confirmado. Regravando os dois bindings por stdin para evitar entrada interativa vazia...');
for (const [name, value] of [
  ['TURNSTILE_SITE_KEY', sitekey],
  ['TURNSTILE_SECRET_KEY', secret]
]) {
  const written = runWrangler(['secret', 'put', name], { input: `${value}\n`, capture: false });
  if (written.error) fail(`Falha ao iniciar Wrangler para ${name}: ${written.error.message}`, written);
  if (written.status !== 0) process.exit(written.status || 1);
}

// Drop secret-bearing strings from references as soon as the writes complete.
widget = null;

const checkUrl = `https://${EXPECTED_HOSTNAME}/api/auth/login-state?cb=${Date.now()}`;
let response;
try {
  response = await fetch(checkUrl, { headers: { 'cache-control': 'no-cache' } });
} catch (error) {
  console.error(`Bindings foram atualizados, mas a validação HTTP falhou: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const state = await response.json().catch(() => null);
if (!response.ok || state?.captchaConfigured !== true || typeof state?.siteKey !== 'string' || !state.siteKey) {
  console.error('Os bindings foram atualizados, mas o Worker ainda não confirmou o Turnstile em runtime.');
  console.error('Estado público:', JSON.stringify({
    status: response.status,
    captchaConfigured: Boolean(state?.captchaConfigured),
    siteKeyPresent: Boolean(state?.siteKey)
  }));
  process.exit(1);
}

console.log('Turnstile confirmado em produção: sitekey presente e validação server-side configurada.');
console.log('Nenhuma secret key foi exibida ou gravada em arquivo local.');
