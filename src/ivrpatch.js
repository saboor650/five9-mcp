// Targeted edits to an EXISTING IVR script's xmlDefinition.
//
// The flow builder (ivr.js) composes whole scripts. This module is the other
// half: small, surgical changes to scripts that were built by hand in the
// designer — change a transfer number, swap a prompt, retarget a menu key —
// without anyone hand-editing tens of KB of XML. Every op works on the module
// block identified by its moduleName, keeps everything else byte-identical,
// and reports exactly what changed so a dry run is reviewable.
//
// Ops (each { op, module, ...args }):
//   set_transfer_number    { number }                 thirdPartyTransfer
//   set_prompt             { prompt_name }            play / menu main prompt
//   set_interruptible      { value: true|false }      play / menu main prompt
//   set_agent_variable     { variable }               agentTransfer
//   set_menu_option        { digit, next, label? }    menu: retarget or add a key
//   remove_menu_option     { digit }                  menu
//   set_no_match           { next }                   menu "No Match" branch
//   set_condition          { variable, op, value | value_variable } ifElse (replaces all conditions)
//   set_hangup_disposition { disposition, overwrite? } hangup (system dispositions only)
//   rename_module          { new_name }               any module
//   set_lookup_field       { field, variable? }       lookupCRMRecord
//
// `next` / targets are module NAMES (see listIvrModules), never ids.

import { escapeXml, parseXml, toArray } from './five9.js';
import { SYSTEM_DISPOSITIONS, IF_ELSE_OPS } from './ivr.js';

export const IVR_PATCH_OPS = ['set_transfer_number', 'set_prompt', 'set_interruptible', 'set_agent_variable', 'set_menu_option', 'remove_menu_option', 'set_no_match', 'set_condition', 'set_hangup_disposition', 'rename_module', 'set_lookup_field'];

const MODULE_TAGS = ['incomingCall', 'play', 'menu', 'ifElse', 'skillTransfer', 'agentTransfer', 'thirdPartyTransfer', 'voiceMailTransfer', 'hangup', 'lookupCRMRecord', 'setVariable', 'foreignScript', 'input', 'getDigits', 'case', 'startOnHangup', 'query', 'setPriority', 'conference', 'transferCall', 'sendSMS', 'customerLookup', 'agentDataPush'];

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const text = (xml, tag) => {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1] : undefined;
};

// ---- Inventory ----

// Every module in <modules> (the on-hangup lane is listed separately) with
// its wiring resolved to module NAMES so a reader never has to see a GUID.
export function listIvrModules(xmlDefinition) {
  const doc = parseXml(xmlDefinition);
  const script = doc?.ivrScript;
  if (!script) throw new Error('Not an IVR script: no <ivrScript> root.');
  const collect = (section) => {
    const out = [];
    for (const [type, val] of Object.entries(section || {})) {
      for (const m of toArray(val)) {
        if (!m || typeof m !== 'object' || !m.moduleId) continue;
        out.push({ type, name: m.moduleName || type, id: m.moduleId, raw: m });
      }
    }
    return out;
  };
  const main = collect(script.modules);
  const onHangup = collect(script.modulesOnHangup);
  const nameOf = Object.fromEntries([...main, ...onHangup].map((m) => [m.id, m.name]));
  const describe = ({ type, name, id, raw }) => {
    const d = raw.data || {};
    const out = { type, name, id };
    if (raw.singleDescendant) out.next = nameOf[raw.singleDescendant] || raw.singleDescendant;
    if (raw.exceptionalDescendant) out.on_error = nameOf[raw.exceptionalDescendant] || raw.exceptionalDescendant;
    const branches = toArray(d.branches?.entry).filter((e) => e?.key);
    if (branches.length) out.branches = Object.fromEntries(branches.map((e) => [e.key, nameOf[e.value?.desc] || e.value?.desc]));
    if (type === 'menu') {
      out.options = toArray(d.items).map((it) => ({
        digit: String(it.dtmf || '').replace(/^DTMF_/, ''), label: it.choice?.value, branch: it.actionName,
        next: out.branches?.[it.actionName],
      }));
      out.max_attempts = d.maxAttempts;
      const p = toArray(d.prompts)[0]?.prompt;
      out.prompt = promptSummary(p);
    }
    if (type === 'play') out.prompt = promptSummary(d.prompt);
    if (type === 'thirdPartyTransfer') {
      const n = d.thirdPartyNumber || {};
      out.number = n.isVarSelected === 'true' ? `{${n.variableName}}` : n.stringValue?.value;
      out.ringing_timeout = d.ringingTimeout;
    }
    if (type === 'agentTransfer') {
      out.agent = d.agentButNotVarSelected === 'true' ? (d.agentToTransfer?.name || d.agentToTransfer) : `{${d.agentVarName}}`;
      out.leave_voicemail = d.leaveVoicemail;
      out.max_queue_seconds = d.maxQueueTime;
    }
    if (type === 'skillTransfer') out.skills = toArray(d.listOfSkillsEx?.extrnalObj).map((s) => s.name);
    if (type === 'voiceMailTransfer') out.voicemail_box = d.vmSkillBox?.name || d.vmPersonalBox?.name || d.vmBoxType;
    if (type === 'lookupCRMRecord') {
      out.lookup_fields = toArray(d.lookupCriteria);
      out.conditions = toArray(d.conditions).map((c) => ({ field: c.crmField, op: c.operator, value: c.value, is_variable: c.isVariableSelected === 'true' }));
    }
    if (type === 'ifElse') {
      out.match = d.conditionGrouping;
      out.conditions = toArray(d.conditions).map((c) => ({
        variable: c.leftOperand?.variableName, op: c.comparisonType,
        value: c.rightOperand?.isVarSelected === 'true' ? `{${c.rightOperand.variableName}}` : (c.rightOperand?.stringValue?.value ?? c.rightOperand?.integerValue?.value ?? c.rightOperand?.timeValue?.minutes),
      }));
    }
    if (type === 'hangup') { out.disposition = d.dispo?.name; out.overwrite_disposition = d.overwriteDisposition; }
    return out;
  };
  return { modules: main.map(describe), on_hangup: onHangup.map(describe), module_count: main.length };
}

function promptSummary(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.filePrompt) return { prompt_name: p.filePrompt.promptData?.prompt?.name, interruptible: p.interruptible === 'true' };
  if (p.ttsPrompt) return { tts: '(inline TTS)', interruptible: p.interruptible === 'true' };
  if (p.multiLanguagesPromptItem) return { prompt_ref: p.multiLanguagesPromptItem.prompt, interruptible: p.interruptible === 'true' };
  return { empty: true };
}

// ---- Module block access (string level, so untouched XML stays identical) ----

function findModuleBlocks(xml) {
  // A module block is <tag> ... <moduleName>X</moduleName> ... </tag> where tag
  // is a designer module element. The negative lookahead stops a match from
  // swallowing a following module of the same type.
  const blocks = [];
  const re = new RegExp(`<(${MODULE_TAGS.join('|')})>(?:(?!<\\1>)[\\s\\S])*?</\\1>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const name = text(m[0], 'moduleName');
    const id = text(m[0], 'moduleId');
    if (!id) continue;
    blocks.push({ tag: m[1], name, id, start: m.index, end: m.index + m[0].length, xml: m[0] });
  }
  return blocks;
}

function getModule(xml, moduleName, wantTags) {
  const matches = findModuleBlocks(xml).filter((b) => b.name === moduleName);
  if (!matches.length) throw new Error(`Module "${moduleName}" not found. Use list_ivr_modules to see module names.`);
  if (matches.length > 1) throw new Error(`Module name "${moduleName}" is used ${matches.length} times — rename one in the designer first so the target is unambiguous.`);
  const b = matches[0];
  if (wantTags && !wantTags.includes(b.tag)) throw new Error(`Module "${moduleName}" is a ${b.tag} module; this op needs ${wantTags.join(' or ')}.`);
  return b;
}

function replaceBlock(xml, block, newBlockXml) {
  return xml.slice(0, block.start) + newBlockXml + xml.slice(block.end);
}

// Replace exactly one occurrence of a regex inside a block, or throw.
function replaceOnce(blockXml, regex, replacement, what) {
  const m = regex.exec(blockXml);
  if (!m) throw new Error(`Could not find ${what} in the module XML — the module may be shaped differently than expected.`);
  return blockXml.slice(0, m.index) + replacement(m) + blockXml.slice(m.index + m[0].length);
}

const filePromptXml = (name, id, interruptible, ttsEnumed) =>
  `<filePrompt><promptData><promptSelected>true</promptSelected><prompt><id>${id}</id><name>${escapeXml(name)}</name></prompt><isRecordedMessage>false</isRecordedMessage></promptData></filePrompt>` +
  `<interruptible>${interruptible}</interruptible><canChangeInterruptableOption>true</canChangeInterruptableOption><ttsEnumed>${ttsEnumed}</ttsEnumed><exitModuleOnException>false</exitModuleOnException>`;

// The main prompt slot of a play (<data><prompt>…</prompt>) or menu
// (<prompts><prompt>…</prompt><count>) module.
// A compound prompt nests its own <prompt><id/><name/></prompt> inside
// filePrompt, so the OUTER element is recognised by the exitModuleOnException
// flag every compound prompt ends with.
function mainPromptRegex(tag) {
  return tag === 'menu'
    ? /<prompts>\s*<prompt>([\s\S]*?<exitModuleOnException>(?:true|false)<\/exitModuleOnException>)\s*<\/prompt>(\s*<count>)/
    : /<data>\s*<prompt>([\s\S]*?<exitModuleOnException>(?:true|false)<\/exitModuleOnException>)\s*<\/prompt>/;
}

function addAscendant(xml, targetId, fromId) {
  const blocks = findModuleBlocks(xml);
  const t = blocks.find((b) => b.id === targetId);
  if (!t) return xml;
  if (new RegExp(`<ascendants>${fromId}</ascendants>`).test(t.xml)) return xml;
  const updated = t.xml.replace(/^<(\w+)>/, (m) => `${m}<ascendants>${fromId}</ascendants>`);
  return replaceBlock(xml, t, updated);
}

function removeAscendantIfUnreferenced(xml, targetId, fromId) {
  const blocks = findModuleBlocks(xml);
  const from = blocks.find((b) => b.id === fromId);
  if (from && from.xml.includes(`<desc>${targetId}</desc>`)) return xml; // still referenced by another branch
  if (from && from.xml.includes(`<singleDescendant>${targetId}</singleDescendant>`)) return xml;
  const t = blocks.find((b) => b.id === targetId);
  if (!t) return xml;
  const updated = t.xml.replace(new RegExp(`\\s*<ascendants>${fromId}</ascendants>`), '');
  return updated === t.xml ? xml : replaceBlock(xml, t, updated);
}

// ---- Patch ----

// resolved: { prompts: Map(lowerName -> {id, name}) } for set_prompt. Returns
// { xml, changes: [ { op, module, detail } ] }.
export function patchIvrXml(xmlDefinition, ops, resolved = { prompts: new Map() }) {
  if (resolved instanceof Map) resolved = { prompts: resolved };
  if (!resolved?.prompts) resolved = { ...resolved, prompts: new Map() };
  let xml = String(xmlDefinition);
  const changes = [];
  const list = toArray(ops);
  if (!list.length) throw new Error('ops must contain at least one operation.');

  for (const [i, op] of list.entries()) {
    const where = `ops[${i}]`;
    if (!op || typeof op !== 'object') throw new Error(`${where} must be an object.`);
    if (!IVR_PATCH_OPS.includes(op.op)) throw new Error(`${where}: unknown op "${op.op}" (use ${IVR_PATCH_OPS.join(', ')}).`);
    if (!op.module) throw new Error(`${where}: module (the module name) is required.`);
    const targetIdOf = (name) => getModule(xml, name).id;

    if (op.op === 'set_transfer_number') {
      const num = String(op.number ?? '').replace(/[\s()\-.]/g, '');
      if (!/^\+?\d{3,15}$/.test(num)) throw new Error(`${where}: number must be 3-15 digits.`);
      const b = getModule(xml, op.module, ['thirdPartyTransfer']);
      const before = text(b.xml, 'value');
      const updated = replaceOnce(b.xml, /<thirdPartyNumber>[\s\S]*?<\/thirdPartyNumber>/,
        () => `<thirdPartyNumber><isVarSelected>false</isVarSelected><stringValue><value>${num}</value><id>0</id></stringValue></thirdPartyNumber>`, 'thirdPartyNumber');
      xml = replaceBlock(xml, b, updated);
      changes.push({ op: op.op, module: op.module, from: before, to: num });
    }

    if (op.op === 'set_prompt') {
      if (!op.prompt_name) throw new Error(`${where}: prompt_name is required.`);
      const p = resolved.prompts.get(String(op.prompt_name).toLowerCase());
      if (!p) throw new Error(`${where}: prompt "${op.prompt_name}" is not on the domain (see list_prompts, or upload it with generate_prompt_audio / manage_wav_prompt).`);
      const b = getModule(xml, op.module, ['play', 'menu']);
      const re = mainPromptRegex(b.tag);
      const m = re.exec(b.xml);
      if (!m) throw new Error(`${where}: could not find the main prompt slot in "${op.module}".`);
      const interruptible = text(m[1], 'interruptible') === 'true';
      const ttsEnumed = b.tag === 'menu' ? 'true' : 'false';
      const before = /<name>([^<]*)<\/name>/.exec(m[1])?.[1] || (m[1].includes('ttsPrompt') ? '(inline TTS)' : '(empty)');
      const updated = replaceOnce(b.xml, re, (mm) =>
        b.tag === 'menu'
          ? `<prompts><prompt>${filePromptXml(p.name, p.id ?? 0, interruptible, ttsEnumed)}</prompt>${mm[2]}`
          : `<data><prompt>${filePromptXml(p.name, p.id ?? 0, interruptible, ttsEnumed)}</prompt>`, 'main prompt');
      xml = replaceBlock(xml, b, updated);
      changes.push({ op: op.op, module: op.module, from: before, to: p.name });
    }

    if (op.op === 'set_interruptible') {
      if (typeof op.value !== 'boolean') throw new Error(`${where}: value must be true or false.`);
      const b = getModule(xml, op.module, ['play', 'menu']);
      const re = mainPromptRegex(b.tag);
      const m = re.exec(b.xml);
      if (!m) throw new Error(`${where}: could not find the main prompt slot in "${op.module}".`);
      const before = text(m[1], 'interruptible');
      const inner = m[1].replace(/<interruptible>(true|false)<\/interruptible>/, `<interruptible>${op.value}</interruptible>`);
      const updated = b.xml.slice(0, m.index) + m[0].replace(m[1], inner) + b.xml.slice(m.index + m[0].length);
      xml = replaceBlock(xml, b, updated);
      changes.push({ op: op.op, module: op.module, from: before === 'true', to: op.value });
    }

    if (op.op === 'set_agent_variable') {
      if (!/^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(String(op.variable || ''))) throw new Error(`${where}: variable must look like "Contact.last_agent".`);
      const b = getModule(xml, op.module, ['agentTransfer']);
      const before = text(b.xml, 'agentVarName');
      let updated = replaceOnce(b.xml, /<agentVarName>[^<]*<\/agentVarName>|<agentVarName\/>/, () => `<agentVarName>${escapeXml(op.variable)}</agentVarName>`, 'agentVarName');
      updated = updated.replace(/<agentButNotVarSelected>true<\/agentButNotVarSelected>/, '<agentButNotVarSelected>false</agentButNotVarSelected>');
      xml = replaceBlock(xml, b, updated);
      changes.push({ op: op.op, module: op.module, from: before, to: op.variable });
    }

    if (op.op === 'set_menu_option' || op.op === 'remove_menu_option') {
      const digit = Number(op.digit);
      if (!Number.isInteger(digit) || digit < 0 || digit > 9) throw new Error(`${where}: digit must be 0-9.`);
      const b = getModule(xml, op.module, ['menu']);
      const itemRe = new RegExp(`<items>(?:(?!<items>)[\\s\\S])*?<dtmf>DTMF_${digit}</dtmf>[\\s\\S]*?</items>`);
      const item = itemRe.exec(b.xml);
      const existingBranch = item ? text(item[0], 'actionName') : null;
      const branchRe = (key) => new RegExp(`<entry>\\s*<key>${esc(key)}</key>\\s*<value>\\s*<name>${esc(key)}</name>\\s*<desc>([0-9A-F]+)</desc>\\s*</value>\\s*</entry>`);

      if (op.op === 'remove_menu_option') {
        if (!item) throw new Error(`${where}: menu "${op.module}" has no option on digit ${digit}.`);
        const oldTarget = branchRe(existingBranch).exec(b.xml)?.[1];
        let updated = b.xml.replace(item[0], '');
        updated = updated.replace(branchRe(existingBranch), '');
        xml = replaceBlock(xml, b, updated);
        if (oldTarget) xml = removeAscendantIfUnreferenced(xml, oldTarget, b.id);
        changes.push({ op: op.op, module: op.module, digit, removed_branch: existingBranch });
        continue;
      }

      if (!op.next) throw new Error(`${where}: next (target module name) is required.`);
      const targetId = targetIdOf(op.next);
      const label = String(op.label || existingBranch || op.next).trim();
      if (label.toLowerCase() === 'no match') throw new Error(`${where}: "No Match" is a reserved branch name.`);
      let updated = b.xml;
      let oldTarget = null;
      if (item) {
        // Retarget (and optionally relabel) an existing key.
        const bm = branchRe(existingBranch).exec(updated);
        oldTarget = bm?.[1] || null;
        if (label !== existingBranch) {
          if (branchRe(label).test(updated)) throw new Error(`${where}: branch "${label}" already exists on this menu.`);
          updated = updated.replace(item[0], item[0]
            .replace(/<choice><type>VALUE<\/type><value>[^<]*<\/value>/, `<choice><type>VALUE</type><value>${escapeXml(label)}</value>`)
            .replace(/<actionName>[^<]*<\/actionName>/, `<actionName>${escapeXml(label)}</actionName>`));
          updated = updated.replace(branchRe(existingBranch), `<entry><key>${escapeXml(label)}</key><value><name>${escapeXml(label)}</name><desc>${targetId}</desc></value></entry>`);
        } else {
          updated = replaceOnce(updated, branchRe(existingBranch), () => `<entry><key>${escapeXml(label)}</key><value><name>${escapeXml(label)}</name><desc>${targetId}</desc></value></entry>`, `branch "${existingBranch}"`);
        }
      } else {
        if (branchRe(label).test(updated)) throw new Error(`${where}: branch "${label}" already exists on this menu — pick a different label.`);
        const entry = `<entry><key>${escapeXml(label)}</key><value><name>${escapeXml(label)}</name><desc>${targetId}</desc></value></entry>`;
        updated = replaceOnce(updated, /<\/branches>/, () => `${entry}</branches>`, '<branches>');
        const newItem = `<items><choice><type>VALUE</type><value>${escapeXml(label)}</value><showInVivr>true</showInVivr></choice>` +
          '<match>APPR</match><thumbnail><type>VALUE</type><value></value><showInVivr>true</showInVivr></thumbnail>' +
          `<dtmf>DTMF_${digit}</dtmf><actionType>BRANCH</actionType><actionName>${escapeXml(label)}</actionName></items>`;
        // Items sit between </confirmData> and <maxTimeToEnter> in designer output.
        updated = replaceOnce(updated, /(<\/confirmData>[\s\S]*?)(<maxTimeToEnter>)/, (mm) => `${mm[1]}${newItem}${mm[2]}`, 'menu items list');
      }
      xml = replaceBlock(xml, b, updated);
      xml = addAscendant(xml, targetId, b.id);
      if (oldTarget && oldTarget !== targetId) xml = removeAscendantIfUnreferenced(xml, oldTarget, b.id);
      changes.push({ op: op.op, module: op.module, digit, branch: label, to: op.next, ...(item ? { retargeted: true } : { added: true }) });
    }

    if (op.op === 'set_no_match') {
      if (!op.next) throw new Error(`${where}: next (target module name) is required.`);
      const b = getModule(xml, op.module, ['menu']);
      const targetId = targetIdOf(op.next);
      const re = /<entry>\s*<key>No Match<\/key>\s*<value>\s*<name>No Match<\/name>\s*<desc>([0-9A-F]+)<\/desc>/;
      const old = re.exec(b.xml)?.[1];
      const updated = replaceOnce(b.xml, re, () => `<entry><key>No Match</key><value><name>No Match</name><desc>${targetId}</desc>`, 'No Match branch');
      xml = replaceBlock(xml, b, updated);
      xml = addAscendant(xml, targetId, b.id);
      if (old && old !== targetId) xml = removeAscendantIfUnreferenced(xml, old, b.id);
      changes.push({ op: op.op, module: op.module, to: op.next });
    }

    if (op.op === 'set_condition') {
      const cmp = String(op.comparison || op.op_type || 'EQUALS').toUpperCase();
      if (!IF_ELSE_OPS.includes(cmp)) throw new Error(`${where}: comparison must be one of ${IF_ELSE_OPS.join(', ')}.`);
      if (!/^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(String(op.variable || ''))) throw new Error(`${where}: variable must look like "Contact.last_agent".`);
      if (op.value === undefined && op.value_variable === undefined) throw new Error(`${where}: value or value_variable is required.`);
      const b = getModule(xml, op.module, ['ifElse']);
      const right = op.value_variable !== undefined
        ? `<isVarSelected>true</isVarSelected><variableName>${escapeXml(op.value_variable)}</variableName>`
        : (Number.isInteger(op.value) ? `<isVarSelected>false</isVarSelected><integerValue><value>${op.value}</value></integerValue>`
          : `<isVarSelected>false</isVarSelected><stringValue><value>${escapeXml(op.value)}</value><id>0</id></stringValue>`);
      const cond = `<conditions><comparisonType>${cmp}</comparisonType><joinMode>AND</joinMode><rightOperand>${right}</rightOperand><leftOperand><isVarSelected>true</isVarSelected><variableName>${escapeXml(op.variable)}</variableName></leftOperand></conditions>`;
      const stripped = b.xml.replace(/<conditions>[\s\S]*?<\/conditions>/g, '');
      const updated = replaceOnce(stripped, /<\/data>\s*<\/ifElse>$/, (mm) => `${cond}${mm[0]}`, 'ifElse data');
      xml = replaceBlock(xml, b, updated);
      changes.push({ op: op.op, module: op.module, condition: `${op.variable} ${cmp} ${op.value_variable ?? op.value}` });
    }

    if (op.op === 'set_hangup_disposition') {
      const d = SYSTEM_DISPOSITIONS[String(op.disposition || '').toLowerCase()];
      if (!d) throw new Error(`${where}: disposition must be one of ${Object.values(SYSTEM_DISPOSITIONS).map((x) => x.name).join(', ')}.`);
      const b = getModule(xml, op.module, ['hangup']);
      const before = /<dispo>[\s\S]*?<name>([^<]*)<\/name>/.exec(b.xml)?.[1];
      let updated = replaceOnce(b.xml, /<dispo>[\s\S]*?<\/dispo>/, () => `<dispo><id>${d.id}</id><name>${escapeXml(d.name)}</name></dispo>`, 'dispo');
      if (op.overwrite !== undefined) updated = updated.replace(/<overwriteDisposition>(true|false)<\/overwriteDisposition>/, `<overwriteDisposition>${op.overwrite === true}</overwriteDisposition>`);
      xml = replaceBlock(xml, b, updated);
      changes.push({ op: op.op, module: op.module, from: before, to: d.name, ...(op.overwrite !== undefined ? { overwrite: op.overwrite === true } : {}) });
    }

    if (op.op === 'rename_module') {
      const newName = String(op.new_name || '').trim();
      if (!newName) throw new Error(`${where}: new_name is required.`);
      if (findModuleBlocks(xml).some((x) => x.name === newName)) throw new Error(`${where}: a module named "${newName}" already exists.`);
      const b = getModule(xml, op.module);
      const updated = replaceOnce(b.xml, /<moduleName>[^<]*<\/moduleName>/, () => `<moduleName>${escapeXml(newName)}</moduleName>`, 'moduleName');
      xml = replaceBlock(xml, b, updated);
      changes.push({ op: op.op, module: op.module, to: newName });
    }

    if (op.op === 'set_lookup_field') {
      if (!op.field) throw new Error(`${where}: field (contact field name) is required.`);
      const variable = op.variable || 'Call.ANI';
      if (!/^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(String(variable))) throw new Error(`${where}: variable must look like "Call.ANI".`);
      const b = getModule(xml, op.module, ['lookupCRMRecord']);
      const before = /<conditions>[\s\S]*?<crmField>([^<]*)<\/crmField>[\s\S]*?<value>([^<]*)<\/value>/.exec(b.xml);
      const stripped = b.xml.replace(/<conditions>[\s\S]*?<\/conditions>/g, '');
      const cond = `<conditions><crmField>${escapeXml(op.field)}</crmField><operator>EQUALS</operator><value>${escapeXml(variable)}</value><isVariableSelected>true</isVariableSelected></conditions>`;
      const updated = replaceOnce(stripped, /<groupingType>/, () => `${cond}<groupingType>`, 'groupingType');
      xml = replaceBlock(xml, b, updated);
      changes.push({ op: op.op, module: op.module, from: before ? `${before[1]} = ${before[2]}` : null, to: `${op.field} = ${variable}` });
    }
  }

  // Sanity: the result must still parse and keep every module id it started with.
  const beforeIds = new Set(findModuleBlocks(xmlDefinition).map((b) => b.id));
  const afterIds = new Set(findModuleBlocks(xml).map((b) => b.id));
  for (const id of beforeIds) if (!afterIds.has(id)) throw new Error(`Internal check failed: module ${id} disappeared during patching. Nothing was changed.`);
  parseXml(xml);
  return { xml, changes };
}
