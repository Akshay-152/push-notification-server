#!/usr/bin/env node
/**
 * Generate a fresh VAPID keypair for Web Push.
 * Usage: npm run generate:vapid
 *
 * Print ready-to-paste .env lines. The PRIVATE key must never leave the
 * server, never be committed, and never be exposed through the API.
 */
import webPush from 'web-push';

const keys = webPush.generateVAPIDKeys();

console.log('New VAPID keypair generated.\n');
console.log('Add these lines to your .env file:\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('VAPID_SUBJECT=mailto:you@example.com');
console.log(`
Notes:
  • Keep VAPID_PRIVATE_KEY secret - it is server-only. Never commit .env.
  • Changing keys invalidates existing subscriptions: after rotating them,
    subscribers must re-subscribe (their old subscriptions will fail).
  • VAPID_SUBJECT must be a mailto: or https: contact address.
`);
