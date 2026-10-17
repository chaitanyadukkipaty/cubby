// /apps: the signed-in user's apps as cards (visibility, delete, scheduled jobs). /apps/:slug shows one of them.
import { h, ago, jobState } from '../helpers.js';
import { api, rerender } from '../session.js';
import { navigate } from '../router.js';
import { toast, pageHeader } from '../ui.js';

// An app's scheduled jobs, loaded when its "Scheduled jobs" section is opened.
function jobsPanel(a, { open = false } = {}) {
  const body = h('div', { class: 'stack small' }, h('p', { class: 'muted' }, 'Loading…'));
  const draw = async () => {
    const jobs = await api('GET', `/api/projects/${a.slug}/jobs`);
    body.replaceChildren(...jobs.map((j) => {
      const st = jobState(j);
      const log = h('pre', { hidden: true });
      return h('div', { class: 'stack', role: 'group', 'aria-label': `Job ${j.name}` },
        h('div', {}, h('b', { class: 'mono' }, j.name), ' ', h('span', { class: `badge ${st.kind}` }, st.text)),
        h('p', { class: 'muted' }, h('span', { class: 'mono' }, j.schedule), ' UTC · ', j.last_run ? `last run ${ago(j.last_run.started)}` : 'never run',
          j.next_run ? ` · next ${new Date(j.next_run).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : ''),
        h('div', { class: 'row' },
          h('button', { onclick: async (e) => {
            e.target.disabled = true;
            try {
              const r = await api('POST', `/api/projects/${a.slug}/jobs/${j.name}/run`);
              toast(`${j.name}: ${r.status}`);
              await draw();
            } catch (ex) { toast(ex.message); e.target.disabled = false; }
          } }, 'Run now'),
          h('button', { onclick: async () => {
            await api('PATCH', `/api/projects/${a.slug}/jobs/${j.name}`, { paused: !j.paused });
            toast(j.paused ? `${j.name} resumed` : `${j.name} paused`);
            await draw();
          } }, j.paused ? 'Resume' : 'Pause'),
          j.last_run ? h('button', { class: 'link', onclick: async () => {
            if (log.hidden) log.textContent = (await api('GET', `/api/projects/${a.slug}/jobs/${j.name}/runs?limit=1`))[0]?.log || '(no output)';
            log.hidden = !log.hidden;
          } }, 'Last log') : null,
        ),
        log,
      );
    }));
  };
  return h('details', { class: 'small', open, ontoggle: (e) => { if (e.target.open) draw().catch((ex) => toast(ex.message)); } },
    h('summary', { class: 'muted' }, `Scheduled jobs (${a.jobs})`),
    body,
  );
}

function appCard(a, { onDeleted, detail = false }) {
  return h('article', { class: 'card app stack', 'aria-label': a.name },
    h('div', {},
      h('div', { class: 'spread' },
        h('h2', {}, detail ? a.name : h('a', { href: `/apps/${a.slug}` }, a.name)),
        a.unlisted ? h('span', { class: 'badge' }, 'unlisted') : null),
      a.description ? h('p', { class: 'muted small' }, a.description) : null,
      h('p', { class: 'meta' }, a.current_deploy ? `Deployed ${ago(a.last_deployed)}` : 'Not deployed yet'),
    ),
    h('div', { class: 'row' },
      a.current_deploy ? h('a', { href: a.url, target: '_blank', rel: 'noopener' }, 'Open ↗') : h('span', { class: 'muted small' }, a.url.replace(/^https?:\/\//, '')),
    ),
    h('div', { class: 'spread' },
      h('label', { class: 'check small' },
        h('input', { type: 'checkbox', checked: !a.unlisted, onchange: async (e) => {
          await api('PATCH', `/api/projects/${a.slug}`, { unlisted: !e.target.checked });
          toast(e.target.checked ? 'Shown in gallery' : 'Hidden from gallery');
        } }),
        'Show in gallery'),
      h('button', { class: 'danger', onclick: async () => {
        if (prompt(`This deletes ${a.slug}, all its data and deploys. Type the app name to confirm:`) !== a.slug) return;
        await api('DELETE', `/api/projects/${a.slug}`);
        toast(`Deleted ${a.slug}`);
        onDeleted();
      } }, 'Delete'),
    ),
    a.jobs ? jobsPanel(a, { open: detail }) : null,
  );
}

export const noAppsYet = () => h('div', { class: 'empty' }, 'No apps yet. Run ', h('code', {}, 'cubby init my-app'), ' to create one.');

export async function renderApps(el) {
  const list = h('div', { class: 'grid' }, h('p', { class: 'muted' }, 'Loading…'));
  const header = pageHeader('Apps');
  el.replaceChildren(header, list);
  const apps = await api('GET', '/api/projects');
  header.append(h('span', { class: 'muted' }, String(apps.length)));
  if (!apps.length) return list.replaceWith(noAppsYet());
  list.replaceChildren(...apps.map((a) => appCard(a, { onDeleted: rerender })));
}

export async function renderApp(el, { slug }) {
  const back = h('a', { class: 'back', href: '/apps' }, '← Apps');
  el.replaceChildren(back, h('p', { class: 'muted' }, 'Loading…'));
  const a = (await api('GET', '/api/projects')).find((p) => p.slug === slug);
  if (!a) return el.replaceChildren(back, pageHeader(slug), h('div', { class: 'empty' }, `You don't have an app called ${slug}.`));
  el.replaceChildren(back, pageHeader(a.name, h('span', { class: 'muted mono small' }, a.slug)),
    h('div', { style: 'max-width:560px' }, appCard(a, { detail: true, onDeleted: () => navigate('/apps') })));
}
