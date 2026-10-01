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
        merged[key] = (row[key] !== undefined
