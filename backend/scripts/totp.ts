/** Dev helper: prints the current TOTP code for a base32 secret (acts as an authenticator app). */
import { base32Decode, hotp } from '../packages/commerce-domain/src/identity.ts';
const secret = process.argv[2];
if (!secret) throw new Error('usage: tsx scripts/totp.ts <base32-secret>');
console.log(hotp(base32Decode(secret), Math.floor(Date.now() / 30000)));
