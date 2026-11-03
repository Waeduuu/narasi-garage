import { STATUSES, MAX_IMAGE_BYTES, listReimbursements, getEvidence, saveReimbursement,
  deleteReimbursement, filterReimbursements, formatAmount, totalAmount, localDate, openDatabase, listDiscordLogs } from './reimbursement-store.js?v=20261103-discord1';
import { flushDiscordLogs } from './reimbursement-discord.js?v=20261103-discord1';

const section = document.getElementById('section-reimbursement');
if (section) startReimbursement().catch(error => {
  const status = document.getElementById('rmbStatus');
  status.className = 'status error';
  status.textContent = 'Database belum dapat dibuka: ' + error.message;
  document.getElementById('rmbSave').disabled = true;
});

async function startReimbursement() {
  const $ = id => document.getElementById(id);
  const form = $('rmbForm'), saveButton = $('rmbSave'), upload = $('rmbUpload');
  const nameIds = ['rmbWorker', 'rmbAgency', 'rmbCustomer'];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let records = [], editing = null, evidenceChange, previewUrl = null, viewerUrl = null;
  let busy = false, validatingImage = false, imageGeneration = 0;
  let databaseReady = false, discordBusy = false;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('narasi-reimbursement-updates-v1') : null;

  function status(message, kind = '') {
    $('rmbStatus').textContent = message;
    $('rmbStatus').className = 'status ' + kind;
  }

  function errorText(error) {
    return error?.name === 'QuotaExceededError' ? 'Ruang simpan browser penuh. Data belum disimpan; gunakan gambar yang lebih kecil.' : error.message || 'Operasi tidak berhasil. Coba lagi.';
  }

  function updateButtons() {
    saveButton.disabled = busy || validatingImage || !databaseReady;
    $('rmbFile').disabled = busy;
    $('rmbChooseFile').disabled = busy;
    $('rmbReset').disabled = busy;
    $('rmbRemovePhoto').disabled = busy || validatingImage;
    $('rmbRetryDiscord').disabled = busy || discordBusy;
    form.querySelectorAll('input:not([type="file"]),select,textarea').forEach(field => { field.disabled = busy; });
    $('rmbTableBody')?.querySelectorAll('[data-rmb-action="edit"],[data-rmb-action="delete"]').forEach(button => { button.disabled = busy || validatingImage; });
    saveButton.textContent = busy ? '⏳ MENYIMPAN...' : editing ? '💾 SIMPAN PERUBAHAN' : '💾 SIMPAN REIMBURSEMENT';
    upload.setAttribute('aria-busy', String(validatingImage));
  }

  async function syncDiscordLogs() {
    if (discordBusy || !databaseReady) return;
    discordBusy = true; updateButtons();
    const notice = $('rmbDiscordStatus'), retry = $('rmbRetryDiscord');
    try {
      const result = await flushDiscordLogs(id => {
        notice.className = 'status'; notice.textContent = '⏳ Mengirim log ' + id + ' beserta bukti ke Discord...';
      });
      retry.hidden = !result.pending;
      notice.className = 'status ' + (result.pending ? 'warn' : 'ok');
      notice.textContent = result.pending ? result.pending + ' log menunggu pengiriman. Klik Coba Lagi jika belum terkirim.' :
        result.sent ? '✅ ' + result.sent + ' log berhasil masuk ke Discord.' : 'Log Discord aktif untuk tambah, edit, perubahan status, dan hapus rekod.';
    } catch (error) {
      retry.hidden = false; notice.className = 'status error';
      const pending = await listDiscordLogs().then(rows => rows.length).catch(() => null);
      notice.textContent = (pending === null ? 'Log' : pending + ' log') + ' belum terkirim. ' + error.message + ' Rekod tetap tersimpan di browser.';
    } finally { discordBusy = false; updateButtons(); }
  }
  $('rmbRetryDiscord').addEventListener('click', () => syncDiscordLogs());

  function revokePreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    $('rmbPhoto').removeAttribute('src');
    $('rmbPhotoPreview').hidden = true;
    $('rmbRemovePhoto').hidden = true;
    $('rmbPhotoName').textContent = '';
  }

  function showPreview(blob, name) {
    revokePreview();
    previewUrl = URL.createObjectURL(blob);
    $('rmbPhoto').src = previewUrl;
    $('rmbPhotoPreview').hidden = false;
    $('rmbRemovePhoto').hidden = false;
    $('rmbPhotoName').textContent = name + ' · ' + (blob.size / 1024 / 1024).toFixed(2) + 'MB';
  }

  async function validateImage(file) {
    if (!file || !file.size || file.size > MAX_IMAGE_BYTES) throw new Error('Gambar harus berukuran lebih dari 0 dan maksimal 8MB.');
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const png = [137,80,78,71,13,10,26,10].every((value, i) => bytes[i] === value);
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!png && !jpeg) throw new Error('Format bukti hanya PNG atau JPG/JPEG.');
    const type = png ? 'image/png' : 'image/jpeg';
    const blob = file.slice(0, file.size, type);
    const url = URL.createObjectURL(blob);
    try {
      await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          if (image.naturalWidth > 16000 || image.naturalHeight > 16000 || image.naturalWidth * image.naturalHeight > 50000000) {
            reject(new Error('Dimensi gambar terlalu besar. Gunakan screenshot dengan ukuran lebih kecil.'));
          } else resolve();
        };
        image.onerror = () => reject(new Error('Gambar rusak atau tidak dapat dibaca.'));
        image.src = url;
      });
    } finally { URL.revokeObjectURL(url); }
    return { blob, name: file.name || 'screenshot-' + Date.now() + (png ? '.png' : '.jpg') };
  }

  async function acceptImage(file) {
    if (busy) return;
    const generation = ++imageGeneration;
    validatingImage = true; updateButtons(); status('Memeriksa gambar...');
    try {
      const evidence = await validateImage(file);
      if (generation !== imageGeneration) return;
      evidenceChange = evidence;
      showPreview(evidence.blob, evidence.name);
      status('Bukti siap. Tekan Simpan Reimbursement untuk menyimpan gambar bersama rekod.', 'ok');
    } catch (error) { if (generation === imageGeneration) status(errorText(error), 'error'); }
    finally { if (generation === imageGeneration) { validatingImage = false; updateButtons(); } }
  }

  $('rmbChooseFile').addEventListener('click', () => { if (!busy) $('rmbFile').click(); });
  $('rmbFile').addEventListener('change', () => {
    const file = $('rmbFile').files[0];
    $('rmbFile').value = '';
    if (file) acceptImage(file);
  });
  upload.addEventListener('paste', event => {
    const items = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file');
    const files = items.map(item => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    event.preventDefault(); event.stopPropagation();
    if (files.length !== 1) { status('Paste satu screenshot untuk setiap reimbursement.', 'error'); return; }
    acceptImage(files[0]);
  });
  upload.addEventListener('click', event => {
    if (!event.target.closest('button')) upload.focus();
  });
  upload.addEventListener('dragover', event => { event.preventDefault(); if (!busy) upload.classList.add('drag'); });
  upload.addEventListener('dragleave', () => upload.classList.remove('drag'));
  upload.addEventListener('drop', event => {
    event.preventDefault(); event.stopPropagation(); upload.classList.remove('drag');
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length !== 1) { status('Pilih satu screenshot untuk setiap reimbursement.', 'error'); return; }
    acceptImage(files[0]);
  });
  $('rmbRemovePhoto').addEventListener('click', () => {
    if (busy || validatingImage) return;
    imageGeneration++; evidenceChange = null; revokePreview();
    status('Bukti dihapus dari form. Perubahan berlaku setelah disimpan.');
  });

  function closeViewer() {
    $('rmbViewerImage').removeAttribute('src');
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = null;
  }
  function openViewer(blob, title) {
    closeViewer(); viewerUrl = URL.createObjectURL(blob);
    $('rmbViewerTitle').textContent = title;
    $('rmbViewerImage').src = viewerUrl;
    $('rmbViewerLink').href = viewerUrl;
    $('rmbViewerLink').download = title.replace(/[^a-z0-9._-]/gi, '-') + (blob.type === 'image/png' ? '.png' : '.jpg');
    $('rmbViewer').showModal();
  }
  $('rmbPhotoPreview').addEventListener('click', async () => {
    try {
      const evidence = evidenceChange || (editing?.evidenceId ? await getEvidence(editing.evidenceId) : null);
      if (evidence) openViewer(evidence.blob, editing?.displayId || 'Bukti Reimbursement');
    } catch (error) { status(errorText(error), 'error'); }
  });
  $('rmbViewerClose').addEventListener('click', () => $('rmbViewer').close());
  $('rmbViewer').addEventListener('close', closeViewer);
  $('rmbViewer').addEventListener('click', event => { if (event.target === $('rmbViewer')) $('rmbViewer').close(); });

  function validateNames() {
    const valid = nameIds.some(id => $(id).value.trim());
    $('rmbWorker').setCustomValidity(valid ? '' : 'Isi minimal satu dari tiga nama ini.');
    return valid;
  }
  nameIds.forEach(id => $(id).addEventListener('input', validateNames));
  $('rmbAmount').addEventListener('input', () => {
    const amount = Number($('rmbAmount').value);
    $('rmbAmountPreview').textContent = Number.isSafeInteger(amount) && amount > 0 ? formatAmount(amount) : '$NR0';
  });

  function resetForm() {
    imageGeneration++; validatingImage = false; editing = null; evidenceChange = undefined;
    form.reset(); $('rmbWorker').setCustomValidity('');
    $('rmbDate').value = localDate();
    $('rmbFormTitle').textContent = 'Tambah Reimbursement';
    $('rmbEditingId').hidden = true; $('rmbAmountPreview').textContent = '$NR0';
    revokePreview(); updateButtons();
  }
  $('rmbReset').addEventListener('click', () => { if (!busy) { resetForm(); status(''); } });

  function renderRecords() {
    if (!$('rmbTableBody')) return;
    const filter = { query: $('rmbSearch').value, status: $('rmbFilterStatus').value, from: $('rmbFrom').value, to: $('rmbTo').value };
    const invalidRange = filter.from && filter.to && filter.from > filter.to;
    $('rmbFilterError').textContent = invalidRange ? 'Tanggal awal tidak boleh melebihi tanggal akhir.' : '';
    const visible = invalidRange ? [] : filterReimbursements(records, filter);
    $('rmbTotal').textContent = formatAmount(totalAmount(records));
    for (const item of STATUSES) $('rmbTotal' + item).textContent = formatAmount(totalAmount(records.filter(record => record.status === item)));
    $('rmbResultSummary').textContent = visible.length + ' dari ' + records.length + ' rekod · Total hasil filter: ' + formatAmount(totalAmount(visible));
    $('rmbTableBody').innerHTML = visible.length ? visible.map(record => `<tr>
      <td><strong>${esc(record.displayId)}</strong></td><td>${esc(record.date.split('-').reverse().join('/'))}</td>
      <td>${esc(record.workerName || '-')}</td><td>${esc(record.agencyName || '-')}</td><td>${esc(record.customerName || '-')}</td>
      <td class="rmb-amount-cell">${esc(formatAmount(record.amount))}</td>
      <td>${record.evidenceId ? `<button type="button" class="btn ghost sm" data-rmb-action="view" data-uid="${esc(record.uid)}" aria-label="Lihat bukti ${esc(record.displayId)}">View</button>` : '<span class="sub">-</span>'}</td>
      <td><span class="rmb-badge ${record.status.toLowerCase()}">${esc(record.status)}</span></td>
      <td><div class="rmb-row-actions"><button type="button" class="btn silver sm" data-rmb-action="edit" data-uid="${esc(record.uid)}" aria-label="Edit ${esc(record.displayId)}">Edit</button><button type="button" class="btn red sm" data-rmb-action="delete" data-uid="${esc(record.uid)}" aria-label="Hapus ${esc(record.displayId)}">Hapus</button></div></td>
    </tr>`).join('') : '<tr><td colspan="9" class="rmb-empty">' + (records.length ? 'Tidak ada rekod sesuai filter.' : 'Belum ada reimbursement. Tambahkan rekod pertama melalui form di atas.') + '</td></tr>';
    updateButtons();
  }
  async function refreshRecords() { records = await listReimbursements(); renderRecords(); }
  ['rmbSearch','rmbFilterStatus','rmbFrom','rmbTo'].forEach(id => $(id)?.addEventListener(id === 'rmbSearch' ? 'input' : 'change', renderRecords));
  $('rmbClearFilters')?.addEventListener('click', () => { ['rmbSearch','rmbFilterStatus','rmbFrom','rmbTo'].forEach(id => $(id).value = ''); renderRecords(); });

  async function editRecord(record) {
    if (busy || validatingImage) return;
    resetForm(); editing = { ...record }; $('rmbFormTitle').textContent = 'Edit Reimbursement';
    $('rmbEditingId').textContent = record.displayId; $('rmbEditingId').hidden = false;
    $('rmbWorker').value = record.workerName; $('rmbAgency').value = record.agencyName; $('rmbCustomer').value = record.customerName;
    $('rmbAmount').value = record.amount; $('rmbAmountPreview').textContent = formatAmount(record.amount);
    $('rmbNote').value = record.note; $('rmbDate').value = record.date;
    if (record.evidenceId) {
      const generation = ++imageGeneration; validatingImage = true; updateButtons();
      try {
        const evidence = await getEvidence(record.evidenceId);
        if (generation === imageGeneration && evidence) showPreview(evidence.blob, evidence.name);
        if (generation === imageGeneration && !evidence) status('Bukti tersimpan tidak ditemukan. Rekod tetap tersedia.', 'warn');
      } finally { if (generation === imageGeneration) validatingImage = false; }
    }
    updateButtons(); $('rmbForm').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('rmbWorker').focus({ preventScroll: true });
  }

  $('rmbTableBody')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-rmb-action]');
    if (!button || busy || validatingImage) return;
    const record = records.find(item => item.uid === button.dataset.uid);
    if (!record) return;
    try {
      if (button.dataset.rmbAction === 'view') {
        const evidence = await getEvidence(record.evidenceId);
        if (!evidence) throw new Error('Bukti tidak ditemukan.');
        openViewer(evidence.blob, record.displayId);
      } else if (button.dataset.rmbAction === 'edit') {
        await editRecord(record);
      } else if (button.dataset.rmbAction === 'delete') {
        if (!confirm('Hapus ' + record.displayId + ' beserta bukti screenshot? Tindakan ini tidak dapat dibatalkan.')) return;
        busy = true; updateButtons();
        await deleteReimbursement(record.uid, record.revision, { queueDiscord: true });
        if (editing?.uid === record.uid) resetForm();
        await refreshRecords(); channel?.postMessage('changed');
        status(record.displayId + ' berhasil dihapus.', 'ok');
        await syncDiscordLogs();
      }
    } catch (error) { status(errorText(error), 'error'); }
    finally { busy = false; updateButtons(); }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || validatingImage || !databaseReady) return;
    validateNames(); if (!form.reportValidity()) return;
    const input = {
      workerName: $('rmbWorker').value, agencyName: $('rmbAgency').value, customerName: $('rmbCustomer').value,
      amount: $('rmbAmount').value, note: $('rmbNote').value, status: editing?.status || 'Pending', date: $('rmbDate').value
    };
    busy = true; updateButtons(); status('Menyimpan rekod dan bukti ke database...');
    try {
      const record = await saveReimbursement(input, { uid: editing?.uid, revision: editing?.revision, evidence: evidenceChange, queueDiscord: true });
      resetForm(); await refreshRecords(); channel?.postMessage('changed');
      status(record.displayId + ' berhasil disimpan' + (record.evidenceId ? ' bersama bukti screenshot.' : '.'), 'ok');
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      await syncDiscordLogs();
    } catch (error) { status(errorText(error), 'error'); }
    finally { busy = false; updateButtons(); }
  });

  channel?.addEventListener('message', () => refreshRecords().catch(error => status(errorText(error), 'error')));
  window.addEventListener('focus', () => { if (!busy) refreshRecords().catch(() => {}); });
  window.addEventListener('pagehide', () => { if (previewUrl) URL.revokeObjectURL(previewUrl); closeViewer(); });
  resetForm();
  await openDatabase(); databaseReady = true; await refreshRecords(); updateButtons();
  await syncDiscordLogs();
}
