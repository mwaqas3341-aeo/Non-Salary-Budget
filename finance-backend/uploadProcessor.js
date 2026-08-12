/**
 * Finance Management — Upload Processor
 * ---------------------------------------------------------------------
 * Core backend logic for the quarterly fund upload workflow described
 * in finance_management_architecture.md, section 5. Framework-agnostic:
 * call these functions from a thin Express route, a Cloudflare Worker,
 * or an Apps Script Web App relay — whichever you host the backend on.
 *
 * Holds/uses:
 *   - SUPABASE_SERVICE_ROLE_KEY (server-side only, never in frontend JS)
 *   - Google Drive service-account credentials (server-side only)
 *
 * Requires: @supabase/supabase-js, xlsx (SheetJS), node's built-in crypto
 *   npm install @supabase/supabase-js xlsx
 * ---------------------------------------------------------------------
 */

const { createClient } = require('@supabase/supabase-js');
const XLSX = require('xlsx');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // service role — server only
);

// Columns the workflow requires in every uploaded quarterly file.
// Adjust header names here if your source files use different labels.
const REQUIRED_COLUMNS = ['emis_code', 'school_name', 'received_amount'];

// =====================================================================
// STEP 1 — VALIDATE FILE
// =====================================================================
/**
 * Parses an xlsx/csv buffer into rows and checks required columns exist.
 * @param {Buffer} fileBuffer
 * @returns {{ rows: object[], errors: string[] }}
 */
function parseAndValidateFile(fileBuffer, fileExt) {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  const errors = [];
  if (rawRows.length === 0) {
    errors.push('File contains no data rows.');
    return { rows: [], errors };
  }

  const headerKeys = Object.keys(rawRows[0]).map((k) => k.toString().trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((col) => !headerKeys.includes(col));
  if (missing.length > 0) {
    errors.push(`Missing required column(s): ${missing.join(', ')}`);
  }

  // Normalize keys to lowercase/trimmed so header casing doesn't matter
  const rows = rawRows.map((r) => {
    const normalized = {};
    for (const [k, v] of Object.entries(r)) {
      normalized[k.toString().trim().toLowerCase()] = v;
    }
    return normalized;
  });

  return { rows, errors };
}

// =====================================================================
// STEP 2 — RESOLVE / CHECK FUND QUARTER
// =====================================================================
/**
 * Looks up an existing fund_quarter or tells the caller none exists yet.
 * Does NOT create one here — creation happens explicitly once the
 * upload_type (initial/additional/correction) is confirmed, so we never
 * silently create a quarter row for a file that turns out to be invalid.
 */
async function findFundQuarter(financialYearId, fundId, quarter) {
  const { data, error } = await supabase
    .from('fund_quarters')
    .select('*')
    .eq('financial_year_id', financialYearId)
    .eq('fund_id', fundId)
    .eq('quarter', quarter)
    .maybeSingle();

  if (error) throw error;
  return data; // null if it doesn't exist yet
}

async function createFundQuarter(financialYearId, fundId, quarter, createdBy) {
  const { data, error } = await supabase
    .from('fund_quarters')
    .insert({
      financial_year_id: financialYearId,
      fund_id: fundId,
      quarter,
      created_by: createdBy,
      processing_status: 'processing',
    })
    .select()
    .single();

  if (error) throw error; // unique constraint violation surfaces here if raced
  return data;
}

// =====================================================================
// STEP 3 — DRIVE UPLOAD + HASH DEDUP
// =====================================================================
function computeFileHash(fileBuffer) {
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

/**
 * Checks whether this exact physical file was already uploaded anywhere
 * in the system (regardless of quarter/fund), before it ever reaches Drive.
 */
async function checkExactFileDuplicate(fileHash) {
  const { data, error } = await supabase
    .from('drive_files')
    .select('id, file_name, uploaded_at')
    .eq('file_hash', fileHash)
    .maybeSingle();
  if (error) throw error;
  return data; // null if not a duplicate
}

/**
 * Uploads to the resolved Drive folder and records it in drive_files.
 * `driveClient` is your initialized googleapis drive client (v3),
 * passed in so this module stays testable without live Drive calls.
 */
async function uploadToDriveAndRegister({
  driveClient,
  folderId,
  fileBuffer,
  standardizedName,
  originalName,
  mimeType,
  uploadedBy,
}) {
  const fileHash = computeFileHash(fileBuffer);

  const existing = await checkExactFileDuplicate(fileHash);
  if (existing) {
    const err = new Error(`Identical file already uploaded as "${existing.file_name}" on ${existing.uploaded_at}.`);
    err.code = 'DUPLICATE_FILE';
    throw err;
  }

  const driveRes = await driveClient.files.create({
    requestBody: { name: standardizedName, parents: [folderId] },
    media: { mimeType, body: fileBuffer },
    fields: 'id, webViewLink',
  });

  const { data: driveFileRow, error } = await supabase
    .from('drive_files')
    .insert({
      google_drive_file_id: driveRes.data.id,
      google_drive_url: driveRes.data.webViewLink,
      file_name: standardizedName,
      original_file_name: originalName,
      file_type: mimeType,
      file_size_bytes: fileBuffer.length,
      file_hash: fileHash,
      uploaded_by: uploadedBy,
    })
    .select()
    .single();

  if (error) throw error;
  return driveFileRow;
}

// =====================================================================
// STEP 4 — CREATE fund_uploads ROW + STAGE PARSED ROWS
// =====================================================================
async function createFundUploadRecord({ fundQuarterId, driveFileRow, uploadType, uploadedBy, recordsFound }) {
  const { data, error } = await supabase
    .from('fund_uploads')
    .insert({
      fund_quarter_id: fundQuarterId,
      drive_file_id: driveFileRow.id,
      file_name: driveFileRow.file_name,
      file_type: driveFileRow.file_type,
      file_size_bytes: driveFileRow.file_size_bytes,
      google_drive_file_id: driveFileRow.google_drive_file_id,
      google_drive_url: driveFileRow.google_drive_url,
      upload_type: uploadType,
      uploaded_by: uploadedBy,
      processing_status: 'pending',
      records_found: recordsFound,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function stageRows(fundUploadId, rows) {
  const stagingRows = rows.map((r) => ({
    fund_upload_id: fundUploadId,
    emis_code: (r.emis_code ?? '').toString().trim(),
    allocated_amount: r.allocated_amount ?? null,
    received_amount: r.received_amount ?? null,
  }));

  const { error } = await supabase.from('fund_upload_staging').insert(stagingRows);
  if (error) throw error;
}

// =====================================================================
// STEP 5 — CLASSIFY STAGED ROWS (new / duplicate / unknown_emis / invalid)
// =====================================================================
/**
 * Mirrors the SQL pattern from finance_management_schema.sql section 12,
 * done in application code so partial failures are easy to report back
 * to the preview screen without a giant single UPDATE statement.
 */
async function classifyStagedRows(fundUploadId, fundQuarterId) {
  const { data: staged, error: stagedErr } = await supabase
    .from('fund_upload_staging')
    .select('*')
    .eq('fund_upload_id', fundUploadId);
  if (stagedErr) throw stagedErr;

  const emisCodes = staged.map((r) => r.emis_code).filter(Boolean);

  const { data: schools, error: schoolsErr } = await supabase
    .from('schools')
    .select('id, emis_code')
    .in('emis_code', emisCodes);
  if (schoolsErr) throw schoolsErr;
  const schoolByEmis = new Map(schools.map((s) => [s.emis_code, s.id]));

  const { data: existingFsq, error: fsqErr } = await supabase
    .from('fund_school_quarterly')
    .select('id, school_id')
    .eq('fund_quarter_id', fundQuarterId);
  if (fsqErr) throw fsqErr;
  const fsqBySchoolId = new Map(existingFsq.map((f) => [f.school_id, f.id]));

  const updates = [];
  for (const row of staged) {
    let matchStatus, matchedSchoolId = null, matchedFsqId = null;

    const amountInvalid =
      row.received_amount === null || row.received_amount === undefined || Number(row.received_amount) < 0;

    if (!row.emis_code || amountInvalid) {
      matchStatus = 'invalid';
    } else if (!schoolByEmis.has(row.emis_code)) {
      matchStatus = 'unknown_emis';
    } else {
      matchedSchoolId = schoolByEmis.get(row.emis_code);
      if (fsqBySchoolId.has(matchedSchoolId)) {
        matchStatus = 'duplicate';
        matchedFsqId = fsqBySchoolId.get(matchedSchoolId);
      } else {
        matchStatus = 'new';
      }
    }

    updates.push({
      id: row.id,
      match_status: matchStatus,
      matched_school_id: matchedSchoolId,
      matched_fsq_id: matchedFsqId,
    });
  }

  // Batch update staging rows with their classification
  for (const u of updates) {
    const { error } = await supabase
      .from('fund_upload_staging')
      .update({ match_status: u.match_status, matched_school_id: u.matched_school_id, matched_fsq_id: u.matched_fsq_id })
      .eq('id', u.id);
    if (error) throw error;
  }

  return updates;
}

// =====================================================================
// STEP 6 — PREVIEW SUMMARY (what the officer sees before confirming)
// =====================================================================
async function getUploadPreview(fundUploadId) {
  const { data, error } = await supabase
    .from('fund_upload_staging')
    .select('match_status')
    .eq('fund_upload_id', fundUploadId);
  if (error) throw error;

  const counts = { new: 0, duplicate: 0, unknown_emis: 0, invalid: 0 };
  for (const row of data) counts[row.match_status] = (counts[row.match_status] || 0) + 1;
  return { total: data.length, ...counts };
}

// =====================================================================
// STEP 7 — COMMIT: insert new rows, apply explicitly confirmed updates
// =====================================================================
/**
 * @param {number} fundUploadId
 * @param {number} fundQuarterId
 * @param {number[]} confirmedUpdateStagingIds - staging rows marked
 *   'duplicate' that the officer explicitly chose to overwrite
 * @param {string} userId
 * @param {string} reason - required when confirmedUpdateStagingIds is non-empty
 */
async function commitUpload(fundUploadId, fundQuarterId, confirmedUpdateStagingIds, userId, reason) {
  const { data: staged, error } = await supabase
    .from('fund_upload_staging')
    .select('*')
    .eq('fund_upload_id', fundUploadId);
  if (error) throw error;

  const newRows = staged.filter((r) => r.match_status === 'new');
  const updateRows = staged.filter(
    (r) => r.match_status === 'duplicate' && confirmedUpdateStagingIds.includes(r.id)
  );

  let inserted = 0;
  let updated = 0;

  if (newRows.length > 0) {
    const toInsert = newRows.map((r) => ({
      fund_quarter_id: fundQuarterId,
      school_id: r.matched_school_id,
      emis_code: r.emis_code,
      allocated_amount: r.allocated_amount ?? 0,
      received_amount: r.received_amount ?? 0,
      source_upload_id: fundUploadId,
    }));
    const { error: insErr, count } = await supabase
      .from('fund_school_quarterly')
      .insert(toInsert, { count: 'exact' });
    if (insErr) throw insErr;
    inserted = count ?? toInsert.length;
  }

  for (const r of updateRows) {
    // Fetch old value first so the audit log has a real before/after
    const { data: oldRow, error: oldErr } = await supabase
      .from('fund_school_quarterly')
      .select('*')
      .eq('id', r.matched_fsq_id)
      .single();
    if (oldErr) throw oldErr;

    const newValue = {
      ...oldRow,
      allocated_amount: r.allocated_amount ?? oldRow.allocated_amount,
      received_amount: r.received_amount ?? oldRow.received_amount,
      status: 'corrected',
      source_upload_id: fundUploadId,
    };

    const { error: updErr } = await supabase
      .from('fund_school_quarterly')
      .update({
        allocated_amount: newValue.allocated_amount,
        received_amount: newValue.received_amount,
        status: 'corrected',
        source_upload_id: fundUploadId,
      })
      .eq('id', r.matched_fsq_id);
    if (updErr) throw updErr;

    const { error: auditErr } = await supabase.from('audit_logs').insert({
      user_id: userId,
      table_name: 'fund_school_quarterly',
      record_id: r.matched_fsq_id,
      action: 'correction',
      old_value: oldRow,
      new_value: newValue,
      reason: reason || 'Confirmed update from additional/correction upload',
    });
    if (auditErr) throw auditErr;

    updated += 1;
  }

  const duplicateCount = staged.filter((r) => r.match_status === 'duplicate').length;
  const errorCount = staged.filter((r) => r.match_status === 'invalid' || r.match_status === 'unknown_emis').length;

  const { error: finalizeErr } = await supabase
    .from('fund_uploads')
    .update({
      processing_status: 'committed',
      records_inserted: inserted,
      records_updated: updated,
      duplicate_records: duplicateCount,
      error_records: errorCount,
      processing_message: `Committed: ${inserted} new, ${updated} corrected, ${duplicateCount} left as-is, ${errorCount} rejected.`,
    })
    .eq('id', fundUploadId);
  if (finalizeErr) throw finalizeErr;

  // Recompute the quarter total so dashboards don't need a live SUM every load
  const { data: totalRow, error: totalErr } = await supabase
    .from('fund_school_quarterly')
    .select('received_amount')
    .eq('fund_quarter_id', fundQuarterId);
  if (totalErr) throw totalErr;
  const total = totalRow.reduce((sum, r) => sum + Number(r.received_amount || 0), 0);

  await supabase
    .from('fund_quarters')
    .update({ total_amount: total, processing_status: 'done' })
    .eq('id', fundQuarterId);

  return { inserted, updated, duplicateCount, errorCount, total };
}

module.exports = {
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
};
