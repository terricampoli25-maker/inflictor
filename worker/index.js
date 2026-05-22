// Serial Activation System — Cloudflare Worker
// Handles: Stripe webhooks, activation, subscription check-ins

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const SERIAL_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/I/1

function generateSerial(productCode) {
  const chunk = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map(b => SERIAL_CHARSET[b % SERIAL_CHARSET.length])
      .join('');
  return `${productCode}-${chunk()}-${chunk()}-${chunk()}`;
}

function subscriptionExpiry() {
  return new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString();
}

async function signToken(payload, privateKeyBase64) {
  const keyBytes = Uint8Array.from(atob(privateKeyBase64), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', keyBytes.buffer,
    { name: 'Ed25519' },
    false, ['sign']
  );
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const sig  = await crypto.subtle.sign('Ed25519', key, data);
  return btoa(JSON.stringify(payload)) + '.' + btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function sendEmail(to, subject, html, env) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend: ${await res.text()}`);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ---------------------------------------------------------------------------
// Stripe webhook verification (no SDK — pure Web Crypto)
// ---------------------------------------------------------------------------

async function parseStripeWebhook(request, secret) {
  const body = await request.text();
  const sigHeader = request.headers.get('stripe-signature') ?? '';

  const parts = {};
  sigHeader.split(',').forEach(part => {
    const idx = part.indexOf('=');
    parts[part.slice(0, idx)] = part.slice(idx + 1);
  });

  const { t: timestamp, v1: expectedSig } = parts;
  if (!timestamp || !expectedSig) throw new Error('Missing stripe-signature parts');

  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
    throw new Error('Stale Stripe timestamp');
  }

  const signedPayload = `${timestamp}.${body}`;
  const keyBytes = new TextEncoder().encode(secret);
  const msgBytes = new TextEncoder().encode(signedPayload);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBytes  = await crypto.subtle.sign('HMAC', cryptoKey, msgBytes);
  const computed  = Array.from(new Uint8Array(sigBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  if (computed !== expectedSig) throw new Error('Invalid Stripe signature');

  return JSON.parse(body);
}

// ---------------------------------------------------------------------------
// Handler: Stripe webhook
// ---------------------------------------------------------------------------

async function handleStripeWebhook(request, env) {
  let event;
  try {
    event = await parseStripeWebhook(request, env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return json({ error: e.message }, 400);
  }

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session     = event.data.object;
        const email       = session.customer_details?.email ?? session.customer_email;
        const productCode = session.metadata?.product_code;
        const isSubscription = session.mode === 'subscription';

        if (!productCode || !email) {
          console.error('Webhook missing product_code metadata or customer email', session.id);
          break;
        }

        const product = await env.DB.prepare(
          'SELECT id, name FROM products WHERE code = ? AND is_active = 1'
        ).bind(productCode).first();

        if (!product) {
          console.error('Unknown product code:', productCode);
          break;
        }

        // Generate a unique serial (retry on the rare collision)
        let serial;
        for (let i = 0; i < 10; i++) {
          const candidate = generateSerial(productCode);
          const exists = await env.DB.prepare(
            'SELECT id FROM serials WHERE serial = ?'
          ).bind(candidate).first();
          if (!exists) { serial = candidate; break; }
        }
        if (!serial) throw new Error('Failed to generate unique serial');

        await env.DB.prepare(`
          INSERT INTO serials
            (serial, product_id, customer_email, stripe_payment_id, stripe_customer_id, stripe_subscription_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          serial,
          product.id,
          email,
          session.payment_intent ?? null,
          session.customer ?? null,
          session.subscription ?? null,
        ).run();

        const licenseNote = isSubscription
          ? '<p>Your license is active while your subscription is current. You may activate on up to 2 devices.</p>'
          : '<p>This is a lifetime license. You may activate on up to 2 devices.</p>';

        await sendEmail(
          email,
          `Your Serial Number — ${product.name}`,
          `
            <div style="font-family:sans-serif;max-width:520px;margin:auto">
              <h2>Thank you for your purchase!</h2>
              <p>Your serial number for <strong>${product.name}</strong> is:</p>
              <p style="font-family:monospace;font-size:24px;letter-spacing:4px;background:#f4f4f4;padding:16px;border-radius:6px">${serial}</p>
              <p>Open the app, click <strong>Activate</strong>, and enter this code.</p>
              ${licenseNote}
              <p style="color:#888;font-size:13px">Keep this email — it's your proof of purchase.</p>
            </div>
          `,
          env,
        );

        console.log('Serial issued:', serial, 'for', email);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const result = await env.DB.prepare(
          'UPDATE serials SET is_active = 0 WHERE stripe_subscription_id = ?'
        ).bind(sub.id).run();
        console.log('Subscription canceled, deactivated serials:', result.meta.changes, 'for sub', sub.id);
        break;
      }

      // invoice.payment_failed — Stripe will eventually fire subscription.deleted;
      // letting the 35-day expiry window handle the grace period is enough.
    }
  } catch (e) {
    console.error('Webhook processing error:', e);
    // Return 200 so Stripe doesn't keep retrying for our internal errors
  }

  return json({ received: true });
}

// ---------------------------------------------------------------------------
// Handler: /activate
// Body: { serial: string, machineId: string }
// ---------------------------------------------------------------------------

async function handleActivation(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { serial, machineId } = body ?? {};
  if (!serial || !machineId) return json({ error: 'serial and machineId are required' }, 400);

  const row = await env.DB.prepare(`
    SELECT s.id, s.max_activations, s.is_active,
           p.code AS product, p.name AS productName, p.is_subscription
    FROM serials s
    JOIN products p ON p.id = s.product_id
    WHERE s.serial = ?
  `).bind(serial).first();

  if (!row)         return json({ error: 'Serial number not found' }, 404);
  if (!row.is_active) return json({ error: 'This license has been deactivated' }, 403);

  const existing = await env.DB.prepare(
    'SELECT id FROM activations WHERE serial_id = ? AND machine_id = ?'
  ).bind(row.id, machineId).first();

  const expiresAt = row.is_subscription ? subscriptionExpiry() : null;

  if (existing) {
    // Already activated on this device — refresh expiry and re-issue token
    await env.DB.prepare(
      'UPDATE activations SET expires_at = ?, last_checkin = datetime("now") WHERE id = ?'
    ).bind(expiresAt, existing.id).run();
  } else {
    // New device — check activation limit
    const { n } = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM activations WHERE serial_id = ?'
    ).bind(row.id).first();

    if (n >= row.max_activations) {
      return json({
        error: `Activation limit reached (${row.max_activations} devices). Deactivate another device first.`
      }, 403);
    }

    await env.DB.prepare(
      'INSERT INTO activations (serial_id, machine_id, expires_at) VALUES (?, ?, ?)'
    ).bind(row.id, machineId, expiresAt).run();
  }

  const token = await signToken({
    serial,
    machineId,
    product:   row.product,
    type:      row.is_subscription ? 'subscription' : 'lifetime',
    issuedAt:  new Date().toISOString(),
    expiresAt,
  }, env.SIGNING_PRIVATE_KEY);

  return json({ token, expiresAt, product: row.product, type: row.is_subscription ? 'subscription' : 'lifetime' });
}

// ---------------------------------------------------------------------------
// Handler: /checkin  (subscriptions — called every ~7 days in background)
// Body: { serial: string, machineId: string }
// ---------------------------------------------------------------------------

async function handleCheckin(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { serial, machineId } = body ?? {};
  if (!serial || !machineId) return json({ error: 'serial and machineId are required' }, 400);

  const row = await env.DB.prepare(`
    SELECT a.id, s.is_active, p.code AS product, p.is_subscription
    FROM activations a
    JOIN serials  s ON s.id = a.serial_id
    JOIN products p ON p.id = s.product_id
    WHERE s.serial = ? AND a.machine_id = ?
  `).bind(serial, machineId).first();

  if (!row)           return json({ error: 'Not activated on this device' }, 404);
  if (!row.is_active) return json({ error: 'Subscription is no longer active' }, 403);

  const expiresAt = row.is_subscription ? subscriptionExpiry() : null;

  await env.DB.prepare(
    'UPDATE activations SET expires_at = ?, last_checkin = datetime("now") WHERE id = ?'
  ).bind(expiresAt, row.id).run();

  const token = await signToken({
    serial,
    machineId,
    product:  row.product,
    type:     row.is_subscription ? 'subscription' : 'lifetime',
    issuedAt: new Date().toISOString(),
    expiresAt,
  }, env.SIGNING_PRIVATE_KEY);

  return json({ token, expiresAt });
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const { pathname } = new URL(request.url);

    if (request.method === 'POST') {
      if (pathname === '/webhook/stripe') return handleStripeWebhook(request, env);
      if (pathname === '/activate')       return handleActivation(request, env);
      if (pathname === '/checkin')        return handleCheckin(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
};
