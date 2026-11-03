import { listDiscordLogs, claimDiscordLog, finishDiscordLog, formatAmount } from './reimbursement-store.js?v=20261103-discord1';

// The production endpoint is inserted when publishing; previews never send real logs.
const WEBHOOK_URL = 'https://canary.discord.com/api/webhooks/1567092404039983205/OxjLTwccnO37TOyAbMDewYcNischfXnp4UPoBa_4ZYz_MAMxpYz0VZPh6QmCSxh9R1om';
const ACTIONS = { created: '➕ REKOD BARU', updated: '✏️ REKOD DIKEMAS KINI', deleted: '🗑️ REKOD DIHAPUS' };
const FIELDS = {
  workerName: 'Nama Pekerja', agencyName: 'Nama Instansi', customerName: 'Nama Customer',
  amount: 'Jumlah', date: 'Tanggal', status: 'Status', note: 'Keterangan', evidenceId: 'Bukti Screenshot'
};
const markdown = value => String(value || '-').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/[\\`*_{}\[\]()<>~|]/g, '\\$&');

export function buildDiscordPayload(event) {
  const record = event.record;
  const filename = record.displayId + '-bukti' + (event.evidence?.blob.type === 'image/jpeg' ? '.jpg' : '.png');
  const embed = {
    title: '💸 NARASI GARAGE • REIMBURSEMENT',
    description: '**' + ACTIONS[event.action] + '**\n\n**Keterangan**\n' + markdown(record.note),
    color: event.action === 'deleted' || record.status === 'Rejected' ? 0xed5565 : record.status === 'Approved' ? 0x45d6ab : 0x41d5e5,
    fields: [
      { name: 'ID Reimbursement', value: record.displayId, inline: true },
      { name: 'Tanggal (WIB)', value: record.date.split('-').reverse().join('/'), inline: true },
      { name: 'Status', value: record.status, inline: true },
      { name: 'Nama Pekerja', value: markdown(record.workerName), inline: true },
      { name: 'Nama Instansi', value: markdown(record.agencyName), inline: true },
      { name: 'Nama Customer', value: markdown(record.customerName), inline: true },
      { name: 'Jumlah Reimbursement', value: formatAmount(record.amount), inline: true },
      { name: 'Bukti Screenshot', value: event.evidence ? 'Terlampir di bawah' : 'Tidak dilampirkan', inline: true }
    ],
    footer: { text: 'Rekod: ' + record.uid + ' • Rev ' + record.revision + ' • Log: ' + event.eventId },
    timestamp: event.occurredAt
  };
  if (event.action === 'updated' && event.previous) {
    const changed = Object.entries(FIELDS).filter(([key]) => record[key] !== event.previous[key]).map(([, label]) => label);
    embed.fields.push({ name: 'Perubahan', value: changed.join(', ') || 'Rekod disimpan ulang', inline: false });
    if (event.previous.status !== record.status) {
      embed.fields.push({ name: 'Perubahan Status', value: event.previous.status + ' → ' + record.status, inline: false });
    }
  }
  const payload = { username: 'Narasi Garage • Reimbursement', allowed_mentions: { parse: [] }, embeds: [embed] };
  if (event.evidence) {
    payload.attachments = [{ id: 0, filename }];
    embed.image = { url: 'attachment://' + filename };
  }
  return { payload, filename };
}

export async function sendDiscordLog(event, fetchImpl = fetch) {
  const { payload, filename } = buildDiscordPayload(event);
  const body = new FormData();
  body.append('payload_json', JSON.stringify(payload));
  if (event.evidence) body.append('files[0]', event.evidence.blob, filename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetchImpl(WEBHOOK_URL + '?wait=true', { method: 'POST', body, signal: controller.signal });
    if (!response.ok) {
      if (response.status === 429) {
        const retry = await response.json().catch(() => ({}));
        const seconds = Math.max(1, Math.ceil(Number(retry.retry_after) || 5));
        throw new Error('Discord sedang membatasi pengiriman. Coba lagi setelah ' + seconds + ' detik.');
      }
      if (response.status === 401 || response.status === 404) throw new Error('Webhook Discord tidak aktif atau tidak valid. Hubungi petinggi.');
      if (response.status === 413) throw new Error('Discord menolak ukuran gambar. Log tetap berada dalam antrean.');
      throw new Error('Discord menolak log (HTTP ' + response.status + ').');
    }
    const message = await response.json().catch(() => null);
    if (!message?.id) throw new Error('Discord belum mengonfirmasi log. Periksa channel sebelum mencoba lagi.');
    return message.id;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) {
      throw new Error('Belum ada konfirmasi dari Discord. Periksa koneksi dan channel sebelum mencoba lagi.');
    }
    throw error;
  } finally { clearTimeout(timer); }
}

let sending;
export function flushDiscordLogs(onProgress = () => {}) {
  if (sending) return sending;
  sending = (async () => {
    let sent = 0;
    const queued = await listDiscordLogs();
    for (const item of queued) {
      const event = await claimDiscordLog(item.key);
      if (!event) continue; // Another tab is already sending this event.
      try {
        onProgress(event.record.displayId);
        await sendDiscordLog(event);
        await finishDiscordLog(event.key, event.leaseToken);
        sent++;
      } catch (error) {
        await finishDiscordLog(event.key, event.leaseToken, false);
        throw error;
      }
    }
    return { sent, pending: (await listDiscordLogs()).length };
  })().finally(() => { sending = null; });
  return sending;
}
