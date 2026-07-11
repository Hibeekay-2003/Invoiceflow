const { authenticator } = require('otplib');
const qrcode = require('qrcode-terminal');

const secret = authenticator.generateSecret();
const appName = 'InvoiceFlow';
const user = 'admin'; // Generic username for shared login
const otpauth = authenticator.keyuri(user, appName, secret);

console.log('\n=============================================');
console.log('🔒 INVOICEFLOW 2FA SECURE SETUP 🔒');
console.log('=============================================\n');

console.log('1. Open your Google Authenticator app.');
console.log('2. Tap the "+" button and select "Scan a QR code".');
console.log('3. Scan the giant QR code below:\n');

qrcode.generate(otpauth, { small: true });

console.log('\n=============================================');
console.log('✅ SECRET GENERATED SUCCESSFULLY!');
console.log('=============================================\n');

console.log('If you cannot scan the QR code, manually enter this secret key:');
console.log(`🔑 ${secret}\n`);

console.log('=============================================');
console.log('🚀 FINAL STEP: TURN IT ON');
console.log('=============================================');
console.log('To activate this new passwordless protection, restart your server');
console.log('using this exact command to inject the secret:\n');

console.log(`sudo docker stop $(sudo docker ps -q --filter ancestor=invoiceflow)`);
console.log(`sudo docker run -d -p 7821:7821 -e INVOICEFLOW_TOTP_SECRET="${secret}" --restart always invoiceflow`);

console.log('\n=============================================\n');
