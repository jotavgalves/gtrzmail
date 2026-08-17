import { resolveMx, resolveTxt } from 'node:dns/promises';

const domain = process.argv[2] || 'gtrz.com.br';

async function txt(name) {
  try {
    return (await resolveTxt(name)).map((parts) => parts.join(''));
  } catch (error) {
    return [`[não encontrado: ${error.code || error.message}]`];
  }
}

async function mx(name) {
  try {
    return (await resolveMx(name)).sort((a, b) => a.priority - b.priority);
  } catch (error) {
    return [{ exchange: `[não encontrado: ${error.code || error.message}]`, priority: 0 }];
  }
}

const [rootTxt, dmarcTxt, dkimTxt, mxRecords] = await Promise.all([
  txt(domain),
  txt(`_dmarc.${domain}`),
  txt(`resend._domainkey.${domain}`),
  mx(domain)
]);

const spf = rootTxt.filter((value) => value.toLowerCase().startsWith('v=spf1'));
const dmarc = dmarcTxt.filter((value) => value.toLowerCase().startsWith('v=dmarc1'));
const dkim = dkimTxt.filter((value) => value.toLowerCase().startsWith('p=') || value.toLowerCase().includes('v=dkim1'));

console.log(`\nDiagnóstico DNS de e-mail para ${domain}\n`);
console.log('SPF:');
console.log(spf.length ? spf.join('\n') : '  AUSENTE no domínio raiz');
console.log('\nDMARC:');
console.log(dmarc.length ? dmarc.join('\n') : `  AUSENTE — ponto de partida recomendado: v=DMARC1; p=none; adkim=s; aspf=s`);
console.log('\nDKIM Resend (resend._domainkey):');
console.log(dkim.length ? dkim.join('\n') : `  Não foi localizado via DNS público. Confira a verificação do domínio no Resend.`);
console.log('\nMX:');
for (const record of mxRecords) console.log(`  ${record.priority} ${record.exchange}`);

const issues = [];
if (!spf.length) issues.push('SPF raiz não localizado');
if (!dmarc.length) issues.push('DMARC não localizado');
if (!dkim.length) issues.push('DKIM Resend não localizado');

console.log('\nResultado:');
if (issues.length) {
  for (const issue of issues) console.log(`  ⚠ ${issue}`);
  process.exitCode = 2;
} else {
  console.log('  ✓ SPF, DMARC e DKIM foram localizados no DNS público.');
}
