// Tests for the Lion Mountain extensions: connector modify, VCC configuration
// writes, routing IVR nodes, IVR patching, call lookup, bulk user provisioning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Five9Client, parseXml, toArray, kvPairs, flattenKeys } from '../src/five9.js';
import { validateFlow, composeIvrXml, flowToMermaid, IVR_NODE_TYPES } from '../src/ivr.js';
import { listIvrModules, patchIvrXml, IVR_PATCH_OPS } from '../src/ivrpatch.js';
import { parseCsv, csvToObjects, planUsersFromCsv, bulkCreateUsers, findCalls } from '../src/ops.js';
import { buildAbout, buildInstructions } from '../src/about.js';
import { TOOLS, TOOL_GROUPS, WRITE_TOOLS } from '../src/tools.js';

const FIXTURE = readFileSync(new URL('./fixture_last_agent_ivr.xml', import.meta.url), 'utf8');

// A Five9Client whose SOAP layer is replaced by canned responses + a call log.
function mockClient(responses = {}) {
  const c = new Five9Client({ username: 'u', password: 'p' });
  c.calls = [];
  c.admin = async (method, xml) => {
    c.calls.push({ method, xml });
    const r = responses[method];
    if (typeof r === 'function') return r(xml);
    if (r instanceof Error) throw r;
    return r ?? {};
  };
  return c;
}

const CONNECTOR = {
  addWorksheet: 'false', agentApplication: 'EmbeddedBrowser', constants: { key: '' }, ctiWebServices: 'CurrentBrowserWindow',
  description: 'Posts Call Ended to WFA', executeInBrowser: 'false', name: 'wfa-last-agent-call-ended', postMethod: 'true',
  postVariables: [{ key: 'user_name', value: 'Agent.user_name' }, { key: 'number', value: 'Call.number' }],
  startPageText: 'Please wait', trigger: 'OnCallDispositioned',
  triggerDispositions: ['Consult Set', 'No Answer'],
  url: 'https://example.test/hook',
};

// ---- manage_web_connector modify ----

test('modifyWebConnector adds trigger dispositions and clears/replaces the list', async () => {
  const f9 = mockClient({ getWebConnectors: { return: CONNECTOR } });
  const r = await f9.modifyWebConnector('wfa-last-agent-call-ended', { addTriggerDispositions: ['Made contact - Refusal', 'No Answer'] });
  assert.deepEqual(r.triggerDispositions, ['Consult Set', 'No Answer', 'Made contact - Refusal']);
  const call = f9.calls.find((c) => c.method === 'modifyWebConnector');
  assert.ok(call, 'modifyWebConnector was sent');
  const doc = parseXml(`<r>${call.xml}</r>`).r.connector;
  assert.equal(doc.clearTriggerDispositions, 'true');
  assert.deepEqual(toArray(doc.triggerDispositions), ['Consult Set', 'No Answer', 'Made contact - Refusal']);
  assert.equal(doc.constants, undefined, 'blank constants placeholder is not echoed back');
  assert.equal(doc.url, 'https://example.test/hook');
  // schema order: postVariables before trigger before url
  const order = ['<postVariables>', '<trigger>', '<url>'].map((t) => call.xml.indexOf(t));
  assert.ok(order[0] < order[1] && order[1] < order[2], 'connector children in WSDL order');
});

test('modifyWebConnector replaces POST fields from a {key: value} object and can remove dispositions', async () => {
  const f9 = mockClient({ getWebConnectors: { return: CONNECTOR } });
  const r = await f9.modifyWebConnector('wfa-last-agent-call-ended', {
    postVariables: { user_name: 'Agent.user_name', DNIS: 'Call.DNIS' },
    removeTriggerDispositions: ['No Answer'], url: 'https://example.test/v2',
  });
  assert.deepEqual(r.applied.sort(), ['postVariables', 'triggerDispositions', 'url']);
  const doc = parseXml(`<r>${f9.calls.at(-1).xml}</r>`).r.connector;
  assert.deepEqual(toArray(doc.postVariables).map((p) => p.key), ['user_name', 'DNIS']);
  assert.deepEqual(toArray(doc.triggerDispositions), ['Consult Set']);
  assert.equal(doc.url, 'https://example.test/v2');
});

test('modifyWebConnector refuses dispositions on a non-dispositioned trigger and empty changes', async () => {
  const f9 = mockClient({ getWebConnectors: { return: { ...CONNECTOR, trigger: 'OnCallAccepted', triggerDispositions: undefined } } });
  await assert.rejects(() => f9.modifyWebConnector('wfa-last-agent-call-ended', { addTriggerDispositions: ['X'] }), /OnCallDispositioned/);
  await assert.rejects(() => f9.modifyWebConnector('wfa-last-agent-call-ended', {}), /Nothing to change/);
  await assert.rejects(() => mockClient({ getWebConnectors: { return: [] } }).modifyWebConnector('nope', { url: 'x' }), /not found/);
});

test('createWebConnector accepts OnCallDispositioned with dispositions and POST fields', async () => {
  const f9 = mockClient();
  await f9.manageWebConnector('create', { name: 'c1', url: 'https://x', trigger: 'OnCallDispositioned', triggerDispositions: ['A'], postMethod: true, postVariables: [{ key: 'k', value: 'Call.ANI' }] });
  const doc = parseXml(`<r>${f9.calls.at(-1).xml}</r>`).r.connector;
  assert.equal(doc.trigger, 'OnCallDispositioned');
  assert.equal(doc.triggerDispositions, 'A');
  assert.equal(doc.postVariables.value, 'Call.ANI');
  await assert.rejects(() => f9.manageWebConnector('create', { name: 'c2', url: 'https://x', triggerDispositions: ['A'] }), /OnCallDispositioned/);
});

test('kvPairs and flattenKeys helpers', () => {
  assert.deepEqual(kvPairs({ a: 1, b: 'x' }), [{ key: 'a', value: '1' }, { key: 'b', value: 'x' }]);
  assert.deepEqual(kvPairs([{ key: 'a', value: 'b' }, { key: '', value: 'skip' }]), [{ key: 'a', value: 'b' }]);
  assert.deepEqual(flattenKeys({ miscOptions: { defaultCampaign: 'X' }, timeZoneAssignment: 'Y' }), ['miscOptions.defaultCampaign', 'timeZoneAssignment']);
});

// ---- modify_vcc_configuration ----

test('modifyVCCConfiguration merges nested changes into the fetched configuration', async () => {
  const current = { agentProductivity: { longACWTime: '600' }, domainId: '1', domainName: 'D', miscOptions: { defaultCampaign: 'Old', maySelectCampaign: 'true', voicemailTimeout: '20' }, timeZoneAssignment: 'PHONE_NUMBER' };
  const f9 = mockClient({ getVCCConfiguration: { return: current } });
  const r = await f9.modifyVCCConfiguration({ miscOptions: { defaultCampaign: 'Main Inbound', maySelectCampaign: false } });
  assert.deepEqual(r.applied, ['miscOptions.defaultCampaign', 'miscOptions.maySelectCampaign']);
  const doc = parseXml(`<r>${f9.calls.at(-1).xml}</r>`).r.configuration;
  assert.equal(doc.miscOptions.defaultCampaign, 'Main Inbound');
  assert.equal(doc.miscOptions.maySelectCampaign, 'false');
  assert.equal(doc.miscOptions.voicemailTimeout, '20', 'untouched siblings survive');
  assert.equal(doc.timeZoneAssignment, 'PHONE_NUMBER');
  assert.equal(doc.domainName, 'D');
  await assert.rejects(() => f9.modifyVCCConfiguration({}), /at least one setting/);
});

// ---- IVR routing nodes ----

const affinityFlow = {
  entry: 'menu',
  nodes: {
    menu: { type: 'menu', prompt: { tts: 'Press 1 for your agent, 2 for title.' }, interruptible: true, no_match: 'lookup',
      options: [{ digit: 1, label: 'ISA', next: 'lookup' }, { digit: 2, label: 'Title', next: 'title' }] },
    lookup: { type: 'lookup_contact', field: 'number1', next: 'found' },
    found: { type: 'if_else', conditions: [{ variable: 'Contact.last_agent', op: 'REGEXP', value: '.+' }], then: 'to_agent', else: 'overflow' },
    to_agent: { type: 'agent_transfer', agent_variable: 'Contact.last_agent', next: 'bye' },
    overflow: { type: 'third_party_transfer', number: '(555) 010-0003', next: 'bye' },
    title: { type: 'third_party_transfer', number_variable: 'Contact.title_number', ringing_timeout: 20, next: 'bye' },
    bye: { type: 'hangup', disposition: 'No Disposition', overwrite_disposition: true },
  },
};

test('IVR node list includes the routing nodes and the affinity flow validates', () => {
  for (const t of ['lookup_contact', 'if_else', 'agent_transfer', 'third_party_transfer']) assert.ok(IVR_NODE_TYPES.includes(t));
  const r = validateFlow(affinityFlow);
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.deepEqual(r.warnings, []);
});

test('validateFlow catches routing-node mistakes', () => {
  const bad = (nodes, entry = Object.keys(nodes)[0]) => validateFlow({ entry, nodes }).errors.join(' | ');
  assert.match(bad({ a: { type: 'lookup_contact', next: 'a' } }), /needs field/);
  assert.match(bad({ a: { type: 'lookup_contact', field: 'number1', variable: 'ANI', next: 'a' } }), /variable must be/);
  assert.match(bad({ a: { type: 'if_else', conditions: [{ variable: 'Contact.x', op: 'LIKE', value: '1' }], then: 'a', else: 'a' } }), /op "LIKE"/);
  assert.match(bad({ a: { type: 'if_else', conditions: [{ variable: 'Contact.x', op: 'REGEXP', value: '(' }], then: 'a', else: 'a' } }), /not a valid regular expression/);
  assert.match(bad({ a: { type: 'if_else', conditions: [{ variable: 'Contact.x', value: '1' }], then: 'a' } }), /needs else/);
  assert.match(bad({ a: { type: 'agent_transfer', next: 'a' } }), /agent_variable/);
  assert.match(bad({ a: { type: 'third_party_transfer', number: '12', next: 'a' } }), /3-15 digits/);
  assert.match(bad({ a: { type: 'hangup', disposition: 'Consult Set' } }), /hangup disposition must be one of/);
  assert.match(bad({ a: { type: 'menu', prompt: { tts: 'x' }, options: [{ digit: 1, label: 'A', next: 'a' }], no_match: 'ghost' } }), /"ghost"/);
});

test('composeIvrXml emits designer-shaped routing modules', async () => {
  const { xml, moduleCount } = await composeIvrXml(affinityFlow, { skills: new Map(), prompts: new Map() });
  assert.equal(moduleCount, 10);
  const mods = parseXml(xml).ivrScript.modules;
  // lookup: explicit condition on number1 = Call.ANI (variable), default lookup fields
  const lk = mods.lookupCRMRecord;
  assert.deepEqual(toArray(lk.data.lookupCriteria), ['number1', 'number2', 'number3']);
  assert.equal(lk.data.conditions.crmField, 'number1');
  assert.equal(lk.data.conditions.value, 'Call.ANI');
  assert.equal(lk.data.conditions.isVariableSelected, 'true');
  assert.equal(lk.data.lookupMode, 'LOOKUP_IN_DB');
  // if/else: REGEXP on Contact.last_agent, IF -> agentTransfer, ELSE -> overflow
  const ie = mods.ifElse;
  assert.equal(ie.data.conditions.comparisonType, 'REGEXP');
  assert.equal(ie.data.conditions.leftOperand.variableName, 'Contact.last_agent');
  assert.equal(ie.data.conditions.rightOperand.stringValue.value, '.+');
  const branches = Object.fromEntries(toArray(ie.data.branches.entry).map((e) => [e.key, e.value.desc]));
  assert.equal(branches.IF, mods.agentTransfer.moduleId);
  const overflow = toArray(mods.thirdPartyTransfer).find((t) => t.moduleName === 'overflow');
  assert.equal(branches.ELSE, overflow.moduleId);
  // agent transfer by variable, voicemail on
  const at = mods.agentTransfer;
  assert.equal(at.data.agentVarName, 'Contact.last_agent');
  assert.equal(at.data.agentButNotVarSelected, 'false');
  assert.equal(at.data.leaveVoicemail, 'true');
  assert.equal(at.data.transferMode, 'AGENT');
  assert.equal(at.data.dispo.name, 'Abandon');
  // third-party: digits normalised, variable form, ringing timeout
  assert.equal(overflow.data.thirdPartyNumber.stringValue.value, '5550100003');
  assert.equal(overflow.data.dispo.name, 'Transferred To 3rd Party');
  const title = toArray(mods.thirdPartyTransfer).find((t) => t.moduleName === 'title');
  assert.equal(title.data.thirdPartyNumber.variableName, 'Contact.title_number');
  assert.equal(title.data.ringingTimeout, '20');
  // menu: interruptible prompt, No Match -> lookup, ascendants wired
  assert.equal(mods.menu.data.prompts.prompt.interruptible, 'true');
  const noMatch = toArray(mods.menu.data.branches.entry).find((e) => e.key === 'No Match');
  assert.equal(noMatch.value.desc, lk.moduleId);
  assert.ok(toArray(lk.ascendants).includes(mods.menu.moduleId));
  // hangup: system disposition + overwrite
  assert.equal(mods.hangup.data.dispo.name, 'No Disposition');
  assert.equal(mods.hangup.data.dispo.id, '0');
  assert.equal(mods.hangup.data.overwriteDisposition, 'true');
  // shape parity with the live script for the modules we cloned
  const live = parseXml(FIXTURE).ivrScript.modules;
  assert.deepEqual(Object.keys(lk.data), Object.keys(live.lookupCRMRecord.data));
  assert.deepEqual(Object.keys(at.data), Object.keys(live.agentTransfer.data));
  assert.deepEqual(Object.keys(overflow.data), Object.keys(toArray(live.thirdPartyTransfer)[0].data));
  assert.deepEqual(Object.keys(ie.data), Object.keys(live.ifElse.data));
});

test('flowToMermaid draws the routing edges', () => {
  const m = flowToMermaid(affinityFlow);
  assert.match(m, /Contact\.last_agent REGEXP \.\+/);
  assert.match(m, /"else"/);
  assert.match(m, /no match/);
  assert.match(m, /after transfer/);
});

// ---- IVR inventory + patching (against the real Orchard script) ----

test('listIvrModules resolves wiring to module names', () => {
  const inv = listIvrModules(FIXTURE);
  assert.equal(inv.module_count, 13);
  const menu = inv.modules.find((m) => m.type === 'menu');
  assert.equal(menu.name, 'MainMenu');
  assert.equal(menu.branches['No Match'], 'Lookup Last Agent by ANI');
  assert.equal(menu.options.find((o) => o.digit === '2').next, 'Title Customer Service');
  assert.equal(menu.prompt.prompt_name, 'Orchard Brokerage Phone Tree');
  assert.equal(menu.prompt.interruptible, true);
  const at = inv.modules.find((m) => m.type === 'agentTransfer');
  assert.equal(at.agent, '{Contact.last_agent}');
  const ie = inv.modules.find((m) => m.type === 'ifElse');
  assert.deepEqual(ie.branches, { IF: 'Last Agent Transfer', ELSE: 'AnswerForce Overflow' });
  assert.equal(ie.conditions[0].op, 'REGEXP');
  const t = inv.modules.find((m) => m.name === 'AnswerForce Overflow');
  assert.equal(t.number, '5550100003');
  assert.equal(inv.on_hangup.length, 2);
});

test('patchIvrXml applies every op and keeps the rest of the script intact', () => {
  assert.equal(IVR_PATCH_OPS.length, 11);
  const prompts = new Map([['crf', { id: 0, name: 'CRF' }]]);
  const { xml, changes } = patchIvrXml(FIXTURE, [
    { op: 'set_transfer_number', module: 'Title Customer Service', number: '(469) 250-5199' },
    { op: 'set_prompt', module: 'Play Seeking Employment', prompt_name: 'CRF' },
    { op: 'set_prompt', module: 'MainMenu', prompt_name: 'CRF' },
    { op: 'set_interruptible', module: 'MainMenu', value: false },
    { op: 'set_agent_variable', module: 'Last Agent Transfer', variable: 'Contact.owner' },
    { op: 'set_menu_option', module: 'MainMenu', digit: 3, next: 'AnswerForce Overflow' },
    { op: 'set_menu_option', module: 'MainMenu', digit: 8, label: 'Spanish', next: 'Play Vendor Interest' },
    { op: 'remove_menu_option', module: 'MainMenu', digit: 7 },
    { op: 'set_no_match', module: 'MainMenu', next: 'Hangup5' },
    { op: 'set_condition', module: 'Agent Found', variable: 'Contact.owner', comparison: 'NOT_EQUALS', value: '' },
    { op: 'set_hangup_disposition', module: 'Hangup5', disposition: 'Caller Disconnected', overwrite: false },
    { op: 'set_lookup_field', module: 'Lookup Last Agent by ANI', field: 'number2' },
    { op: 'rename_module', module: 'Hangup5', new_name: 'End Call' },
  ], prompts);
  assert.equal(changes.length, 13);
  const inv = listIvrModules(xml);
  assert.equal(inv.module_count, 13, 'no module lost');
  const menu = inv.modules.find((m) => m.type === 'menu');
  assert.equal(menu.prompt.prompt_name, 'CRF');
  assert.equal(menu.prompt.interruptible, false);
  assert.equal(menu.options.find((o) => o.digit === '3').next, 'AnswerForce Overflow');
  assert.equal(menu.options.find((o) => o.digit === '8').next, 'Play Vendor Interest');
  assert.equal(menu.options.find((o) => o.digit === '8').label, 'Spanish');
  assert.equal(menu.options.find((o) => o.digit === '7'), undefined);
  assert.equal(menu.branches['No Match'], 'End Call');
  assert.equal(menu.branches.AgentCoListing, undefined);
  assert.equal(inv.modules.find((m) => m.name === 'Title Customer Service').number, '4692505199');
  assert.equal(inv.modules.find((m) => m.name === 'Play Seeking Employment').prompt.prompt_name, 'CRF');
  assert.equal(inv.modules.find((m) => m.type === 'agentTransfer').agent, '{Contact.owner}');
  const ie = inv.modules.find((m) => m.type === 'ifElse');
  assert.deepEqual(ie.conditions, [{ variable: 'Contact.owner', op: 'NOT_EQUALS', value: '' }]);
  const end = inv.modules.find((m) => m.name === 'End Call');
  assert.equal(end.disposition, 'Caller Disconnected');
  assert.equal(end.overwrite_disposition, 'false');
  assert.deepEqual(inv.modules.find((m) => m.type === 'lookupCRMRecord').conditions[0], { field: 'number2', op: 'EQUALS', value: 'Call.ANI', is_variable: true });

  // Ascendant bookkeeping: menu removed from Agent Co Listing (key 7 gone) and
  // from OM Main Line (key 3 retargeted); added to AnswerForce Overflow.
  const doc = parseXml(xml).ivrScript.modules;
  const menuId = doc.menu.moduleId;
  const asc = (name) => toArray([...toArray(doc.play), ...toArray(doc.thirdPartyTransfer), ...toArray(doc.hangup)].find((m) => m.moduleName === name).ascendants);
  assert.ok(!asc('Play Agent Co Listing').includes(menuId));
  assert.ok(!asc('OM Main Line').includes(menuId));
  assert.ok(asc('AnswerForce Overflow').includes(menuId));
  assert.ok(asc('Play Vendor Interest').includes(menuId));
  assert.ok(asc('End Call').includes(menuId), 'No Match target gained the menu as ascendant');

  // Everything outside the touched modules is byte-identical.
  const untouched = /<agentTransfer>[\s\S]*?<\/agentTransfer>/;
  assert.notEqual(FIXTURE.match(untouched)[0], xml.match(untouched)[0]);
  const employeeVerification = /<play>(?:(?!<play>)[\s\S])*?<moduleName>Play Employee Verification<\/moduleName>[\s\S]*?<\/play>/;
  assert.equal(FIXTURE.match(employeeVerification)[0], xml.match(employeeVerification)[0]);
});

test('patchIvrXml rejects bad targets without touching the XML', () => {
  assert.throws(() => patchIvrXml(FIXTURE, [{ op: 'set_transfer_number', module: 'Nope', number: '5551234567' }]), /not found/);
  assert.throws(() => patchIvrXml(FIXTURE, [{ op: 'set_transfer_number', module: 'MainMenu', number: '5551234567' }]), /needs thirdPartyTransfer/);
  assert.throws(() => patchIvrXml(FIXTURE, [{ op: 'set_prompt', module: 'MainMenu', prompt_name: 'missing' }], new Map()), /not on the domain/);
  assert.throws(() => patchIvrXml(FIXTURE, [{ op: 'set_menu_option', module: 'MainMenu', digit: 9, label: 'Title', next: 'Hangup5' }]), /already exists/);
  assert.throws(() => patchIvrXml(FIXTURE, [{ op: 'remove_menu_option', module: 'MainMenu', digit: 9 }]), /no option on digit 9/);
  assert.throws(() => patchIvrXml(FIXTURE, [{ op: 'set_hangup_disposition', module: 'Hangup5', disposition: 'Consult Set' }]), /must be one of/);
  assert.throws(() => patchIvrXml(FIXTURE, [{ op: 'explode', module: 'MainMenu' }]), /unknown op/);
  assert.throws(() => patchIvrXml(FIXTURE, []), /at least one/);
});

// ---- ops: CSV, users, calls ----

test('parseCsv handles quotes, embedded commas and CRLF', () => {
  const rows = parseCsv('a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n2,,\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', '', '']]);
  assert.deepEqual(csvToObjects('h1, h2\nv1,v2').records, [{ h1: 'v1', h2: 'v2' }]);
});

const USERS_CSV = `Username,First Name,Last Name,Email,Roles,Skills,Extension
jane.doe@orchard.test,Jane,Doe,jane.doe@orchard.test,agent,Customer Support;Sales,1001
ops.lead@orchard.test,Ops,Lead,ops.lead@orchard.test,agent|supervisor,Customer Support,1002
`;

test('planUsersFromCsv maps columns, fills passwords, validates rows', () => {
  const plan = planUsersFromCsv(USERS_CSV);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.users.length, 2);
  assert.deepEqual(plan.users[0].skills, ['Customer Support', 'Sales']);
  assert.deepEqual(plan.users[1].roles, ['agent', 'supervisor']);
  assert.equal(plan.users[0].extension, '1001');
  assert.ok(plan.users[0].password.length >= 12, 'random temporary password generated');
  const bad = planUsersFromCsv('email,first name,last name,roles\nnot-an-email,A,B,boss\njane@x.test,Jane,,agent\njane@x.test,J,D,agent');
  assert.equal(bad.problems.length, 4);
  assert.ok(bad.problems.some((p) => /unknown role "boss"/.test(p)));
  assert.ok(bad.problems.some((p) => /duplicate username/.test(p)));
  assert.throws(() => planUsersFromCsv('only,a,header'), /no data rows/);
});

test('bulkCreateUsers dry-runs by default, blocks on missing skills/existing users, then creates', async () => {
  const f9 = mockClient({
    getUsersGeneralInfo: { return: [{ userName: 'ops.lead@orchard.test' }] },
    getSkills: { return: [{ name: 'Customer Support' }] },
    createUser: (xml) => ({ return: { generalInfo: { userName: /<userName>([^<]*)</.exec(xml)[1], id: '9' } } }),
  });
  const blocked = await bulkCreateUsers(f9, USERS_CSV);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blockers.some((b) => /Sales/.test(b)));
  assert.ok(blocked.blockers.some((b) => /ops\.lead/.test(b)));
  assert.ok(!f9.calls.some((c) => c.method === 'createUser'), 'nothing created while blocked');

  const f9b = mockClient({
    getUsersGeneralInfo: { return: [{ userName: 'ops.lead@orchard.test' }] },
    getSkills: { return: [{ name: 'Customer Support' }, { name: 'Sales' }] },
    createUser: (xml) => ({ return: { generalInfo: { userName: /<userName>([^<]*)</.exec(xml)[1], id: '9' } } }),
  });
  const dry = await bulkCreateUsers(f9b, USERS_CSV, { skipExisting: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.would_create, 1);
  assert.equal(dry.users[0].password, undefined, 'passwords never echoed in the plan');

  const real = await bulkCreateUsers(f9b, USERS_CSV, { skipExisting: true, dryRun: false, revealPasswords: true });
  assert.equal(real.created, 1);
  assert.equal(real.failed, 0);
  assert.equal(real.results[0].userName, 'jane.doe@orchard.test');
  assert.ok(real.results[0].temp_password);
  const created = f9b.calls.filter((c) => c.method === 'createUser');
  assert.equal(created.length, 1);
  assert.match(created[0].xml, /<skillName>Customer Support<\/skillName>/);
});

test('findCalls runs the Call Log report, waits, and filters rows', async () => {
  const csv = 'CALL ID,TIMESTAMP,CAMPAIGN,CALL TYPE,AGENT,DISPOSITION,ANI,DNIS,SESSION ID\n' +
    '1,2026-09-03 10:00,Orchard Main Inbound,Manual,lion.mtn@orchad.com,Consult Set,8329178826,2813240116,abc\n' +
    '2,2026-09-03 10:05,Orchard Main Inbound,Inbound,,Caller Disconnected,7135550000,2813240116,def\n' +
    '3,2026-09-03 10:07,OutboundQATesting,Outbound,agent2,No Answer,8329178826,,ghi\n';
  let polls = 0;
  const f9 = mockClient({
    runReport: { return: 'rid-1' },
    isReportRunning: () => ({ return: String(polls++ < 1) }),
    getReportResultCsv: { return: csv },
  });
  const r = await findCalls(f9, { hours: 2, ani: '(832) 917-8826' });
  assert.equal(r.ready, true);
  assert.equal(r.total_in_window, 3);
  assert.equal(r.matched, 2);
  assert.deepEqual(r.calls.map((c) => c['CALL ID']), ['1', '3']);
  const narrowed = await findCalls(f9, { hours: 2, ani: '8329178826', campaign: 'orchard main', columns: ['AGENT', 'DISPOSITION'] });
  assert.deepEqual(narrowed.calls, [{ AGENT: 'lion.mtn@orchad.com', DISPOSITION: 'Consult Set' }]);
  const run = f9.calls.find((c) => c.method === 'runReport');
  assert.match(run.xml, /<folderName>Call Log Reports<\/folderName><reportName>Call Log<\/reportName><criteria><time><end>/);
  await assert.rejects(() => findCalls(f9, { hours: 0 }), /hours must be/);
});

// ---- about + tool registry ----

test('about text is Lion Mountain operator context with labels applied', () => {
  const a = buildAbout({ domainLabel: 'Orchard Technologies Inc', clientLabel: 'Orchard Technologies' });
  assert.match(a, /Orchard Technologies Inc/);
  assert.match(a, /Lion Mountain/);
  assert.match(a, /Credentials are never typed/);
  assert.doesNotMatch(a, /outboundIQ/);
  assert.match(buildInstructions({ domainLabel: 'X', clientLabel: 'Y' }), /domain X \(client Y\)/);
});

test('new tools are registered, grouped, and write-flagged', () => {
  const names = TOOLS.map((t) => t.name);
  for (const n of ['modify_vcc_configuration', 'list_ivr_modules', 'patch_ivr_script', 'find_calls', 'bulk_create_users']) assert.ok(names.includes(n), n);
  const grouped = new Set(TOOL_GROUPS.flatMap((g) => g.tools));
  for (const n of names) assert.ok(grouped.has(n), `${n} has a UI group`);
  for (const n of ['modify_vcc_configuration', 'patch_ivr_script', 'bulk_create_users', 'manage_web_connector']) assert.ok(WRITE_TOOLS.has(n), `${n} is a write tool`);
  assert.ok(!WRITE_TOOLS.has('find_calls'));
  assert.ok(!WRITE_TOOLS.has('list_ivr_modules'));
  const wc = TOOLS.find((t) => t.name === 'manage_web_connector');
  assert.deepEqual(wc.inputSchema.properties.action.enum, ['create', 'modify', 'delete']);
});
