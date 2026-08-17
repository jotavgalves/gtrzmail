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

function dmarcTags(record) {
  return Object.fromEntries(
    record.split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return index > 0 ? [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim()] : [part.toLowerCase(), ''];
      })
  );
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
console.log(spf.length ? spf.map((value) => `  ${value}`).join('\n') : '  AUSENTE no domínio raiz');
if (spf.length > 1) console.log('  ⚠ Existem múltiplos registros SPF. Deve existir apenas um SPF por hostname.');

console.log('\nDMARC:');
if (dmarc.length) {
  for (const record of dmarc) {
    console.log(`  ${record}`);
    const tags = dmarcTags(record);
    const policy = (tags.p || '').toLowerCase();
    const subPolicy = (tags.sp || tags.p || '').toLowerCase();
    if (policy === 'reject') console.log(`  ✓ Política raiz: reject (enforcement máximo)`);
    else if (policy === 'quarantine') console.log(`  ✓ Política raiz: quarantine`);
    else if (policy === 'none') console.log(`  ⚠ Política raiz: none (somente monitoramento)`);
    else console.log(`  ⚠ Política DMARC sem p= reconhecido`);
    console.log(`  Subdomínios: ${subPolicy || 'herdam a política raiz'}`);
    if (tags.rua) console.log(`  Relatórios agregados: ${tags.rua}`);
    else console.log('  ℹ O registro não informa rua= para relatórios agregados.');
  }
} else {
  console.log('  AUSENTE — não publique uma política nova sem validar primeiro alinhamento SPF/DKIM.');
}

console.log('\nDKIM Resend (resend._domainkey):');
console.log(dkim.length ? dkim.map((value) => `  ${value}`).join('\n') : '  Não foi localizado via DNS público. Confira a verificação do domínio no Resend.');

console.log('\nMX:');
for (const record of mxRecords) console.log(`  ${record.priority} ${record.exchange}`);

const issues = [];
if (!spf.length) issues.push('SPF raiz não localizado');
if (spf.length > 1) issues.push('múltiplos registros SPF no domínio raiz');
if (!dmarc.length) issues.push('DMARC não localizado');
if (dmarc.length > 1) issues.push('múltiplos registros DMARC');
if (!dkim.length) issues.push('DKIM Resend não localizado');

console.log('\nResultado:');
if (issues.length) {
  for (const issue of issues) console.log(`  ⚠ ${issue}`);
  process.exitCode = 2;
} else {
  const policy = dmarcTags(dmarc[0]).p?.toLowerCase();
  console.log('  ✓ SPF, DMARC e DKIM foram localizados no DNS público.');
  if (policy === 'reject') console.log('  ✓ DMARC está em reject; não reduza a política sem motivo operacional.');
}

console.log('\nPostmaster Tools:');
console.log(`  Adicione ${domain} ao Google Postmaster Tools e publique somente o TXT de verificação fornecido pela sua Conta Google.`);
