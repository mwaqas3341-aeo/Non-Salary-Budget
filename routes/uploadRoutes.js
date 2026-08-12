/**
 * Example route layer — adapt to Cloudflare Worker / Vercel function /
 * Apps Script Web App as needed. This shows the full call sequence the
 * frontend upload screen drives, matching architecture doc section 5.
 */
const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const {
  parseAndValidateFile,
  findFundQuarter,
  createFundQuarter,
  computeFileHash,
  checkExactFileDuplicate,
  uploadToDriveAndRegister,
  createFundUploadRecord,
  stageRows,
  classifyStagedRows,
  getUploadPreview,
  commitUpload,
} = require('../uploadProcessor');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Resolve/create the Drive folder for year/fund/quarter/type, caching
// the top-level quarter folder id on fund_quarters.drive_folder_id.
// (Implementation omitted here — see architecture doc section 3;
// wire to your own getOrCreateDriveFolder(driveClient, pathParts) helper.)
const { getOrCreateDriveFolder } = require('../driveFolders');

function getDriveClient() {
  const auth = new google.auth.JWT(
    process.env.DRIVE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/drive']
  );
  return google.drive({ version: 'v3', auth });
}

function requireSession(req, res, next) {
  // Plug in your existing personnel-number/CNIC session validation here.
  // Must set req.user = { id, role, district, tehsil, markaz, ... }
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

/**
 * STEP A — Officer picks Financial Year + Fund + Quarter + file.
 * Tells the frontend whether this quarter already exists, so it can
 * prompt "Additional / Correction?" before anything is uploaded.
 */
router.post('/check-quarter', requireSession, async (req, res) => {
  const { financialYearId, fundId, quarter } = req.body;
  const existing = await findFundQuarter(financialYearId, fundId, quarter);
  res.json({ exists: !!existing, fundQuarter: existing });
});

/**
 * STEP B — Actual upload. uploadType is 'initial' | 'additional' | 'correction',
 * chosen by the frontend based on the check-quarter response.
 */
router.post('/upload', requireSession, upload.single('file'), async (req, res) => {
  try {
    const { financialYearId, fundId, quarter, uploadType } = req.body;
    const fileBuffer = req.file.buffer;
    const ext = req.file.originalname.split('.').pop();

    // 1. Validate structure
    const { rows, errors } = parseAndValidateFile(fileBuffer, ext);
    if (errors.length > 0) return res.status(400).json({ errors });

    // 2. Resolve fund_quarter (create only for a confirmed 'initial' upload)
    let fundQuarter = await findFundQuarter(financialYearId, fundId, quarter);
    if (!fundQuarter) {
      if (uploadType !== 'initial') {
        return res.status(409).json({ error: 'Quarter does not exist yet — upload as Initial first.' });
      }
      fundQuarter = await createFundQuarter(financialYearId, fundId, quarter, req.user.id);
    } else if (uploadType === 'initial') {
      return res.status(409).json({
        error: `Q${quarter} already exists for this fund/year. Choose Additional or Correction instead.`,
      });
    }

    // 3. Exact-file dedup check before touching Drive
    const fileHash = computeFileHash(fileBuffer);
    const dup = await checkExactFileDuplicate(fileHash);
    if (dup) {
      return res.status(409).json({ error: `Identical file already uploaded: ${dup.file_name}` });
    }

    // 4. Standardized name + Drive folder + upload + register
    const drive = getDriveClient();
    const isoDate = new Date().toISOString().slice(0, 10);
    const typeLabel = uploadType.charAt(0).toUpperCase() + uploadType.slice(1);
    const standardizedName = `${req.body.fundCode}_${req.body.yearCode}_${quarter}_${typeLabel}_${isoDate}.${ext}`;

    const folderId = await getOrCreateDriveFolder(drive, [
      'Finance Management',
      req.body.yearCode,
      req.body.fundCode,
      quarter,
      typeLabel,
    ]);

    const driveFileRow = await uploadToDriveAndRegister({
      driveClient: drive,
      folderId,
      fileBuffer,
      standardizedName,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      uploadedBy: req.user.id,
    });

    // 5. Create fund_uploads row, stage + classify rows
    const fundUpload = await createFundUploadRecord({
      fundQuarterId: fundQuarter.id,
      driveFileRow,
      uploadType,
      uploadedBy: req.user.id,
      recordsFound: rows.length,
    });
    await stageRows(fundUpload.id, rows);
    await classifyStagedRows(fundUpload.id, fundQuarter.id);

    // 6. Return preview counts — frontend shows this before commit
    const preview = await getUploadPreview(fundUpload.id);
    res.json({ fundUploadId: fundUpload.id, fundQuarterId: fundQuarter.id, preview });
  } catch (err) {
    if (err.code === 'DUPLICATE_FILE') return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Upload processing failed.' });
  }
});

/**
 * STEP C — Officer reviews the preview and confirms commit, optionally
 * choosing specific 'duplicate' rows to overwrite (with a reason).
 */
router.post('/commit', requireSession, async (req, res) => {
  try {
    const { fundUploadId, fundQuarterId, confirmedUpdateStagingIds = [], reason } = req.body;
    const result = await commitUpload(
      fundUploadId,
      fundQuarterId,
      confirmedUpdateStagingIds,
      req.user.id,
      reason
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Commit failed.' });
  }
});

module.exports = router;
