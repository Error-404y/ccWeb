export async function sendReset(ref, url = process.env.QZU_RESET_WEBHOOK, fetcher = fetch, now = new Date()) {
  if (!url) throw new Error('Reset service unavailable.');
  const endpoint = new URL(url);
  if (endpoint.origin !== 'https://discord.com' || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(endpoint.pathname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Reset service unavailable.');
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).format(now);
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      embeds: [
        {
          title: 'emg.exe | Reset request',
          color: 0xBD0000,
          description: '```\nTime: ' + time + '\nReference: ' + ref + '\nApplied\n```'
        }
      ],
      allowed_mentions: {
        parse: []
      }
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Reset service unavailable.');
}

export async function sendFeedback(message, url = process.env.QZU_FEEDBACK_WEBHOOK, fetcher = fetch) {
  if (typeof message !== 'string' || !message.trim() || message.trim().length > 2000) throw new Error('Invalid feedback.');
  if (!url) throw new Error('Feedback service unavailable.');
  const endpoint = new URL(url);
  if (endpoint.origin !== 'https://discord.com' || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(endpoint.pathname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Feedback service unavailable.');
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{ title: 'qzu. | Feedback', color: 0xBD0000, description: message.trim() }],
      allowed_mentions: { parse: [] }
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(6500)
  });
  if (!response.ok) throw new Error('Feedback service unavailable.');
}

export async function sendPayment(row, url = process.env.QZU_PAYMENT_WEBHOOK, fetcher = fetch) {
  const endpoint = new URL(url);
  if (endpoint.origin !== 'https://discord.com' || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(endpoint.pathname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Payment notification unavailable.');
  const response = await fetcher(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6500),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [{ title: 'qzu-Access | Payment confirmed', color: 0xBD0000, description: 'Invoice: ' + row.id + '\nPlan: ' + row.plan + '\nEUR: ' + (row.eur_cents / 100).toFixed(2) + '\nVerification: Manual developer approval' }], allowed_mentions: { parse: [] } })
  });
  if (!response.ok) throw new Error('Payment notification unavailable.');
}
