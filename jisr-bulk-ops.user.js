// ==UserScript==
// @name         Jisr Bulk Ops
// @namespace    jisr-bulk-ops
// @version      2.2.0
// @description  One tool for all Jisr bulk operations - pick a module from the dropdown. Direct API calls, Dry Run required before any live write. Includes Letter Template Variables extractor.
// @updateURL    https://raw.githubusercontent.com/esam-almithali/jisr-bulk-ops/main/jisr-bulk-ops.user.js
// @downloadURL  https://raw.githubusercontent.com/esam-almithali/jisr-bulk-ops/main/jisr-bulk-ops.user.js
// @match        https://*.jisr.net/*
// @match        https://*.jisr.net.sa/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      workers.dev
// @connect      apis.jisr.net
// @connect      api.jisr.net.sa
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ===========================================================================
  // Config
  // ===========================================================================
  const BACKEND_URL = 'https://jisr-bulk-ops-backend.jisr.workers.dev';
  const WRITE_KEY = 'Jisr_Tool_2026$';

  // ===========================================================================
  // CORE — shared plumbing, used by every module
  // ===========================================================================
  const GM_PREFIX = 'jisrBulkOps_';

  function gmGet_(key, fallback) {
    try { return GM_getValue(GM_PREFIX + key, fallback); } catch (e) { return fallback; }
  }
  function gmSet_(key, val) {
    try { GM_setValue(GM_PREFIX + key, val); } catch (e) { /* ignore */ }
  }

  function apiBase_() {
    const host = location.hostname;
    if (host.endsWith('jisr.net.sa')) return 'https://api.jisr.net.sa/api';
    if (host.endsWith('jisr.net')) return 'https://apis.jisr.net/api';
    throw new Error('Unrecognized Jisr host - refusing to guess an API base for: ' + host);
  }

  function currentSlug_() {
    return location.hostname.split('.')[0];
  }

  function sleep_(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function apiRequest_(method, path, opts) {
    opts = opts || {};
    const qs = new URLSearchParams(Object.assign({ slug: currentSlug_() }, opts.query || {}));
    const url = apiBase_() + path + '?' + qs.toString();
    const headers = Object.assign({ accept: 'application/json', slug: currentSlug_() }, opts.headers || {});
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    let lastErr = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          credentials: 'include',
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
        if (res.status === 429 || res.status === 503) {
          const retryAfter = parseFloat(res.headers.get('Retry-After')) || (attempt * 2);
          await sleep_(retryAfter * 1000 + Math.random() * 300);
          continue;
        }
        const data = await res.json().catch(() => null);
        return { status: res.status, ok: res.ok, data };
      } catch (e) {
        lastErr = e;
        console.error('[Jisr Bulk Ops] fetch exception on attempt ' + attempt + ' for ' + method + ' ' + path + ':', e.name, e.message, e);
        await sleep_(attempt * 1200 + Math.random() * 400);
      }
    }
    throw lastErr || new Error('Request failed after retries: ' + method + ' ' + path);
  }
  function apiGet_(path, query) { return apiRequest_('GET', path, { query }); }
  function apiPost_(path, body, query) { return apiRequest_('POST', path, { body, query }); }
  function apiPut_(path, body, query) { return apiRequest_('PUT', path, { body, query }); }

  function backendRequest_(path, method, body, extraHeaders) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method,
        url: BACKEND_URL + path,
        headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
        data: body ? JSON.stringify(body) : undefined,
        onload: (res) => {
          try { resolve({ status: res.status, data: JSON.parse(res.responseText) }); }
          catch (e) { resolve({ status: res.status, data: null }); }
        },
        onerror: () => resolve({ status: 0, data: null }),
      });
    });
  }

  function ensureRegistered_() {
    let email = gmGet_('userEmail', '');
    if (!email) {
      email = prompt('Enter your email to activate the Jisr tools (one time only):');
      if (!email || !email.includes('@')) { alert('Invalid email.'); return null; }
      gmSet_('userEmail', email);
    }
    backendRequest_('/api/register', 'POST', { email, tenant: currentSlug_() });
    return email;
  }

  function logActivity_(module, action, detail, success) {
    const email = gmGet_('userEmail', '');
    if (!email) return;
    backendRequest_('/api/activity', 'POST',
      { actor_email: email, tenant: currentSlug_(), module, action, detail, success },
      { 'X-Write-Key': WRITE_KEY });
  }

  // ===========================================================================
  // Shared response-envelope helpers
  // ===========================================================================
  function extractArray_(data, depth) {
    depth = depth || 0;
    if (Array.isArray(data)) return data;
    if (depth > 2 || !data || typeof data !== 'object') return null;
    const candidateKeys = ['data', 'departments', 'job_titles', 'employees', 'results', 'records', 'items', 'list', 'variables', 'letter_variables'];
    for (const key of candidateKeys) {
      if (data[key] !== undefined) {
        const found = extractArray_(data[key], depth + 1);
        if (found) return found;
      }
    }
    const arrayCandidates = [];
    for (const key of Object.keys(data)) {
      const found = extractArray_(data[key], depth + 1);
      if (found) arrayCandidates.push(found);
    }
    if (arrayCandidates.length === 1) return arrayCandidates[0];
    return null;
  }

  function extractRecord_(data, depth) {
    depth = depth || 0;
    if (data && typeof data === 'object' && !Array.isArray(data) && ('id' in data || 'name' in data)) return data;
    if (depth > 2 || !data || typeof data !== 'object') return null;
    const candidateKeys = ['data', 'department', 'record', 'result'];
    for (const key of candidateKeys) {
      if (data[key] !== undefined) {
        const found = extractRecord_(data[key], depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function writeSucceeded_(res) {
    if (!res.ok) {
      let detail = 'HTTP ' + res.status;
      if (res.data && typeof res.data === 'object') {
        if (res.data.message) detail += ': ' + res.data.message;
        else if (res.data.errors) detail += ': ' + JSON.stringify(res.data.errors);
        else if (res.data.error) detail += ': ' + JSON.stringify(res.data.error);
        else {
          const preview = JSON.stringify(res.data);
          if (preview && preview !== '{}' && preview !== 'null') detail += ': ' + preview.slice(0, 300);
        }
      }
      return { ok: false, reason: detail };
    }
    if (res.data && typeof res.data === 'object' && 'success' in res.data && res.data.success === false) {
      return { ok: false, reason: res.data.message || 'server reported success:false' };
    }
    return { ok: true, reason: null };
  }

  // ===========================================================================
  // CSV helpers
  // ===========================================================================
  function toBool_(v) {
    return /^(true|1|yes)$/i.test(String(v === undefined || v === null ? '' : v).trim());
  }
  function orNull_(v) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    return s === '' ? null : s;
  }
  function safeNeutralizeStartDate_() {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - 13);
    return d.toISOString().slice(0, 10);
  }

  function toIsoDate_(dateStr) {
    const s = String(dateStr || '').trim();
    const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (m) {
      const [, d, mo, y] = m;
      return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    return s;
  }

  function toHijri_(isoGregorianDate) {
    try {
      const d = new Date(isoGregorianDate + 'T00:00:00Z');
      if (isNaN(d.getTime())) return null;
      const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
        year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC',
      }).formatToParts(d);
      const y = parts.find((p) => p.type === 'year').value;
      const mo = parts.find((p) => p.type === 'month').value.padStart(2, '0');
      const da = parts.find((p) => p.type === 'day').value.padStart(2, '0');
      return `${y}-${mo}-${da}`;
    } catch (e) {
      console.log('[Jisr Bulk Ops] Hijri conversion failed:', e.message);
      return null;
    }
  }

  function toCsv_(rows, headers) {
    const esc = (v) => {
      v = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const lines = [headers.map(esc).join(',')];
    for (const row of rows) lines.push(headers.map((h) => esc(row[h])).join(','));
    return lines.join('\r\n');
  }

  function parseCsv_(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 1) return [];
    const headers = splitCsvLine_(lines[0]);
    return lines.slice(1).map((line) => {
      const cells = splitCsvLine_(line);
      const row = {};
      headers.forEach((h, i) => { row[h] = cells[i] !== undefined ? cells[i] : ''; });
      return row;
    });
  }

  function splitCsvLine_(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') { inQuotes = false; }
        else { cur += c; }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        out.push(cur); cur = '';
      } else {
        cur += c;
      }
    }
    out.push(cur);
    return out;
  }

  function downloadCsv_(filename, csvText) {
    const blob = new Blob(['\uFEFF' + csvText], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ===========================================================================
  // MODULE: Departments
  // ===========================================================================
  const DepartmentsModule = {
    key: 'departments',
    label: 'Departments',
    editableHeaders: ['id', 'name', 'name_ar', 'manager_id', 'parent_id', 'category_ids'],
    readableHeaders: ['manager_name', 'manager_national_id', 'parent_name', 'category_names'],
    get csvHeaders() { return this.editableHeaders.concat(this.readableHeaders); },

    async fetchAll() {
      const res = await apiGet_('/v2/departments');
      console.log('[Jisr Bulk Ops] /v2/departments raw response:', res.data);
      if (!res.ok) throw new Error('Request failed (status ' + res.status + ')');
      const arr = extractArray_(res.data);
      if (!arr) {
        const keys = res.data && typeof res.data === 'object' ? Object.keys(res.data).join(', ') : typeof res.data;
        const dataPreview = res.data && res.data.data !== undefined ? JSON.stringify(res.data.data).slice(0, 300) : '(no .data key)';
        throw new Error('Unexpected response shape. Top-level keys: [' + keys + ']. Inside "data": ' + dataPreview);
      }
      try {
        const dirRes = await apiGet_('/v2/employees/get_all');
        this._employeeDirectory = {};
        (extractArray_(dirRes.data) || []).forEach((e) => { this._employeeDirectory[e.id] = e; });
      } catch (e) {
        this._employeeDirectory = {};
      }
      return arr;
    },

    toRow(d, byId) {
      const parent = d.parent_id && byId[d.parent_id] ? byId[d.parent_id] : null;
      const managerDir = (this._employeeDirectory && d.manager && this._employeeDirectory[d.manager.id]) || {};
      return {
        id: d.id,
        name: d.name || '',
        name_ar: d.name_ar || '',
        manager_id: d.manager && d.manager.id !== undefined ? d.manager.id : '',
        parent_id: d.parent_id !== undefined && d.parent_id !== null ? d.parent_id : '',
        category_ids: Array.isArray(d.categories) ? d.categories.map((c) => c.id).join('|') : '',
        manager_national_id: (managerDir.identification_info && managerDir.identification_info.document_number) ||
          (managerDir.identification_info_attributes && managerDir.identification_info_attributes.document_number) ||
          managerDir.national_id || managerDir.document_number || '',
        manager_name: d.manager && d.manager.name ? d.manager.name : '',
        parent_name: parent ? parent.name : '',
        category_names: Array.isArray(d.categories) ? d.categories.map((c) => c.name).filter(Boolean).join('|') : '',
      };
    },

    buildPlanForRow(row, currentById) {
      const isNew = !row.id || String(row.id).trim() === '';
      const warnings = [];

      if (isNew) {
        if (!row.name || !row.name_ar || !row.manager_id) {
          return { isNew, skip: true, warnings: ['New department missing required field(s) (name/name_ar/manager_id) - skipped.'] };
        }
        return {
          isNew, skip: false, warnings,
          body: {
            name: row.name, name_ar: row.name_ar,
            manager_id: Number(row.manager_id),
            category_ids: row.category_ids ? row.category_ids.split('|').map(Number) : [],
          },
          preview: { name: ['(new)', row.name], name_ar: ['(new)', row.name_ar] },
        };
      }

      const current = currentById[row.id];
      if (!current) {
        return { isNew, skip: true, warnings: [`id ${row.id} not found in current data - skipped.`] };
      }
      const currentRow = this.toRow(current, currentById);
      const merged = {};
      for (const key of this.editableHeaders) {
        merged[key] = (row[key] !== undefined && String(row[key]).trim() !== '') ? row[key] : currentRow[key];
      }
      const changed = this.editableHeaders.filter((k) => k !== 'id' && String(merged[k]) !== String(currentRow[k]));
      if (changed.length === 0) {
        return { isNew, skip: true, warnings: ['No change detected - skipped.'] };
      }
      if (changed.includes('manager_id') || changed.includes('category_ids')) {
        warnings.push('manager_id/category_ids changes cannot be verified from the API response (documented gap) - double-check manually after running.');
      }
      return {
        isNew, skip: false, warnings,
        body: {
          id: Number(row.id), name: merged.name, name_ar: merged.name_ar,
          manager_id: Number(merged.manager_id),
          parent_id: merged.parent_id ? Number(merged.parent_id) : null,
          category_ids: merged.category_ids ? String(merged.category_ids).split('|').map(Number) : [],
        },
        preview: {
          name: [currentRow.name, merged.name],
          name_ar: [currentRow.name_ar, merged.name_ar],
          parent_id: [currentRow.parent_id, merged.parent_id],
        },
        changed,
      };
    },

    async applyPlan(plan) {
      const res = plan.isNew
        ? await apiPost_('/v2/departments', plan.body)
        : await apiPut_(`/v2/departments/${plan.body.id}`, plan.body);
      console.log('[Jisr Bulk Ops] departments write response:', res.status, res.data);
      const verdict = writeSucceeded_(res);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      const echoed = extractRecord_(res.data);
      if (echoed && (String(echoed.name) !== String(plan.body.name) || String(echoed.name_ar) !== String(plan.body.name_ar))) {
        return { ok: false, reason: `server returned success but echoed record doesn't match (got name="${echoed.name}")` };
      }
      return { ok: true, reason: null };
    },
  };

  // ===========================================================================
  // MODULE: Job Titles
  // ===========================================================================
  const JobTitlesModule = {
    key: 'job_titles',
    label: 'Job Titles',
    editableHeaders: ['id', 'name', 'name_ar', 'description', 'delete'],
    readableHeaders: [],
    get csvHeaders() { return this.editableHeaders; },

    async fetchAll() {
      const res = await apiGet_('/v2/job_titles/', { 'filter[search]': '' });
      console.log('[Jisr Bulk Ops] /v2/job_titles raw response:', res.data);
      if (!res.ok) throw new Error('Request failed (status ' + res.status + ')');
      const arr = extractArray_(res.data);
      if (!arr) {
        const keys = res.data && typeof res.data === 'object' ? Object.keys(res.data).join(', ') : typeof res.data;
        throw new Error('Unexpected response shape. Top-level keys: [' + keys + ']');
      }
      return arr;
    },

    toRow(d) {
      return {
        id: d.id, name: d.name || '', name_ar: d.name_ar || '',
        description: d.description || '', delete: '',
      };
    },

    buildPlanForRow(row, currentById) {
      const isNew = !row.id || String(row.id).trim() === '';
      const wantsDelete = /^(true|1|yes)$/i.test(String(row.delete || '').trim());

      if (isNew) {
        if (wantsDelete) return { isNew, skip: true, warnings: ['Cannot delete a row with no id - skipped.'] };
        if (!row.name || !row.name_ar) {
          return { isNew, skip: true, warnings: ['New job title missing name/name_ar - skipped.'] };
        }
        return {
          isNew, skip: false, warnings: [],
          body: { name: row.name, name_ar: row.name_ar, reference_job_title_id: null },
          preview: { name: ['(new)', row.name], name_ar: ['(new)', row.name_ar] },
        };
      }

      const current = currentById[row.id];
      if (!current) return { isNew, skip: true, warnings: [`id ${row.id} not found - skipped.`] };
      const currentRow = this.toRow(current);

      if (wantsDelete) {
        return {
          isNew: false, isDelete: true, skip: false, warnings: ['This row will be DELETED.'],
          body: { id: Number(row.id) },
          preview: { name: [currentRow.name, '(DELETE)'] },
        };
      }

      const merged = {};
      for (const key of ['id', 'name', 'name_ar', 'description']) {
        merged[key] = (row[key] !== undefined && String(row[key]).trim() !== '') ? row[key] : currentRow[key];
      }
      const changed = ['name', 'name_ar', 'description'].filter((k) => String(merged[k]) !== String(currentRow[k]));
      if (changed.length === 0) return { isNew, skip: true, warnings: ['No change detected - skipped.'] };
      return {
        isNew, skip: false, warnings: [],
        body: { id: Number(row.id), name: merged.name, name_ar: merged.name_ar, description: merged.description, reference_job_title_id: null },
        preview: {
          name: [currentRow.name, merged.name],
          name_ar: [currentRow.name_ar, merged.name_ar],
          description: [currentRow.description, merged.description],
        },
        changed,
      };
    },

    async applyPlan(plan) {
      if (plan.isDelete) {
        const res = await apiRequest_('DELETE', `/v2/job_titles/${plan.body.id}/`);
        console.log('[Jisr Bulk Ops] job_titles delete response:', res.status, res.data);
        const verdict = writeSucceeded_(res);
        return verdict.ok ? { ok: true, reason: null } : { ok: false, reason: verdict.reason };
      }
      const res = plan.isNew
        ? await apiPost_('/v2/job_titles/', { job_title: plan.body })
        : await apiPut_(`/v2/job_titles/${plan.body.id}/`, { job_title: plan.body });
      console.log('[Jisr Bulk Ops] job_titles write response:', res.status, res.data);
      const verdict = writeSucceeded_(res);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      const echoed = extractRecord_(res.data);
      if (echoed && (String(echoed.name) !== String(plan.body.name) || String(echoed.name_ar) !== String(plan.body.name_ar))) {
        return { ok: false, reason: `server returned success but echoed record doesn't match (got name="${echoed.name}")` };
      }
      return { ok: true, reason: null };
    },
  };

  // ===========================================================================
  // MODULE: Employee Code
  // ===========================================================================
  const EmployeeCodeModule = {
    key: 'employee_code',
    label: 'Employee Code',
    editableHeaders: ['id', 'code'],
    readableHeaders: ['full_name', 'national_id'],
    get csvHeaders() { return this.editableHeaders.concat(this.readableHeaders); },

    async fetchAll() {
      const res = await apiGet_('/v2/employees/get_all');
      console.log('[Jisr Bulk Ops] /v2/employees/get_all raw response:', res.data);
      if (!res.ok) throw new Error('Request failed (status ' + res.status + ')');
      const arr = extractArray_(res.data);
      if (!arr) {
        const keys = res.data && typeof res.data === 'object' ? Object.keys(res.data).join(', ') : typeof res.data;
        throw new Error('Unexpected response shape. Top-level keys: [' + keys + ']');
      }
      return arr;
    },

    toRow(d) {
      return {
        id: d.id,
        code: d.code || d.employee_code || '',
        full_name: d.full_name || d.name || '',
        national_id: (d.identification_info && d.identification_info.document_number) ||
          (d.identification_info_attributes && d.identification_info_attributes.document_number) ||
          d.national_id || d.document_number || '',
      };
    },

    buildPlanForRow(row, currentById) {
      if (!row.id) return { skip: true, warnings: ['Employee code cannot be created via this tool - id required.'] };
      const current = currentById[row.id];
      if (!current) return { skip: true, warnings: [`id ${row.id} not found - skipped.`] };
      const currentRow = this.toRow(current);
      const newCode = String(row.code || '').trim() !== '' ? row.code : currentRow.code;
      if (String(newCode) === String(currentRow.code)) return { skip: true, warnings: ['No change detected - skipped.'] };
      return {
        isNew: false, skip: false, warnings: [],
        body: { id: Number(row.id), code: newCode },
        preview: { code: [currentRow.code, newCode] },
        changed: ['code'],
      };
    },

    async applyPlan(plan) {
      const res = await apiPut_(`/v2/employees/${plan.body.id}`, { employee: { code: plan.body.code } });
      console.log('[Jisr Bulk Ops] employee_code write response:', res.status, res.data);
      const verdict = writeSucceeded_(res);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      const echoed = extractRecord_(res.data);
      const echoedCode = echoed ? (echoed.code || echoed.employee_code) : null;
      if (echoed && echoedCode !== undefined && String(echoedCode) !== String(plan.body.code)) {
        return { ok: false, reason: `server returned success but echoed code doesn't match (got "${echoedCode}")` };
      }
      return { ok: true, reason: null };
    },
  };

  function parseLatLngFromMapsUrl_(text) {
    const s = String(text || '');
    let m = s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (!m) m = s.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
    return null;
  }

  async function resolveLatLng_(searchOrUrl) {
    const fromUrl = parseLatLngFromMapsUrl_(searchOrUrl);
    if (fromUrl) return { ...fromUrl, source: 'url' };
    const acRes = await apiGet_('/v2/integration/google_maps/places/autocomplete', { search: searchOrUrl });
    console.log('[Jisr Bulk Ops] places autocomplete response:', acRes.data);
    const suggestions = extractArray_(acRes.data) || [];
    if (suggestions.length === 0) return null;
    const placeId = suggestions[0].place_id || suggestions[0].id;
    if (!placeId) return null;
    const detRes = await apiGet_('/v2/integration/google_maps/places/details', { place_id: placeId });
    console.log('[Jisr Bulk Ops] places details response:', detRes.data);
    const detail = extractRecord_(detRes.data);
    if (!detail) return null;
    const lat = detail.latitude !== undefined ? detail.latitude
      : (detail.geometry && detail.geometry.location && detail.geometry.location.lat);
    const lng = detail.longitude !== undefined ? detail.longitude
      : (detail.geometry && detail.geometry.location && detail.geometry.location.lng);
    if (lat === undefined || lng === undefined) return null;
    return { lat: Number(lat), lng: Number(lng), source: 'search' };
  }

  // ===========================================================================
  // MODULE: Areas
  // ===========================================================================
  const AreasModule = {
    key: 'areas',
    label: 'Areas',
    editableHeaders: ['id', 'name', 'name_ar', 'country_id', 'manager_id'],
    readableHeaders: [],
    get csvHeaders() { return this.editableHeaders; },
    noExport: true,

    async fetchAll() { return []; },
    toRow() { return {}; },

    buildPlanForRow(row) {
      const isNew = !row.id || String(row.id).trim() === '';
      if (isNew) {
        if (!row.name || !row.name_ar || !row.country_id) {
          return { isNew: true, skip: true, warnings: ['Missing required field (name/name_ar/country_id) - skipped.'] };
        }
        return {
          isNew: true, skip: false, warnings: [],
          body: { isOpen: true, name: row.name, name_ar: row.name_ar, country_id: Number(row.country_id), manager_id: row.manager_id ? Number(row.manager_id) : null },
          preview: { name: ['(new)', row.name], name_ar: ['(new)', row.name_ar] },
        };
      }
      if (!row.name && !row.name_ar && !row.manager_id) {
        return { skip: true, warnings: ['No new values provided for this existing area id - skipped.'] };
      }
      return {
        isNew: false, skip: false,
        warnings: ['Editing an existing area needs country_id/name/name_ar/manager_id ALL filled in - fill in every column even for unchanged values.'],
        body: {
          id: Number(row.id), country_id: row.country_id ? Number(row.country_id) : null,
          manager_id: row.manager_id ? Number(row.manager_id) : null, name: row.name, name_ar: row.name_ar,
        },
        preview: { name: ['(will submit)', row.name], name_ar: ['(will submit)', row.name_ar] },
      };
    },

    async applyPlan(plan) {
      const res = plan.isNew
        ? await apiPost_('/v2/areas/bulk_create', { area: [plan.body] })
        : await apiPut_(`/v2/areas/${plan.body.id}/`, { area: plan.body });
      console.log('[Jisr Bulk Ops] areas write response:', res.status, res.data);
      const verdict = writeSucceeded_(res);
      return verdict.ok ? { ok: true, reason: null } : { ok: false, reason: verdict.reason };
    },
  };

  // ===========================================================================
  // MODULE: Locations
  // ===========================================================================
  const LocationsModule = {
    key: 'locations',
    label: 'Locations',
    editableHeaders: ['id', 'address_en', 'address_ar', 'area_id', 'city_id', 'manager_id',
      'google_maps_link_or_address', 'radius', 'delete'],
    readableHeaders: [],
    get csvHeaders() { return this.editableHeaders; },

    async fetchAll() {
      let all = [];
      let page = 1;
      for (let guard = 0; guard < 30; guard++) {
        const res = await apiGet_('/v2/locations', { search: '', page, onboarding: true, rpp: 50, 'sort_by[localized_address]': 'ASC' });
        console.log('[Jisr Bulk Ops] locations page ' + page + ':', res.data);
        if (!res.ok) throw new Error('Request failed (status ' + res.status + ')');
        const arr = extractArray_(res.data);
        if (!arr) {
          const keys = res.data && typeof res.data === 'object' ? Object.keys(res.data).join(', ') : typeof res.data;
          throw new Error('Unexpected response shape. Top-level keys: [' + keys + ']');
        }
        if (arr.length === 0) break;
        all = all.concat(arr);
        if (arr.length < 50) break;
        page++;
        await sleep_(200);
      }
      return all;
    },

    toRow(d) {
      return {
        id: d.id, address_en: d.address_en || d.address || '', address_ar: d.address_ar || '',
        area_id: d.area && d.area.id !== undefined ? d.area.id : (d.area_id || ''),
        city_id: d.city && d.city.id !== undefined ? d.city.id : (d.city_id || ''),
        manager_id: d.manager && d.manager.id !== undefined ? d.manager.id : '',
        google_maps_link_or_address: '', radius: d.radius || '', delete: '',
      };
    },

    buildPlanForRow(row, currentById) {
      const isNew = !row.id || String(row.id).trim() === '';
      const wantsDelete = /^(true|1|yes)$/i.test(String(row.delete || '').trim());

      if (wantsDelete) {
        if (isNew) return { skip: true, warnings: ['Cannot delete a row with no id - skipped.'] };
        return {
          isDelete: true, skip: false, warnings: ['This location will be DELETED.'],
          body: { id: Number(row.id) },
          preview: { id: [row.id, '(DELETE)'] },
        };
      }

      if (isNew) {
        if (!row.address_en || !row.area_id) {
          return { skip: true, warnings: ['New location missing address_en/area_id - skipped.'] };
        }
        return {
          isNew: true, skip: false, warnings: [],
          body: {
            address_en: row.address_en, address_ar: row.address_ar || '', area_id: Number(row.area_id),
            city_id: row.city_id ? Number(row.city_id) : null, manager_id: row.manager_id ? Number(row.manager_id) : null,
          },
          geoInput: row.google_maps_link_or_address ? { text: row.google_maps_link_or_address, radius: row.radius } : null,
          preview: { address_en: ['(new)', row.address_en] },
        };
      }

      const current = currentById[row.id];
      if (!current) return { skip: true, warnings: [`id ${row.id} not found - skipped.`] };
      const currentRow = this.toRow(current);
      const merged = {};
      for (const key of ['address_en', 'address_ar', 'area_id', 'city_id', 'manager_id']) {
        merged[key] = (row[key] !== undefined && String(row[key]).trim() !== '') ? row[key] : currentRow[key];
      }
      const changed = Object.keys(merged).filter((k) => String(merged[k]) !== String(currentRow[k]));
      const hasGeo = row.google_maps_link_or_address && row.radius;
      if (changed.length === 0 && !hasGeo) {
        return { skip: true, warnings: ['No change detected - skipped.'] };
      }
      return {
        isNew: false, skip: false, warnings: [],
        body: {
          id: Number(row.id), address_en: merged.address_en, address_ar: merged.address_ar,
          area_id: merged.area_id ? Number(merged.area_id) : null, city_id: merged.city_id ? Number(merged.city_id) : null,
          manager_id: merged.manager_id ? Number(merged.manager_id) : null,
        },
        geoInput: hasGeo ? { text: row.google_maps_link_or_address, radius: row.radius } : null,
        preview: {
          address_en: [currentRow.address_en, merged.address_en], area_id: [currentRow.area_id, merged.area_id],
          manager_id: [currentRow.manager_id, merged.manager_id],
        },
      };
    },

    async applyPlan(plan) {
      if (plan.isDelete) {
        const res = await apiRequest_('DELETE', `/v2/locations/${plan.body.id}/`, { body: null });
        console.log('[Jisr Bulk Ops] location delete response:', res.status, res.data);
        const verdict = writeSucceeded_(res);
        return verdict.ok ? { ok: true, reason: null } : { ok: false, reason: verdict.reason };
      }

      const res = plan.isNew
        ? await apiPost_('/v2/locations/bulk_create', { location: plan.body })
        : await apiPut_(`/v2/locations/${plan.body.id}/`, { location: plan.body });
      console.log('[Jisr Bulk Ops] location write response:', res.status, res.data);
      const verdict = writeSucceeded_(res);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };

      if (!plan.geoInput) return { ok: true, reason: null };

      const locationId = plan.isNew ? (extractRecord_(res.data) || {}).id : plan.body.id;
      if (!locationId) return { ok: true, reason: 'Address saved, but could not determine the new location\'s id to also set its geo-location.' };
      try {
        const coords = await resolveLatLng_(plan.geoInput.text);
        if (!coords) return { ok: true, reason: 'Address saved, but could not resolve coordinates from "' + plan.geoInput.text + '" - geo-location NOT set.' };
        const geoRes = await apiPut_(`/v2/attendance/locations/${locationId}/`, {
          location: { id: locationId, radius: Number(plan.geoInput.radius), latitude: coords.lat, longitude: coords.lng },
        }, { with_geo_location: true });
        console.log('[Jisr Bulk Ops] location geo-update response:', geoRes.status, geoRes.data);
        const geoVerdict = writeSucceeded_(geoRes);
        if (!geoVerdict.ok) return { ok: true, reason: 'Address saved, but geo-location update failed: ' + geoVerdict.reason };
        return { ok: true, reason: coords.source === 'search' ? '⚠️ Geo-location set via best-effort address search (response shape unconfirmed) - verify the pin manually.' : null };
      } catch (e) {
        return { ok: true, reason: 'Address saved, but geo-location step failed: ' + e.message };
      }
    },
  };

  // ===========================================================================
  // MODULE: Employee Contracts
  // ===========================================================================
  const EmployeeContractsModule = {
    key: 'employee_contracts',
    label: 'Employee Contracts (Export/Update/Delete/Create)',
    editableHeaders: ['employee_id', 'contract_id', 'contract_type', 'start_date', 'contract_period',
      'auto_renewal', 'indefinitable', 'month', 'reminder_period', 'delete', 'reason'],
    readableHeaders: ['status', 'employee_code', 'employee_name', 'national_id'],
    get csvHeaders() { return this.editableHeaders.concat(this.readableHeaders); },
    needsIdList: true,

    async fetchAllForIds(employeeIds) {
      let directoryById = {};
      try {
        const dirRes = await apiGet_('/v2/employees/get_all');
        const dirArr = extractArray_(dirRes.data) || [];
        dirArr.forEach((e) => { directoryById[e.id] = e; });
      } catch (e) {
        console.log('[Jisr Bulk Ops] could not fetch employee directory for code lookup:', e.message);
      }

      const allRows = [];
      for (const empId of employeeIds) {
        const dirEntry = directoryById[empId] || null;
        try {
          const res = await apiGet_(`/v2/employees/${empId}/employee_contracts/`);
          console.log('[Jisr Bulk Ops] contracts for employee ' + empId + ':', res.data);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const arr = extractArray_(res.data) || [];
          if (arr.length === 0) {
            allRows.push(this.toRow({}, empId, dirEntry));
          } else {
            for (const c of arr) allRows.push(this.toRow(c, empId, dirEntry));
          }
        } catch (e) {
          console.log('[Jisr Bulk Ops] failed to fetch contracts for ' + empId + ':', e.message);
          const errRow = this.toRow({}, empId, dirEntry);
          errRow.employee_name = '(fetch failed: ' + e.message + ')';
          allRows.push(errRow);
        }
        await sleep_(200);
      }
      return allRows;
    },

    toRow(c, empId, dirEntry) {
      dirEntry = dirEntry || {};
      let status = '';
      if (c.status !== undefined) status = c.status;
      else if (c.active !== undefined) status = c.active ? 'Active' : 'Inactive';
      else if (c.is_active !== undefined) status = c.is_active ? 'Active' : 'Inactive';
      return {
        employee_id: empId || c.employee_id || '',
        contract_id: c.id || '',
        contract_type: c.contract_type || '',
        start_date: c.start_date || '',
        contract_period: c.contract_period || '',
        auto_renewal: c.auto_renewal !== undefined ? c.auto_renewal : '',
        indefinitable: c.indefinitable !== undefined ? c.indefinitable : '',
        month: c.month || '',
        reminder_period: c.reminder_period || '',
        delete: '',
        reason: '',
        status,
        employee_code: dirEntry.code || dirEntry.employee_code || '',
        national_id: (dirEntry.identification_info && dirEntry.identification_info.document_number) ||
          (dirEntry.identification_info_attributes && dirEntry.identification_info_attributes.document_number) ||
          dirEntry.national_id || dirEntry.document_number || '',
        employee_name: dirEntry.full_name || dirEntry.name || c.employee_name || (c.employee && c.employee.full_name) || '',
      };
    },

    buildPlanForRow(row) {
      const wantsDelete = /^(true|1|yes)$/i.test(String(row.delete || '').trim());
      const hasContractId = row.contract_id && String(row.contract_id).trim() !== '';
      const todayIso = new Date().toISOString().slice(0, 10);

      if (wantsDelete) {
        if (!hasContractId) return { skip: true, warnings: ['Cannot delete without a contract_id - skipped.'] };
        if (!row.reason) return { skip: true, warnings: ['Delete requires a reason - skipped.'] };
        const isCurrentlyActive = /^active$/i.test(String(row.status || '').trim());
        const deleteWarnings = ['This contract will be DELETED.'];

        if (isCurrentlyActive) {
          deleteWarnings.push('⚠️ Contract is Active - will first neutralize it automatically, confirmed live to flip status to Inactive, THEN delete.');
          return {
            isDelete: true, skip: false, warnings: deleteWarnings,
            preStep: {
              contract_type: 'Fixed term', contract_type_i18n: 'Fixed term',
              contract_period: '1 year', contract_period_i18n: '1 year',
              start_date: safeNeutralizeStartDate_(),
              auto_renewal: false, indefinitable: false,
              reminder_period: '90_days', month: 0,
              reason: row.reason, effective_date: todayIso,
            },
            body: { employee_id: row.employee_id, contract_id: row.contract_id, reason: row.reason },
            preview: { contract_id: [row.contract_id, '(auto-neutralize, then DELETE)'] },
          };
        }
        return {
          isDelete: true, skip: false, warnings: deleteWarnings,
          body: { employee_id: row.employee_id, contract_id: row.contract_id, reason: row.reason },
          preview: { contract_id: [row.contract_id, '(DELETE)'] },
        };
      }

      if (!hasContractId) {
        if (!row.employee_id || !row.contract_type || !row.start_date) {
          return { skip: true, warnings: ['New contract missing employee_id/contract_type/start_date - skipped.'] };
        }
        const isoStart = toIsoDate_(row.start_date);
        return {
          isNew: true, skip: false,
          warnings: ['Confirmed via real DevTools capture: start_date in ISO format + a computed start_date_hijri + month as 0 (not null).'],
          body: {
            employee_id: row.employee_id,
            contract: {
              file: '', contract_type: row.contract_type, start_date: isoStart, start_date_hijri: toHijri_(isoStart),
              auto_renewal: toBool_(row.auto_renewal), contract_period: orNull_(row.contract_period),
              indefinitable: toBool_(row.indefinitable), month: row.month ? Number(row.month) : 0,
              reminder_period: orNull_(row.reminder_period), effective_date: todayIso,
            },
          },
          preview: {
            contract_type: ['(new)', row.contract_type],
            start_date: ['(new)', isoStart],
            contract_period: ['(new)', row.contract_period || ''],
            auto_renewal: ['(new)', String(toBool_(row.auto_renewal))],
            indefinitable: ['(new)', String(toBool_(row.indefinitable))],
            reminder_period: ['(new)', row.reminder_period || ''],
          },
        };
      }

      if (!row.reason) {
        return { skip: true, warnings: ['Editing a contract requires a "reason" - skipped.'] };
      }
      const editWarnings = ['Echoed start/end dates have a known discrepancy vs. what was submitted - verify manually after running.'];
      return {
        isNew: false, skip: false,
        warnings: editWarnings,
        body: {
          employee_id: row.employee_id, contract_id: row.contract_id,
          contract: {
            id: Number(row.contract_id), contract_type: row.contract_type, contract_type_i18n: row.contract_type,
            start_date: row.start_date,
            auto_renewal: toBool_(row.auto_renewal), contract_period: orNull_(row.contract_period),
            contract_period_i18n: orNull_(row.contract_period),
            indefinitable: toBool_(row.indefinitable), month: orNull_(row.month),
            reminder_period: orNull_(row.reminder_period), reason: row.reason, effective_date: todayIso,
          },
        },
        preview: {
          contract_type: ['(current)', row.contract_type],
          start_date: ['(current)', row.start_date],
          contract_period: ['(current)', row.contract_period || ''],
          auto_renewal: ['(current)', String(toBool_(row.auto_renewal))],
          indefinitable: ['(current)', String(toBool_(row.indefinitable))],
          reminder_period: ['(current)', row.reminder_period || ''],
          reason: ['(required)', row.reason],
        },
      };
    },

    async applyPlan(plan) {
      if (plan.isDelete && plan.preStep) {
        const editBody = {
          id: Number(plan.body.contract_id), contract_type: plan.preStep.contract_type,
          contract_type_i18n: plan.preStep.contract_type_i18n, start_date: plan.preStep.start_date,
          auto_renewal: plan.preStep.auto_renewal, contract_period: plan.preStep.contract_period,
          contract_period_i18n: plan.preStep.contract_period_i18n, indefinitable: plan.preStep.indefinitable,
          month: plan.preStep.month, reminder_period: plan.preStep.reminder_period,
          reason: plan.preStep.reason, effective_date: plan.preStep.effective_date,
        };
        const editRes = await apiPut_(`/v2/employees/${plan.body.employee_id}/employee_contracts/${plan.body.contract_id}`, { employee_contract: editBody });
        console.log('[Jisr Bulk Ops] pre-delete fix-up edit response:', editRes.status, editRes.data);
        const editVerdict = writeSucceeded_(editRes);
        if (!editVerdict.ok) return { ok: false, reason: 'Fix-up edit failed (delete not attempted): ' + editVerdict.reason };

        await sleep_(1500);

        const delRes = await apiRequest_('DELETE', `/v2/employees/${plan.body.employee_id}/employee_contracts/${plan.body.contract_id}`,
          { body: { reason: plan.body.reason, notifier_ids: [] } });
        console.log('[Jisr Bulk Ops] contract delete response (after fix-up):', delRes.status, delRes.data);
        const delVerdict = writeSucceeded_(delRes);
        return delVerdict.ok ? { ok: true, reason: null } : { ok: false, reason: 'Fix-up edit succeeded but delete still failed: ' + delVerdict.reason };
      }
      if (plan.isDelete) {
        const res = await apiRequest_('DELETE', `/v2/employees/${plan.body.employee_id}/employee_contracts/${plan.body.contract_id}`,
          { body: { reason: plan.body.reason, notifier_ids: [] } });
        console.log('[Jisr Bulk Ops] contract delete response:', res.status, res.data);
        const verdict = writeSucceeded_(res);
        return verdict.ok ? { ok: true, reason: null } : { ok: false, reason: verdict.reason };
      }
      if (plan.isNew) {
        const res = await apiPost_(`/v2/employees/${plan.body.employee_id}/employee_contracts/`, { employee_contract: plan.body.contract });
        console.log('[Jisr Bulk Ops] contract create response:', res.status, res.data);
        const verdict = writeSucceeded_(res);
        return verdict.ok ? { ok: true, reason: null } : { ok: false, reason: verdict.reason };
      }
      const res = await apiPut_(`/v2/employees/${plan.body.employee_id}/employee_contracts/${plan.body.contract_id}`, { employee_contract: plan.body.contract });
      console.log('[Jisr Bulk Ops] contract edit response:', res.status, res.data);
      const verdict = writeSucceeded_(res);
      return verdict.ok ? { ok: true, reason: null } : { ok: false, reason: verdict.reason };
    },

    async neutralizeActiveContract(toApplyRows) {
      const activeRow = toApplyRows.find((p) =>
        !p.isNew && !p.isDelete && /^active$/i.test(String(p.row.status || '').trim()));
      if (!activeRow) return null;

      const neutralBody = {
        id: Number(activeRow.row.contract_id), contract_type: 'Fixed term', contract_type_i18n: 'Fixed term',
        start_date: safeNeutralizeStartDate_(), contract_period: '1 year', contract_period_i18n: '1 year',
        auto_renewal: false, indefinitable: false, month: 0, reminder_period: '90_days',
        reason: 'Temporary neutralization before batch edit (Jisr Bulk Ops)',
        effective_date: new Date().toISOString().slice(0, 10),
      };
      const res = await apiPut_(`/v2/employees/${activeRow.row.employee_id}/employee_contracts/${activeRow.row.contract_id}`,
        { employee_contract: neutralBody });
      console.log('[Jisr Bulk Ops] neutralize-active-contract response:', res.status, res.data);
      const verdict = writeSucceeded_(res);
      return { ok: verdict.ok, reason: verdict.reason, contractId: activeRow.row.contract_id };
    },
  };

  // ===========================================================================
  // MODULE: Change Joining Date
  // ===========================================================================
  const JoiningDateModule = {
    key: 'joining_date',
    label: 'Change Joining Date (org-level, separate from contracts)',
    editableHeaders: ['id', 'new_joining_date', 'reason'],
    readableHeaders: [],
    get csvHeaders() { return this.editableHeaders; },
    noExport: true,

    async fetchAll() { return []; },
    toRow() { return {}; },

    buildPlanForRow(row) {
      if (!row.id || !row.new_joining_date || !row.reason) {
        return { isNew: false, skip: true, warnings: ['Missing id/new_joining_date/reason - skipped.'] };
      }
      return {
        isNew: false, skip: false,
        warnings: ['Response cannot be verified from the API body (documented gap) - re-check the employee record after running.'],
        body: { id: Number(row.id), new_joining_date: row.new_joining_date, reason: row.reason },
        preview: { joining_date: ['(current unknown)', row.new_joining_date] },
      };
    },

    async applyPlan(plan) {
      const res = await apiPost_(`/v2/employees/${plan.body.id}/employee_information/organization_changes`, {
        organization_changes: {
          organization_changeset: { joining_date: plan.body.new_joining_date, joining_date_hijri: null },
          effective_date: plan.body.new_joining_date,
          reason: plan.body.reason,
          sync_gosi: false,
          without_retroactive: false,
        },
      });
      console.log('[Jisr Bulk Ops] joining_date write response:', res.status, res.data);
      const verdict = writeSucceeded_(res);
      return verdict.ok ? { ok: true, reason: null } : { ok: false, reason: verdict.reason };
    },
  };

  // ===========================================================================
  // MODULE: Salary Increment
  // ===========================================================================
  const SalaryIncrementModule = {
    key: 'salary_increment',
    label: 'Salary Increment',
    editableHeaders: ['employee_id', 'new_basic_salary', 'effective_date', 'reason', 'without_retroactive'],
    readableHeaders: ['current_basic_salary', 'employee_code', 'employee_name', 'national_id'],
    get csvHeaders() { return this.editableHeaders.concat(this.readableHeaders); },
    needsIdList: true,

    async fetchAllForIds(employeeIds) {
      let directoryById = {};
      try {
        const dirRes = await apiGet_('/v2/employees/get_all');
        (extractArray_(dirRes.data) || []).forEach((e) => { directoryById[e.id] = e; });
      } catch (e) { /* اختياري - نكمل حتى لو فشل */ }

      const rows = [];
      for (const empId of employeeIds) {
        const dirEntry = directoryById[empId] || {};
        let currentSalary = '';
        try {
          const res = await apiGet_(`/v2/employees/${empId}`, { profile_tab: 'salary_and_financial' });
          console.log('[Jisr Bulk Ops] salary read for ' + empId + ':', res.data);
          const rec = extractRecord_(res.data) || {};
          currentSalary = rec.basic_salary ||
            (rec.salary_information && rec.salary_information.basic_salary) ||
            (rec.financial_information && rec.financial_information.basic_salary) || '';
        } catch (e) {
          console.log('[Jisr Bulk Ops] salary read failed for ' + empId + ':', e.message);
        }
        rows.push({
          employee_id: empId, new_basic_salary: '', effective_date: '', reason: '', without_retroactive: '',
          current_basic_salary: currentSalary,
          employee_code: dirEntry.code || dirEntry.employee_code || '',
          employee_name: dirEntry.full_name || dirEntry.name || '',
          national_id: (dirEntry.identification_info && dirEntry.identification_info.document_number) ||
            (dirEntry.identification_info_attributes && dirEntry.identification_info_attributes.document_number) ||
            dirEntry.national_id || dirEntry.document_number || '',
        });
        await sleep_(200);
      }
      return rows;
    },

    buildPlanForRow(row) {
      if (!row.employee_id || !row.new_basic_salary || !row.effective_date || !row.reason) {
        return { skip: true, warnings: ['Missing employee_id/new_basic_salary/effective_date/reason - skipped.'] };
      }
      return {
        skip: false, warnings: ['Current-salary read is best-effort (field path unconfirmed) - always double-check the new value applied correctly after running.'],
        body: {
          employee_id: row.employee_id,
          basic_salary: row.new_basic_salary, benefits: [], earnings_action: 'appraisal',
          effective_date: row.effective_date, reason: row.reason,
          without_retroactive: toBool_(row.without_retroactive), sync_gosi: false,
        },
        preview: {
          basic_salary: [row.current_basic_salary || '(unknown)', row.new_basic_salary],
          effective_date: ['-', row.effective_date],
        },
      };
    },

    async applyPlan(plan) {
      const res = await apiPost_(`/v2/finance/employees/${plan.body.employee_id}/earnings`, {
        basic_salary: plan.body.basic_salary, benefits: plan.body.benefits, earnings_action: plan.body.earnings_action,
        effective_date: plan.body.effective_date, reason: plan.body.reason,
        without_retroactive: plan.body.without_retroactive, sync_gosi: plan.body.sync_gosi,
      });
      console.log('[Jisr Bulk Ops] salary increment response:', res.status, res.data);
      const verdict = writeSucceeded_(res);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      if (res.data && res.data.data && res.data.data.gosi_error) {
        return { ok: false, reason: 'Saved but GOSI sync reported an error: ' + JSON.stringify(res.data.data.gosi_error) };
      }
      return { ok: true, reason: null };
    },
  };

  // ===========================================================================
  // MODULE: GOSI Applicable Amount
  // ===========================================================================
  const GosiAmountModule = {
    key: 'gosi_amount',
    label: 'GOSI Applicable Amount',
    editableHeaders: ['employee_id', 'new_gosi_applicable_amount', 'effective_date', 'reason'],
    readableHeaders: ['gosi_configuration_value', 'employee_code', 'employee_name', 'national_id'],
    get csvHeaders() { return this.editableHeaders.concat(this.readableHeaders); },
    needsIdList: true,

    async fetchAllForIds(employeeIds) {
      let directoryById = {};
      try {
        const dirRes = await apiGet_('/v2/employees/get_all');
        (extractArray_(dirRes.data) || []).forEach((e) => { directoryById[e.id] = e; });
      } catch (e) { /* اختياري */ }

      const rows = [];
      for (const empId of employeeIds) {
        const dirEntry = directoryById[empId] || {};
        let gosiConfigValue = '';
        try {
          const res = await apiGet_(`/v2/employees/${empId}/employee_information/compensation_changes/histories`);
          console.log('[Jisr Bulk Ops] compensation history for ' + empId + ':', res.data);
          const arr = extractArray_(res.data) || [];
          const latest = arr[0] || {};
          gosiConfigValue = (latest.gosi_configuration && latest.gosi_configuration.value) || '';
        } catch (e) {
          console.log('[Jisr Bulk Ops] compensation history read failed for ' + empId + ':', e.message);
        }
        rows.push({
          employee_id: empId, new_gosi_applicable_amount: '', effective_date: '', reason: '',
          gosi_configuration_value: gosiConfigValue,
          employee_code: dirEntry.code || dirEntry.employee_code || '',
          employee_name: dirEntry.full_name || dirEntry.name || '',
          national_id: (dirEntry.identification_info && dirEntry.identification_info.document_number) ||
            (dirEntry.identification_info_attributes && dirEntry.identification_info_attributes.document_number) ||
            dirEntry.national_id || dirEntry.document_number || '',
        });
        await sleep_(200);
      }
      return rows;
    },

    buildPlanForRow(row) {
      if (!row.employee_id || !row.new_gosi_applicable_amount || !row.effective_date || !row.reason) {
        return { skip: true, warnings: ['Missing employee_id/new_gosi_applicable_amount/effective_date/reason - skipped.'] };
      }
      if (!row.gosi_configuration_value) {
        return { skip: true, warnings: ['Could not read this employee\'s gosi_configuration value (required by the write) - export again or fill it in manually if known. Skipped.'] };
      }
      return {
        skip: false, warnings: ['⚠️ Documented gap: the API response is data:null on success - this cannot be verified from the response alone. Re-check the employee record manually after running.'],
        body: {
          employee_id: row.employee_id, gosi_configuration_value: row.gosi_configuration_value,
          gosi_applicable_amount: row.new_gosi_applicable_amount,
          effective_date: row.effective_date, reason: row.reason,
        },
        preview: { gosi_applicable_amount: ['(current unknown)', row.new_gosi_applicable_amount] },
      };
    },

    async applyPlan(plan) {
      const res = await apiPost_(`/v2/employees/${plan.body.employee_id}/employee_information/compensation_changes`, {
        compensation_changes: {
          compensation_changeset: {
            gosi_configuration: { value: plan.body.gosi_configuration_value, gosi_applicable_amount: plan.body.gosi_applicable_amount },
          },
        },
        effective_date: plan.body.effective_date, reason: plan.body.reason, without_retroactive: false,
      });
      console.log('[Jisr Bulk Ops] GOSI amount response:', res.status, res.data);
      const verdict = writeSucceeded_(res);
      return verdict.ok ? { ok: true, reason: null } : { ok: false, reason: verdict.reason };
    },
  };

  // ===========================================================================
  // MODULE: Flight Ticket Policy Assignment
  // ===========================================================================
  const FlightTicketsModule = {
    key: 'flight_tickets',
    label: 'Flight Ticket Policy Assignment',
    editableHeaders: ['policy_id', 'employee_id', 'manual_adjustment_balance', 'is_all_airports_allowed', 'is_all_destinations_allowed'],
    readableHeaders: ['policy_name', 'policy_status', 'max_tickets_per_employee', 'cycle_period'],
    get csvHeaders() { return this.editableHeaders.concat(this.readableHeaders); },

    async fetchAll() {
      const res = await apiGet_('/v2/benefits_management/flight_tickets/policies');
      console.log('[Jisr Bulk Ops] flight ticket policies raw response:', res.data);
      if (!res.ok) throw new Error('Request failed (status ' + res.status + ')');
      const arr = res.data && Array.isArray(res.data.flight_ticket_policies) ? res.data.flight_ticket_policies : extractArray_(res.data);
      if (!arr) {
        const keys = res.data && typeof res.data === 'object' ? Object.keys(res.data).join(', ') : typeof res.data;
        throw new Error('Unexpected response shape. Top-level keys: [' + keys + ']');
      }
      return arr;
    },

    toRow(d) {
      return {
        policy_id: d.id, employee_id: '', manual_adjustment_balance: '',
        is_all_airports_allowed: '', is_all_destinations_allowed: '',
        policy_name: d.name_i18n || '', policy_status: d.status_i18n || '',
        max_tickets_per_employee: d.max_tickets_per_employee || '', cycle_period: d.cycle_period_i18n || '',
      };
    },

    buildPlanForRow(row) {
      if (!row.policy_id || !row.employee_id) {
        return { skip: true, warnings: ['Missing policy_id/employee_id - skipped (this export lists policies for reference; add an employee_id yourself to assign one).'] };
      }
      const hasAnyValue = row.manual_adjustment_balance || row.is_all_airports_allowed || row.is_all_destinations_allowed;
      if (!hasAnyValue) return { skip: true, warnings: ['No values to set - skipped.'] };
      return {
        skip: false, warnings: ['⚠️ Documented gap: response is data:null on success - cannot verify from the response alone. Re-check manually after running.'],
        body: {
          policy_id: row.policy_id, employee_id: row.employee_id,
          manual_adjustment_balance: row.manual_adjustment_balance ? Number(row.manual_adjustment_balance) : null,
          is_all_airports_allowed: row.is_all_airports_allowed ? toBool_(row.is_all_airports_allowed) : null,
          is_all_destinations_allowed: row.is_all_destinations_allowed ? toBool_(row.is_all_destinations_allowed) : null,
        },
        preview: { manual_adjustment_balance: ['(current unknown)', row.manual_adjustment_balance || '(unchanged)'] },
      };
    },

    async applyPlan(plan) {
      const res = await apiPut_(`/v2/benefits_management/flight_tickets/policies/${plan.body.policy_id}/employees/${plan.body.employee_id}`, {
        flight_ticket_policy_employee: {
          manual_adjustment_balance: plan.body.manual_adjustment_balance,
          is_all_airports_allowed: plan.body.is_all_airports_allowed,
          is_all_destinations_allowed: plan.body.is_all_destinations_allowed,
        },
      });
      console.log('[Jisr Bulk Ops] flight ticket policy write response:', res.status, res.data);
      const verdict = writeSucceeded_(res);
      return verdict.ok ? { ok: true, reason: null } : { ok: false, reason: verdict.reason };
    },
  };

  // ===========================================================================
  // MODULE: Role Assignment
  // ===========================================================================
  const RoleAssignmentModule = {
    key: 'role_assignment',
    label: 'Role Assignment (Assign/Revoke)',
    editableHeaders: ['role_id', 'employee_ids', 'action'],
    readableHeaders: ['role_name'],
    get csvHeaders() { return this.editableHeaders.concat(this.readableHeaders); },

    async fetchAll() {
      const res = await apiGet_('/v2/roles', { search: '', 'filter[is_default]': '' });
      console.log('[Jisr Bulk Ops] roles raw response:', res.data);
      if (!res.ok) throw new Error('Request failed (status ' + res.status + ')');
      const arr = extractArray_(res.data);
      if (!arr) {
        const keys = res.data && typeof res.data === 'object' ? Object.keys(res.data).join(', ') : typeof res.data;
        throw new Error('Unexpected response shape. Top-level keys: [' + keys + ']');
      }
      return arr;
    },

    toRow(d) {
      return { role_id: d.id, employee_ids: '', action: '', role_name: d.name || d.name_i18n || '' };
    },

    buildPlanForRow(row) {
      const action = String(row.action || '').trim().toLowerCase();
      if (!row.role_id || !row.employee_ids || !['assign', 'revoke'].includes(action)) {
        return { skip: true, warnings: ['Missing role_id/employee_ids, or action must be exactly "assign" or "revoke" - skipped.'] };
      }
      const ids = row.employee_ids.split('|').map((s) => s.trim()).filter(Boolean).map(Number);
      return {
        skip: false, isRevoke: action === 'revoke', warnings: [],
        body: { role_id: Number(row.role_id), employee_ids: ids },
        preview: { action: ['-', action], employee_ids: ['-', ids.join(', ')] },
      };
    },

    async applyPlan(plan) {
      if (plan.isRevoke) {
        const employee_role = plan.body.employee_ids.map((eid) => ({ employee_id: eid, role_id: plan.body.role_id }));
        let res = await apiRequest_('DELETE', '/v2/employee_roles/revoke', { body: { employee_role } });
        if (res.status === 422) {
          console.log('[Jisr Bulk Ops] revoke DELETE got 422, retrying as POST with override header');
          res = await apiRequest_('POST', '/v2/employee_roles/revoke', {
            body: { employee_role }, headers: { 'X-HTTP-Method-Override': 'DELETE' },
          });
        }
        console.log('[Jisr Bulk Ops] role revoke response:', res.status, res.data);
        const verdict = writeSucceeded_(res);
        return verdict.ok ? { ok: true, reason: null } : { ok: false, reason: verdict.reason };
      }
      const res = await apiPost_(`/v2/employee_roles/roles/${plan.body.role_id}/assign_employees`, {
        item_ids: plan.body.employee_ids, item_type: 'employee',
      });
      console.log('[Jisr Bulk Ops] role assign response:', res.status, res.data);
      const verdict = writeSucceeded_(res);
      return verdict.ok ? { ok: true, reason: null } : { ok: false, reason: verdict.reason };
    },
  };

  // ===========================================================================
  // MODULE: Payroll Reconciliation (read-only)
  // ===========================================================================
  const PayrollReconciliationModule = {
    key: 'payroll_reconciliation',
    label: 'Payroll Reconciliation (read-only)',
    editableHeaders: [],
    readableHeaders: ['id', 'name', 'status', 'employees_count', 'total_net_salary'],
    get csvHeaders() { return this.readableHeaders; },

    async fetchAll() {
      const res = await apiGet_('/v2/finance/paygroups/landing_page', { rpp: 50 });
      console.log('[Jisr Bulk Ops] paygroups landing page raw response:', res.data);
      if (!res.ok) throw new Error('Request failed (status ' + res.status + ')');
      const arr = extractArray_(res.data);
      if (!arr) {
        const keys = res.data && typeof res.data === 'object' ? Object.keys(res.data).join(', ') : typeof res.data;
        throw new Error('Unexpected response shape. Top-level keys: [' + keys + ']');
      }
      return arr;
    },

    toRow(d) {
      return {
        id: d.id, name: d.name || '', status: d.status || d.status_i18n || '',
        employees_count: d.employees_count || '', total_net_salary: d.total_net_salary || '',
      };
    },

    buildPlanForRow() { return { skip: true, warnings: ['This module is read-only (no write endpoints documented) - export only.'] }; },
    async applyPlan() { return { ok: false, reason: 'Read-only module - nothing to apply.' }; },
  };

  // ===========================================================================
  // MODULE: Employee Groups
  // ===========================================================================
  const GroupsModule = {
    key: 'groups',
    label: 'Employee Groups',
    editableHeaders: ['id', 'name', 'name_ar', 'manager_id', 'delete'],
    readableHeaders: ['status', 'group_scope', 'manager_national_id'],
    get csvHeaders() { return this.editableHeaders.concat(this.readableHeaders); },

    async fetchAll() {
      let all = [];
      let page = 1;
      for (let guard = 0; guard < 30; guard++) {
        const res = await apiGet_('/v2/common/groups', { page, per_page: 100 });
        console.log('[Jisr Bulk Ops] groups page ' + page + ':', res.data);
        if (!res.ok) throw new Error('Request failed (status ' + res.status + ')');
        const data = res.data && res.data.data;
        const groups = data && data.groups;
        if (!Array.isArray(groups)) {
          const keys = res.data && typeof res.data === 'object' ? Object.keys(res.data).join(', ') : typeof res.data;
          throw new Error('Unexpected response shape. Top-level keys: [' + keys + ']');
        }
        all = all.concat(groups);
        const pagination = data.pagination;
        if (!pagination || !pagination.next_page || pagination.next_page <= page) break;
        page = pagination.next_page;
        await sleep_(200);
      }
      try {
        const dirRes = await apiGet_('/v2/employees/get_all');
        this._employeeDirectory = {};
        (extractArray_(dirRes.data) || []).forEach((e) => { this._employeeDirectory[e.id] = e; });
      } catch (e) {
        this._employeeDirectory = {};
      }
      return all;
    },

    toRow(d) {
      const primaryManager = Array.isArray(d.group_managers)
        ? (d.group_managers.find((m) => m.is_primary) || d.group_managers[0]) : null;
      const managerId = primaryManager ? primaryManager.employee_id : '';
      const managerDir = (this._employeeDirectory && managerId && this._employeeDirectory[managerId]) || {};
      return {
        id: d.id, name: d.name || '', name_ar: d.name_ar || '', manager_id: managerId, delete: '',
        status: d.status || '', group_scope: d.group_scope || '',
        manager_national_id: (managerDir.identification_info && managerDir.identification_info.document_number) ||
          (managerDir.identification_info_attributes && managerDir.identification_info_attributes.document_number) ||
          managerDir.national_id || managerDir.document_number || '',
      };
    },

    buildPlanForRow(row, currentById) {
      const isNew = !row.id || String(row.id).trim() === '';
      const wantsDelete = /^(true|1|yes)$/i.test(String(row.delete || '').trim());

      if (isNew) {
        if (wantsDelete) return { skip: true, warnings: ['Cannot delete a row with no id - skipped.'] };
        if (!row.name || !row.name_ar) return { skip: true, warnings: ['New group missing name/name_ar - skipped.'] };
        return {
          isNew: true, skip: false,
          warnings: ['New group created with no membership rules (applies to nobody) - set real filter conditions in Jisr\'s own UI afterward.'],
          body: {
            name: row.name, name_ar: row.name_ar, group_scope: 'general', is_applicable_to_all: false, description: null,
            filter_config: { include: { conditions: [], expression: '' } },
            group_managers_attributes: row.manager_id ? [{ employee_id: Number(row.manager_id), is_primary: true }] : [],
          },
          preview: { name: ['(new)', row.name], name_ar: ['(new)', row.name_ar] },
        };
      }

      const current = currentById[row.id];
      if (!current) return { skip: true, warnings: [`id ${row.id} not found - skipped.`] };

      if (wantsDelete) {
        return {
          isDelete: true, skip: false, warnings: ['This group will be ARCHIVED (Jisr\'s equivalent of delete).'],
          body: { id: Number(row.id) },
          preview: { id: [row.id, '(ARCHIVE)'] },
        };
      }

      const currentRow = this.toRow(current);
      const newName = row.name || currentRow.name;
      const newNameAr = row.name_ar || currentRow.name_ar;
      const newManagerId = row.manager_id || currentRow.manager_id;
      if (newName === currentRow.name && newNameAr === currentRow.name_ar && String(newManagerId) === String(currentRow.manager_id)) {
        return { skip: true, warnings: ['No change detected - skipped.'] };
      }
      return {
        isNew: false, skip: false,
        warnings: ['Only name/name_ar/manager are editable here - membership rules/scope/description are preserved unchanged from the current record.'],
        body: {
          id: Number(row.id), name: newName, name_ar: newNameAr,
          group_scope: current.group_scope, is_applicable_to_all: current.is_applicable_to_all,
          description: current.description, filter_config: current.filter_config,
          group_managers_attributes: newManagerId ? [{ employee_id: Number(newManagerId), is_primary: true }] : [],
        },
        preview: {
          name: [currentRow.name, newName], name_ar: [currentRow.name_ar, newNameAr],
          manager_id: [currentRow.manager_id, newManagerId],
        },
      };
    },

    async applyPlan(plan) {
      if (plan.isDelete) {
        const res = await apiPut_(`/v2/common/groups/${plan.body.id}/archive`);
        console.log('[Jisr Bulk Ops] group archive response:', res.status, res.data);
        const verdict = writeSucceeded_(res);
        return verdict.ok ? { ok: true, reason: null } : { ok: false, reason: verdict.reason };
      }
      const res = plan.isNew
        ? await apiPost_('/v2/common/groups', { group: plan.body })
        : await apiPut_(`/v2/common/groups/${plan.body.id}`, { group: plan.body });
      console.log('[Jisr Bulk Ops] group write response:', res.status, res.data);
      const verdict = writeSucceeded_(res);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      const echoed = extractRecord_(res.data);
      if (echoed && (String(echoed.name) !== String(plan.body.name) || String(echoed.name_ar) !== String(plan.body.name_ar))) {
        return { ok: false, reason: `server returned success but echoed record doesn't match (got name="${echoed.name}")` };
      }
      return { ok: true, reason: null };
    },
  };

  // ===========================================================================
  // MODULE: Business Units
  // ===========================================================================
  const BusinessUnitsModule = {
    key: 'business_units',
    label: 'Business Units',
    editableHeaders: ['id', 'name', 'name_ar', 'manager_id', 'delete'],
    readableHeaders: ['manager_national_id'],
    get csvHeaders() { return this.editableHeaders.concat(this.readableHeaders); },

    async fetchAll() {
      const res = await apiGet_('/v2/business_units/');
      console.log('[Jisr Bulk Ops] business units raw response:', res.data);
      if (!res.ok) throw new Error('Request failed (status ' + res.status + ')');
      const arr = extractArray_(res.data);
      if (!arr) {
        const keys = res.data && typeof res.data === 'object' ? Object.keys(res.data).join(', ') : typeof res.data;
        throw new Error('Unexpected response shape. Top-level keys: [' + keys + ']');
      }
      try {
        const dirRes = await apiGet_('/v2/employees/get_all');
        this._employeeDirectory = {};
        (extractArray_(dirRes.data) || []).forEach((e) => { this._employeeDirectory[e.id] = e; });
      } catch (e) {
        this._employeeDirectory = {};
      }
      return arr;
    },

    toRow(d) {
      const managerId = d.manager && d.manager.id !== undefined ? d.manager.id : '';
      const managerDir = (this._employeeDirectory && managerId && this._employeeDirectory[managerId]) || {};
      return {
        id: d.id, name: d.name || '', name_ar: d.name_ar || '', manager_id: managerId, delete: '',
        manager_national_id: (managerDir.identification_info && managerDir.identification_info.document_number) ||
          (managerDir.identification_info_attributes && managerDir.identification_info_attributes.document_number) ||
          managerDir.national_id || managerDir.document_number || '',
      };
    },

    buildPlanForRow(row, currentById) {
      const isNew = !row.id || String(row.id).trim() === '';
      const wantsDelete = /^(true|1|yes)$/i.test(String(row.delete || '').trim());

      if (wantsDelete) {
        if (isNew) return { skip: true, warnings: ['Cannot delete a row with no id - skipped.'] };
        return {
          isDelete: true, skip: false, warnings: ['This business unit will be DELETED.'],
          body: { id: Number(row.id) },
          preview: { id: [row.id, '(DELETE)'] },
        };
      }
      if (isNew) {
        if (!row.name || !row.name_ar) return { skip: true, warnings: ['New business unit missing name/name_ar - skipped.'] };
        return {
          isNew: true, skip: false, warnings: [],
          body: { name: row.name, name_ar: row.name_ar, manager_id: row.manager_id ? Number(row.manager_id) : null },
          preview: { name: ['(new)', row.name], name_ar: ['(new)', row.name_ar] },
        };
      }

      const current = currentById[row.id];
      if (!current) return { skip: true, warnings: [`id ${row.id} not found - skipped.`] };
      const currentRow = this.toRow(current);
      const newName = row.name || currentRow.name;
      const newNameAr = row.name_ar || currentRow.name_ar;
      const newManagerId = row.manager_id || currentRow.manager_id;
      if (newName === currentRow.name && newNameAr === currentRow.name_ar && String(newManagerId) === String(currentRow.manager_id)) {
        return { skip: true, warnings: ['No change detected - skipped.'] };
      }
      return {
        isNew: false, skip: false,
        warnings: [],
        body: {
          id: Number(row.id), name: newName, name_ar: newNameAr, name_i18n: newName,
          manager: current.manager || null,
          description: current.description !== undefined ? current.description : null,
          number_of_employees: current.number_of_employees,
          manager_id: newManagerId ? Number(newManagerId) : null,
        },
        preview: {
          name: [currentRow.name, newName], name_ar: [currentRow.name_ar, newNameAr],
          manager_id: [currentRow.manager_id, newManagerId],
        },
      };
    },

    async applyPlan(plan) {
      if (plan.isDelete) {
        const res = await apiRequest_('DELETE', `/v2/business_units/${plan.body.id}/`, { body: null });
        console.log('[Jisr Bulk Ops] business unit delete response:', res.status, res.data);
        const verdict = writeSucceeded_(res);
        return verdict.ok ? { ok: true, reason: null } : { ok: false, reason: verdict.reason };
      }
      const res = plan.isNew
        ? await apiPost_('/v2/business_units/', { business_unit: plan.body })
        : await apiPut_(`/v2/business_units/${plan.body.id}/`, { business_unit: plan.body });
      console.log('[Jisr Bulk Ops] business unit write response:', res.status, res.data);
      const verdict = writeSucceeded_(res);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      const echoed = extractRecord_(res.data);
      if (echoed && String(echoed.name) !== String(plan.body.name)) {
        return { ok: false, reason: `server returned success but echoed record doesn't match (got name="${echoed.name}")` };
      }
      return { ok: true, reason: null };
    },
  };

  // ===========================================================================
  // MODULE: Letter Template Variables (استخراج المتغيرات)
  // ---------------------------------------------------------------------------
  // الهدف: استخراج كل المتغيرات (Variables) من محرر قوالب الخطابات/الرسائل
  //        في جسر، وعرضها كـ CSV: الاسم الظاهر (عربي/إنجليزي) + الكود الفعلي.
  //
  // مثال على المخرجات:
  //   display_name     | variable_code
  //   السبب            | {{{request_reason}}}
  //   اسم الموظف       | {{{employee_name}}}
  //
  // طريقة الاستخدام:
  //   1) افتح شاشة إنشاء/تعديل قالب خطاب في جسر
  //   2) افتح قائمة "المتغيرات" في محرر النص (TinyMCE) - لا تغلقها
  //   3) من الأداة: اختر "Letter Template Variables" ثم "Export CSV"
  //      أو اضغط "نسخ المتغيرات" لعرضها في صندوق نصي للنسخ السريع
  //
  // ملاحظة: لا يوجد endpoint مؤكد رسمياً لجلب المتغيرات. الأداة تجرّب
  //         عدة طرق بالترتيب: DOM scraping → data attributes → endpoints
  //         محتملة → استخراج من محتوى القالب الحالي.
  // ===========================================================================
  const LetterVariablesModule = {
    key: 'letter_variables',
    label: 'Letter Template Variables (استخراج المتغيرات)',
    editableHeaders: [],
    readableHeaders: ['display_name', 'variable_code', 'source', 'category'],
    get csvHeaders() { return this.readableHeaders; },
    isExtractor: true,

    async fetchAll() {
      const found = [];
      const seenCodes = new Set();

      const pushVar = (displayName, code, source, category) => {
        const cleanCode = String(code || '').trim();
        if (!cleanCode || !/\{\{\{/.test(cleanCode)) return;
        const cleanName = String(displayName || '').replace(/\s+/g, ' ').trim();
        const key = cleanCode + '||' + cleanName;
        if (seenCodes.has(key)) return;
        seenCodes.add(key);
        found.push({
          display_name: cleanName,
          variable_code: cleanCode,
          source: source,
          category: category || '',
        });
      };

      // -----------------------------------------------------------------------
      // 1) Scrape من DOM — قائمة المتغيرات داخل TinyMCE (tox-menu)
      // -----------------------------------------------------------------------
      const menuItems = document.querySelectorAll(
        '.tox-menu .tox-collection__item, .tox-collection__item[role="menuitem"], [class*="tox-collection__item"]'
      );
      console.log('[Jisr Bulk Ops] letter_variables: found', menuItems.length, 'menu items in DOM');

      menuItems.forEach((el) => {
        const textEl = el.querySelector('.tox-collection__item-label, span');
        let displayName = (textEl ? textEl.textContent : el.textContent) || '';
        displayName = displayName.replace(/\s+/g, ' ').trim();

        let code = '';
        const htmlDump = el.outerHTML || '';
        const codeMatch = htmlDump.match(/\{\{\{[^}]+\}\}\}/);
        if (codeMatch) code = codeMatch[0];

        if (!code) {
          for (const attr of el.attributes) {
            if (/data-/.test(attr.name) && /\{\{\{/.test(attr.value)) {
              const m = attr.value.match(/\{\{\{[^}]+\}\}\}/);
              if (m) { code = m[0]; break; }
            }
          }
        }
        if (!code && el.title) {
          const m = el.title.match(/\{\{\{[^}]+\}\}\}/);
          if (m) code = m[0];
        }

        if (code) pushVar(displayName, code, 'dom_menu', '');
      });

      // -----------------------------------------------------------------------
      // 2) Scrape من data attributes (data-code/data-variable/...)
      // -----------------------------------------------------------------------
      document.querySelectorAll('[data-code], [data-variable], [data-merge-tag], [data-token]').forEach((el) => {
        const candidates = [el.getAttribute('data-code'), el.getAttribute('data-variable'),
                            el.getAttribute('data-merge-tag'), el.getAttribute('data-token')];
        candidates.forEach((c) => {
          if (!c) return;
          const m = String(c).match(/\{\{\{[^}]+\}\}\}/);
          if (m) pushVar(el.textContent || '', m[0], 'data_attr', '');
          else if (/^[a-z_][a-z0-9_]*$/i.test(String(c).trim())) {
            pushVar(el.textContent || '', '{{{' + String(c).trim() + '}}}', 'data_attr', '');
          }
        });
      });

      // -----------------------------------------------------------------------
      // 3) خطة احتياطية: محاولة endpoints محتملة على API جسر
      // -----------------------------------------------------------------------
      const candidateEndpoints = [
        '/v2/letters/variables',
        '/v2/letters/letter_variables',
        '/v2/letter_templates/variables',
        '/v2/workflow/letters/variables',
        '/v2/workflow/letters/letter_templates/variables',
        '/v2/communication/letters/variables',
        '/v2/document_templates/variables',
      ];

      for (const path of candidateEndpoints) {
        try {
          const res = await apiGet_(path);
          if (!res.ok) continue;
          const arr = extractArray_(res.data);
          if (!arr || arr.length === 0) continue;
          console.log('[Jisr Bulk Ops] letter_variables: got data from', path, arr);
          arr.forEach((v) => {
            const displayName = v.name_ar || v.name || v.label || v.display_name || v.title || '';
            let code = v.code || v.key || v.variable || v.value || v.token || v.placeholder || '';
            if (code && !/^\{\{\{/.test(code)) code = '{{{' + code + '}}}';
            pushVar(displayName, code, 'api:' + path, v.category || v.group || '');
          });
          if (arr.length > 0) break;
        } catch (e) { /* جرّب التالي */ }
      }

      // -----------------------------------------------------------------------
      // 4) استخراج من محتوى القالب الحالي (iframe الخاص بـ TinyMCE)
      // -----------------------------------------------------------------------
      try {
        const iframes = document.querySelectorAll('.tox-edit-area iframe, .mce-edit-area iframe, iframe[title*="Rich Text"], iframe[title*="rich text"]');
        iframes.forEach((iframe) => {
          try {
            const bodyHtml = iframe.contentDocument && iframe.contentDocument.body ? iframe.contentDocument.body.innerHTML : '';
            const matches = bodyHtml.match(/\{\{\{[^}]+\}\}\}/g) || [];
            matches.forEach((m) => pushVar('(used in current template)', m, 'current_template', ''));
          } catch (e) { /* cross-origin - تجاهل */ }
        });
      } catch (e) { /* مفيش محرر - تجاهل */ }

      console.log('[Jisr Bulk Ops] letter_variables: total extracted =', found.length, found);
      return found;
    },

    toRow(d) {
      return {
        display_name: d.display_name || '',
        variable_code: d.variable_code || '',
        source: d.source || '',
        category: d.category || '',
      };
    },

    buildPlanForRow() {
      return { skip: true, warnings: ['وحدة قراءة فقط (Read-only) - استخدم Export CSV أو "نسخ المتغيرات".'] };
    },
    async applyPlan() { return { ok: false, reason: 'Read-only module.' }; },
  };

  // ===========================================================================
  // Module registry
  // ===========================================================================
  const MODULES = [
    DepartmentsModule, JobTitlesModule, EmployeeCodeModule, GroupsModule, BusinessUnitsModule,
    AreasModule, LocationsModule, EmployeeContractsModule, JoiningDateModule,
    SalaryIncrementModule, GosiAmountModule, FlightTicketsModule, RoleAssignmentModule,
    PayrollReconciliationModule,
    LetterVariablesModule,
  ];

  // ===========================================================================
  // Generic engine
  // ===========================================================================
  async function buildFullPlan_(mod, csvRows) {
    const current = (mod.needsIdList || mod.noExport) ? [] : await mod.fetchAll();
    const byId = {};
    current.forEach((r) => { byId[r.id] = r; });
    return csvRows.map((row) => Object.assign({ row }, mod.buildPlanForRow(row, byId)));
  }

  function rowLabel_(p) {
    if (p.isNew) return '(new)';
    if (p.row.id) return 'id ' + p.row.id;
    if (p.row.employee_id) return 'employee ' + p.row.employee_id + (p.row.contract_id ? '/contract ' + p.row.contract_id : '');
    return '(row)';
  }

  function renderDryRun_(plan) {
    const toApply = plan.filter((p) => !p.skip);
    const toSkip = plan.filter((p) => p.skip);
    let html = `<b>${toApply.length} row(s) will be applied, ${toSkip.length} will be skipped.</b>`;
    if (toSkip.length > 0) {
      const reasonCounts = {};
      toSkip.forEach((p) => {
        const reason = (p.warnings && p.warnings[0]) || 'skipped';
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      });
      html += '<div style="margin-top:6px;padding:8px;background:#fff8e6;border:1px solid #fde68a;border-radius:6px;">' +
        '<b>⚠️ Why rows are skipped:</b><br>' +
        Object.entries(reasonCounts).map(([reason, count]) => `• (${count}) ${reason}`).join('<br>') +
        '</div>';
    }
    html += '<br><br>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
    html += '<tr style="background:#f5f5f5;"><th style="text-align:left;padding:6px;">Row</th><th style="text-align:left;padding:6px;">Change</th><th style="text-align:left;padding:6px;">Notes</th></tr>';
    for (const p of plan) {
      const label = rowLabel_(p);
      const summary = p.skip
        ? (p.warnings[0] || 'skipped')
        : Object.entries(p.preview).filter(([, [a, b]]) => String(a) !== String(b))
            .map(([k, [a, b]]) => `${k}: "${a}" → "${b}"`).join('<br>');
      const notes = (p.warnings || []).join('<br>');
      const rowBg = p.skip ? '#fafafa' : (p.isDelete ? '#fdecec' : '#f0f9f0');
      const rowColor = p.skip ? '#999' : '#222';
      html += `<tr style="border-bottom:1px solid #eee;background:${rowBg};color:${rowColor};">` +
        `<td style="padding:6px;">${label}</td><td style="padding:6px;">${summary}</td><td style="padding:6px;color:#b8860b;">${notes}</td></tr>`;
    }
    html += '</table>';
    return html;
  }

  let lastDryRunPlan = null;
  let lastDryRunFileName = null;
  let lastDryRunModuleKey = null;

  function currentModule() {
    const sel = document.getElementById('jisrModuleSelect');
    return MODULES.find((m) => m.key === sel.value) || MODULES[0];
  }

  function setStatus_(html) {
    const el = document.getElementById('jisrStatus');
    if (!el) return;
    el.innerHTML = html;
    el.className = '';
    if (/^✅|Done\. \d+ ok, 0 failed/.test(html)) el.className = 'jisr-status-ok';
    else if (/^❌|Done\. 0 ok|Done\. \d+ ok, [1-9]/.test(html)) el.className = 'jisr-status-fail';
    else if (/^ℹ️/.test(html)) el.className = 'jisr-status-info';
    else if (html) el.className = 'jisr-status-progress';
  }

  async function handleExportEverything_() {
    setStatus_('⏳ Exporting everything - this can take a few minutes...');
    const results = [];
    let i = 0;
    for (const mod of MODULES) {
      i++;
      if (mod.needsIdList) {
        results.push({ key: mod.key, ok: null, note: 'skipped (needs an employee-ID-list file - use it individually)' });
        continue;
      }
      setStatus_(`⏳ Exporting ${i}/${MODULES.length}: ${mod.label}...`);
      try {
        if (mod.noExport) {
          results.push({ key: mod.key, ok: null, note: 'skipped (no list-all endpoint for this module)' });
          continue;
        }
        const records = await mod.fetchAll();
        const byId = {};
        records.forEach((r) => { byId[r.id] = r; });
        const rows = records.map((r) => mod.toRow(r, byId));
        const csv = toCsv_(rows, mod.csvHeaders);
        downloadCsv_(`${mod.key}_export.csv`, csv);
        results.push({ key: mod.key, ok: true, note: `${rows.length} rows` });
        logActivity_(mod.key, 'export', `${rows.length} rows (from Export Everything)`, true);
      } catch (e) {
        results.push({ key: mod.key, ok: false, note: e.message });
        logActivity_(mod.key, 'export', String(e.message) + ' (from Export Everything)', false);
      }
      await sleep_(800);
    }
    const summary = results.map((r) => {
      const icon = r.ok === true ? '✅' : r.ok === false ? '❌' : 'ℹ️';
      return `${icon} ${r.key}: ${r.note}`;
    }).join('<br>');
    setStatus_(`Done exporting everything.<br>${summary}`);
  }

  // ---------------------------------------------------------------------------
  // نسخ المتغيرات كـ نص (للوحدة الجديدة فقط)
  // ---------------------------------------------------------------------------
  async function handleCopyVariables_() {
    const mod = currentModule();
    if (!mod.isExtractor) {
      alert('هذا الزر مخصص لوحدة "Letter Template Variables" فقط. اخترها من القائمة أولاً.');
      return;
    }
    setStatus_('⏳ جاري استخراج المتغيرات...');
    try {
      const records = await mod.fetchAll();
      if (records.length === 0) {
        setStatus_('❌ لم يتم العثور على أي متغيرات. تأكد من فتح قائمة "المتغيرات" في محرر الخطاب أولاً، أو افتح قالباً يحتوي متغيرات.');
        return;
      }

      // جدول نصي بسيط: الاسم الظاهر ثم الكود الفعلي
      const lines = records.map((r) => {
        const name = r.display_name || '(بدون اسم)';
        const code = r.variable_code || '';
        return `${name}\t${code}`;
      });
      const text = 'الاسم الظاهر\tالكود الفعلي\n' + lines.join('\n');

      // عرض في صندوق نصي منبثق
      showVariablesPopup_(text, records.length);
      setStatus_(`✅ تم استخراج ${records.length} متغير. انسخهم من الصندوق الظاهر.`);
      logActivity_(mod.key, 'extract_variables', `${records.length} variables copied`, true);
    } catch (e) {
      setStatus_('❌ فشل الاستخراج: ' + e.message);
      logActivity_(mod.key, 'extract_variables', String(e.message), false);
    }
  }

  function showVariablesPopup_(text, count) {
    const existing = document.getElementById('jisrVarsPopup');
    if (existing) existing.remove();

    const popup = document.createElement('div');
    popup.id = 'jisrVarsPopup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:100000;' +
      'background:#fff;border:2px solid #2563eb;border-radius:10px;padding:16px;' +
      'box-shadow:0 10px 40px rgba(0,0,0,.3);width:520px;max-width:90vw;font-family:Arial;direction:rtl;';

    popup.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <b style="font-size:15px;color:#1e40af;">المتغيرات المستخرجة (${count})</b>
        <button id="jisrVarsClose" style="border:none;background:#dc2626;color:#fff;border-radius:5px;padding:4px 10px;cursor:pointer;font-weight:bold;">✕</button>
      </div>
      <div style="font-size:12px;color:#666;margin-bottom:8px;">الاسم الظاهر ثم الكود الفعلي (مفصولين بـ Tab):</div>
      <textarea id="jisrVarsText" style="width:100%;height:280px;font-family:monospace;font-size:12px;direction:ltr;text-align:left;border:1px solid #ccc;border-radius:5px;padding:8px;" readonly></textarea>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button id="jisrVarsCopy" style="flex:1;padding:8px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">📋 نسخ الكل</button>
        <button id="jisrVarsCsv" style="flex:1;padding:8px;background:#059669;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">⬇ تحميل CSV</button>
      </div>
    `;
    document.body.appendChild(popup);

    const textarea = document.getElementById('jisrVarsText');
    textarea.value = text;

    document.getElementById('jisrVarsClose').addEventListener('click', () => popup.remove());

    document.getElementById('jisrVarsCopy').addEventListener('click', () => {
      textarea.select();
      try {
        navigator.clipboard.writeText(text);
        document.getElementById('jisrVarsCopy').textContent = '✅ تم النسخ';
        setTimeout(() => {
          const btn = document.getElementById('jisrVarsCopy');
          if (btn) btn.textContent = '📋 نسخ الكل';
        }, 1500);
      } catch (e) {
        document.execCommand('copy');
      }
    });

    document.getElementById('jisrVarsCsv').addEventListener('click', () => {
      const rows = text.split('\n').slice(1).map((line) => {
        const [name, code] = line.split('\t');
        return { display_name: name || '', variable_code: code || '' };
      });
      const csv = toCsv_(rows, ['display_name', 'variable_code']);
      downloadCsv_('letter_variables_export.csv', csv);
    });
  }

  async function handleExport_() {
    const mod = currentModule();

    // ---- الوحدة الجديدة: استخراج المتغيرات ----
    if (mod.isExtractor) {
      setStatus_('⏳ جاري استخراج المتغيرات من الصفحة...');
      try {
        const records = await mod.fetchAll();
        if (records.length === 0) {
          setStatus_('❌ لم يتم العثور على أي متغيرات. تأكد من فتح قائمة "المتغيرات" في محرر الخطاب أولاً.');
          return;
        }
        const rows = records.map((r) => mod.toRow(r));
        const csv = toCsv_(rows, mod.csvHeaders);
        downloadCsv_('letter_variables_export.csv', csv);
        setStatus_(`✅ تم تصدير ${records.length} متغير إلى letter_variables_export.csv`);
        logActivity_(mod.key, 'export', `${records.length} variables`, true);
      } catch (e) {
        setStatus_('❌ فشل الاستخراج: ' + e.message);
        logActivity_(mod.key, 'export', String(e.message), false);
      }
      return;
    }

    // ---- الوحدات اللي تحتاج قائمة معرفات موظفين ----
    if (mod.needsIdList) {
      const file = document.getElementById('jisrFileInput').files[0];
      if (!file) {
        alert('This module needs a list of employee IDs first. Choose a CSV with an "id" (or "employee_id") column in the file picker below, then click Export again.');
        return;
      }
      setStatus_('Reading employee ID list and fetching each one\'s contracts...');
      try {
        const text = await file.text();
        const idRows = parseCsv_(text);
        const ids = idRows.map((r) => r.id || r.employee_id).filter(Boolean);
        if (ids.length === 0) throw new Error('No id/employee_id column with values found in the chosen file.');
        const rows = await mod.fetchAllForIds(ids);
        const csv = toCsv_(rows, mod.csvHeaders);
        downloadCsv_(`${mod.key}_export.csv`, csv);
        setStatus_(`✅ Exported ${rows.length} row(s) for ${ids.length} employee(s).`);
        logActivity_(mod.key, 'export', `${rows.length} rows for ${ids.length} employees`, true);
      } catch (e) {
        setStatus_('❌ Export failed: ' + e.message);
        logActivity_(mod.key, 'export', String(e.message), false);
      }
      return;
    }

    // ---- وحدات بدون list endpoint ----
    if (mod.noExport) {
      const placeholderRow = {};
      mod.csvHeaders.forEach((h) => { placeholderRow[h] = ''; });
      placeholderRow[mod.csvHeaders[0]] = 'NO LIST-ALL ENDPOINT EXISTS FOR THIS MODULE - fill in rows below manually, this row is just an example, delete it before running';
      downloadCsv_(`${mod.key}_template.csv`, toCsv_([placeholderRow], mod.csvHeaders));
      setStatus_('ℹ️ No "list all" endpoint exists for this module - downloaded a blank template instead. Fill it in manually.');
      return;
    }

    // ---- الوحدات العادية ----
    setStatus_('Fetching data...');
    try {
      const records = await mod.fetchAll();
      const byId = {};
      records.forEach((r) => { byId[r.id] = r; });
      const rows = records.map((r) => mod.toRow(r, byId));
      const csv = toCsv_(rows, mod.csvHeaders);
      downloadCsv_(`${mod.key}_export.csv`, csv);
      setStatus_(`✅ Exported ${rows.length} rows.`);
      logActivity_(mod.key, 'export', `${rows.length} rows`, true);
    } catch (e) {
      setStatus_('❌ Export failed: ' + e.message);
      logActivity_(mod.key, 'export', String(e.message), false);
    }
  }

  async function handleDryRun_(file) {
    const mod = currentModule();
    setStatus_('Reading file and comparing against current data...');
    try {
      const text = await file.text();
      const rows = parseCsv_(text);
      const plan = await buildFullPlan_(mod, rows);
      lastDryRunPlan = plan;
      lastDryRunFileName = file.name;
      lastDryRunModuleKey = mod.key;
      document.getElementById('jisrDryRunOutput').innerHTML = renderDryRun_(plan);
      document.getElementById('jisrRunLiveBtn').disabled = false;
      setStatus_('✅ Dry run complete - review the table below, then "Run Live" if it looks correct.');
      logActivity_(mod.key, 'dry_run', `${rows.length} rows from ${file.name}`, true);
    } catch (e) {
      setStatus_('❌ Dry run failed: ' + e.message);
      logActivity_(mod.key, 'dry_run', String(e.message), false);
    }
  }

  async function handleRunLive_() {
    const mod = currentModule();
    if (!lastDryRunPlan || lastDryRunModuleKey !== mod.key) {
      alert('Run a Dry Run first (for the currently selected module).');
      return;
    }
    if (!confirm('This will make real changes in Jisr. Continue?')) return;

    const runLiveBtn = document.getElementById('jisrRunLiveBtn');
    const dryRunBtn = document.getElementById('jisrDryRunBtn');
    runLiveBtn.disabled = true;
    dryRunBtn.disabled = true;

    const initialToApply = lastDryRunPlan.filter((p) => !p.skip);
    if (typeof mod.neutralizeActiveContract === 'function') {
      setStatus_('⏳ Temporarily neutralizing the active contract before batch edits...');
      try {
        const neutralizeResult = await mod.neutralizeActiveContract(initialToApply);
        if (neutralizeResult) {
          if (!neutralizeResult.ok) {
            setStatus_('❌ Could not neutralize the active contract first: ' + neutralizeResult.reason + '<br>Proceeding anyway - the active row may still fail.');
            await sleep_(1500);
          } else {
            setStatus_(`✅ Contract ${neutralizeResult.contractId} temporarily set Inactive - proceeding with the batch...`);
            await sleep_(1500);
          }
        }
      } catch (e) {
        setStatus_('❌ Neutralization step failed: ' + e.message + '<br>Proceeding anyway.');
        await sleep_(1500);
      }
    }

    const MAX_PASSES = 2;
    let toApply = lastDryRunPlan.filter((p) => !p.skip);
    let ok = 0, failed = 0;
    const failMessages = [];

    for (let pass = 1; pass <= MAX_PASSES && toApply.length > 0; pass++) {
      const stillFailed = [];
      let i = 0;
      for (const p of toApply) {
        i++;
        const label = rowLabel_(p);
        const passNote = pass > 1 ? ` (retry pass ${pass})` : '';
        setStatus_(`⏳ Running ${i}/${toApply.length}${passNote}: ${label}...`);
        try {
          const result = await mod.applyPlan(p);
          if (result.ok) {
            ok++;
          } else {
            if (pass < MAX_PASSES) stillFailed.push(p);
            else failed++, failMessages.push(`${label}: ${result.reason}`);
          }
        } catch (e) {
          if (pass < MAX_PASSES) stillFailed.push(p);
          else failed++, failMessages.push(`${label}: ${e.message}`);
        }
        await sleep_(2500);
      }
      toApply = stillFailed;
      if (toApply.length > 0 && pass < MAX_PASSES) {
        setStatus_(`⏳ ${toApply.length} row(s) failed on pass ${pass} - retrying once (siblings may have just been updated)...`);
        await sleep_(1500);
      }
    }

    dryRunBtn.disabled = false;
    const detail = `${ok} ok, ${failed} failed (from ${lastDryRunFileName})`;
    setStatus_(`Done. ${detail}` + (failMessages.length ? '<br>' + failMessages.join('<br>') : ''));
    logActivity_(mod.key, 'run_live', detail, failed === 0);

    document.getElementById('jisrRunLiveBtn').disabled = true;
    lastDryRunPlan = null;
  }

  // ===========================================================================
  // UI
  // ===========================================================================
  function makeDraggable_(box, handle) {
    let dragging = false, offX = 0, offY = 0;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      offX = e.clientX - box.offsetLeft;
      offY = e.clientY - box.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      box.style.left = (e.clientX - offX) + 'px';
      box.style.top = (e.clientY - offY) + 'px';
      box.style.right = 'auto';
      box.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function buildWidget_(email) {
    const box = document.createElement('div');
    box.id = 'jisrBulkOpsBox';
    box.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;background:#fff;border:1px solid #ccc;border-radius:8px;font-family:Arial;font-size:13px;box-shadow:0 2px 10px rgba(0,0,0,.2);width:460px;max-height:78vh;overflow:hidden;display:flex;flex-direction:column;';

    box.innerHTML = `
      <div id="jisrDragHandle" style="padding:10px 12px;background:#f4f4f4;border-bottom:1px solid #ddd;display:flex;justify-content:space-between;align-items:center;border-radius:8px 8px 0 0;">
        <span style="font-weight:bold;">Jisr Bulk Ops (${email})</span>
        <button id="jisrMinimizeBtn" title="Minimize" style="border:none;background:none;font-size:16px;cursor:pointer;padding:0 6px;">—</button>
      </div>
      <div id="jisrBody" style="padding:12px;overflow:auto;">
        <div style="margin-bottom:10px;">
          <select id="jisrModuleSelect" style="padding:6px;width:100%;border-radius:5px;border:1px solid #ccc;">
            ${MODULES.map((m) => `<option value="${m.key}">${m.label}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
          <button id="jisrExportBtn" class="jisr-btn jisr-btn-export">⬇ Export CSV</button>
          <button id="jisrCopyVarsBtn" class="jisr-btn" style="background:#7c3aed;">📋 نسخ المتغيرات</button>
          <button id="jisrExportAllBtn" class="jisr-btn jisr-btn-export" style="background:#1e40af;">⬇⬇ Export Everything</button>
        </div>
        <div style="margin-bottom:10px;">
          <input type="file" id="jisrFileInput" accept=".csv" style="margin-bottom:8px;width:100%;">
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button id="jisrDryRunBtn" class="jisr-btn jisr-btn-dryrun">🔍 Dry Run</button>
            <button id="jisrRunLiveBtn" class="jisr-btn jisr-btn-live" disabled>▶ Run Live</button>
          </div>
        </div>
        <div id="jisrStatus" style="margin-bottom:10px;padding:8px 10px;border-radius:6px;background:#f7f7f7;color:#555;font-size:12px;"></div>
        <div id="jisrDryRunOutput"></div>
      </div>
    `;
    document.body.appendChild(box);

    if (!document.getElementById('jisrBulkOpsStyles')) {
      const style = document.createElement('style');
      style.id = 'jisrBulkOpsStyles';
      style.textContent = `
        .jisr-btn { padding:8px 14px; border:none; border-radius:6px; cursor:pointer; font-weight:bold; font-size:13px; color:#fff; transition:opacity .15s; }
        .jisr-btn:hover { opacity:.88; }
        .jisr-btn:disabled { background:#ccc !important; cursor:not-allowed; opacity:.7; }
        .jisr-btn-export { background:#2563eb; }
        .jisr-btn-dryrun { background:#d97706; }
        .jisr-btn-live { background:#dc2626; }
        .jisr-status-ok { background:#e6f6ea !important; color:#166534 !important; border:1px solid #86efac; }
        .jisr-status-fail { background:#fdecec !important; color:#991b1b !important; border:1px solid #fca5a5; }
        .jisr-status-info { background:#eef2ff !important; color:#3730a3 !important; border:1px solid #c7d2fe; }
        .jisr-status-progress { background:#fffbeb !important; color:#92400e !important; border:1px solid #fde68a; }
      `;
      document.head.appendChild(style);
    }

    makeDraggable_(box, document.getElementById('jisrDragHandle'));

    let minimized = false;
    document.getElementById('jisrMinimizeBtn').addEventListener('click', () => {
      minimized = !minimized;
      document.getElementById('jisrBody').style.display = minimized ? 'none' : 'block';
      document.getElementById('jisrMinimizeBtn').textContent = minimized ? '▢' : '—';
      box.style.width = minimized ? '220px' : '460px';
    });

    document.getElementById('jisrModuleSelect').addEventListener('change', () => {
      document.getElementById('jisrDryRunOutput').innerHTML = '';
      document.getElementById('jisrRunLiveBtn').disabled = true;
      lastDryRunPlan = null;
      const mod = currentModule();
      if (mod.isExtractor) {
        setStatus_('ℹ️ الخطوات: (1) افتح شاشة إنشاء قالب خطاب في جسر. (2) افتح قائمة "المتغيرات" في المحرر. (3) اضغط "📋 نسخ المتغيرات" أو "⬇ Export CSV".');
      } else if (mod.needsIdList) {
        setStatus_('ℹ️ 2 خطوات: (1) اختر ملف CSV فيه معرفات الموظفين، اضغط Export. (2) عدّل الملف، اختره ثانية، ثم Dry Run.');
      } else if (mod.noExport) {
        setStatus_('ℹ️ لا يوجد list endpoint - Export يحمّل قالب فارغ. عبّيه يدوياً.');
      } else {
        setStatus_('');
      }
    });

    document.getElementById('jisrExportBtn').addEventListener('click', handleExport_);
    document.getElementById('jisrCopyVarsBtn').addEventListener('click', handleCopyVariables_);
    document.getElementById('jisrExportAllBtn').addEventListener('click', handleExportEverything_);
    document.getElementById('jisrDryRunBtn').addEventListener('click', () => {
      const file = document.getElementById('jisrFileInput').files[0];
      if (!file) { alert('Choose a CSV file first.'); return; }
      document.getElementById('jisrRunLiveBtn').disabled = true;
      handleDryRun_(file);
    });
    document.getElementById('jisrRunLiveBtn').addEventListener('click', handleRunLive_);
  }

  const email = ensureRegistered_();
  if (email) buildWidget_(email);
})();
