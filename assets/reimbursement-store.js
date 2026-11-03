export const DATABASE_NAME = 'narasi-garage-reimbursement-v1';
export const STATUSES = ['Pending', 'Approved', 'Rejected'];
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_AMOUNT = 999999999999;
let connection;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('Transaksi database dibatalkan.'));
    transaction.onerror = () => {};
  });
}

export function openDatabase() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('Database browser tidak tersedia. Gunakan browser biasa, bukan mode privat.'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const records = db.createObjectStore('reimbursements', { keyPath: 'uid' });
      records.createIndex('displayId', 'displayId', { unique: true });
      records.createIndex('date', 'date');
      records.createIndex('status', 'status');
      db.createObjectStore('evidence', { keyPath: 'id' });
      db.createObjectStore('metadata', { keyPath: 'key' });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Tutup tab lama website ini agar database dapat dibuka.'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      resolve(db);
    };
  }).catch(error => { connection = undefined; throw error; });
  return connection;
}

export function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const part = name => parts.find(item => item.type === name).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateRecord(input) {
  const names = ['workerName', 'agencyName', 'customerName'];
  const value = Object.fromEntries(names.map(key => [key, String(input[key] || '').trim()]));
  if (!names.some(key => value[key])) throw new Error('Isi minimal satu nama: pekerja, instansi, atau customer.');
  if (names.some(key => value[key].length > 150)) throw new Error('Setiap nama maksimal 150 karakter.');
  const amount = Number(input.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw new Error('Jumlah reimbursement harus berupa bilangan bulat lebih dari 0, maksimal $NR999.999.999.999.');
  }
  if (!STATUSES.includes(input.status)) throw new Error('Status reimbursement tidak valid.');
  if (!validDate(input.date)) throw new Error('Tanggal reimbursement tidak valid.');
  const note = String(input.note || '').trim();
  if (note.length > 2000) throw new Error('Keterangan maksimal 2.000 karakter.');
  return { ...value, amount, note, status: input.status, date: input.date };
}

function uniqueId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join('-');
}

export async function listReimbursements() {
  const db = await openDatabase();
  const tx = db.transaction('reimbursements', 'readonly');
  const done = transactionDone(tx);
  const records = await requestResult(tx.objectStore('reimbursements').getAll());
  await done;
  return records.sort((a, b) => b.sequence - a.sequence);
}

export async function getEvidence(id) {
  if (!id) return null;
  const db = await openDatabase();
  const tx = db.transaction('evidence', 'readonly');
  const done = transactionDone(tx);
  const evidence = await requestResult(tx.objectStore('evidence').get(id));
  await done;
  return evidence || null;
}

// undefined keeps saved evidence; null removes it; an object replaces it.
export async function saveReimbursement(input, { uid = null, revision = null, evidence } = {}) {
  const data = validateRecord(input);
  if (evidence && (!(evidence.blob instanceof Blob) || evidence.blob.size < 1 ||
      evidence.blob.size > MAX_IMAGE_BYTES || !['image/png', 'image/jpeg'].includes(evidence.blob.type))) {
    throw new Error('Bukti harus berupa gambar PNG atau JPG/JPEG, maksimal 8MB.');
  }
  const db = await openDatabase();
  const tx = db.transaction(['reimbursements', 'evidence', 'metadata'], 'readwrite');
  const done = transactionDone(tx);
  try {
    const records = tx.objectStore('reimbursements');
    const files = tx.objectStore('evidence');
    const previous = uid ? await requestResult(records.get(uid)) : null;
    if (uid && !previous) throw new Error('Rekod ini sudah dihapus pada tab lain. Muat ulang daftar.');
    if (previous && previous.revision !== revision) throw new Error('Rekod ini sudah diubah pada tab lain. Buka Edit sekali lagi.');
    let sequence = previous?.sequence;
    if (!previous) {
      const metadata = tx.objectStore('metadata');
      const counter = await requestResult(metadata.get('sequence'));
      sequence = Number(counter?.value || 0) + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error('Nomor rekod telah mencapai batas.');
      metadata.put({ key: 'sequence', value: sequence });
    }
    let evidenceId = previous?.evidenceId || null;
    if (evidence !== undefined) {
      if (evidenceId) files.delete(evidenceId);
      evidenceId = evidence ? uniqueId() : null;
      if (evidence) files.put({ id: evidenceId, blob: evidence.blob, name: String(evidence.name || 'bukti.png').slice(0,200), size: evidence.blob.size });
    }
    const now = new Date().toISOString();
    const record = {
      ...data, uid: previous?.uid || uniqueId(), sequence,
      displayId: previous?.displayId || 'RMB-' + String(sequence).padStart(3, '0'),
      evidenceId, revision: Number(previous?.revision || 0) + 1,
      createdAt: previous?.createdAt || now, updatedAt: now
    };
    records.put(record);
    await done;
    return record;
  } catch (error) {
    try { tx.abort(); } catch {}
    await done.catch(() => {});
    throw error;
  }
}

export async function deleteReimbursement(uid, revision) {
  const db = await openDatabase();
  const tx = db.transaction(['reimbursements', 'evidence'], 'readwrite');
  const done = transactionDone(tx);
  try {
    const records = tx.objectStore('reimbursements');
    const record = await requestResult(records.get(uid));
    if (!record) throw new Error('Rekod ini sudah dihapus.');
    if (record.revision !== revision) throw new Error('Rekod sudah berubah. Muat ulang sebelum menghapus.');
    if (record.evidenceId) tx.objectStore('evidence').delete(record.evidenceId);
    records.delete(uid);
    await done;
  } catch (error) {
    try { tx.abort(); } catch {}
    await done.catch(() => {});
    throw error;
  }
}

export function filterReimbursements(records, { query = '', status = '', from = '', to = '' } = {}) {
  const search = query.trim().toLocaleLowerCase();
  return records.filter(record =>
    (!search || [record.workerName, record.agencyName, record.customerName].some(name => name.toLocaleLowerCase().includes(search))) &&
    (!status || record.status === status) && (!from || record.date >= from) && (!to || record.date <= to)
  );
}

export function formatAmount(amount) {
  return '$NR' + BigInt(amount).toLocaleString('id-ID');
}

export function totalAmount(records) {
  return records.reduce((sum, record) => sum + BigInt(record.amount), 0n);
}
