// Admin: server stats, name, invites, limits, scheduled jobs, users, every app, and updates.
import { h, ago, fmtBytes, displayName, inviteText, jobState, updateNotice, versionLabel } from '../helpers.js';
import { state, api, rerender, SERVER } from '../session.js';
import { toast, copy, pageHeader } from '../ui.js';

function updateCard(update, s) {
  const n = updateNotice(update);
  return h('div', { class: 'card stack', role: 'region', 'aria-label': 'Updates' },
    h('div', { class: 'spread' },
      h('div', {},
        n.kind === 'available' ? h('span', { class: 'badge accent' }, 'update') : null,
        ' ', h('b', {}, n.text)),
      n.url ? h('a', { href: n.url, target: '_blank', rel: 'noopener' }, 'Release notes ↗') : null,
    ),
    n.command ? h('div', {},
      h('p', { class: 'muted small' }, 'Run this on the server (a backup is taken first; data is kept):'),
      h('pre', {}, n.command),
      h('button', { onclick: () => copy(n.command, 'Command copied') }, 'Copy command'),
    ) : null,
    update?.reason === 'env' ? null : h('label', { class: 'check small' },
      h('input', { type: 'checkbox', checked: s.update_check, onchange: async (e) => {
        await api('PATCH', '/api/admin/settings', { update_check: e.target.checked });
        toast(e.target.checked ? 'Update checks on' : 'Update checks off');
        rerender();
      } }),
      'Check for new Cubby releases once a day (asks GitHub; the only request Cubby itself makes)'),
  );
}

const stat = (label, value, sub) => h('div', {}, h('span', { class: 'muted small' }, label), h('b', {}, value), sub ? h('span', { class: 'muted small' }, sub) : null);

export async function renderAdmin(el) {
  el.replaceChildren(pageHeader('Admin'), h('p', { class: 'muted' }, 'Loading…'));
  const [overview, users, apps, jobs] = await Promise.all([api('GET', '/api/admin/overview'), api('GET', '/api/admin/users'), api('GET', '/api/admin/apps'), api('GET', '/api/admin/jobs')]);
  const s = overview.settings;
  const srv = overview.server;
  const invite = inviteText(SERVER, s.signup_code, s.server_name);

  const nameForm = h('form', { class: 'row', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await api('PATCH', '/api/admin/settings', { server_name: new FormData(e.target).get('server_name') });
      state.info.name = r.server_name;
      document.title = displayName(state.info.name);
      toast('Server name saved');
      rerender();
    } catch (ex) { toast(ex.message); }
  } },
    h('input', { type: 'text', name: 'server_name', value: s.server_name, maxlength: 60, required: true, 'aria-label': 'Server name', style: 'flex:1;min-width:0' }),
    h('button', { type: 'submit' }, 'Save name'),
  );

  const limitsForm = h('form', { class: 'row', onsubmit: async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    try {
      await api('PATCH', '/api/admin/settings', { max_apps_per_user: Number(d.max_apps_per_user), max_deploy_mb: Number(d.max_deploy_mb) });
      toast('Limits saved');
    } catch (ex) { toast(ex.message); }
  } },
    h('label', { class: 'small' }, 'Apps per user', h('input', { type: 'number', name: 'max_apps_per_user', min: 1, value: s.max_apps_per_user, style: 'width:110px;display:block' })),
    h('label', { class: 'small' }, 'Max deploy (MB)', h('input', { type: 'number', name: 'max_deploy_mb', min: 1, value: s.max_deploy_mb, style: 'width:110px;display:block' })),
    h('button', { type: 'submit', style: 'align-self:flex-end' }, 'Save limits'),
  );

  el.replaceChildren(
    pageHeader('Admin', h('span', { class: 'muted' }, srv.public_url)),
    h('div', { class: 'stats' },
      stat('Users', srv.users), stat('Apps', srv.apps), stat('Data stored', fmtBytes(srv.data_bytes)),
      stat('Disk free', fmtBytes(srv.disk_free_bytes), `of ${fmtBytes(srv.disk_total_bytes)}`),
    ),

    h('h3', {}, 'Server name'),
    h('div', { class: 'card stack' },
      h('p', { class: 'muted small' }, 'Shown to everyone on the dashboard, the sign-in page and when connecting an agent.'),
      nameForm,
    ),

    h('h3', {}, 'Invite people'),
    h('div', { class: 'card stack' },
      h('div', { class: 'spread' },
        h('div', {}, h('span', { class: 'muted small' }, 'Signup code '), h('code', { class: 'mono', style: 'font-size:15px', 'aria-label': 'Current signup code' }, s.signup_code)),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => copy(invite, 'Invite copied') }, 'Copy invite'),
          h('button', { onclick: async () => {
            if (!confirm('Rotate the signup code? The current code stops working for new signups.')) return;
            await api('PATCH', '/api/admin/settings', { rotate_code: true });
            toast('New code generated');
            rerender();
          } }, 'Rotate code'),
        ),
      ),
      h('label', { class: 'check small' },
        h('input', { type: 'checkbox', checked: s.open_signup, onchange: async (e) => {
          await api('PATCH', '/api/admin/settings', { open_signup: e.target.checked });
          toast(e.target.checked ? 'Anyone with the URL can sign up' : 'Signup code required');
        } }),
        'Open signup (no code needed — anyone with the URL can join)'),
    ),

    h('h3', {}, 'Limits'),
    h('div', { class: 'card' }, limitsForm),

    h('h3', {}, `Scheduled jobs (${jobs.length})`),
    h('div', { class: 'card stack' },
      h('label', { class: 'check small' },
        h('input', { type: 'checkbox', checked: s.jobs, onchange: async (e) => {
          await api('PATCH', '/api/admin/settings', { jobs: e.target.checked });
          toast(e.target.checked ? 'Jobs will run on schedule' : 'All jobs stopped');
          rerender();
        } }),
        'Run scheduled jobs (turn off to stop every app\'s jobs at once)'),
      h('form', { class: 'row', onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('PATCH', '/api/admin/settings', { job_timeout_s: Number(new FormData(e.target).get('job_timeout_s')) });
          toast('Time limit saved');
        } catch (ex) { toast(ex.message); }
      } },
        h('label', { class: 'small' }, 'Time limit per run (seconds)', h('input', { type: 'number', name: 'job_timeout_s', min: 5, max: 290, value: s.job_timeout_s, style: 'width:110px;display:block' })),
        h('button', { type: 'submit', style: 'align-self:flex-end' }, 'Save'),
      ),
      jobs.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'App'), h('th', {}, 'Job'), h('th', {}, 'Schedule (UTC)'), h('th', {}, 'Last run'))),
        h('tbody', {}, jobs.map((j) => {
          const st = jobState(j);
          return h('tr', {},
            h('td', {}, j.app, h('div', { class: 'muted small' }, j.owner)), h('td', { class: 'mono' }, j.name), h('td', { class: 'mono' }, j.schedule),
            h('td', {}, h('span', { class: `badge ${st.kind}` }, st.text), ' ', h('span', { class: 'muted small' }, j.last_run ? ago(j.last_run.started) : '')),
          );
        })),
      )) : h('p', { class: 'muted small' }, 'No app has jobs yet. Apps add them in cubby/jobs/.'),
    ),

    h('h3', {}, `Users (${users.length})`),
    h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Email'), h('th', {}, 'Apps'), h('th', {}, 'Disk'), h('th', {}, 'Joined'), h('th', {}, ''))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', {}, u.email, ' ', u.is_admin ? h('span', { class: 'badge accent' }, 'admin') : null, u.disabled ? h('span', { class: 'badge' }, 'disabled') : null),
        h('td', {}, u.apps), h('td', {}, fmtBytes(u.disk_bytes)), h('td', { class: 'muted' }, ago(u.created)),
        h('td', { style: 'text-align:right' }, u.id === state.me.id ? null : h('div', { class: 'row', style: 'justify-content:flex-end;flex-wrap:nowrap' },
          h('button', { onclick: async () => {
            await api('PATCH', `/api/admin/users/${u.id}`, { disabled: !u.disabled });
            toast(u.disabled ? 'User enabled' : 'User disabled — their apps stay online');
            rerender();
          } }, u.disabled ? 'Enable' : 'Disable'),
          h('button', { class: 'danger', onclick: async () => {
            if (prompt(`Delete ${u.email} and all ${u.apps} of their apps? Type their email to confirm:`) !== u.email) return;
            await api('DELETE', `/api/admin/users/${u.id}`);
            toast('User deleted');
            rerender();
          } }, 'Delete'),
        )),
      ))),
    )),

    h('h3', {}, `All apps (${apps.length})`),
    apps.length ? h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'App'), h('th', {}, 'Owner'), h('th', {}, 'Disk'), h('th', {}, 'Last deploy'), h('th', {}, ''))),
      h('tbody', {}, apps.sort((a, b) => b.disk_bytes - a.disk_bytes).map((a) => h('tr', {},
        h('td', {}, h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.slug), a.unlisted ? h('span', { class: 'badge', style: 'margin-left:6px' }, 'unlisted') : null),
        h('td', { class: 'muted' }, a.owner), h('td', {}, fmtBytes(a.disk_bytes)), h('td', { class: 'muted' }, ago(a.last_deployed)),
        h('td', { style: 'text-align:right' }, h('button', { class: 'danger', onclick: async () => {
          if (prompt(`Delete ${a.slug} (owned by ${a.owner}), its data and deploys? Type the app name to confirm:`) !== a.slug) return;
          await api('DELETE', `/api/admin/apps/${a.slug}`);
          toast(`Deleted ${a.slug}`);
          rerender();
        } }, 'Delete')),
      ))),
    )) : h('div', { class: 'empty' }, 'No apps yet.'),

    h('h3', {}, 'Server'),
    h('div', { class: 'stack' }, updateCard(overview.update, s), h('div', { class: 'card small stack' },
      h('p', {}, `${versionLabel(srv.version)} · ${srv.public_url} · ${srv.https ? 'HTTPS' : 'HTTP only'}`),
      h('p', { class: 'muted' }, 'Backups run nightly (7 kept). Manage them with ', h('code', {}, 'cubby-server backup'), ' / ', h('code', {}, 'cubby-server restore'), ' on the server. ',
        'The database dashboard is reachable from the server only: ', h('code', {}, 'ssh -L 8090:127.0.0.1:8090 <server>'), ' then open http://localhost:8090/_/'),
    )),
  );
}
