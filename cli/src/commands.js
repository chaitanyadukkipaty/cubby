// The CLI's command table: the single source for `cubby help` (text and --json), and for the command reference
// in each server's /docs.md. A new command or flag goes here (and in index.js), never in the agent skill: the
// skill is shared by every server version and only names the frozen core (cli/skill/core-commands.json).

export const COMMANDS = [
  // Account and servers
  { name: 'login', usage: 'cubby login <server-url> [--no-wait | --wait | --token <token>]', summary: 'Log in by approving a link in the browser; --no-wait prints the link and exits, --wait finishes. --token for CI.', flags: ['--no-wait', '--wait', '--token', '--email', '--password', '--no-skill'] },
  { name: 'signup', usage: 'cubby signup <server-url> --email <e> --password <p> --code <signup-code>', summary: 'Create an account with the signup code from the admin.', flags: ['--email', '--password', '--code'] },
  { name: 'whoami', usage: 'cubby whoami', summary: 'Who you are on the server.', flags: [] },
  { name: 'agents', usage: 'cubby agents [rename <id> <name> | revoke <id> --yes]', summary: 'Your agents: one per approved `cubby login`, named after the tool and machine, with when each was last seen (* = this agent). Rename one, or revoke its key (revoking this agent logs it out here).', flags: ['--yes'] },
  { name: 'servers', usage: 'cubby servers', summary: "Servers you've added (* = default).", flags: [] },
  { name: 'use', usage: 'cubby use <name|url>', summary: 'Make a server the default for new apps.', flags: [] },
  { name: 'logout', usage: 'cubby logout [--server <name|url>] [--all]', summary: 'Forget one server (the current one by default) or all of them.', flags: ['--all'] },
  { name: 'skill', usage: 'cubby skill install | remove | status', summary: 'Manage the agent skill.', flags: [] },
  { name: 'version', usage: 'cubby version', summary: 'The CLI version that runs for this server, and the server version.', flags: [] },
  { name: 'help', usage: 'cubby help [<command>]', summary: 'This list; --json for agents. Shows what the server you target supports.', flags: [] },
  // Apps
  { name: 'init', usage: 'cubby init <app> [--dir <path>] [--name <n>] [--no-install]', summary: 'Create an app: a folder from the template plus the app on the server.', flags: ['--dir', '--name', '--no-install'] },
  { name: 'link', usage: 'cubby link <app> [--server <name|url>]', summary: 'Attach this folder to an existing app, or move it to another server.', flags: [] },
  { name: 'projects', usage: 'cubby projects', summary: 'Your apps on the server.', flags: [] },
  { name: 'info', usage: 'cubby info', summary: "This folder's app.", flags: [] },
  { name: 'delete', usage: 'cubby delete <app> --yes', summary: 'Delete an app, its data and every deploy.', flags: ['--yes'] },
  { name: 'schema', usage: 'cubby schema push | pull | drop <collection>[.<field>] --yes', summary: 'Apply or fetch cubby/schema.json (push never deletes); drop deletes a collection or field and its data.', flags: ['--file', '--yes'] },
  { name: 'deploy', usage: 'cubby deploy [-m <message>] [--unlisted | --listed] [--no-build] [--dir dist]', summary: 'Push the schema if it changed, build (with the jobs in cubby/jobs/), and publish.', flags: ['--message', '--unlisted', '--listed', '--no-build', '--dir', '--file'] },
  { name: 'deploys', usage: 'cubby deploys', summary: 'The last 10 deploys of this app.', flags: [] },
  { name: 'rollback', usage: 'cubby rollback <deploy-id>', summary: 'Serve an earlier deploy again, with the jobs it shipped (data and secrets are not rolled back).', flags: [] },
  // Scheduled jobs
  { name: 'jobs', usage: 'cubby jobs [run | logs | pause | resume <job>] [--limit <n>] [--run <id>]', summary: 'Scheduled jobs from cubby/jobs/: list them with next and last run; run one now and print its log (exits 1 if it fails); show past logs; pause or resume.', flags: ['--limit', '--run'] },
  { name: 'env', usage: 'cubby env list | set <NAME>=<value> | set <NAME> --from-stdin | unset <NAME> --yes', summary: 'Secrets for jobs, read as env.NAME. Values are encrypted and never shown again.', flags: ['--from-stdin', '--yes'] },
  // Server admins only
  { name: 'admin', usage: 'cubby admin storage | backups [create [--no-wait] | delete <YYYY-MM-DD> --yes [--leave-none]]', summary: 'Admins only. storage: where the disk goes, per category and per app. backups: list them by date; create one now (waits unless --no-wait); delete one (both files; the only backup also needs --leave-none). Restore stays `sudo cubby-server restore <date>`.', flags: ['--no-wait', '--yes', '--leave-none'] },
];

// Accepted by every command.
export const GLOBAL_FLAGS = [
  { name: '--json', summary: 'Machine-readable output.' },
  { name: '--server', summary: 'Which server: a name or URL. Default order: --server, CUBBY_SERVER, the app\'s cubby.json, the default server, the only server.' },
  { name: '--client', summary: 'Your agent\'s name, recorded on deploys and used to name the agent at `cubby login` (detected if unset).' },
];

export function helpJson(version, name) {
  if (name) {
    const cmd = COMMANDS.find((c) => c.name === name);
    return cmd ? { version, command: cmd, global_flags: GLOBAL_FLAGS } : null;
  }
  return { version, commands: COMMANDS, global_flags: GLOBAL_FLAGS };
}

export function helpText(version) {
  const width = Math.max(...COMMANDS.map((c) => c.usage.length)) + 2;
  return [
    `cubby ${version}: build and host apps (Vite + React + Tailwind + PocketBase)`,
    '',
    ...COMMANDS.map((c) => `  ${c.usage.padEnd(width)}${c.summary}`),
    '',
    'Global flags:',
    ...GLOBAL_FLAGS.map((f) => `  ${f.name.padEnd(11)}${f.summary}`),
    'Env: CUBBY_TOKEN (token), CUBBY_SERVER (server name or URL), CUBBY_CLIENT (agent name)',
    'The CLI always matches the server it talks to; in an app folder, the server in cubby.json.',
  ].join('\n');
}

// Markdown command reference for /docs.md.
export function commandsMarkdown() {
  const esc = (s) => s.replaceAll('|', '\\|');
  return [
    '| Command | What it does |',
    '| --- | --- |',
    ...COMMANDS.map((c) => `| \`${esc(c.usage)}\` | ${esc(c.summary)} |`),
    '',
    `Every command accepts ${GLOBAL_FLAGS.map((f) => `\`${f.name}\``).join(', ')}.`,
  ].join('\n');
}
