import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Static assets
app.use(express.static(__dirname));

// Data directory & storage file
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'destiny_hr_data.json');

// Initial seed data if database file does not exist
const initialSeedData = {
  karyawan: [
    {
      id: 101,
      nik: "KRY-2023-001",
      nama: "Andi Saputra",
      jabatanId: 1,
      shiftId: "shift_1",
      gajiPokok: 15000000,
      statusKaryawan: "Tetap",
      noWa: "0811001001"
    }
  ],
  jabatan: [
    { id: 1, nama: "Manager HRD" },
    { id: 2, nama: "Staff Administrasi" }
  ],
  absensi: [],
  imk: [],
  cuti: [],
  pengaturan: {
    jamMasuk: "08:00",
    tunjanganHadir: 50000,
    dendaTelat: 20000,
    adminUsername: "admin",
    adminPassword: "admin123",
    shifts: [
      { id: "shift_1", nama: "Shift Standar (Pagi)", jamMasuk: "08:00", jamPulang: "17:00" }
    ],
    liburNasional: []
  }
};

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        karyawan: Array.isArray(parsed.karyawan) ? parsed.karyawan : initialSeedData.karyawan,
        jabatan: Array.isArray(parsed.jabatan) ? parsed.jabatan : initialSeedData.jabatan,
        absensi: Array.isArray(parsed.absensi) ? parsed.absensi : [],
        imk: Array.isArray(parsed.imk) ? parsed.imk : [],
        cuti: Array.isArray(parsed.cuti) ? parsed.cuti : [],
        pengaturan: parsed.pengaturan || initialSeedData.pengaturan
      };
    }
  } catch (err) {
    console.error("Gagal membaca database file, menggunakan seed:", err);
  }
  writeDb(initialSeedData);
  return initialSeedData;
}

function writeDb(data) {
  try {
    const tempFile = `${DB_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, DB_FILE);
    return true;
  } catch (err) {
    console.error("Gagal menulis database file:", err);
    return false;
  }
}

// In-memory atomic queue for concurrent scans
let scanQueue = Promise.resolve();

function processScanAtomic(scanPayload) {
  return new Promise((resolve) => {
    scanQueue = scanQueue.then(async () => {
      try {
        const db = readDb();
        const { code, metode, lat, lng, clientTimestamp } = scanPayload;

        if (!code) {
          return resolve({ success: false, code: 'EMPTY_CODE', message: 'Kode barcode/QR kosong.' });
        }

        let rawCode = String(code || '').trim();
        // Handle URL or JSON payloads
        if (rawCode.startsWith('{') && rawCode.endsWith('}')) {
          try {
            const parsed = JSON.parse(rawCode);
            rawCode = String(parsed.nik || parsed.nip || parsed.id || rawCode).trim();
          } catch (e) {}
        } else if (rawCode.includes('?') || rawCode.includes('/')) {
          const parts = rawCode.split(/[\/?=&]/);
          const lastPart = parts.filter(Boolean).pop();
          if (lastPart) rawCode = lastPart.trim();
        }
        rawCode = rawCode.replace(/[\r\n]+/g, '').trim();
        const cleanCode = rawCode.toLowerCase();

        // Cari profil karyawan yang cocok
        const karyawan = (db.karyawan || []).find(k =>
          (k.nik && k.nik.trim().toLowerCase() === cleanCode) ||
          (k.nip && k.nip.trim().toLowerCase() === cleanCode) ||
          (k.nikKtp && k.nikKtp.trim().toLowerCase() === cleanCode) ||
          String(k.id) === rawCode
        );

        if (!karyawan) {
          return resolve({
            success: false,
            code: 'NOT_FOUND',
            message: `Kode "${rawCode}" tidak terdaftar pada sistem Karyawan.`
          });
        }

        const now = clientTimestamp ? new Date(clientTimestamp) : new Date();
        const timeString = now.toTimeString().substring(0, 5);
        const dateString = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        if (!db.absensi) db.absensi = [];

        const shifts = db.pengaturan?.shifts || initialSeedData.pengaturan.shifts;
        const shiftKaryawan = shifts.find(s => s.id === karyawan.shiftId) || shifts[0] || { jamMasuk: '08:00', jamPulang: '17:00' };
        const isLibur = (db.pengaturan?.liburNasional || []).find(l => l.tanggal === dateString);

        let absenTerakhir = [...db.absensi].reverse().find(a => a.karyawanId === karyawan.id);
        let isShiftBelumSelesai = absenTerakhir && !absenTerakhir.jamPulang;

        if (isShiftBelumSelesai) {
          const diffTime = now.getTime() - new Date(absenTerakhir.tanggal).getTime();
          if (diffTime / (1000 * 3600 * 24) > 1.5) {
            isShiftBelumSelesai = false; // Terlalu lama (dianggap shift hangus)
          }
        }

        // Anti-duplicate debounce per-karyawan (mencegah klik ganda / scan bertubi-tubi dalam 15 detik)
        if (absenTerakhir) {
          const lastTimeStr = absenTerakhir.jamPulang
            ? `${absenTerakhir.tanggal}T${absenTerakhir.jamPulang}:00`
            : `${absenTerakhir.tanggal}T${absenTerakhir.jamMasuk}:00`;
          const lastTimeMs = new Date(lastTimeStr).getTime();
          if (!isNaN(lastTimeMs) && Math.abs(now.getTime() - lastTimeMs) < 15000) {
            const currentAction = absenTerakhir.jamPulang ? 'pulang' : 'masuk';
            return resolve({
              success: true,
              isDuplicatePrevented: true,
              action: currentAction,
              message: `${karyawan.nama} sudah tercatat presensi ${currentAction} barusan (${absenTerakhir.jamPulang || absenTerakhir.jamMasuk}).`,
              employee: { id: karyawan.id, nama: karyawan.nama, nik: karyawan.nik, jabatanId: karyawan.jabatanId },
              record: absenTerakhir,
              allAbsensi: db.absensi
            });
          }
        }

        let action = 'masuk';
        let recordResult = null;

        if (isShiftBelumSelesai) {
          // TERCATAT SEBAGAI JAM PULANG SHIFT
          action = 'pulang';
          absenTerakhir.jamPulang = timeString;
          absenTerakhir.metodePulang = metode || 'QR';
          if (lat && lng) {
            absenTerakhir.latPulang = lat;
            absenTerakhir.lngPulang = lng;
          }
          absenTerakhir.updatedAt = now.toISOString();
          recordResult = absenTerakhir;
        } else {
          // CEK APAKAH SUDAH SELESAI HARI INI
          let absenHariIni = db.absensi.find(a => a.karyawanId === karyawan.id && a.tanggal === dateString);
          if (!absenHariIni) {
            action = 'masuk';
            const statusMasuk = isLibur ? 'Hadir (Libur)' : (timeString > (shiftKaryawan?.jamMasuk || '08:00') ? 'Terlambat' : 'Tepat Waktu');
            const newRecord = {
              id: Date.now() + Math.floor(Math.random() * 1000),
              karyawanId: karyawan.id,
              karyawanNama: karyawan.nama,
              karyawanNik: karyawan.nik || '',
              tanggal: dateString,
              jamMasuk: timeString,
              jamPulang: null,
              statusMasuk,
              metode: metode || 'QR',
              lat: lat || null,
              lng: lng || null,
              createdAt: now.toISOString()
            };
            db.absensi.push(newRecord);
            recordResult = newRecord;
          } else {
            return resolve({
              success: false,
              code: 'ALREADY_COMPLETED',
              message: `${karyawan.nama} sudah merampungkan presensi masuk (${absenHariIni.jamMasuk}) & pulang (${absenHariIni.jamPulang || '-'}) hari ini.`,
              employee: { id: karyawan.id, nama: karyawan.nama, nik: karyawan.nik },
              record: absenHariIni
            });
          }
        }

        // Tulis perubahan secara atomik ke disk
        writeDb(db);

        const jabatanObj = (db.jabatan || []).find(j => j.id == karyawan.jabatanId);
        resolve({
          success: true,
          action,
          message: action === 'masuk'
            ? `Selamat bekerja, ${karyawan.nama}! (${recordResult.statusMasuk})`
            : `Hati-hati di jalan, ${karyawan.nama}! Pulang pukul ${timeString}`,
          employee: {
            id: karyawan.id,
            nama: karyawan.nama,
            nik: karyawan.nik || '-',
            jabatan: jabatanObj ? jabatanObj.nama : '-'
          },
          record: recordResult,
          allAbsensi: db.absensi
        });
      } catch (err) {
        console.error("Critical error in processScanAtomic:", err);
        resolve({ success: false, code: 'SERVER_EXCEPTION', message: err.message });
      }
    });
  });
}

function processImkAtomic(imkPayload) {
  return new Promise((resolve) => {
    scanQueue = scanQueue.then(async () => {
      try {
        const db = readDb();
        const { code, clientTimestamp } = imkPayload;

        let rawCode = String(code || '').trim().replace(/[\r\n]+/g, '');
        const cleanCode = rawCode.toLowerCase();

        const karyawan = (db.karyawan || []).find(k =>
          (k.nik && k.nik.trim().toLowerCase() === cleanCode) ||
          (k.nip && k.nip.trim().toLowerCase() === cleanCode) ||
          (k.nikKtp && k.nikKtp.trim().toLowerCase() === cleanCode) ||
          String(k.id) === rawCode
        );

        if (!karyawan) {
          return resolve({ success: false, code: 'NOT_FOUND', message: `Kode "${rawCode}" tidak terdaftar.` });
        }

        const now = clientTimestamp ? new Date(clientTimestamp) : new Date();
        const timeString = now.toTimeString().substring(0, 5);
        const dateString = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        if (!db.imk) db.imk = [];
        let imkTerakhir = [...db.imk].reverse().find(i => i.karyawanId === karyawan.id);
        let isMasihDiLuar = imkTerakhir && !imkTerakhir.jamKembali;

        if (isMasihDiLuar) {
          const diffTime = now.getTime() - new Date(imkTerakhir.tanggal).getTime();
          if (diffTime / (1000 * 3600 * 24) > 1.5) isMasihDiLuar = false;
        }

        let action = 'keluar';
        let recordResult = null;

        if (!isMasihDiLuar) {
          action = 'keluar';
          recordResult = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            karyawanId: karyawan.id,
            karyawanNama: karyawan.nama,
            karyawanNik: karyawan.nik || '',
            tanggal: dateString,
            jamKeluar: timeString,
            jamKembali: null,
            durasi: '-'
          };
          db.imk.push(recordResult);
        } else {
          action = 'kembali';
          imkTerakhir.jamKembali = timeString;

          let tglKeluar = new Date(`${imkTerakhir.tanggal}T${imkTerakhir.jamKeluar}:00`);
          let tglKembali = new Date(`${dateString}T${timeString}:00`);
          if (tglKembali < tglKeluar) tglKembali.setDate(tglKembali.getDate() + 1);

          let diffMins = Math.floor((tglKembali - tglKeluar) / 60000);
          if (diffMins < 0) diffMins = 0;
          imkTerakhir.durasi = `${Math.floor(diffMins / 60) > 0 ? Math.floor(diffMins / 60) + ' jam ' : ''}${diffMins % 60} menit`;
          recordResult = imkTerakhir;
        }

        writeDb(db);
        resolve({
          success: true,
          action,
          message: action === 'keluar'
            ? `${karyawan.nama} tercatat KELUAR kantor pukul ${timeString}`
            : `${karyawan.nama} KEMBALI ke kantor. Durasi: ${recordResult.durasi}`,
          employee: { id: karyawan.id, nama: karyawan.nama, nik: karyawan.nik },
          record: recordResult,
          allImk: db.imk
        });
      } catch (err) {
        resolve({ success: false, code: 'SERVER_EXCEPTION', message: err.message });
      }
    });
  });
}

// ==========================================
// REST API ROUTES
// ==========================================

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', serverTime: new Date().toISOString() });
});

// Full state load endpoint
app.get('/api/data', (req, res) => {
  const db = readDb();
  res.json({
    success: true,
    data: db,
    serverTime: new Date().toISOString()
  });
});

// Full state save endpoint (from Admin)
app.post('/api/save', (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ success: false, message: 'Payload tidak valid' });
    }
    const currentDb = readDb();
    const mergedDb = {
      karyawan: Array.isArray(payload.karyawan) ? payload.karyawan : currentDb.karyawan,
      jabatan: Array.isArray(payload.jabatan) ? payload.jabatan : currentDb.jabatan,
      absensi: Array.isArray(payload.absensi) ? payload.absensi : currentDb.absensi,
      imk: Array.isArray(payload.imk) ? payload.imk : currentDb.imk,
      cuti: Array.isArray(payload.cuti) ? payload.cuti : currentDb.cuti,
      pengaturan: payload.pengaturan ? { ...currentDb.pengaturan, ...payload.pengaturan } : currentDb.pengaturan
    };

    writeDb(mergedDb);
    res.json({ success: true, message: 'Data berhasil disinkronisasi ke server pusat.', serverTime: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Dedicated ATOMIC Attendance Scan Endpoint (Kiosk & GPS HP)
app.post('/api/absen', async (req, res) => {
  const result = await processScanAtomic(req.body);
  if (!result.success && result.code === 'NOT_FOUND') {
    return res.status(404).json(result);
  }
  res.json(result);
});

// Dedicated ATOMIC IMK Scan Endpoint
app.post('/api/imk', async (req, res) => {
  const result = await processImkAtomic(req.body);
  res.json(result);
});

// Fast sync endpoint for live polling
app.get('/api/sync', (req, res) => {
  const db = readDb();
  const since = req.query.since ? parseInt(req.query.since, 10) : 0;
  let newAbsensi = db.absensi;
  if (since > 0) {
    newAbsensi = db.absensi.filter(a => (a.id || 0) > since || new Date(a.createdAt || 0).getTime() > since);
  }
  res.json({
    success: true,
    serverTime: Date.now(),
    totalAbsensi: db.absensi.length,
    newAbsensi: newAbsensi.slice(-50),
    totalKaryawan: db.karyawan.length,
    allAbsensi: db.absensi
  });
});

// Single Page Application fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Destiny HR System running at http://0.0.0.0:${PORT}`);
});
