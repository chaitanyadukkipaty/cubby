// One skill serves every server version, so SKILL.md may only name the frozen core (cli/skill/core-commands.json).
// The command table (cli/src/commands.js) drives `cubby help` and /docs.md, so they can't drift from the CLI.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS, GLOBAL_FLAGS, helpJson, helpText, commandsMarkdown } from '../../cli/src/commands.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const skill = read('cli/skill/cubby/SKILL.md');
const core = JSON.parse(read('cli/skill/core-commands.json'));
const cli = read('cli/src/index.js');

// Every `cubby …` snippet in the skill: inline code spans and code-block lines.
function cubbySnippets(md) {
  const snippets = [...md.matchAll(/`([^`\n]*)`/g)].map((m) => m[1]);
  for (const block of md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) snippets.push(...block[1].split('\n'));
  return snippets.map((s) => s.trim()).filter((s) => s.startsWith('cubby '));
}

describe('SKILL.md stays within the frozen core', () => {
  const snippets = cubbySnippets(skill);
  test('the skill uses the CLI at all (sanity)', () => assert.ok(snippets.length > 8));
  test('every command it names is in the core', () => {
    const commands = new Set(core.commands);
    for (const s of snippets) {
      const words = s.split(/\s+/).slice(1).filter((w) => !w.startsWith('-') && !w.startsWith('{') && !w.startsWith('"'));
      const cmd = words[0];
      const name = cmd === 'schema' ? `schema ${words[1]}` : cmd;
      assert.ok(commands.has(name) || (cmd === 'schema' && words[1]?.includes('|')), `SKILL.md uses \`${s}\`: "${name}" is not in core-commands.json`);
    }
  });
  test('every flag it uses is in the core', () => {
    const flags = new Set(core.flags);
    for (const s of snippets) for (const f of s.match(/(?<=\s)--?[a-z][a-z-]*/g) ?? []) assert.ok(flags.has(f), `SKILL.md uses ${f} in \`${s}\`, which is not in core-commands.json`);
  });
  test('the prose list of core commands matches the core', () => {
    const list = skill.match(/core commands every Cubby server supports: ([\s\S]*?)\. Add/)[1];
    for (const c of core.commands.filter((c) => !c.startsWith('schema '))) assert.match(list, new RegExp(`\`${c}\``), c);
  });
  test('it tells agents to ask `cubby help --json` for anything beyond the core', () => {
    assert.match(skill, /`cubby help --json`/);
  });
  test('every core command and flag exists in this CLI', () => {
    const names = new Set(COMMANDS.map((c) => c.name));
    for (const c of core.commands) assert.ok(names.has(c.split(' ')[0]), c);
    for (const f of core.flags) {
      const long = f === '-m' ? 'message' : f.replace(/^--/, '');
      assert.match(cli, new RegExp(`['"]?${long}['"]?: \\{ type:`), `${f} is not a CLI option`);
    }
  });
});

describe('command table → help and docs', () => {
  test('every command the CLI implements is in the table, and nothing else', () => {
    const block = cli.slice(cli.indexOf('const commands = {'));
    const implemented = [...block.matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]).sort();
    assert.deepEqual(COMMANDS.map((c) => c.name).sort(), implemented);
  });
  test('every flag a command lists is a real CLI option', () => {
    for (const c of COMMANDS) {
      for (const f of c.flags) assert.match(cli, new RegExp(`['"]?${f.replace(/^--/, '')}['"]?: \\{ type:`), `${c.name}: ${f}`);
    }
    for (const f of GLOBAL_FLAGS) assert.match(cli, new RegExp(`${f.name.replace(/^--/, '')}: \\{ type:`));
  });
  test('help --json is the table, for the version that runs', () => {
    assert.deepEqual(helpJson('1.2.3'), { version: '1.2.3', commands: COMMANDS, global_flags: GLOBAL_FLAGS });
    assert.equal(helpJson('1.2.3', 'deploy').command.name, 'deploy');
    assert.equal(helpJson('1.2.3', 'nope'), null);
  });
  test('help text lists every command\'s usage', () => {
    const text = helpText('1.2.3');
    assert.match(text, /^cubby 1\.2\.3: build and host apps/);
    for (const c of COMMANDS) assert.ok(text.includes(c.usage), c.name);
  });
  test('the /docs.md reference is a table of every command, with pipes escaped', () => {
    const md = commandsMarkdown();
    for (const c of COMMANDS) assert.ok(md.includes(`\`${c.usage.replaceAll('|', '\\|')}\``), c.name);
    assert.match(md, /Every command accepts `--json`, `--server`, `--client`\./);
  });
});
