import { randomBytes } from 'node:crypto';

const key = randomBytes(32).toString('base64');

console.log('MASTER_KEY_B64 gerada com 256 bits de entropia:');
console.log(key);
console.log('\nGuarde essa chave fora do Git e configure com:');
console.log('npx wrangler secret put MASTER_KEY_B64');
