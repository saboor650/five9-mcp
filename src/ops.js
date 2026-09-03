// Higher-level operations composed from several Five9 calls:
//   findCalls        — "what happened to that call?" via the standard Call Log
//                      report, filtered client-side (ANI, DNIS, agent, session,
//                      campaign, disposition) so the model gets rows, not CSV.
//   bulkCreateUsers  — provision many agents/supervisors from a CSV, with a
//                      dry run that validates every row before anything is
//                      created.

import { Five9Error, toArray } from './five9.js';

// ---- CSV ----

// RFC 4180-ish parser: quoted fields, doubled quotes, CRLF/LF, trailing newline.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text ?? '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

// Rows -> objects keyed by the header line (trimmed, original case kept).
export function csvToObjects(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { columns: rows[0] || [], records: [] };
  const columns = rows[0].map((c) => String(c).trim());
  const records = rows.slice(1).map((r) => Object.fromEntries(columns.map((c, i) => [c, (r[i] ?? '').trim()])));
  return { columns, records };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- find_calls ----

const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');

// Report timestamps: Five9 wants ISO-8601 with milliseconds. Accepts an ISO
// string or a Date.
const isoOf = (d) => (d instanceof Date ? d : new Date(d)).toISOString();

export async function findCalls(f9, opts = {}) {
  const now = new Date();
  const hours = Number(opts.hours ?? 24);
  if (!opts.start && (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 31)) throw new Five9Error('hours must be between 0 and 744 (31 days), or pass start/end.');
  const start = isoOf(opts.start || new Date(now.getTime() - hours * 3600 * 1000));
  const end = isoOf(opts.end || now);
  const folder = opts.folderName || 'Call Log Reports';
  const report = opts.reportName || 'Call Log';

  const { identifier } = await f9.runReport(folder, report, start, end);
  const maxPolls = Number(opts.maxPolls ?? 20);
  let csv = null;
  for (let i = 0; i < maxPolls; i++) {
    const r = await f9.getReportResult(identifier);
    if (r.ready) { csv = r.csv; break; }
    await sleep(Math.min(1500 * (i + 1), 5000));
  }
  if (csv === null) return { ready: false, identifier, note: 'The report is still running — call get_report_result with this identifier, or retry with a narrower window.' };

  const { columns, records } = csvToObjects(csv);
  const col = (...names) => columns.find((c) => names.some((n) => c.toLowerCase() === n.toLowerCase()));
  const cAni = col('ANI'); const cDnis = col('DNIS'); const cAgent = col('AGENT', 'AGENT NAME', 'AGENT USERNAME');
  const cSession = col('SESSION ID', 'SESSIONID'); const cCampaign = col('CAMPAIGN'); const cDispo = col('DISPOSITION');
  const cType = col('CALL TYPE'); const cCallId = col('CALL ID');

  const want = {
    ani: opts.ani ? digitsOf(opts.ani) : null,
    dnis: opts.dnis ? digitsOf(opts.dnis) : null,
    agent: opts.agent ? String(opts.agent).toLowerCase() : null,
    session: opts.sessionId ? String(opts.sessionId).toLowerCase() : null,
    campaign: opts.campaign ? String(opts.campaign).toLowerCase() : null,
    dispo: opts.disposition ? String(opts.disposition).toLowerCase() : null,
    type: opts.callType ? String(opts.callType).toLowerCase() : null,
    callId: opts.callId ? String(opts.callId) : null,
  };
  const has = (row, c, needle, digits) => {
    if (!needle) return true;
    if (!c) return false;
    const v = digits ? digitsOf(row[c]) : String(row[c] ?? '').toLowerCase();
    return digits ? v.endsWith(needle) || needle.endsWith(v) && v.length >= 7 : v.includes(needle);
  };
  const matches = records.filter((row) =>
    has(row, cAni, want.ani, true) && has(row, cDnis, want.dnis, true) && has(row, cAgent, want.agent) &&
    has(row, cSession, want.session) && has(row, cCampaign, want.campaign) && has(row, cDispo, want.dispo) &&
    has(row, cType, want.type) && (!want.callId || String(row[cCallId] ?? '') === want.callId));

  const limit = Math.max(1, Math.min(Number(opts.limit ?? 50), 500));
  const keep = opts.columns?.length ? columns.filter((c) => opts.columns.some((k) => k.toLowerCase() === c.toLowerCase())) : columns;
  return {
    ready: true, window: { start, end }, report: `${folder} / ${report}`, columns: keep,
    total_in_window: records.length, matched: matches.length, returned: Math.min(limit, matches.length),
    calls: matches.slice(-limit).map((row) => Object.fromEntries(keep.map((c) => [c, row[c]]))),
    note: matches.length > limit ? `Showing the last ${limit} of ${matches.length} matches — narrow the filters or raise limit.` : undefined,
  };
}

// ---- bulk_create_users ----

// Column aliases accepted in the CSV header (case-insensitive).
const USER_COLS = {
  userName: ['username', 'user_name', 'user name', 'login', 'email login'],
  password: ['password', 'temp password', 'temporary password'],
  firstName: ['first name', 'firstname', 'first_name', 'first'],
  lastName: ['last name', 'lastname', 'last_name', 'last'],
  email: ['email', 'e-mail', 'email address'],
  roles: ['roles', 'role'],
  skills: ['skills', 'skill'],
  agentGroups: ['agent groups', 'agent_groups', 'agentgroups', 'group', 'groups'],
  extension: ['extension', 'ext'],
  userProfileName: ['user profile', 'user_profile', 'profile', 'userprofilename'],
  phoneNumber: ['phone', 'phone number', 'phonenumber'],
  active: ['active'],
};

const splitList = (v) => String(v ?? '').split(/[;|,]/).map((s) => s.trim()).filter(Boolean);
const randomPassword = () => {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower = 'abcdefghjkmnpqrstuvwxyz', digits = '23456789', special = '!@#$%';
  const pick = (s, n) => Array.from({ length: n }, () => s[Math.floor(Math.random() * s.length)]).join('');
  const raw = pick(upper, 3) + pick(lower, 5) + pick(digits, 3) + pick(special, 1);
  return raw.split('').sort(() => Math.random() - 0.5).join('');
};

export function planUsersFromCsv(csvText, defaults = {}) {
  const { columns, records } = csvToObjects(csvText);
  if (!records.length) throw new Five9Error('The CSV has no data rows (first line must be a header, e.g. "username,first name,last name,email,roles,skills").');
  const lower = columns.map((c) => c.toLowerCase());
  const colFor = (key) => { const i = lower.findIndex((c) => USER_COLS[key].includes(c)); return i >= 0 ? columns[i] : null; };
  const map = Object.fromEntries(Object.keys(USER_COLS).map((k) => [k, colFor(k)]));
  const unknown = columns.filter((c) => !Object.values(map).includes(c));
  const problems = [];
  const seen = new Set();
  const users = records.map((r, idx) => {
    const line = idx + 2;
    const u = {
      userName: map.userName ? r[map.userName] : '',
      password: (map.password && r[map.password]) || defaults.password || randomPassword(),
      firstName: map.firstName ? r[map.firstName] : '',
      lastName: map.lastName ? r[map.lastName] : '',
      email: map.email ? r[map.email] : '',
      roles: map.roles && r[map.roles] ? splitList(r[map.roles]).map((x) => x.toLowerCase()) : toArray(defaults.roles || ['agent']),
      skills: map.skills && r[map.skills] ? splitList(r[map.skills]) : toArray(defaults.skills || []),
      agentGroups: map.agentGroups && r[map.agentGroups] ? splitList(r[map.agentGroups]) : toArray(defaults.agentGroups || []),
      extension: map.extension ? r[map.extension] || undefined : undefined,
      userProfileName: (map.userProfileName && r[map.userProfileName]) || defaults.userProfileName || undefined,
      phoneNumber: map.phoneNumber ? r[map.phoneNumber] || undefined : undefined,
      active: map.active && r[map.active] ? !/^(false|no|0|inactive)$/i.test(r[map.active]) : true,
      mustChangePassword: defaults.mustChangePassword ?? true,
    };
    if (!u.userName && u.email) u.userName = u.email; // Five9 usernames are usually the email
    if (!u.email && /@/.test(u.userName)) u.email = u.userName;
    if (!u.userName) problems.push(`line ${line}: missing username/email`);
    if (!u.firstName || !u.lastName) problems.push(`line ${line}: missing first or last name`);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u.email)) problems.push(`line ${line}: email "${u.email}" is not valid`);
    const badRole = u.roles.find((x) => !['agent', 'admin', 'supervisor', 'reporting'].includes(x));
    if (badRole) problems.push(`line ${line}: unknown role "${badRole}" (agent, admin, supervisor, reporting)`);
    if (seen.has(u.userName.toLowerCase())) problems.push(`line ${line}: duplicate username "${u.userName}"`);
    seen.add(u.userName.toLowerCase());
    return u;
  });
  return { columns, mapped: map, unknown_columns: unknown, users, problems };
}

export async function bulkCreateUsers(f9, csvText, opts = {}) {
  const plan = planUsersFromCsv(csvText, opts.defaults || {});
  const preview = plan.users.map(({ password, ...u }) => u);
  if (plan.problems.length) {
    return { ok: false, dry_run: true, rows: plan.users.length, problems: plan.problems, unknown_columns: plan.unknown_columns, users: preview,
      note: 'Fix the problems above and re-run. Nothing was created.' };
  }
  // Existence checks: usernames and referenced skills.
  const existing = new Set((await f9.getUsers('.*')).map((u) => String(u.userName).toLowerCase()));
  const skills = new Set((await f9.getSkills('.*')).map((s) => String(s.name).toLowerCase()));
  const already = plan.users.filter((u) => existing.has(u.userName.toLowerCase())).map((u) => u.userName);
  const missingSkills = [...new Set(plan.users.flatMap((u) => u.skills).filter((s) => !skills.has(s.toLowerCase())))];
  const blockers = [];
  if (already.length && !opts.skipExisting) blockers.push(`already exist on the domain: ${already.join(', ')} (pass skip_existing true to skip them)`);
  if (missingSkills.length) blockers.push(`skills not on the domain: ${missingSkills.join(', ')} (create them with manage_skill first)`);
  const toCreate = plan.users.filter((u) => !(opts.skipExisting && existing.has(u.userName.toLowerCase())));
  if (opts.dryRun !== false || blockers.length) {
    return { ok: blockers.length === 0, dry_run: true, rows: plan.users.length, would_create: toCreate.length, skipped_existing: opts.skipExisting ? already : [],
      blockers, unknown_columns: plan.unknown_columns, users: preview, note: blockers.length ? 'Nothing was created.' : 'Re-run with dry_run false to create these users.' };
  }
  const results = [];
  for (const u of toCreate) {
    try {
      const r = await f9.createUser(u);
      results.push({ userName: u.userName, ok: true, roles: r.roles, temp_password: opts.revealPasswords ? u.password : undefined });
    } catch (e) {
      results.push({ userName: u.userName, ok: false, error: e.message });
    }
  }
  const failed = results.filter((r) => !r.ok);
  return { ok: failed.length === 0, dry_run: false, created: results.length - failed.length, failed: failed.length, skipped_existing: already, results,
    note: opts.revealPasswords ? 'Temporary passwords are included once; users must change them at first login.' : 'Temporary passwords were generated per user (or taken from the CSV) and are not echoed — pass reveal_passwords true if you need them.' };
}
