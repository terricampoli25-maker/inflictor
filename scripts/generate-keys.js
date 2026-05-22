// Serial Activation System — Key Generator
// Run ONCE before first deployment:
//
//   node scripts/generate-keys.js
//
// Then follow the printed instructions.
// Node.js 18 or higher required.

const { webcrypto } = require('crypto');
const subtle = webcrypto.subtle;

async function main() {
  const keyPair = await subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify']
  );

  const privateKeyBytes = await subtle.exportKey('pkcs8', keyPair.privateKey);
  const publicKeyBytes  = await subtle.exportKey('raw',   keyPair.publicKey);

  const privateKey = Buffer.from(privateKeyBytes).toString('base64');
  const publicKey  = Buffer.from(publicKeyBytes).toString('base64');

  console.log('');
  console.log('='.repeat(64));
  console.log('  PRIVATE KEY  →  Cloudflare secret: SIGNING_PRIVATE_KEY');
  console.log('='.repeat(64));
  console.log(privateKey);
  console.log('');
  console.log('='.repeat(64));
  console.log('  PUBLIC KEY  →  paste into lib/validate.js as PUBLIC_KEY');
  console.log('='.repeat(64));
  console.log(publicKey);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Set the private key:  wrangler secret put SIGNING_PRIVATE_KEY');
  console.log('     (paste the private key above when prompted)');
  console.log('  2. Open lib/validate.js and replace PUBLIC_KEY with the public key above.');
  console.log('  3. Never commit the private key to git. The public key is safe to ship in apps.');
  console.log('');
}

main().catch(err => {
  console.error('Error generating keys:', err.message);
  process.exit(1);
});
